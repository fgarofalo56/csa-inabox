/**
 * /api/onelake/lifecycle — tenant-admin gate on PUT (#4619) and workspace
 * resolution through the canonical `resolveAdminWorkspace` ladder.
 *
 * The PUT replaces a storage account's whole management policy, so it is
 * tenant-admin. The workspace (whose bound account is targeted) resolves for
 * its creator exactly as before, and for a tenant admin through the shared
 * tenant-boundary resolver; a non-admin non-owner is a 404 with no ARM call.
 * Each load-bearing assertion names the input that breaks it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

const readMock = vi.fn();
vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: vi.fn(async () => ({ item: () => ({ read: readMock }) })),
}));
vi.mock('@/lib/auth/workspace-access', () => ({ resolveWorkspaceAccessByOid: vi.fn() }));
vi.mock('@/lib/azure/adls-client', () => ({
  getLifecyclePolicy: vi.fn(),
  setLifecyclePolicy: vi.fn(),
  LifecyclePolicyError: class LifecyclePolicyError extends Error { code = 'forbidden'; },
  STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID: '17d1049b-9a84-46fb-8f53-869881c3d3ab',
}));

import { GET, PUT } from '../lifecycle/route';
import { getSession } from '@/lib/auth/session';
import { resolveWorkspaceAccessByOid } from '@/lib/auth/workspace-access';
import { getLifecyclePolicy, setLifecyclePolicy } from '@/lib/azure/adls-client';

const user = { claims: { upn: 'u@x', tid: 't1', oid: 'user-oid' } };
const admin = { claims: { upn: 'a@x', tid: 't1', oid: 'admin-oid' } };

const ACCOUNT_ARM_ID = '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Storage/storageAccounts/acctws';

const RULE = {
  name: 'cool-after-30',
  enabled: true,
  conditionField: 'daysAfterModificationGreaterThan',
  conditionDays: 30,
  actions: ['tierToCool'],
};

function putReq(body: unknown) {
  return { json: async () => body, nextUrl: new URL('http://x/api/onelake/lifecycle') } as any;
}
const getReq = () => ({ nextUrl: new URL('http://x/api/onelake/lifecycle?workspaceId=ws-1') }) as any;

/** The caller created ws-1: the owner point read on its partition finds it. */
function callerOwnsWorkspace() {
  readMock.mockImplementation(async () => ({
    resource: { id: 'ws-1', tenantId: (getSession as any)()?.claims?.oid, storageAccountId: ACCOUNT_ARM_ID },
  }));
}
/** ws-1 lives in another creator's partition: the owner point read 404s. */
function workspaceOwnedByOther() {
  readMock.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));
}

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
  callerOwnsWorkspace();
  (setLifecyclePolicy as any).mockImplementation(async (rules: unknown[]) => rules);
  (getLifecyclePolicy as any).mockResolvedValue([]);
});

describe('PUT /api/onelake/lifecycle — authorization', () => {
  it('401 without a session, and the sink is never called', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await PUT(putReq({ workspaceId: 'ws-1', rules: [RULE] }), {} as any);
    expect(res.status).toBe(401);
    expect(setLifecyclePolicy).not.toHaveBeenCalled();
  });

  it('403 admin_only for a signed-in non-admin who OWNS the workspace, and the sink is never called', async () => {
    // Breaks if PUT is not tenant-admin gated: the caller owns ws-1, so the
    // workspace resolves and setLifecyclePolicy (mocked to echo) would be
    // called with a 200.
    (getSession as any).mockReturnValue(user);
    const res = await PUT(putReq({ workspaceId: 'ws-1', rules: [RULE] }), {} as any);
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('admin_only');
    expect(setLifecyclePolicy).not.toHaveBeenCalled();
  });

  it('a tenant admin on their own workspace reaches the sink, scoped to its bound account (positive pair)', async () => {
    // Breaks if the gate refuses admins, or the account ref stops being taken
    // from the resolved workspace document.
    (getSession as any).mockReturnValue(admin);
    const res = await PUT(putReq({ workspaceId: 'ws-1', rules: [RULE] }), {} as any);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(setLifecyclePolicy).toHaveBeenCalledTimes(1);
    expect((setLifecyclePolicy as any).mock.calls[0][0][0].name).toBe('cool-after-30');
    expect((setLifecyclePolicy as any).mock.calls[0][1]).toEqual({
      account: 'acctws', resourceGroup: 'rg-1', subscriptionId: 'sub-1',
    });
  });

  it('a tenant admin on another creator\'s workspace resolves through the tenant-boundary resolver', async () => {
    // Breaks if resolution were still the owner-only partition read: ws-1 is
    // not in the admin's partition, so that read 404s and the answer is 404.
    (getSession as any).mockReturnValue(admin);
    workspaceOwnedByOther();
    (resolveWorkspaceAccessByOid as any).mockResolvedValue({
      workspace: { id: 'ws-1', tenantId: 'creator-oid', storageAccountId: ACCOUNT_ARM_ID },
      role: 'Admin', via: 'admin', canWrite: true,
    });
    const res = await PUT(putReq({ workspaceId: 'ws-1', rules: [RULE] }), {} as any);
    expect(res.status).toBe(200);
    expect((resolveWorkspaceAccessByOid as any).mock.calls[0][2]).toMatchObject({ callerTid: 't1', tenantAdmin: true });
    expect((setLifecyclePolicy as any).mock.calls[0][1].account).toBe('acctws');
  });

  it('a tenant admin the resolver refuses gets 404, and the sink is never called', async () => {
    // Breaks if a null resolver verdict were treated as an allow.
    (getSession as any).mockReturnValue(admin);
    workspaceOwnedByOther();
    (resolveWorkspaceAccessByOid as any).mockResolvedValue(null);
    const res = await PUT(putReq({ workspaceId: 'ws-1', rules: [RULE] }), {} as any);
    expect(res.status).toBe(404);
    expect(setLifecyclePolicy).not.toHaveBeenCalled();
  });
});

describe('GET /api/onelake/lifecycle', () => {
  it('stays session-scoped: a non-admin owner can still read the policy', async () => {
    // Breaks if GET were gated tenant-admin (403), or the owner path were lost.
    (getSession as any).mockReturnValue(user);
    const res = await GET(getReq(), {} as any);
    expect(res.status).toBe(200);
    expect(getLifecyclePolicy).toHaveBeenCalledTimes(1);
    expect((getLifecyclePolicy as any).mock.calls[0][0].account).toBe('acctws');
  });

  it('a non-admin who does not own the workspace gets 404 and no ARM read (no ACL widening)', async () => {
    // Breaks if GET resolved through authorizeWorkspace/allowReadRoles or any
    // path that consults the resolver for a non-admin: the resolver is never
    // asked, and nothing is read from ARM.
    (getSession as any).mockReturnValue(user);
    workspaceOwnedByOther();
    (resolveWorkspaceAccessByOid as any).mockResolvedValue({
      workspace: { id: 'ws-1', tenantId: 'creator-oid', storageAccountId: ACCOUNT_ARM_ID },
      role: 'Viewer', via: 'acl', canWrite: false,
    });
    const res = await GET(getReq(), {} as any);
    expect(res.status).toBe(404);
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
    expect(getLifecyclePolicy).not.toHaveBeenCalled();
  });
});
