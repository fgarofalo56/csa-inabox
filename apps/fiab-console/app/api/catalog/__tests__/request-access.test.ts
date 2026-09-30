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
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
}));
vi.mock('@/lib/azure/access-policy-client', () => ({ enforceAccessGrant: vi.fn() }));
vi.mock('@/lib/dataproducts/discoverability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dataproducts/discoverability')>();
  return { ...actual, resolveDiscoveryAccess: vi.fn() };
});

import { POST } from '../request-access/route';
import { getSession } from '@/lib/auth/session';
import {
  accessRequestWorkflowContainer, auditLogContainer, notificationsContainer, itemsContainer,
} from '@/lib/azure/cosmos-client';
import { enforceAccessGrant } from '@/lib/azure/access-policy-client';
import { resolveDiscoveryAccess } from '@/lib/dataproducts/discoverability';
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
