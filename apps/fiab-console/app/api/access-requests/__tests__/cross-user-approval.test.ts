/**
 * F16 CROSS-USER APPROVAL — the discriminating case.
 *
 * The F16 access-request workflow only means anything if user A can request
 * access and a DIFFERENT user B can approve it. Every test that existed before
 * this file used ONE identity for both roles, so the suite could not tell the
 * two apart.
 *
 * These tests drive the REAL routes end to end against a partition-honest Cosmos
 * fake (see ./partitioned-cosmos-fake):
 *
 *   1. user A POSTs /api/catalog/request-access          (the real writer)
 *   2. approver B GETs /api/access-requests              (the real inbox)
 *   3. approver B POSTs /api/access-requests/[id]/decision (the real decision)
 *
 * Before the tenantScopeId() adoption, steps 2 and 3 were dead: the writer
 * stamped `tenantId` with the REQUESTER's oid while both readers keyed on the
 * SIGNED-IN user's oid, so B's inbox returned zero rows and B's decision point
 * read missed the partition and 404'd before any approver logic ran.
 *
 * They also pin the authorization boundary that the partition widening opens up:
 * a tenant-wide inbox must NOT mean a tenant-wide right to approve.
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
vi.mock('@/lib/azure/access-policy-client', () => ({ enforceAccessGrant: vi.fn() }));

import { POST as requestAccessPOST } from '@/app/api/catalog/request-access/route';
import { GET as inboxGET } from '../route';
import { POST as decisionPOST } from '../[id]/decision/route';
import { getSession } from '@/lib/auth/session';
import {
  accessRequestWorkflowContainer, auditLogContainer, notificationsContainer,
  accessAssignmentsContainer, approvalPoliciesContainer, featurePermissionsContainer,
} from '@/lib/azure/cosmos-client';
import { enforceAccessGrant } from '@/lib/azure/rbac-client';
import { makePartitionedContainer, makeSinkContainer, type FakeContainer } from './partitioned-cosmos-fake';

const TENANT = 'tenant-1-tid';
const USER_A = { oid: 'user-a-oid', tid: TENANT, upn: 'alice@contoso.com' };   // requester
const USER_B = { oid: 'user-b-oid', tid: TENANT, upn: 'bob@contoso.com' };     // approver
const USER_C = { oid: 'user-c-oid', tid: TENANT, upn: 'carol@contoso.com' };   // bystander

let wf: FakeContainer;
let policies: FakeContainer;
let grants: FakeContainer;

function signIn(claims: Record<string, any>) {
  (getSession as any).mockReturnValue({ claims, exp: Date.now() / 1000 + 3600 });
}

function jsonReq(body: any) {
  return { json: async () => body } as any;
}
function inboxReq(qs: string) {
  return { nextUrl: new URL(`http://console.local/api/access-requests${qs}`) } as any;
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** user A files a real access request through the real writer route. */
async function fileRequestAsA(): Promise<string> {
  signIn(USER_A);
  const res = await requestAccessPOST(
    jsonReq({
      assetId: 'asset-1',
      assetName: 'Gold sales',
      itemType: 'lakehouse',
      permission: 'read',
      justification: 'quarterly report',
      scopeType: 'adls-container',
      scopeRef: 'gold',
    }) as any,
  );
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.ok).toBe(true);
  expect(j.requestId).toBeTruthy();
  return j.requestId as string;
}

const ORIGINAL_ADMIN_OID = process.env.LOOM_TENANT_ADMIN_OID;

beforeEach(() => {
  vi.resetAllMocks();
  wf = makePartitionedContainer({ partitionKeyPath: '/tenantId' });
  // Empty but REACHABLE: no approval policy names anyone, and no capability
  // grant exists. So authority comes only from tenant-admin, which is what the
  // bystander tests rely on. A container that THREW would take the
  // "indeterminate" branch instead and prove nothing about the deny path.
  policies = makePartitionedContainer({ partitionKeyPath: '/tenantId' });
  grants = makePartitionedContainer({ partitionKeyPath: '/tenantId' });
  (accessRequestWorkflowContainer as any).mockResolvedValue(wf);
  (approvalPoliciesContainer as any).mockResolvedValue(policies);
  (featurePermissionsContainer as any).mockResolvedValue(grants);
  (auditLogContainer as any).mockResolvedValue(makeSinkContainer());
  (notificationsContainer as any).mockResolvedValue(makeSinkContainer());
  (accessAssignmentsContainer as any).mockResolvedValue(makeSinkContainer());
  // B is the tenant admin — the out-of-the-box approval authority. (Delegation
  // to a non-admin is covered by the capability path; see the bystander test.)
  process.env.LOOM_TENANT_ADMIN_OID = USER_B.oid;
});

afterEach(() => {
  if (ORIGINAL_ADMIN_OID === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = ORIGINAL_ADMIN_OID;
});

describe('F16 cross-user approval', () => {
  it("approver B's inbox contains the request user A filed", async () => {
    await fileRequestAsA();
    // Sanity: the write really happened, and it is in the tenant partition.
    expect(wf.__all()).toHaveLength(1);
    expect(wf.__partition(TENANT)).toHaveLength(1);

    signIn(USER_B);
    const res = await inboxGET(inboxReq('?tier=manager&status=open'));
    const j = await res.json();

    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    // THE ASSERTION THE DEFECT BREAKS: B sees A's request.
    expect(j.requests).toHaveLength(1);
    expect(j.requests[0].requesterUpn).toBe(USER_A.upn);
    expect(j.requests[0].tier).toBe('manager');
  });

  it('approver B can action a request user A filed (no 404)', async () => {
    const id = await fileRequestAsA();

    signIn(USER_B);
    const res = await decisionPOST(jsonReq({ decision: 'approved' }), ctx(id));
    const j = await res.json();

    // THE ASSERTION THE DEFECT BREAKS: the point read finds A's doc in B's
    // session, so the workflow advances instead of 404-ing.
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.request.tier).toBe('privacy');
    expect(j.request.status).toBe('open');
    expect(j.request.managerApproval.byOid).toBe(USER_B.oid);
  });

  it('the full manager -> privacy -> approver -> access-provider chain runs cross-user', async () => {
    const id = await fileRequestAsA();
    (enforceAccessGrant as any).mockResolvedValue({
      status: 'active',
      roleName: 'Storage Blob Data Reader',
      roleAssignmentId: '/subscriptions/REDACTED/roleAssignments/abc',
    });

    signIn(USER_B);
    for (const expected of ['privacy', 'approver', 'access-provider']) {
      const r = await decisionPOST(jsonReq({ decision: 'approved' }), ctx(id));
      expect(r.status).toBe(200);
      const jj = await r.json();
      expect(jj.request.tier).toBe(expected);
    }
    const final = await decisionPOST(jsonReq({ decision: 'approved' }), ctx(id));
    const fj = await final.json();
    expect(final.status).toBe(200);
    expect(fj.request.status).toBe('completed');
    // The grant is provisioned for the REQUESTER, not the approver.
    expect(enforceAccessGrant).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: USER_A.oid }),
    );
  });
});

describe('F16 approval authority (the boundary the widening opens)', () => {
  it('a tenant-wide inbox is NOT a tenant-wide right to approve: bystander C is refused', async () => {
    const id = await fileRequestAsA();

    signIn(USER_C); // not the admin, holds no capability grant, named by no policy
    const res = await decisionPOST(jsonReq({ decision: 'approved' }), ctx(id));
    const j = await res.json();

    expect(res.status).toBe(403);
    expect(j.ok).toBe(false);
    // The request is untouched — no tier advance, no approval step recorded.
    const stored = wf.__all()[0];
    expect(stored.tier).toBe('manager');
    expect(stored.status).toBe('open');
    expect(stored.managerApproval).toBeUndefined();
  });

  it('bystander C cannot read the tenant inbox either', async () => {
    await fileRequestAsA();
    signIn(USER_C);
    const res = await inboxGET(inboxReq('?tier=manager&status=open'));
    const j = await res.json();
    expect(res.status).toBe(403);
    expect(j.ok).toBe(false);
    // Honest, not silent: it says WHY and how to get access (R6/R7).
    expect(String(j.remediation || j.reason || '')).toMatch(/permission|approver|admin/i);
  });

  it('a requester may not approve their OWN request (separation of duties)', async () => {
    const id = await fileRequestAsA();

    // A is made tenant admin so the ONLY thing under test is the self-approval
    // block, not a missing authority.
    process.env.LOOM_TENANT_ADMIN_OID = USER_A.oid;
    signIn(USER_A);
    const res = await decisionPOST(jsonReq({ decision: 'approved' }), ctx(id));
    const j = await res.json();

    expect(res.status).toBe(403);
    expect(String(j.error || j.reason || '')).toMatch(/own request|self/i);
    const stored = wf.__all()[0];
    expect(stored.tier).toBe('manager');
    expect(stored.managerApproval).toBeUndefined();
  });
});
