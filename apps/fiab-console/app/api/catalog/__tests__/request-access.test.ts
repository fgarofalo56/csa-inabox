/**
 * POST /api/catalog/request-access — the access model and the grant scope come
 * from the requested data product, never from the request body.
 *
 * The body names WHICH asset and HOW MUCH access. Every other grant-shaping
 * field (`accessModel`, `scopeType`, `scopeRef`, `assetName`, `itemType`) is
 * ignored, so each test below sends a body whose extra fields DISAGREE with the
 * stored product, and asserts the product's value won. The value that would
 * break each assertion is named at the site.
 *
 * Seams: Cosmos is the partition-honest fake (the route's real SQL runs against
 * it); `enforceAccessGrant` is a spy; discovery (`resolveDiscoveryAccess`) is
 * mocked to 'discoverable' except where a test sets 'denied' — its own rules
 * are covered in lib/dataproducts/__tests__.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/session')>();
  return { ...actual, getSession: vi.fn() };
});
vi.mock('@/lib/azure/cosmos-client', () => ({
  accessRequestWorkflowContainer: vi.fn(),
  auditLogContainer: vi.fn(),
  notificationsContainer: vi.fn(),
  itemsContainer: vi.fn(),
  workspacesContainer: vi.fn(),
  accessAssignmentsContainer: vi.fn(),
}));
vi.mock('@/lib/auth/workspace-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/workspace-guard')>()),
  authorizeWorkspace: vi.fn(),
}));
vi.mock('@/lib/azure/access-policy-client', () => ({ enforceAccessGrant: vi.fn() }));
vi.mock('@/lib/dataproducts/discoverability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dataproducts/discoverability')>();
  return { ...actual, resolveDiscoveryAccess: vi.fn(), workspaceTid: vi.fn() };
});

import { POST } from '../request-access/route';
import { getSession } from '@/lib/auth/session';
import {
  accessRequestWorkflowContainer, auditLogContainer, notificationsContainer, itemsContainer,
} from '@/lib/azure/cosmos-client';
import { enforceAccessGrant } from '@/lib/azure/access-policy-client';
import { resolveDiscoveryAccess, workspaceTid } from '@/lib/dataproducts/discoverability';
import { authorizeWorkspace } from '@/lib/auth/workspace-guard';
import { accessAssignmentsContainer } from '@/lib/azure/cosmos-client';
import {
  makePartitionedContainer, makeSinkContainer, type FakeContainer,
} from '@/app/api/access-requests/__tests__/partitioned-cosmos-fake';

const TENANT = 'tenant-1-tid';
const USER = { oid: 'user-a-oid', tid: TENANT, upn: 'alice@contoso.com' };

/** The container the product's output port is bound to. */
const PRODUCT_CONTAINER = 'gold';
/** A body-supplied scope that must never be granted. */
const BODY_CONTAINER = 'body-container';

function product(id: string, state: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: 'ws-1',
    itemType: 'data-product',
    displayName: `Product ${id}`,
    state: {
      lifecycleState: 'published',
      ports: { output: [{ name: 'gold-out', kind: 'adls', ref: PRODUCT_CONTAINER }] },
      ...state,
    },
    ...extra,
  };
}

let wf: FakeContainer;

function post(body: any) {
  return POST({ json: async () => body } as any, { params: Promise.resolve({}) } as any);
}

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: USER, exp: Date.now() / 1000 + 3600 });
  wf = makePartitionedContainer({ partitionKeyPath: '/tenantId' });
  (accessRequestWorkflowContainer as any).mockResolvedValue(wf);
  (auditLogContainer as any).mockResolvedValue(makeSinkContainer());
  (notificationsContainer as any).mockResolvedValue(makeSinkContainer());
  (itemsContainer as any).mockResolvedValue(makePartitionedContainer({
    partitionKeyPath: '/workspaceId',
    seed: [
      product('governed-1', {}),                                   // no accessModel → governed
      product('self-1', { accessModel: 'self-serve' }),
      product('request-1', { accessModel: 'request' }),
      product('draft-1', { lifecycleState: 'draft', accessModel: 'self-serve' }),
    ],
  }));
  (resolveDiscoveryAccess as any).mockResolvedValue('discoverable');
  (enforceAccessGrant as any).mockResolvedValue({
    status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-1',
  });
});

describe('POST /api/catalog/request-access — asset resolution', () => {
  it('404 for an unknown asset, with no request filed and no grant', async () => {
    // Breaks on: a route that trusts the body and files a request for any id.
    const res = await post({ assetId: 'no-such-asset', accessModel: 'self-serve', scopeRef: BODY_CONTAINER });
    const j = await res.json();
    expect(res.status).toBe(404);
    expect(j.ok).toBe(false);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    expect(wf.__all()).toHaveLength(0);
  });

  it('404 for an unpublished (draft) product, even when it is self-serve', async () => {
    // Breaks on: dropping the DISCOVERABLE lifecycle check (a draft self-serve
    // product would be granted immediately → 200 + 1 grant).
    const res = await post({ assetId: 'draft-1' });
    expect(res.status).toBe(404);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    expect(wf.__all()).toHaveLength(0);
  });

  it('404 for a product the caller may not discover', async () => {
    // Breaks on: ignoring resolveDiscoveryAccess's 'denied'.
    (resolveDiscoveryAccess as any).mockResolvedValue('denied');
    const res = await post({ assetId: 'self-1' });
    expect(res.status).toBe(404);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
  });

  it('400 when no assetId is supplied', async () => {
    const res = await post({ accessModel: 'self-serve', scopeRef: BODY_CONTAINER });
    expect(res.status).toBe(400);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
  });
});

describe('POST /api/catalog/request-access — access model comes from the product', () => {
  it("a governed product goes to approval even when the body says 'self-serve'", async () => {
    // Breaks on: reading accessModel from the body (→ an immediate grant on
    // BODY_CONTAINER, `granted:true`, zero workflow rows).
    const res = await post({
      assetId: 'governed-1', accessModel: 'self-serve',
      scopeType: 'adls-container', scopeRef: BODY_CONTAINER, permission: 'read',
    });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.granted).toBeUndefined();
    expect(j.accessModel).toBe('governed');
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    const docs = wf.__all();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      tenantId: TENANT, assetId: 'governed-1', tier: 'manager', status: 'open',
      requesterId: USER.oid, permission: 'read',
      // The scope recorded on the request is the PRODUCT's, not the body's.
      scopeType: 'adls-container', scopeRef: PRODUCT_CONTAINER,
    });
    expect(docs[0].grantTargets).toEqual([
      { scopeType: 'adls-container', scopeRef: PRODUCT_CONTAINER, source: "output port 'gold-out'" },
    ]);
  });

  it("a 'request' product records the request and files no workflow row, whatever the body says", async () => {
    // Breaks on: a body accessModel of 'governed' opening a workflow row (1 doc).
    const res = await post({ assetId: 'request-1', accessModel: 'governed' });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.accessModel).toBe('request');
    expect(wf.__all()).toHaveLength(0);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
  });
});

describe('POST /api/catalog/request-access — self-serve', () => {
  it("grants Read immediately on the product's bound container, not the body's", async () => {
    // Breaks on: using the body scopeRef (grant on BODY_CONTAINER) or the body
    // scopeType ('adls-path').
    const res = await post({
      assetId: 'self-1', permission: 'read',
      scopeType: 'adls-path', scopeRef: BODY_CONTAINER, accessModel: 'governed',
    });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.granted).toBe(true);
    expect(j.permission).toBe('read');
    expect(enforceAccessGrant).toHaveBeenCalledTimes(1);
    expect(enforceAccessGrant).toHaveBeenCalledWith(expect.objectContaining({
      principalId: USER.oid, scopeType: 'adls-container', scopeRef: PRODUCT_CONTAINER, permission: 'read',
    }));
    expect(wf.__all()).toHaveLength(0);
  });

  it.each(['write', 'admin'])('a %s request on a self-serve product grants nothing and goes to approval', async (perm) => {
    // Breaks on: dropping the self-serve role cap (an immediate `perm` grant,
    // `granted:true`, 1 enforceAccessGrant call).
    const res = await post({ assetId: 'self-1', permission: perm });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.granted).toBeUndefined();
    expect(j.accessModel).toBe('governed');
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    const docs = wf.__all();
    expect(docs).toHaveLength(1);
    expect(docs[0].permission).toBe(perm);
    expect(docs[0].scopeRef).toBe(PRODUCT_CONTAINER);
  });

  it('a self-serve grant that does not land falls through to approval', async () => {
    // Breaks on: reporting `granted:true` on a pending grant.
    (enforceAccessGrant as any).mockResolvedValue({ status: 'pending', detail: 'gate' });
    const res = await post({ assetId: 'self-1', permission: 'read' });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.granted).toBeUndefined();
    expect(wf.__all()).toHaveLength(1);
  });
});

// ── Items that are not data products ────────────────────────────────────────────

function storeItem(id: string, itemType: string, state: Record<string, unknown>) {
  return { id, workspaceId: 'ws-9', itemType, displayName: `Item ${id}`, state };
}

function seedItems(docs: any[]) {
  (itemsContainer as any).mockResolvedValue(makePartitionedContainer({ partitionKeyPath: '/workspaceId', seed: docs }));
}

describe('POST /api/catalog/request-access — a store item is requested on its own store', () => {
  const prevPool = process.env.LOOM_SYNAPSE_DEDICATED_POOL;
  beforeEach(() => {
    (authorizeWorkspace as any).mockResolvedValue(null); // the caller may see the workspace
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'deploymentpool';
  });
  afterEach(() => {
    if (prevPool === undefined) delete process.env.LOOM_SYNAPSE_DEDICATED_POOL;
    else process.env.LOOM_SYNAPSE_DEDICATED_POOL = prevPool;
  });

  it.each([
    // [item, expected scopeType, expected scopeRef]. Each item also carries a
    // client-writable decoy; a resolver reading it would record the decoy.
    [storeItem('lh-1', 'lakehouse', { adlsContainer: 'landing', container: 'planted' }), 'adls-container', 'landing'],
    [storeItem('wh-1', 'warehouse', { dedicatedPool: 'otherpool' }), 'warehouse', 'deploymentpool'],
    [storeItem('kql-1', 'kql-database', { adxDatabase: 'planteddb', provisioning: { status: 'created', secondaryIds: { database: 'telemetry' } } }), 'kql-database', 'telemetry'],
  ])('%#: the request records the item store, not an item/workspace scope', async (item: any, scopeType, scopeRef) => {
    // Breaks on: `deriveRequestTargets` returning `{ scopeType: 'item' }` for every
    // non-product (a workspace-wide Viewer/Contributor grant at approval).
    seedItems([item]);
    const res = await post({ assetId: item.id, permission: 'read', scopeType: 'item', scopeRef: BODY_CONTAINER });
    expect(res.status).toBe(200);
    const [doc] = wf.__all();
    expect(doc.grantTargets.map((t: any) => [t.scopeType, t.scopeRef])).toEqual([[scopeType, scopeRef]]);
    expect(enforceAccessGrant).not.toHaveBeenCalled(); // non-products are governed
  });

  it('a lakehouse with no storage recorded keeps its store type with an empty scope, never item scope', async () => {
    // Breaks on: falling back to `item` (workspace role) for an unbound store item.
    seedItems([storeItem('lh-2', 'lakehouse', { container: 'planted' })]);
    const res = await post({ assetId: 'lh-2', permission: 'read' });
    expect(res.status).toBe(200);
    expect(wf.__all()[0].grantTargets.map((t: any) => [t.scopeType, t.scopeRef])).toEqual([['adls-container', '']]);
  });

  it('an item with no physical store is requested at item scope', async () => {
    // Pairs the store cases: breaks if every item were forced to a store scope.
    seedItems([storeItem('rep-1', 'report', {})]);
    const res = await post({ assetId: 'rep-1', permission: 'read' });
    expect(res.status).toBe(200);
    expect(wf.__all()[0].grantTargets.map((t: any) => [t.scopeType, t.scopeRef])).toEqual([['item', 'rep-1']]);
  });
});

describe('POST /api/catalog/request-access — visibility of an item that is not a data product', () => {
  const denied = new Response(JSON.stringify({ ok: false }), { status: 404 });

  it('404, and no request filed, for a workspace the caller has no role in and another tenant owns', async () => {
    // Breaks on: dropping the workspace/tenant check for non-products (→ 200 + a request doc).
    seedItems([storeItem('lh-x', 'lakehouse', { adlsContainer: 'landing' })]);
    (authorizeWorkspace as any).mockResolvedValue(denied);
    (workspaceTid as any).mockResolvedValue('other-tenant-tid');
    const res = await post({ assetId: 'lh-x', permission: 'read' });
    expect(res.status).toBe(404);
    expect(wf.__all()).toHaveLength(0);
  });

  it('200 for the same item when its workspace is confirmed in the caller\'s own tenant', async () => {
    // The positive pair: breaks if the check refused same-tenant items too.
    seedItems([storeItem('lh-x', 'lakehouse', { adlsContainer: 'landing' })]);
    (authorizeWorkspace as any).mockResolvedValue(denied);
    (workspaceTid as any).mockResolvedValue(TENANT);
    const res = await post({ assetId: 'lh-x', permission: 'read' });
    expect(res.status).toBe(200);
    expect(wf.__all()).toHaveLength(1);
  });
});

describe('POST /api/catalog/request-access — a self-serve grant that lands on some scopes but not all', () => {
  it('records the landed grant in the ledger and on the request, which goes for approval', async () => {
    // Breaks on: the landed grant left unrecorded (0 ledger rows, no grantResults on
    // the request) — which is what lets a later denial revoke it.
    seedItems([product('self-2', { accessModel: 'self-serve', ports: { output: [
      { name: 'gold-out', kind: 'adls', ref: 'gold' }, { name: 'silver-out', kind: 'adls', ref: 'silver' },
    ] } })]);
    const assignments = makePartitionedContainer({ partitionKeyPath: '/principalId' });
    (accessAssignmentsContainer as any).mockResolvedValue(assignments);
    (enforceAccessGrant as any)
      .mockResolvedValueOnce({ status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-gold' })
      .mockResolvedValueOnce({ status: 'error', detail: 'ARM 403 on silver' });

    const res = await post({ assetId: 'self-2', permission: 'read' });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.granted).toBeUndefined();
    const [doc] = wf.__all();
    expect(doc.id).toBe(j.requestId);
    expect(doc.grantResults.map((r: any) => [r.scopeRef, r.status, r.created])).toEqual([
      ['gold', 'active', true], ['silver', 'error', false],
    ]);
    expect(assignments.__all().map((r: any) => [r.resourceRef, r.roleAssignmentId, r.sourceRef])).toEqual([
      ['gold', 'ra-gold', doc.id],
    ]);
    expect(j.message).toMatch(/granted on 1 of 2/);
  });
});

describe('POST /api/catalog/request-access — the owner named in the text', () => {
  it('comes from the product, never the body, and nothing claims the owner was notified', async () => {
    // Breaks on: reading `body.ownerUpn` ('mallory@…' would appear), or a message that
    // says "notified" / "routed to" when no message to the owner is sent.
    seedItems([product('gov-o', { owner: 'owner@contoso.com' })]);
    const notes = makeSinkContainer();
    (notificationsContainer as any).mockResolvedValue(notes);
    const res = await post({ assetId: 'gov-o', permission: 'read', ownerUpn: 'mallory@evil.test' });
    const j = await res.json();
    expect(res.status).toBe(200);
    const text = `${j.message} ${notes.__writes.map((w: any) => w.body).join(' ')}`;
    expect(text).toContain('owner@contoso.com');
    expect(text).not.toContain('mallory@evil.test');
    expect(text).not.toMatch(/notified|routed to/i);
    expect(wf.__all()[0].ownerUpn).toBe('owner@contoso.com');
  });
});
