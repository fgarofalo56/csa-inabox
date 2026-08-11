/**
 * Contract tests for POST /api/access-requests/[id]/decision — the F16
 * multi-tier approval state machine.
 *
 *   - 401 unauthenticated
 *   - 400 on a missing/invalid decision; 400 when denying without a reason
 *   - manager approval advances tier → privacy (status stays open)
 *   - privacy → approver → access-provider on successive approvals
 *   - final (access-provider) approval calls enforceAccessGrant and, on an
 *     active grant, completes the request + sets subscribedAt + records the
 *     real ARM role-assignment id
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
}));
vi.mock('@/lib/azure/rbac-client', () => ({ enforceAccessGrant: vi.fn() }));

import { POST } from '../[id]/decision/route';
import { getSession } from '@/lib/auth/session';
import {
  accessRequestWorkflowContainer, auditLogContainer, notificationsContainer,
  accessAssignmentsContainer, approvalPoliciesContainer, featurePermissionsContainer,
} from '@/lib/azure/cosmos-client';
import { enforceAccessGrant } from '@/lib/azure/rbac-client';
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

function baseDoc(overrides: Partial<any> = {}) {
  return {
    id: 'req-1',
    tenantId: TENANT,
    kind: 'access-request',
    assetId: 'asset-1',
    assetName: 'Gold sales',
    itemType: 'lakehouse',
    scopeType: 'adls-container',
    scopeRef: 'gold',
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

    const res = await POST(makeReq({ decision: 'approved', scopeRef: 'gold' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    // enforceAccessGrant was called with the requester as principal.
    expect(enforceAccessGrant).toHaveBeenCalledWith(expect.objectContaining({
      principalId: 'requester-oid', scopeType: 'adls-container', scopeRef: 'gold', permission: 'read',
    }));
    expect(store.doc.status).toBe('completed');
    expect(store.doc.subscribedAt).toBeTruthy();
    expect(store.doc.enforcement.roleAssignmentId).toContain('roleAssignments/abc');
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
