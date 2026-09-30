/**
 * Contract tests for POST /api/access-requests/[id]/decision — the F16
 * multi-tier approval state machine.
 *
 *   - 401 unauthenticated
 *   - 400 on a missing/invalid decision; 400 when denying without a reason
 *   - manager approval advances tier → privacy (status stays open)
 *   - privacy → approver → access-provider on successive approvals
 *   - final (access-provider) approval calls enforceAccessGrant on the scope
 *     derived from the requested asset's own record (never the body or the
 *     request doc) and, on an active grant, completes the request + sets
 *     subscribedAt + records the real ARM role-assignment id
 *   - deny at any tier closes the request as Denied with the reason
 *   - an enforcement error at the final tier keeps the request open (502) —
 *     no false "completed" (no-vaporware)
 *
 * FIXTURE NOTE (read before changing TENANT / the fake container).
 *
 * This file used to be blind to the defect it looked like it covered. Two
 * things did that, and both are fixed here:
 *
 *   1. `baseDoc()` set `tenantId: TENANT` where TENANT was ALSO the signed-in
 *      approver's `oid` — a document shape the creating routes never produce.
 *      It modelled the ROUTE'S ASSUMPTION rather than what the writers write.
 *   2. the fake container's `item(_id, _pk)` IGNORED the partition key and
 *      returned the one stored doc for any key, so even a correct fixture could
 *      not have surfaced a partition-key mismatch.
 *
 * The fixture now uses the real partitioning: `tenantId` is the ENTRA TENANT
 * and the requester is a DIFFERENT principal, reached via `requesterId` — which
 * is what `catalog/request-access` and `access-packages/[id]/request` actually
 * write. The container is the shared partition-honest fake. Cross-user approval
 * itself is proved end-to-end in ./cross-user-approval.test.ts.
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
  accessAssignmentsContainer: vi.fn(),
  approvalPoliciesContainer: vi.fn(),
  featurePermissionsContainer: vi.fn(),
  itemsContainer: vi.fn(),
}));
vi.mock('@/lib/azure/rbac-client', () => ({
  enforceAccessGrant: vi.fn(), revokeAccessGrant: vi.fn(), revokeStructuredGrant: vi.fn(),
}));

import { POST } from '../[id]/decision/route';
import { getSession } from '@/lib/auth/session';
import {
  accessRequestWorkflowContainer, auditLogContainer, notificationsContainer,
  accessAssignmentsContainer, approvalPoliciesContainer, featurePermissionsContainer,
  itemsContainer,
} from '@/lib/azure/cosmos-client';
import { enforceAccessGrant, revokeAccessGrant, revokeStructuredGrant } from '@/lib/azure/rbac-client';
import { makePartitionedContainer, makeSinkContainer, type FakeContainer } from './partitioned-cosmos-fake';

/** The partition key: the Entra TENANT, as tenantScopeId() resolves it. */
const TENANT = 'tenant-1-tid';
/** The approver acting in these tests — NOT the requester. */
const APPROVER_OID = 'approver-oid';
/** The requester who filed the request — a different principal. */
const REQUESTER_OID = 'requester-oid';

function makeReq(body: any) {
  return { json: async () => body } as any;
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * A partition-honest container seeded with one doc, laid out the way the real
 * creating routes lay it out: partition key = tenant, requester = someone else.
 */
function fakeArContainer(doc: any) {
  const container = makePartitionedContainer({ partitionKeyPath: '/tenantId', seed: [doc] });
  return {
    container,
    get store() {
      return { doc: container.__all()[0] };
    },
  };
}

/**
 * The requested asset as the catalog stores it: a published data product whose
 * ONE output port is bound to the ADLS container `gold`. The final tier derives
 * the grant scope from THIS record. `baseDoc()` below deliberately carries a
 * DIFFERENT scope (`stale-container`) so a route that granted on the request
 * doc's own scope — or on a body-supplied one — grants on the wrong container
 * and the scope assertions go red.
 */
const PRODUCT_CONTAINER = 'gold';
function productItem(overrides: Partial<any> = {}) {
  return {
    id: 'asset-1',
    workspaceId: 'ws-1',
    itemType: 'data-product',
    displayName: 'Gold sales',
    state: {
      lifecycleState: 'published',
      ports: { output: [{ name: 'gold-out', kind: 'adls', ref: PRODUCT_CONTAINER }] },
    },
    ...overrides,
  };
}
let items: FakeContainer;

function baseDoc(overrides: Partial<any> = {}) {
  return {
    id: 'req-1',
    tenantId: TENANT,
    kind: 'access-request',
    assetId: 'asset-1',
    assetName: 'Gold sales',
    itemType: 'lakehouse',
    scopeType: 'adls-container',
    scopeRef: 'stale-container',
    // What the approvers reviewed: the product's scope when the request was made.
    // The display scope above is deliberately DIFFERENT, so a route that grants
    // on the doc's own scopeType/scopeRef grants on 'stale-container'.
    grantTargets: [{ scopeType: 'adls-container', scopeRef: PRODUCT_CONTAINER, source: "output port 'gold-out'" }],
    permission: 'read',
    justification: 'quarterly report',
    requesterId: REQUESTER_OID,
    requesterUpn: 'req@contoso.com',
    requestedAt: '2026-06-01T00:00:00.000Z',
    tier: 'manager',
    status: 'open',
    ...overrides,
  };
}

const ORIGINAL_ADMIN_OID = process.env.LOOM_TENANT_ADMIN_OID;

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({
    claims: { oid: APPROVER_OID, tid: TENANT, upn: 'approver@contoso.com' },
  });
  (auditLogContainer as any).mockResolvedValue(makeSinkContainer());
  (notificationsContainer as any).mockResolvedValue(makeSinkContainer());
  (accessAssignmentsContainer as any).mockResolvedValue(makeSinkContainer());
  (approvalPoliciesContainer as any).mockResolvedValue(
    makePartitionedContainer({ partitionKeyPath: '/tenantId' }),
  );
  (featurePermissionsContainer as any).mockResolvedValue(
    makePartitionedContainer({ partitionKeyPath: '/tenantId' }),
  );
  items = makePartitionedContainer({ partitionKeyPath: '/workspaceId', seed: [productItem()] });
  (itemsContainer as any).mockResolvedValue(items);
  // The approver's authority. Without this the route (correctly) 403s — the
  // approval-authority boundary has its own coverage in cross-user-approval.
  process.env.LOOM_TENANT_ADMIN_OID = APPROVER_OID;
});

afterEach(() => {
  if (ORIGINAL_ADMIN_OID === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = ORIGINAL_ADMIN_OID;
});

describe('POST /api/access-requests/[id]/decision', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(401);
  });

  it('400 on invalid decision', async () => {
    const { container } = fakeArContainer(baseDoc());
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'maybe' }), ctx('req-1'));
    expect(res.status).toBe(400);
  });

  it('400 when denying without a reason', async () => {
    const { container } = fakeArContainer(baseDoc());
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'denied' }), ctx('req-1'));
    expect(res.status).toBe(400);
  });

  it('manager approval advances the tier to privacy (still open)', async () => {
    const { container, store } = fakeArContainer(baseDoc({ tier: 'manager' }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(store.doc.tier).toBe('privacy');
    expect(store.doc.status).toBe('open');
    expect(store.doc.managerApproval.decision).toBe('approved');
  });

  it('privacy → approver → access-provider on successive approvals', async () => {
    const { container, store } = fakeArContainer(baseDoc({ tier: 'privacy' }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);

    await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(store.doc.tier).toBe('approver');

    await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(store.doc.tier).toBe('access-provider');
    expect(store.doc.status).toBe('open');
  });

  it('final approval provisions a real RBAC grant and completes the request', async () => {
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockResolvedValue({
      status: 'active',
      roleName: 'Storage Blob Data Reader',
      roleAssignmentId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acct/blobServices/default/containers/gold/providers/Microsoft.Authorization/roleAssignments/abc',
    });

    const res = await POST(makeReq({ decision: 'approved', scopeType: 'adls-path', scopeRef: 'body-container' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    // enforceAccessGrant was called with the requester as principal, on the
    // scope DERIVED FROM THE PRODUCT (`gold`). Breaks on: a route that uses the
    // body's scope (`body-container` / `adls-path`) or the request doc's own
    // (`stale-container`).
    expect(enforceAccessGrant).toHaveBeenCalledTimes(1);
    expect(enforceAccessGrant).toHaveBeenCalledWith(expect.objectContaining({
      principalId: 'requester-oid', scopeType: 'adls-container', scopeRef: PRODUCT_CONTAINER, permission: 'read',
    }));
    expect(store.doc.scopeRef).toBe(PRODUCT_CONTAINER);
    expect(store.doc.grantTargets).toEqual([
      { scopeType: 'adls-container', scopeRef: PRODUCT_CONTAINER, source: "output port 'gold-out'" },
    ]);
    expect(store.doc.status).toBe('completed');
    expect(store.doc.subscribedAt).toBeTruthy();
    expect(store.doc.enforcement.roleAssignmentId).toContain('roleAssignments/abc');
  });

  it('final approval grants on every bound output, one grant per scope', async () => {
    // Two outputs → two grants. Breaks on: a route that grants only targets[0]
    // (1 call, `silver` never granted).
    items = makePartitionedContainer({
      partitionKeyPath: '/workspaceId',
      seed: [productItem({ state: { lifecycleState: 'published', ports: { output: [
        { name: 'gold-out', kind: 'adls', ref: 'gold' },
        { name: 'silver-out', kind: 'adls', ref: 'silver' },
      ] } } })],
    });
    (itemsContainer as any).mockResolvedValue(items);
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider', grantTargets: [
      { scopeType: 'adls-container', scopeRef: 'gold' }, { scopeType: 'adls-container', scopeRef: 'silver' },
    ] }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockResolvedValue({ status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-1' });

    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(200);
    const refs = (enforceAccessGrant as any).mock.calls.map((c: any[]) => c[0].scopeRef);
    expect(refs).toEqual(['gold', 'silver']);
    expect(store.doc.status).toBe('completed');
    expect(store.doc.grantResults).toHaveLength(2);
  });

  it('409 and no grant when the asset no longer exists; the request is left untouched', async () => {
    // Empty catalog. Breaks on: a route that falls back to the doc's own scope
    // (a grant on `stale-container`, status 200) or that replaces the doc.
    items = makePartitionedContainer({ partitionKeyPath: '/workspaceId' });
    (itemsContainer as any).mockResolvedValue(items);
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    // Count persisted writes: the fake's read hands back the stored object by
    // reference, so an in-memory field set is visible without a replace — the
    // replace count is what distinguishes "persisted" from "not persisted".
    let replaced = 0;
    const origItem = container.item.bind(container);
    container.item = (id: string, pk?: string) => {
      const h = origItem(id, pk);
      return { ...h, replace: async (d: any) => { replaced += 1; return h.replace(d); } };
    };
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);

    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('asset_not_found');
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    expect(replaced).toBe(0);
    expect(store.doc.status).toBe('open');
    expect(store.doc.scopeRef).toBe('stale-container');
  });

  it('an access-package leg keeps the scope its package defines', async () => {
    // packageId set → the doc's scope is authoritative (the package defined it).
    // Breaks on: a route that re-derives for package legs too (grant on `gold`).
    const { container } = fakeArContainer(baseDoc({ tier: 'access-provider', packageId: 'pkg-1' }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockResolvedValue({ status: 'active', roleName: 'r', roleAssignmentId: 'ra-1' });

    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(200);
    expect(enforceAccessGrant).toHaveBeenCalledWith(expect.objectContaining({ scopeRef: 'stale-container' }));
  });

  it('deny at any tier closes the request with the reason', async () => {
    const { container, store } = fakeArContainer(baseDoc({ tier: 'approver' }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'denied', reason: 'insufficient justification' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(store.doc.status).toBe('denied');
    expect(store.doc.denialReason).toBe('insufficient justification');
    expect(store.doc.deniedAtTier).toBe('approver');
  });

  it('enforcement error at the final tier keeps the request open (502)', async () => {
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockResolvedValue({ status: 'error', detail: 'ARM 403' });

    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(502);
    expect(j.ok).toBe(false);
    // Not completed — stays at the final tier so the provider can retry.
    expect(store.doc.status).toBe('open');
    expect(store.doc.tier).toBe('access-provider');
  });

  it('409 when the request is already closed', async () => {
    const { container } = fakeArContainer(baseDoc({ status: 'completed' }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(409);
  });
});

/** A ledger container partitioned the way the real one is (`/principalId`). */
function ledger(): FakeContainer {
  const c = makePartitionedContainer({ partitionKeyPath: '/principalId' });
  (accessAssignmentsContainer as any).mockResolvedValue(c);
  return c;
}

const TWO_OUTPUTS = [
  { name: 'gold-out', kind: 'adls', ref: 'gold' },
  { name: 'silver-out', kind: 'adls', ref: 'silver' },
];
const TWO_TARGETS = [
  { scopeType: 'adls-container', scopeRef: 'gold' }, { scopeType: 'adls-container', scopeRef: 'silver' },
];
function twoOutputProduct() {
  items = makePartitionedContainer({
    partitionKeyPath: '/workspaceId',
    seed: [productItem({ state: { lifecycleState: 'published', ports: { output: TWO_OUTPUTS } } })],
  });
  (itemsContainer as any).mockResolvedValue(items);
}

describe('final tier — the scopes the approvers reviewed', () => {
  it('409 targets_changed, no grant and no write when the product gained an output since the request', async () => {
    // Reviewed: [gold]. Now bound: [gold, silver]. Breaks on: a route that grants on the
    // re-derived set without comparing it (2 grants, status 200, silver never reviewed).
    twoOutputProduct();
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    let replaced = 0;
    const origItem = container.item.bind(container);
    container.item = (id: string, pk?: string) => {
      const h = origItem(id, pk);
      return { ...h, replace: async (d: any) => { replaced += 1; return h.replace(d); } };
    };
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);

    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('targets_changed');
    expect(j.current).toEqual(TWO_TARGETS);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    expect(replaced).toBe(0);
    expect(store.doc.status).toBe('open');
  });

  it('a request recorded before grantTargets existed is compared against its own scope', async () => {
    // No grantTargets; the doc's scope ('stale-container') is what was reviewed and the
    // product now derives 'gold'. Breaks on: skipping the comparison for legacy docs.
    const { container } = fakeArContainer(baseDoc({ tier: 'access-provider', grantTargets: undefined }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('targets_changed');
    expect(enforceAccessGrant).not.toHaveBeenCalled();
  });
});

describe('final tier — a mixed result', () => {
  it('one active + one error: 502, still open, enforcement error, and the landed grant is in the ledger', async () => {
    // Breaks on: `summarizeGrants` using every() for error (status 'active' → completed),
    // or recording ledger rows only when every grant is active (0 rows).
    twoOutputProduct();
    const assignments = ledger();
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider', grantTargets: TWO_TARGETS }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any)
      .mockResolvedValueOnce({ status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-gold' })
      .mockResolvedValueOnce({ status: 'error', detail: 'ARM 403 on silver' });

    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(502);
    expect(store.doc.status).toBe('open');
    expect(store.doc.tier).toBe('access-provider');
    expect(store.doc.enforcement.status).toBe('error');
    expect(store.doc.grantResults.map((r: any) => [r.scopeRef, r.status, r.created]))
      .toEqual([['gold', 'active', true], ['silver', 'error', false]]);
    const rows = assignments.__all();
    expect(rows.map((r: any) => [r.resourceRef, r.roleAssignmentId, r.sourceRef, r.state]))
      .toEqual([['gold', 'ra-gold', 'req-1', 'active']]);
  });
});

describe('denial revokes what the request created', () => {
  const landed = [
    { scopeType: 'adls-container', scopeRef: 'gold', status: 'active', roleAssignmentId: 'ra-gold', created: true },
    { scopeType: 'kql-database', scopeRef: 'events', status: 'active', created: true },
    // An id is recorded here on purpose: without the `created` check this grant
    // WOULD be revoked by id, so the check is what keeps prior access in place.
    { scopeType: 'adls-container', scopeRef: 'held-before', status: 'active', roleAssignmentId: 'ra-held', detail: 'Role already assigned at this scope (idempotent).', created: false },
    { scopeType: 'adls-container', scopeRef: 'silver', status: 'error', created: false },
  ];

  it('revokes each created grant, leaves prior access and failed scopes alone, and marks the ledger', async () => {
    // Breaks on: a deny that revokes nothing (0 calls), one that also revokes the
    // `created: false` scope (a 'held-before' revoke), or one that skips the ledger.
    const assignments = ledger();
    for (const [ref, raId] of [['gold', 'ra-gold'], ['events', undefined]] as const) {
      await assignments.items.upsert({
        id: (await import('@/lib/access/assignment-ledger')).assignmentId(REQUESTER_OID, ref === 'gold' ? 'adls-container' : 'kql-database', ref, 'direct'),
        principalId: REQUESTER_OID, resourceRef: ref, roleAssignmentId: raId, state: 'active',
      });
    }
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider', grantResults: landed }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);

    const res = await POST(makeReq({ decision: 'denied', reason: 'not needed' }), ctx('req-1'));
    expect(res.status).toBe(200);
    expect(store.doc.status).toBe('denied');
    expect(revokeAccessGrant).toHaveBeenCalledTimes(1);
    expect(revokeAccessGrant).toHaveBeenCalledWith('ra-gold');
    expect(revokeStructuredGrant).toHaveBeenCalledTimes(1);
    expect(revokeStructuredGrant).toHaveBeenCalledWith(expect.objectContaining({
      principalId: REQUESTER_OID, scopeType: 'kql-database', scopeRef: 'events', permission: 'read',
    }));
    expect(store.doc.revokedGrants.map((r: any) => r.scopeRef)).toEqual(['gold', 'events']);
    expect(assignments.__all().map((r: any) => [r.resourceRef, r.state])).toEqual([['gold', 'revoked'], ['events', 'revoked']]);
  });

  it('a request with no landed grants revokes nothing', async () => {
    // Pairs the test above: breaks if the deny path revokes from the doc's display scope.
    const { container } = fakeArContainer(baseDoc({ tier: 'approver' }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    expect(res.status).toBe(200);
    expect(revokeAccessGrant).not.toHaveBeenCalled();
    expect(revokeStructuredGrant).not.toHaveBeenCalled();
  });
});

describe('final tier — a store item with no storage recorded yet', () => {
  it('reports pending and grants nothing, rather than a wider grant in its place', async () => {
    // A lakehouse whose container Loom has not recorded derives an empty scope.
    // Breaks on: calling the grant client with scopeRef '' (1 call), or on
    // completing the request.
    items = makePartitionedContainer({
      partitionKeyPath: '/workspaceId',
      seed: [{ id: 'asset-1', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Raw lake', state: {} }],
    });
    (itemsContainer as any).mockResolvedValue(items);
    const { container, store } = fakeArContainer(baseDoc({
      tier: 'access-provider', grantTargets: [{ scopeType: 'adls-container', scopeRef: '' }],
    }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);

    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    expect(store.doc.status).toBe('open');
    expect(store.doc.enforcement.status).toBe('pending');
    expect(j.warning).toMatch(/no adls-container recorded/);
  });
});
