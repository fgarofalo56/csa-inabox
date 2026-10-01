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
  revokeContainerRoleAssignment: vi.fn(), probeAccessGrant: vi.fn(),
}));

import { POST } from '../[id]/decision/route';
import { getSession } from '@/lib/auth/session';
import {
  accessRequestWorkflowContainer, auditLogContainer, notificationsContainer,
  accessAssignmentsContainer, approvalPoliciesContainer, featurePermissionsContainer,
  itemsContainer,
} from '@/lib/azure/cosmos-client';
import {
  enforceAccessGrant, revokeStructuredGrant, revokeContainerRoleAssignment, probeAccessGrant,
} from '@/lib/azure/rbac-client';
import { makePartitionedContainer, makeSinkContainer, type FakeContainer } from './partitioned-cosmos-fake';
import { assignmentId } from '@/lib/access/assignment-ledger';
import {
  GRANT_INTENT_KIND, GRANT_LEASE_MS, IN_FLIGHT, RECONCILED_FOUND, reconcileStaleGrantIntents,
  settleGrantIntent, writeGrantIntent,
} from '@/lib/access/grant-intents';

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
  const container = makePartitionedContainer({ partitionKeyPath: '/tenantId', seed: [doc], etags: true });
  // `store.doc` is read at assertion time: with etags on, a read returns a copy
  // and each write stores a new object, so the stored doc is looked up fresh.
  return {
    container,
    store: {
      get doc() {
        return container.__all()[0];
      },
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

/**
 * Lakehouses in the product's workspace, bound to the containers its output
 * ports name. Ports are checked against these (lib/access/verified-targets.ts);
 * without them no port verifies and nothing is granted.
 */
const BOUND_STORES = [
  { id: 'lh-gold', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Gold lake', state: { adlsContainer: 'gold' } },
  { id: 'lh-silver', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Silver lake', state: { adlsContainer: 'silver' } },
];

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

/**
 * Write grant-ledger rows for the request the way the route does — through the
 * module's own writer and settle, never a transcribed shape — as an earlier
 * attempt that granted `results` would have left them.
 */
async function seedLedger(container: FakeContainer, results: any[], attemptId = 'earlier-attempt') {
  for (const r of results) {
    const row = await writeGrantIntent(container as any, {
      tenantId: TENANT, requestId: 'req-1', attemptId, principalId: REQUESTER_OID, principalName: 'req@contoso.com',
      permission: 'read', assetName: 'Gold sales', by: 'approver@contoso.com',
    }, { scopeType: r.scopeType, scopeRef: r.scopeRef });
    if (r.status !== 'in-flight') await settleGrantIntent(container as any, row, r);
  }
}

/** The request's grant-ledger rows. */
const intents = (container: FakeContainer) => container.__all().filter((d: any) => d.kind === GRANT_INTENT_KIND);

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
  items = makePartitionedContainer({ partitionKeyPath: '/workspaceId', seed: [...BOUND_STORES, productItem()] });
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
      { scopeType: 'adls-container', scopeRef: PRODUCT_CONTAINER, source: "output port 'gold-out'", declaredRef: PRODUCT_CONTAINER },
    ]);
    expect(store.doc.status).toBe('completed');
    // The grant lease is released with the result.
    expect(store.doc.grantLeaseUntil).toBeUndefined();
    expect(store.doc.subscribedAt).toBeTruthy();
    expect(store.doc.enforcement.roleAssignmentId).toContain('roleAssignments/abc');
    // The requester is told once the decision is recorded. The positive pair
    // for the lost-race tests below, which assert no notice is sent.
    const notes = (await (notificationsContainer as any)()).__writes;
    expect(notes.map((n: any) => n.title)).toEqual(['Access granted: Gold sales']);
  });

  it('final approval grants on every bound output, one grant per scope', async () => {
    // Two outputs → two grants. Breaks on: a route that grants only targets[0]
    // (1 call, `silver` never granted).
    items = makePartitionedContainer({
      partitionKeyPath: '/workspaceId',
      seed: [...BOUND_STORES, productItem({ state: { lifecycleState: 'published', ports: { output: [
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
    seed: [...BOUND_STORES, productItem({ state: { lifecycleState: 'published', ports: { output: TWO_OUTPUTS } } })],
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
    // Both lists carry source and declaredRef, so the dialog can render them.
    expect(j.current).toEqual([
      { scopeType: 'adls-container', scopeRef: 'gold', source: "output port 'gold-out'", declaredRef: 'gold' },
      { scopeType: 'adls-container', scopeRef: 'silver', source: "output port 'silver-out'", declaredRef: 'silver' },
    ]);
    expect(j.reviewed).toEqual([{ scopeType: 'adls-container', scopeRef: 'gold', source: "output port 'gold-out'" }]);
    expect(j.changes).toEqual([{
      cause: 'scope_added', source: "output port 'silver-out'",
      current: { scopeType: 'adls-container', scopeRef: 'silver', source: "output port 'silver-out'", declaredRef: 'silver' },
    }]);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    expect(replaced).toBe(0);
    expect(store.doc.status).toBe('open');
  });

  it('a request recorded before grantTargets existed is one predates_recording change, never added/removed claims', async () => {
    // No grantTargets; the doc's scope ('stale-container') came from the request
    // body, which nothing verified, and the product now derives 'gold'. Breaks
    // on: skipping the comparison for legacy docs (a grant), or reporting the
    // pairwise diff (causes ['scope_removed', 'scope_added'] and "was added to
    // ... after this request was made", a claim nothing established).
    const { container } = fakeArContainer(baseDoc({ tier: 'access-provider', grantTargets: undefined }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('targets_changed');
    expect(j.changes).toEqual([{ cause: 'predates_recording' }]);
    expect(j.error).toBe('"Gold sales" cannot be approved as reviewed. This request predates target recording; deny it and ask the requester to re-request.');
    expect(j.suggestedDenyReason).toMatch(/^This request was made before Loom recorded which storage it covers/);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
  });

  it('B probe P1: a request recorded on main with an EMPTY scope gets the same single change', async () => {
    // Main recorded body.scopeRef, which may be ''. Breaks on the pairwise diff:
    // "no adls-container (a scope) is no longer part of..." plus a scope_added.
    const { container } = fakeArContainer(baseDoc({ tier: 'access-provider', grantTargets: undefined, scopeRef: '' }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const j = await (await POST(makeReq({ decision: 'approved' }), ctx('req-1'))).json();
    expect(j.changes).toEqual([{ cause: 'predates_recording' }]);
    expect(j.error).not.toMatch(/a scope|no adls-container|was added|no longer part/);
    expect(j.reviewed).toEqual([{ scopeType: 'adls-container', scopeRef: '' }]);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
  });

  it('a request recorded on main whose scope matches what the product derives now is granted', async () => {
    // Pairs the refusals: breaks if every legacy request were refused regardless
    // of its recorded scope (409 instead of a grant on 'gold').
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider', grantTargets: undefined, scopeRef: 'gold' }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockResolvedValue({ status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-gold', preexisting: false });
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(200);
    expect(store.doc.status).toBe('completed');
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
      .mockResolvedValueOnce({ status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-gold', preexisting: false })
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
    // The grants are in the request's grant ledger only (no `grantResults` on the
    // document). Breaks on: a deny that revokes nothing (0 calls) — as one that
    // read `doc.grantResults` would — one that also revokes the preexisting
    // scope (a 'held-before' revoke), or one that skips either ledger.
    const assignments = ledger();
    for (const [ref, raId] of [['gold', 'ra-gold'], ['events', undefined]] as const) {
      await assignments.items.upsert({
        id: (await import('@/lib/access/assignment-ledger')).assignmentId(REQUESTER_OID, ref === 'gold' ? 'adls-container' : 'kql-database', ref, 'direct'),
        principalId: REQUESTER_OID, resourceRef: ref, roleAssignmentId: raId, state: 'active',
      });
    }
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    await seedLedger(container, landed);
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (revokeStructuredGrant as any).mockResolvedValue({ status: 'revoked' });

    const res = await POST(makeReq({ decision: 'denied', reason: 'not needed' }), ctx('req-1'));
    expect(res.status).toBe(200);
    expect(store.doc.status).toBe('denied');
    expect(revokeContainerRoleAssignment).toHaveBeenCalledTimes(1);
    expect(revokeContainerRoleAssignment).toHaveBeenCalledWith('ra-gold');
    expect(revokeStructuredGrant).toHaveBeenCalledTimes(1);
    expect(revokeStructuredGrant).toHaveBeenCalledWith(expect.objectContaining({
      principalId: REQUESTER_OID, scopeType: 'kql-database', scopeRef: 'events', permission: 'read',
    }));
    expect(store.doc.revokedGrants.map((r: any) => r.scopeRef)).toEqual(['gold', 'events']);
    expect(assignments.__all().map((r: any) => [r.resourceRef, r.state])).toEqual([['gold', 'revoked'], ['events', 'revoked']]);
    expect(intents(container).map((r: any) => [r.scopeRef, r.state])).toEqual([
      ['gold', 'revoked'], ['events', 'revoked'], ['held-before', 'preexisting'], ['silver', 'failed'],
    ]);
  });

  it('a request with no landed grants revokes nothing', async () => {
    // Pairs the test above: breaks if the deny path revokes from the doc's display scope.
    const { container } = fakeArContainer(baseDoc({ tier: 'approver' }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    expect(res.status).toBe(200);
    expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
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
      tier: 'access-provider', grantTargets: [{ scopeType: 'adls-container', scopeRef: '', source: 'lakehouse item' }],
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

describe('denial, warehouse and KQL: only what the request provably created is revoked', () => {
  beforeEach(() => { ledger(); });

  /** A request at the final tier whose grant ledger holds `results`. */
  async function withLedger(results: any[]) {
    const f = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    await seedLedger(f.container, results);
    (accessRequestWorkflowContainer as any).mockResolvedValue(f.container);
    return f;
  }

  it('a KQL grant whose prior membership is unknown is kept, reported, and not revoked', async () => {
    // Breaks if an unknown `created` were treated as created: `.drop` would run and
    // could remove a role the requester held before the request.
    const { store } = await withLedger([
      { scopeType: 'kql-database', scopeRef: 'events', status: 'active', detail: 'Granted viewers on ADX database events.' },
    ]);
    const res = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(revokeStructuredGrant).not.toHaveBeenCalled();
    expect(store.doc.revokedGrants).toBeUndefined();
    expect(j.warning).toMatch(/kql-database events \(Could not determine whether the requester held this role/);
  });

  it('a KQL grant the requester already held (created: false) is left alone, silently', async () => {
    // Breaks if a pre-existing membership were revoked (1 `.drop`).
    await withLedger([{ scopeType: 'kql-database', scopeRef: 'events', status: 'active', created: false }]);
    const res = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    expect(res.status).toBe(200);
    expect(revokeStructuredGrant).not.toHaveBeenCalled();
    expect((await res.json()).warning).toBeUndefined();
  });

  it('a revoke that FAILS is reported as kept, not revoked, and its ledger row stays active', async () => {
    // Breaks if a failed revoke were recorded as done (the pre-fix `revokeStructuredGrant`
    // swallowed errors and the entry landed in `revokedGrants` with its ledger row revoked).
    const assignments = ledger();
    const { assignmentId } = await import('@/lib/access/assignment-ledger');
    await assignments.items.upsert({ id: assignmentId(REQUESTER_OID, 'warehouse', 'deploymentpool', 'direct'), principalId: REQUESTER_OID, resourceRef: 'deploymentpool', state: 'active' });
    const { container, store } = await withLedger([{ scopeType: 'warehouse', scopeRef: 'deploymentpool', status: 'active', created: true }]);
    (revokeStructuredGrant as any).mockResolvedValue({ status: 'error', detail: 'TDS down' });
    const res = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(revokeStructuredGrant).toHaveBeenCalledOnce();
    expect(store.doc.revokedGrants).toBeUndefined();
    expect(j.warning).toMatch(/Revoke failed: TDS down/);
    expect(assignments.__all()[0].state).toBe('active');
    expect(intents(container)[0].state).toBe('active');
  });

  it('an ADLS revoke is "already gone" only on an ARM 404 status, never on message text', async () => {
    // A2. gold: ARM answered 404. silver: ARM answered 403, and its message
    // quotes a scope containing "404" and "NotFound" (as armCall builds it from
    // ARM's error.message). Breaks if the classifier read the message: silver
    // would be reported revoked, its ledger row marked revoked, and no warning.
    const { container, store } = await withLedger([
      { scopeType: 'adls-container', scopeRef: 'gold', status: 'active', roleAssignmentId: 'ra-gold', created: true },
      { scopeType: 'adls-container', scopeRef: 'archive-404', status: 'active', roleAssignmentId: 'ra-archive', created: true },
    ]);
    const gone: any = Object.assign(new Error('The role assignment was not found.'), { status: 404 });
    const denied: any = Object.assign(
      new Error("The client does not have authorization over scope '/containers/archive-404' (RoleAssignmentNotFound check skipped)."),
      { status: 403 },
    );
    (revokeContainerRoleAssignment as any).mockRejectedValueOnce(gone).mockRejectedValueOnce(denied);
    const res = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    const j = await res.json();
    expect(store.doc.revokedGrants.map((r: any) => r.scopeRef)).toEqual(['gold']);
    expect(j.warning).toMatch(/adls-container archive-404 \(Revoke failed: The client does not have authorization/);
    expect(intents(container).map((r: any) => [r.scopeRef, r.state])).toEqual([['gold', 'revoked'], ['archive-404', 'active']]);
  });

  it('a grant with no revoke path is kept with that reason, not an unknown-state or failure reason', async () => {
    // Breaks if the unknown-state branch ran first (the item grant would read
    // "Could not determine…"), or if the ADLS grant with no recorded id
    // were reported as a failed revoke ("Revoke failed: No automatic revoke…").
    const { store } = await withLedger([
      { scopeType: 'item', scopeRef: 'dp-1', status: 'active', roleName: 'Viewer' },
      { scopeType: 'adls-container', scopeRef: 'gold', status: 'active', created: true },
    ]);
    const res = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.warning).toMatch(/item dp-1 \(No automatic revoke exists for item grants/);
    expect(j.warning).toMatch(/adls-container gold \(No role-assignment id was recorded for this grant/);
    expect(j.warning).not.toMatch(/Could not determine|Revoke failed/);
    expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
    expect(store.doc.revokedGrants).toBeUndefined();
    expect(store.doc.status).toBe('denied');
  });
});

describe('final tier — a store bound after the request was made', () => {
  it('bind-then-approve: the second approval grants on the now-recorded container (200)', async () => {
    // Breaks on the strict one-to-one match: the reviewed `{ adls-container, '' }`
    // never equals `{ adls-container, 'raw' }`, so every approval after binding
    // answers 409 targets_changed, the dead end the pending text pointed into.
    const lake = { id: 'asset-1', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Raw lake', state: {} as Record<string, unknown> };
    items = makePartitionedContainer({ partitionKeyPath: '/workspaceId', seed: [lake] });
    (itemsContainer as any).mockResolvedValue(items);
    const { container, store } = fakeArContainer(baseDoc({
      tier: 'access-provider', grantTargets: [{ scopeType: 'adls-container', scopeRef: '', source: 'lakehouse item' }],
    }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);

    const first = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(first.status).toBe(200);
    expect(enforceAccessGrant).not.toHaveBeenCalled();

    // Loom binds the lakehouse's storage.
    items.__all().find((d: any) => d.id === 'asset-1').state.adlsContainer = 'raw';
    (enforceAccessGrant as any).mockResolvedValue({ status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-raw', preexisting: false });

    const second = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(second.status).toBe(200);
    expect((enforceAccessGrant as any).mock.calls[0][0]).toMatchObject({ scopeType: 'adls-container', scopeRef: 'raw' });
    expect(store.doc.status).toBe('completed');
    expect(store.doc.grantTargets).toEqual([{ scopeType: 'adls-container', scopeRef: 'raw', source: 'lakehouse item' }]);
  });

  it('an empty reviewed scope is NOT satisfied by a different source', async () => {
    // Pairs the test above: breaks if an empty reviewed scope matched any
    // current scope of the same type (a product whose port now names a bound
    // container would then pass without that port having been reviewed).
    const { container } = fakeArContainer(baseDoc({
      tier: 'access-provider', grantTargets: [{ scopeType: 'adls-container', scopeRef: '', source: "output port 'other-out'" }],
    }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('targets_changed');
    expect(enforceAccessGrant).not.toHaveBeenCalled();
  });

  it('a port re-pointed at another store since the request answers 409 targets_changed and grants nothing', async () => {
    // At request time `gold-out` named 'foo', which no store in the workspace
    // held (recorded unbound, declaredRef 'foo'). The owner has since pointed
    // the same port at the bound container 'gold'. Breaks if the empty reviewed
    // scope were matched on type + source alone: the approval would grant on
    // 'gold', a store the approvers never saw named (1 grant call, status 200).
    const { container, store } = fakeArContainer(baseDoc({
      tier: 'access-provider',
      grantTargets: [{ scopeType: 'adls-container', scopeRef: '', source: "output port 'gold-out'", declaredRef: 'foo' }],
    }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('targets_changed');
    expect(j.current).toEqual([{ scopeType: 'adls-container', scopeRef: 'gold', source: "output port 'gold-out'", declaredRef: 'gold' }]);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    expect(store.doc.status).toBe('open');
  });

  it('a port still naming the store it named at request time is granted once that store is bound (200)', async () => {
    // The positive pair: declaredRef 'gold' then, 'gold' now and bound. Breaks
    // if the declaredRef compare refused every unbound-then-bound port (409).
    const { container, store } = fakeArContainer(baseDoc({
      tier: 'access-provider',
      grantTargets: [{ scopeType: 'adls-container', scopeRef: '', source: "output port 'gold-out'", declaredRef: 'gold' }],
    }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockResolvedValue({ status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-gold', preexisting: false });
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(200);
    expect(enforceAccessGrant).toHaveBeenCalledTimes(1);
    expect((enforceAccessGrant as any).mock.calls[0][0]).toMatchObject({ scopeType: 'adls-container', scopeRef: 'gold' });
    expect(store.doc.status).toBe('completed');
  });

  it('an unbound port target recorded without declaredRef (before it was recorded) is refused, not granted', async () => {
    // Disclosed behaviour: such a request cannot show which store the port
    // named, so it is not approved onto whatever the port names now. Breaks if
    // a missing declaredRef were treated as matching any current store.
    const { container } = fakeArContainer(baseDoc({
      tier: 'access-provider',
      grantTargets: [{ scopeType: 'adls-container', scopeRef: '', source: "output port 'gold-out'" }],
    }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.code).toBe('targets_changed');
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    // Named by cause: breaks if the classifier read the missing declaredRef as a
    // re-bound port (cause 'port_rebound', and the "nobody reviewed" sentence).
    expect(j.changes.map((ch: any) => ch.cause)).toEqual(['predates_recording']);
    expect(j.error).toContain("output port 'gold-out': this request predates target recording; deny it and ask the requester to re-request.");
    expect(j.error).not.toContain('nobody reviewed');
    expect(j.suggestedDenyReason).toMatch(/^This request was made before Loom recorded which storage it covers/);
    expect(j.reviewed).toEqual([{ scopeType: 'adls-container', scopeRef: '', source: "output port 'gold-out'" }]);
    expect(j.current).toEqual([{ scopeType: 'adls-container', scopeRef: 'gold', source: "output port 'gold-out'", declaredRef: 'gold' }]);
  });
});

describe('final tier — targets_changed names each change by its cause', () => {
  /** The product with its one port `gold-out` now naming `ref`. */
  function portNames(ref: string) {
    items = makePartitionedContainer({
      partitionKeyPath: '/workspaceId',
      seed: [...BOUND_STORES, productItem({ state: { lifecycleState: 'published', ports: { output: [{ name: 'gold-out', kind: 'adls', ref }] } } })],
    });
    (itemsContainer as any).mockResolvedValue(items);
  }
  async function approveWith(reviewed: any[]) {
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider', grantTargets: reviewed }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(409);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    expect(store.doc.status).toBe('open');
    return res.json();
  }

  it('port_unbound: a port bound when requested that names no bound store now', async () => {
    // Reviewed gold (bound); the port now names 'nowhere', which no store holds.
    // Breaks if the cause were derived from the current side alone ('declared_ref_changed').
    portNames('nowhere');
    const reviewed = { scopeType: 'adls-container', scopeRef: 'gold', source: "output port 'gold-out'", declaredRef: 'gold' };
    const j = await approveWith([reviewed]);
    expect(j.changes).toEqual([{
      cause: 'port_unbound', source: "output port 'gold-out'", reviewed,
      current: { scopeType: 'adls-container', scopeRef: '', source: "output port 'gold-out'", declaredRef: 'nowhere' },
    }]);
    // Names what the port points to now. Breaks on the earlier text "is bound to
    // no store now", which left the approver guessing what changed.
    expect(j.error).toContain("output port 'gold-out' was bound to adls-container 'gold' when this request was made and now names 'nowhere', which no store in the workspace holds.");
    expect(j.error).toContain('Approving it would grant access nobody reviewed.');
    expect(j.suggestedDenyReason).toMatch(/^The storage behind "Gold sales" changed after you requested access/);
  });

  it('port_rebound: a port bound when requested that is bound to a different store now', async () => {
    // Reviewed gold; the port now names silver, which is bound. Breaks if a
    // bound-to-bound change were reported as unbound or as a name change.
    portNames('silver');
    const reviewed = { scopeType: 'adls-container', scopeRef: 'gold', source: "output port 'gold-out'", declaredRef: 'gold' };
    const j = await approveWith([reviewed]);
    expect(j.changes.map((ch: any) => ch.cause)).toEqual(['port_rebound']);
    expect(j.error).toContain("output port 'gold-out' was bound to adls-container 'gold' when this request was made and is bound to adls-container 'silver' now.");
    expect(j.reviewed).toEqual([reviewed]);
    expect(j.current).toEqual([{ scopeType: 'adls-container', scopeRef: 'silver', source: "output port 'gold-out'", declaredRef: 'silver' }]);
  });

  it('declared_ref_changed: a port unbound when requested that names a different store now', async () => {
    // Reviewed: unbound, declared 'foo'. Now: still unbound, declared 'bar'.
    // Breaks if the declared names were not compared (cause 'port_rebound').
    portNames('bar');
    const reviewed = { scopeType: 'adls-container', scopeRef: '', source: "output port 'gold-out'", declaredRef: 'foo' };
    const j = await approveWith([reviewed]);
    expect(j.changes.map((ch: any) => ch.cause)).toEqual(['declared_ref_changed']);
    expect(j.error).toContain("output port 'gold-out' named adls-container 'foo' (not bound yet) when this request was made and names adls-container 'bar' (not bound yet) now.");
    expect(j.current).toEqual([{ scopeType: 'adls-container', scopeRef: '', source: "output port 'gold-out'", declaredRef: 'bar' }]);
  });
});

describe('final tier — one grant at a time per request', () => {
  it('two concurrent final approvals: exactly one grants, the other answers 409 grant_in_progress', async () => {
    // Breaks without the lease: both approvals pass the open/tier checks, both
    // call the grant client (2 calls), and the later write wins.
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (enforceAccessGrant as any).mockImplementation(async () => {
      await gate;
      return { status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-gold', preexisting: false };
    });

    const settled: Response[] = [];
    const a = POST(makeReq({ decision: 'approved' }), ctx('req-1')).then((r: Response) => { settled.push(r); return r; });
    const b = POST(makeReq({ decision: 'approved' }), ctx('req-1')).then((r: Response) => { settled.push(r); return r; });
    // One approval holds the lease and waits in the grant; the other must
    // already have been refused.
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    const refused = settled[0];
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe('grant_in_progress');
    release();
    const statuses = (await Promise.all([a, b])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(enforceAccessGrant).toHaveBeenCalledTimes(1);
    expect(store.doc.status).toBe('completed');
    expect(store.doc.grantLeaseUntil).toBeUndefined();
  });

  it('a denial while a grant lease is held is refused, and revokes nothing', async () => {
    // Breaks if the lease check applied to approvals only: the denial would
    // revoke before the in-flight grant is recorded, and then be overwritten.
    const live = new Date(Date.now() + 60_000).toISOString();
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider', grantLeaseUntil: live }));
    await seedLedger(container, [{ scopeType: 'adls-container', scopeRef: 'gold', status: 'active', roleAssignmentId: 'ra-gold', created: true }]);
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.code).toBe('grant_in_progress');
    // The hold's expiry is stated, not "another decision is granting right now".
    expect(j.holdUntil).toBe(live);
    expect(j.error).toContain(`holds this request until ${live.slice(11, 19)} UTC`);
    expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
    expect(store.doc.status).toBe('open');
  });

  it('an expired lease does not block the approval', async () => {
    // Pairs the refusal: breaks if any recorded lease blocked regardless of its
    // expiry (a crashed approval would then hold the request forever).
    const stale = new Date(Date.now() - 60_000).toISOString();
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider', grantLeaseUntil: stale }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockResolvedValue({ status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-gold', preexisting: false });
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(200);
    expect(enforceAccessGrant).toHaveBeenCalledTimes(1);
    expect(store.doc.status).toBe('completed');
    expect(store.doc.grantLeaseUntil).toBeUndefined();
  });
});

/**
 * Wrap the request container so a test can act between the route's writes to
 * the REQUEST document (`req-1`; grant-ledger rows are not counted or hooked).
 * `onReplace(fn)` runs `fn(doc, n)` before the n-th replace of the request
 * (1-based) reaches the store; `raw(patch)` writes the stored document
 * unconditionally, as another decision's write would. Raw writes do not go
 * through the hook.
 */
function instrument(container: FakeContainer) {
  const origItem = container.item.bind(container);
  let before: ((doc: any, n: number) => Promise<void> | void) | undefined;
  let n = 0;
  container.item = (id: string, pk?: string) => {
    const h = origItem(id, pk);
    if (id !== 'req-1') return h;
    return {
      ...h,
      replace: async (d: any, o?: any) => {
        n += 1;
        if (before) await before(d, n);
        return h.replace(d, o);
      },
    };
  };
  return {
    onReplace(fn: (doc: any, n: number) => Promise<void> | void) { before = fn; },
    async raw(patch: Record<string, unknown>) {
      const h = origItem('req-1', TENANT);
      const { resource } = await h.read();
      await h.replace({ ...resource, ...patch });
    },
  };
}

const GOLD_LEDGER_ID = assignmentId(REQUESTER_OID, 'adls-container', 'gold', 'direct');
const activeGold = { status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-gold', preexisting: false };

describe('decisions that lose the request while granting or revoking', () => {
  let notes: ReturnType<typeof makeSinkContainer>;
  beforeEach(() => {
    notes = makeSinkContainer();
    (notificationsContainer as any).mockResolvedValue(notes);
  });

  it('a grant that outlasts its lease: a denial after +130 s wins, and the approval removes the grant it made', async () => {
    // The measured scenario: the approval's grant is held open past the 120 s
    // lease, a denial is recorded, then the grant completes. Breaks without
    // compensation (the approval answers 409 and leaves 'ra-gold' live: 0
    // revoke calls, ledger row 'active'), and without the conditioned write
    // (the approval would overwrite the denial: status 'completed').
    const assignments = ledger();
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (enforceAccessGrant as any).mockImplementation(async () => { await gate; return activeGold; });
    (revokeContainerRoleAssignment as any).mockResolvedValue(undefined);

    const approval = POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    await vi.waitFor(() => expect(enforceAccessGrant).toHaveBeenCalledTimes(1));

    // Control: while the lease is live, the denial is refused.
    const early = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    expect(early.status).toBe(409);
    expect((await early.json()).code).toBe('grant_in_progress');

    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 130_000);
    try {
      const denial = await POST(makeReq({ decision: 'denied', reason: 'not needed' }), ctx('req-1'));
      expect(denial.status).toBe(200);
      expect(store.doc.status).toBe('denied');
      // The approval's grant is still in flight: its ledger row is `pending` and
      // the store cannot say yet (the probe answers nothing), so the denial
      // keeps it and says so, rather than revoking blind or saying nothing.
      expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
      expect((await denial.json()).warning).toContain(`adls-container gold (${IN_FLIGHT})`);
      expect(intents(container).map((r: any) => r.state)).toEqual(['pending']);

      release();
      const res = await approval;
      const j = await res.json();
      expect(res.status).toBe(409);
      expect(j.code).toBe('request_changed');
      expect(j.requestStatus).toBe('denied');
      expect(j.revoked).toEqual([expect.objectContaining({
        scopeType: 'adls-container', scopeRef: 'gold', ledgerId: GOLD_LEDGER_ID, roleAssignmentId: 'ra-gold', recorded: true,
      })]);
      expect(j.kept).toEqual([]);
    } finally {
      clock.mockRestore();
    }
    expect(revokeContainerRoleAssignment).toHaveBeenCalledTimes(1);
    expect(revokeContainerRoleAssignment).toHaveBeenCalledWith('ra-gold');
    expect(store.doc.status).toBe('denied');
    expect(store.doc.denialReason).toBe('not needed');
    expect(store.doc.accessProviderApproval.decision).toBe('denied');
    expect(assignments.__all().map((r: any) => [r.id, r.resourceRef, r.state])).toEqual([[GOLD_LEDGER_ID, 'gold', 'revoked']]);
    expect(intents(container).map((r: any) => [r.scopeRef, r.state, r.roleAssignmentId])).toEqual([['gold', 'revoked', 'ra-gold']]);
    expect(notes.__writes).toEqual([]);
  });

  it('a denial racing an approval: the approval leases first, so the denial is refused and revokes nothing', async () => {
    // The approval's lease lands between the denial's read and its first write.
    // Breaks without the denial's lease: it revokes 'ra-gold' first and only
    // then finds the request changed (1 revoke call, code 'request_changed').
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    await seedLedger(container, [{ scopeType: 'adls-container', scopeRef: 'gold', status: 'active', roleAssignmentId: 'ra-gold', created: true }]);
    const io = instrument(container);
    io.onReplace(async (_d, n) => {
      if (n === 1) await io.raw({ grantLeaseUntil: new Date(Date.now() + 60_000).toISOString() });
    });
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('grant_in_progress');
    expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
    expect(store.doc.status).toBe('open');
  });

  it('a renewal that finds the request changed stops the approval before its next scope, and removes the grant it made', async () => {
    // Two scopes; another decision records a denial while the first is granted.
    // Breaks without the renewal between scopes: the second scope is granted too
    // (2 grant calls) before the final write notices.
    twoOutputProduct();
    const assignments = ledger();
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider', grantTargets: TWO_TARGETS }));
    const io = instrument(container);
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any)
      .mockImplementationOnce(async () => { await io.raw({ status: 'denied', denialReason: 'other approver' }); return activeGold; })
      .mockResolvedValueOnce({ ...activeGold, roleAssignmentId: 'ra-silver' });

    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('request_changed');
    expect(enforceAccessGrant).toHaveBeenCalledTimes(1);
    expect(j.revoked.map((r: any) => [r.scopeRef, r.ledgerId])).toEqual([['gold', GOLD_LEDGER_ID]]);
    expect(j.error).toContain('The access it had granted was removed: adls-container gold.');
    expect(revokeContainerRoleAssignment).toHaveBeenCalledWith('ra-gold');
    expect(store.doc.status).toBe('denied');
    expect(store.doc.denialReason).toBe('other approver');
    expect(assignments.__all().map((r: any) => [r.resourceRef, r.state])).toEqual([['gold', 'revoked']]);
    expect(notes.__writes).toEqual([]);
  });

  it('a renewal that errors answers 503 grant_interrupted, removes the grant it made, and releases its hold', async () => {
    // Breaks if a thrown renewal were treated as success (200, grant kept) or
    // reported as another decision's change (409 request_changed); if the
    // service's own message were quoted ('ServiceUnavailable' in the error);
    // or if the hold were left in place (grantLeaseUntil still set, so the
    // next decision is refused for two minutes).
    ledger();
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    const io = instrument(container);
    io.onReplace((_d, n) => {
      if (n === 2) throw Object.assign(new Error('Cosmos 503 ServiceUnavailable: internal-host-7'), { code: 503 });
    });
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockResolvedValue(activeGold);
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(503);
    expect(j.code).toBe('grant_interrupted');
    expect(j.error).toContain('This approval stopped and was not recorded: its hold on the request could not be renewed (the request store answered 503, unavailable).');
    expect(j.error).not.toMatch(/ServiceUnavailable|internal-host/);
    expect(j.error).not.toContain('could not be released');
    expect(revokeContainerRoleAssignment).toHaveBeenCalledWith('ra-gold');
    expect(store.doc.status).toBe('open');
    expect(store.doc.grantLeaseUntil).toBeUndefined();
    expect(notes.__writes).toEqual([]);

    // B3: the retry is not refused for the stopped decision's hold.
    (revokeContainerRoleAssignment as any).mockClear();
    io.onReplace(() => undefined);
    const retry = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(retry.status).toBe(200);
    expect(store.doc.status).toBe('completed');
  });

  it('a stopped decision whose hold cannot be released says when the hold expires', async () => {
    // Breaks if a failed release were silent (the next decision is refused with
    // no explanation) or claimed another decision is granting.
    ledger();
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    const io = instrument(container);
    io.onReplace((_d, n) => {
      if (n >= 2) throw Object.assign(new Error('down'), { code: 503 });
    });
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockResolvedValue(activeGold);
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(503);
    const held = store.doc.grantLeaseUntil;
    expect(typeof held).toBe('string');
    expect(j.error).toContain(`Its hold on the request could not be released and expires at ${held.slice(11, 19)} UTC; the request can be decided again after that.`);
  });

  it('the final write is conditioned: a change between the last renewal and the write is kept, and the grant is removed', async () => {
    // Another writer records a denial just before the approval's final write.
    // Breaks if the final write were unconditioned: it overwrites the other
    // writer (status 'completed', marker gone, 200) and sends "Access granted".
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    const io = instrument(container);
    io.onReplace(async (d) => {
      if (d.status === 'completed' && !('grantLeaseUntil' in d)) {
        await io.raw({ status: 'denied', denialReason: 'other writer', otherWriter: 'marker-7' });
      }
    });
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockResolvedValue(activeGold);
    ledger();
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('request_changed');
    expect(store.doc.otherWriter).toBe('marker-7');
    expect(store.doc.status).toBe('denied');
    expect(store.doc.denialReason).toBe('other writer');
    expect(revokeContainerRoleAssignment).toHaveBeenCalledWith('ra-gold');
    expect(notes.__writes).toEqual([]);
  });

  it('a revoke that fails in compensation is kept, and named as recorded only when its ledger row was written', async () => {
    // Breaks if the "recorded in the Access report" text were unconditional:
    // with the ledger upsert failing the row is not there to review.
    const { container } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    const io = instrument(container);
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockImplementation(async () => { await io.raw({ status: 'denied' }); return activeGold; });
    (revokeContainerRoleAssignment as any).mockRejectedValue(new Error('ARM 403 AuthorizationFailed'));

    ledger();
    const recorded = await (await POST(makeReq({ decision: 'approved' }), ctx('req-1'))).json();
    expect(recorded.kept.map((r: any) => [r.scopeRef, r.recorded])).toEqual([['gold', true]]);
    expect(recorded.error).toContain('They are recorded in the Access report; review them there.');

    const { container: c2 } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    const io2 = instrument(c2);
    (accessRequestWorkflowContainer as any).mockResolvedValue(c2);
    (enforceAccessGrant as any).mockImplementation(async () => { await io2.raw({ status: 'denied' }); return activeGold; });
    const broken = ledger();
    broken.items.upsert = async () => { throw new Error('ledger down'); };
    const unrecorded = await (await POST(makeReq({ decision: 'approved' }), ctx('req-1'))).json();
    expect(unrecorded.kept.map((r: any) => [r.scopeRef, r.recorded])).toEqual([['gold', false]]);
    expect(unrecorded.error).not.toContain('recorded in the Access report');
    expect(unrecorded.error).toContain('Review them in the Access report.');
  });

  it('a denial that loses its final write lists what it revoked', async () => {
    // Breaks if the lost denial answered the bare request_changed body (no
    // `revoked`), leaving the approver unaware 'ra-gold' was removed.
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    await seedLedger(container, [{ scopeType: 'adls-container', scopeRef: 'gold', status: 'active', roleAssignmentId: 'ra-gold', created: true }]);
    const io = instrument(container);
    io.onReplace(async (d) => { if (d.status === 'denied') await io.raw({ otherWriter: 'marker-9' }); });
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('request_changed');
    expect(j.revoked.map((r: any) => [r.scopeRef, r.ledgerId])).toEqual([['gold', GOLD_LEDGER_ID]]);
    expect(j.error).toContain('the denial was not recorded. It had removed: adls-container gold.');
    expect(revokeContainerRoleAssignment).toHaveBeenCalledWith('ra-gold');
    expect(store.doc.otherWriter).toBe('marker-9');
    expect(store.doc.status).toBe('open');
  });

  it('a denial whose renewal fails stops before its next revoke, and lists both what it removed and what it did not attempt', async () => {
    // Breaks without the renewal between revokes: 'ra-silver' is revoked too
    // (2 revoke calls) under a hold the denial no longer has.
    const { container } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    await seedLedger(container, [
      { scopeType: 'adls-container', scopeRef: 'gold', status: 'active', roleAssignmentId: 'ra-gold', created: true },
      { scopeType: 'adls-container', scopeRef: 'silver', status: 'active', roleAssignmentId: 'ra-silver', created: true },
    ]);
    const io = instrument(container);
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (revokeContainerRoleAssignment as any).mockImplementation(async () => { await io.raw({ otherWriter: 'marker-11' }); });
    const res = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('request_changed');
    expect(revokeContainerRoleAssignment).toHaveBeenCalledTimes(1);
    expect(revokeContainerRoleAssignment).toHaveBeenCalledWith('ra-gold');
    expect(j.revoked.map((r: any) => r.scopeRef)).toEqual(['gold']);
    expect(j.kept.map((r: any) => [r.scopeRef, r.detail])).toEqual([['silver', 'Not attempted: the denial stopped before this revoke.']]);
    expect(j.error).toContain('Not attempted, still in place: adls-container silver.');
  });
});

describe('the grant ledger: written before each grant, and what compensation and denial revoke from', () => {
  let notes: ReturnType<typeof makeSinkContainer>;
  beforeEach(() => {
    notes = makeSinkContainer();
    (notificationsContainer as any).mockResolvedValue(notes);
  });

  it('the ledger row exists, pending, BEFORE the grant call, and is settled active with the assignment after it', async () => {
    // Breaks if the row were written after the grant (0 rows seen inside the
    // call) or not at all, and if the settle did not record the outcome
    // (state still 'pending', no role-assignment id).
    const { container } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const seenAtGrant: any[][] = [];
    (enforceAccessGrant as any).mockImplementation(async () => {
      seenAtGrant.push(intents(container).map((r: any) => [r.scopeRef, r.state, r.requestId, r.principalId]));
      return activeGold;
    });
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(200);
    expect(seenAtGrant).toEqual([[['gold', 'pending', 'req-1', REQUESTER_OID]]]);
    expect(intents(container).map((r: any) => [r.scopeRef, r.state, r.created, r.roleAssignmentId]))
      .toEqual([['gold', 'active', true, 'ra-gold']]);
  });

  it('a grant the requester already held settles preexisting, a failed one settles failed, and a denial revokes neither', async () => {
    // Breaks if the settle ignored `created` (gold recorded active/created, so
    // the denial revokes 'ra-gold-old', access the requester held before), or
    // if a failed grant settled as landed.
    twoOutputProduct();
    const { container } = fakeArContainer(baseDoc({ tier: 'access-provider', grantTargets: TWO_TARGETS }));
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any)
      .mockResolvedValueOnce({ status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-gold-old', preexisting: true })
      .mockResolvedValueOnce({ status: 'error', detail: 'ARM 403 on silver' });
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(502);
    expect(intents(container).map((r: any) => [r.scopeRef, r.state, r.created]))
      .toEqual([['gold', 'preexisting', false], ['silver', 'failed', false]]);

    const denial = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    const j = await denial.json();
    expect(denial.status).toBe(200);
    expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
    expect(j.warning).toBeUndefined();
  });

  it("A's probe (B's P4): a final write that errors answers 503, removes the grant and releases the hold", async () => {
    // Breaks if a non-412 failure of the final write were rethrown (500, the
    // grant 'ra-gold' left live and recorded nowhere but the ledger row).
    ledger();
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    const io = instrument(container);
    io.onReplace((d) => {
      if (d.status === 'completed' && !('grantLeaseUntil' in d)) {
        throw Object.assign(new Error('Cosmos 503 ServiceUnavailable: internal-host-3'), { code: 503 });
      }
    });
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockResolvedValue(activeGold);
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(503);
    expect(j.code).toBe('grant_interrupted');
    expect(j.error).toContain('This approval stopped and was not recorded: its result could not be written (the request store answered 503, unavailable).');
    expect(j.error).not.toMatch(/ServiceUnavailable|internal-host/);
    expect(revokeContainerRoleAssignment).toHaveBeenCalledWith('ra-gold');
    expect(store.doc.status).toBe('open');
    expect(store.doc.grantLeaseUntil).toBeUndefined();
    expect(intents(container).map((r: any) => [r.scopeRef, r.state])).toEqual([['gold', 'revoked']]);
    expect(notes.__writes).toEqual([]);
  });

  it('a grant kept by a failed compensation is revoked by a later denial, read from the ledger, not the request', async () => {
    // The final write fails and the compensating revoke fails too, so 'ra-gold'
    // stays live and the request document never recorded it (no grantResults).
    // Breaks if the denial revoked from the request document: 0 revoke calls.
    ledger();
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    const io = instrument(container);
    io.onReplace((d) => {
      if (d.status === 'completed' && !('grantLeaseUntil' in d)) throw Object.assign(new Error('down'), { code: 503 });
    });
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockResolvedValue(activeGold);
    (revokeContainerRoleAssignment as any).mockRejectedValueOnce(Object.assign(new Error('ARM 500'), { status: 500 }));
    const first = await (await POST(makeReq({ decision: 'approved' }), ctx('req-1'))).json();
    expect(first.code).toBe('grant_interrupted');
    expect(first.kept.map((r: any) => r.scopeRef)).toEqual(['gold']);
    expect(store.doc.grantResults).toBeUndefined();
    expect(store.doc.enforcement).toBeUndefined();

    io.onReplace(() => undefined);
    (revokeContainerRoleAssignment as any).mockResolvedValue(undefined);
    const denial = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    const j = await denial.json();
    expect(denial.status).toBe(200);
    expect(revokeContainerRoleAssignment).toHaveBeenCalledTimes(2);
    expect(revokeContainerRoleAssignment).toHaveBeenLastCalledWith('ra-gold');
    expect(j.request.revokedGrants.map((r: any) => r.scopeRef)).toEqual(['gold']);
    expect(intents(container).map((r: any) => r.state)).toEqual(['revoked']);
  });

  it('R2/A6: an approval that finds the request completed by another approval revokes nothing', async () => {
    // Breaks if the completed branch were removed: the request is closed, so no
    // hold counts as another decision's, and the approval revokes 'ra-gold'
    // that the completing approval granted and recorded.
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    const io = instrument(container);
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockImplementation(async () => {
      await io.raw({ status: 'completed', grantLeaseUntil: undefined, completedBy: 'other-approval' });
      return activeGold;
    });
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('request_changed');
    expect(j.requestStatus).toBe('completed');
    expect(j.kept.map((r: any) => [r.scopeRef, r.detail])).toEqual([['gold', 'Left in place: another approval completed this request.']]);
    expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
    expect(store.doc.completedBy).toBe('other-approval');
  });

  it('A3: an approval that finds another decision holding the request revokes nothing and leaves that hold', async () => {
    // Breaks if heldByOther were removed: the approval revokes 'ra-gold' under
    // the other decision's hold, and releases nothing of its own.
    const { container, store } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    const io = instrument(container);
    const theirs = new Date(Date.now() + 60_000).toISOString();
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (enforceAccessGrant as any).mockImplementation(async () => {
      await io.raw({ grantLeaseUntil: theirs });
      return activeGold;
    });
    ledger();
    const res = await POST(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.requestStatus).toBe('open');
    expect(j.kept.map((r: any) => [r.scopeRef, r.detail]))
      .toEqual([['gold', 'Left in place: another decision holds the request now, and removes or keeps this grant.']]);
    expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
    expect(store.doc.grantLeaseUntil).toBe(theirs);
  });
});

describe('the grant ledger: stale pending rows are resolved from the store', () => {
  const GOLD_ROW = { scopeType: 'adls-container', scopeRef: 'gold', status: 'in-flight' };

  /** A pending row written `ageMs` ago, as a decision that then stopped would leave it. */
  async function seedStale(container: FakeContainer, rows: any[], ageMs = GRANT_LEASE_MS + 80_000) {
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - ageMs);
    try {
      await seedLedger(container, rows, 'stopped-attempt');
    } finally {
      clock.mockRestore();
    }
  }

  it('a denial finds a stale pending grant IN PLACE: marked found, recorded, kept and reported, not revoked', async () => {
    // Breaks if the reconcile were a no-op (row stays 'pending', warning names
    // IN_FLIGHT, no entitlement row), or if a found grant of unknown origin were
    // revoked (1 revoke call).
    const assignments = ledger();
    const { container } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    await seedStale(container, [GOLD_ROW]);
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (probeAccessGrant as any).mockResolvedValue({ held: true, roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-gold' });
    const res = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(probeAccessGrant).toHaveBeenCalledWith(expect.objectContaining({
      principalId: REQUESTER_OID, scopeType: 'adls-container', scopeRef: 'gold', permission: 'read',
    }));
    expect(intents(container).map((r: any) => [r.state, r.detail, r.roleAssignmentId]))
      .toEqual([['active', RECONCILED_FOUND, 'ra-gold']]);
    expect(assignments.__all().map((r: any) => [r.resourceRef, r.roleAssignmentId, r.sourceRef, r.state]))
      .toEqual([['gold', 'ra-gold', 'req-1', 'active']]);
    expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
    expect(j.warning).toContain('adls-container gold (Could not determine whether the requester held this role before the request');
    expect(j.warning).not.toContain(IN_FLIGHT);
  });

  it('a denial finds a stale pending grant NOT in place: marked absent, nothing kept or revoked', async () => {
    // Breaks if the reconcile were a no-op: the row stays 'pending' and the
    // denial warns that the grant is in flight.
    const { container } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    await seedStale(container, [GOLD_ROW]);
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (probeAccessGrant as any).mockResolvedValue({ held: false });
    const res = await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(intents(container).map((r: any) => r.state)).toEqual(['absent']);
    expect(j.warning).toBeUndefined();
    expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
  });

  it('a pending row inside the lease is not probed: its decision may still be granting', async () => {
    // Pairs the two above. Breaks if the age check were dropped: the probe runs
    // (1 call) and the row is marked absent while its grant may still land.
    const { container } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    await seedStale(container, [GOLD_ROW], 10_000);
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    (probeAccessGrant as any).mockResolvedValue({ held: false });
    const j = await (await POST(makeReq({ decision: 'denied', reason: 'no' }), ctx('req-1'))).json();
    expect(probeAccessGrant).not.toHaveBeenCalled();
    expect(intents(container).map((r: any) => r.state)).toEqual(['pending']);
    expect(j.warning).toContain(`adls-container gold (${IN_FLIGHT})`);
  });

  it('the scheduled sweep resolves every stale pending row and counts each outcome', async () => {
    // Distinct non-zero counts, so a sweep that mis-routed one outcome, skipped
    // the age check (checked 4, the fresh row probed) or never probed (all
    // unknown) is caught.
    const assignments = ledger();
    const { container } = fakeArContainer(baseDoc({ tier: 'access-provider' }));
    const rows = ['gold', 'silver', 'bronze', 'tin', 'lead'].map((ref) => ({ scopeType: 'adls-container', scopeRef: ref, status: 'in-flight' }));
    await seedStale(container, rows);
    await seedStale(container, [{ scopeType: 'adls-container', scopeRef: 'fresh', status: 'in-flight' }], 5_000);
    (accessRequestWorkflowContainer as any).mockResolvedValue(container);
    const answer: Record<string, any> = {
      gold: { held: true, roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-gold' },
      silver: { held: false },
      bronze: { held: false },
      tin: { unknown: 'the store could not be read' },
      lead: { unknown: 'the store could not be read' },
    };
    (probeAccessGrant as any).mockImplementation(async (i: any) => {
      if (i.scopeRef === 'fresh') throw new Error('a row inside the lease was probed');
      return answer[i.scopeRef];
    });
    const tally = await reconcileStaleGrantIntents({ tenantId: TENANT });
    expect(tally).toEqual({ checked: 5, absent: 2, found: 1, unknown: 2 });
    expect(assignments.__all().map((r: any) => r.resourceRef)).toEqual(['gold']);
    expect(intents(container).map((r: any) => [r.scopeRef, r.state])).toEqual([
      ['gold', 'active'], ['silver', 'absent'], ['bronze', 'absent'], ['tin', 'pending'], ['lead', 'pending'], ['fresh', 'pending'],
    ]);
  });
});
