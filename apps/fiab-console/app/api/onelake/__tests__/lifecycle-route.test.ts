/**
 * /api/onelake/lifecycle — who may replace a storage account's management
 * policy (#4619), and workspace resolution through `resolveAdminWorkspace`.
 *
 * The PUT replaces ONE storage account's whole policy. A workspace OWNER may
 * write when the workspace binds a DEDICATED account (well-formed ARM id, not
 * the deployment's shared lake account, bound by no other workspace); every
 * other case is SHARED and needs a tenant admin. A non-admin non-owner is a
 * 404 before any ARM call. Each load-bearing assertion names the input that
 * breaks it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

const readMock = vi.fn();
const queryMock = vi.fn();
vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: vi.fn(async () => ({
    item: () => ({ read: readMock }),
    items: { query: (spec: unknown) => ({ fetchAll: () => queryMock(spec) }) },
  })),
}));
vi.mock('@/lib/auth/workspace-access', () => ({ resolveWorkspaceAccessByOid: vi.fn() }));
vi.mock('@/lib/azure/adls-client', () => ({
  getAccountName: vi.fn(),
  getLifecyclePolicy: vi.fn(),
  setLifecyclePolicy: vi.fn(),
  LifecyclePolicyError: class LifecyclePolicyError extends Error { code = 'forbidden'; },
  STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID: '17d1049b-9a84-46fb-8f53-869881c3d3ab',
}));

import { GET, PUT } from '../lifecycle/route';
import { getSession } from '@/lib/auth/session';
import { resolveWorkspaceAccessByOid } from '@/lib/auth/workspace-access';
import { getAccountName, getLifecyclePolicy, setLifecyclePolicy } from '@/lib/azure/adls-client';

const user = { claims: { upn: 'u@x', tid: 't1', oid: 'user-oid' } };
const admin = { claims: { upn: 'a@x', tid: 't1', oid: 'admin-oid' } };

const SUB = '11111111-2222-3333-4444-555555555555';
const armId = (account: string) =>
  `/subscriptions/${SUB}/resourceGroups/rg-1/providers/Microsoft.Storage/storageAccounts/${account}`;
/** The workspace's OWN account. */
const ACCOUNT_ARM_ID = armId('acctws');
/** getAccountName() — the deployment's shared lake account. */
const SHARED_ACCOUNT = 'acctlake';

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
const put = () => PUT(putReq({ workspaceId: 'ws-1', rules: [RULE] }), {} as any);

/** The caller created ws-1 (bound to `storageAccountId`): the owner point read finds it. */
function callerOwnsWorkspace(binding: string | null = ACCOUNT_ARM_ID) {
  const storageAccountId = binding ?? undefined; // null = the workspace binds no account
  readMock.mockImplementation(async () => ({
    resource: { id: 'ws-1', tenantId: (getSession as any)()?.claims?.oid, storageAccountId },
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
  (getAccountName as any).mockReturnValue(SHARED_ACCOUNT);
  queryMock.mockResolvedValue({ resources: [] });
  (setLifecyclePolicy as any).mockImplementation(async (rules: unknown[]) => rules);
  (getLifecyclePolicy as any).mockResolvedValue([]);
});

async function expectAdminOnly(res: Response) {
  expect(res.status).toBe(403);
  const j = await res.json();
  expect(j.code).toBe('admin_only');
  // The envelope names THIS surface, not the canonical labels/DLP text.
  expect(j.reason).toMatch(/lifecycle rules/);
  expect(j.reason).not.toMatch(/sensitivity labels/);
  expect(setLifecyclePolicy).not.toHaveBeenCalled();
}

describe('PUT /api/onelake/lifecycle — dedicated account: the workspace owner may write', () => {
  it('401 without a session, and the sink is never called', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await put()).status).toBe(401);
    expect(setLifecyclePolicy).not.toHaveBeenCalled();
  });

  it('a non-admin OWNER of a workspace with its own account reaches the sink with the parsed ref', async () => {
    // Breaks if PUT were tenant-admin for every workspace (the round-1 shape:
    // 403 here), or if the ref stopped coming from the workspace binding.
    (getSession as any).mockReturnValue(user);
    const res = await put();
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect((setLifecyclePolicy as any).mock.calls[0][0][0].name).toBe('cool-after-30');
    expect((setLifecyclePolicy as any).mock.calls[0][1]).toEqual({
      account: 'acctws', resourceGroup: 'rg-1', subscriptionId: SUB,
    });
  });

  it('asks Cosmos for OTHER workspaces binding the same account', async () => {
    // Breaks if the uniqueness query dropped its self-exclusion (ws-1 would
    // count itself and every owner would be refused) or searched another name.
    (getSession as any).mockReturnValue(user);
    await put();
    const spec = queryMock.mock.calls[0][0];
    expect(spec.query).toMatch(/c\.id != @id/);
    expect(spec.parameters).toEqual(expect.arrayContaining([
      { name: '@id', value: 'ws-1' },
      { name: '@needle', value: '/storageaccounts/acctws' },
    ]));
  });

  it('a substring-only hit (another workspace binds "acctws2") does not make the account shared', async () => {
    // CONTAINS is a prefilter; the exact compare decides. Breaks if a
    // substring hit were counted: this would become a 403.
    (getSession as any).mockReturnValue(user);
    queryMock.mockResolvedValue({ resources: [{ id: 'ws-2', storageAccountId: armId('acctws2') }] });
    expect((await put()).status).toBe(200);
    expect(setLifecyclePolicy).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /api/onelake/lifecycle — shared account: tenant admin only', () => {
  it('403 for a non-admin owner whose workspace binds no account (the shared default)', async () => {
    // Breaks if an unbound workspace were treated as dedicated: the policy
    // would land on the shared account with a 200.
    (getSession as any).mockReturnValue(user);
    callerOwnsWorkspace(null);
    await expectAdminOnly(await put());
  });

  it.each([
    ['exactly', armId(SHARED_ACCOUNT)],
    ['in upper case', armId(SHARED_ACCOUNT.toUpperCase())],
  ])('403 for a non-admin owner whose workspace binds the shared account by id, %s', async (_l, id) => {
    // Breaks if the shared-account comparison were removed, or made
    // case-sensitive (ARM account names are case-insensitive).
    (getSession as any).mockReturnValue(user);
    callerOwnsWorkspace(id);
    await expectAdminOnly(await put());
  });

  it('403 for a non-admin owner when ANOTHER workspace binds the same account', async () => {
    // Breaks if the uniqueness check were removed: ws-1 is otherwise dedicated
    // and the owner would get a 200 on an account ws-2 also uses.
    (getSession as any).mockReturnValue(user);
    queryMock.mockResolvedValue({ resources: [{ id: 'ws-2', storageAccountId: ACCOUNT_ARM_ID.toUpperCase() }] });
    await expectAdminOnly(await put());
  });

  it.each([
    ['a trailing path segment', `${ACCOUNT_ARM_ID}/x`],
    ['a query string', `${ACCOUNT_ARM_ID}?x=1`],
    ['a leading prefix', `/x${ACCOUNT_ARM_ID}`],
    ['a non-GUID subscription', ACCOUNT_ARM_ID.replace(SUB, 'sub-1')],
    ['a non-storage provider', ACCOUNT_ARM_ID.replace('Microsoft.Storage/storageAccounts', 'Microsoft.Web/sites')],
  ])('403 for a non-admin owner whose binding has %s', async (_l, id) => {
    // Breaks if the ARM-id parse were not anchored at both ends: each of these
    // would parse to account "acctws" (or similar) and answer 200.
    (getSession as any).mockReturnValue(user);
    callerOwnsWorkspace(id);
    await expectAdminOnly(await put());
  });

  it('403 (fail closed) when the other-workspaces lookup throws', async () => {
    // Breaks if a failed lookup were read as "no other workspace": 200.
    (getSession as any).mockReturnValue(user);
    queryMock.mockRejectedValue(new Error('cosmos down'));
    await expectAdminOnly(await put());
  });

  it('403 (fail closed) when the shared account name cannot be resolved', async () => {
    // Breaks if an unresolvable shared account were read as "not shared": 200.
    (getSession as any).mockReturnValue(user);
    (getAccountName as any).mockImplementation(() => { throw new Error('no LOOM_*_URL'); });
    await expectAdminOnly(await put());
  });

  it('a tenant admin on an unbound workspace reaches the sink with the default account (positive pair)', async () => {
    // Breaks if the shared branch refused admins too.
    (getSession as any).mockReturnValue(admin);
    callerOwnsWorkspace(null);
    const res = await put();
    expect(res.status).toBe(200);
    expect(setLifecyclePolicy).toHaveBeenCalledTimes(1);
    expect((setLifecyclePolicy as any).mock.calls[0][1]).toBeUndefined();
  });
});

describe('PUT /api/onelake/lifecycle — workspace resolution', () => {
  it('a non-admin who does not own the workspace gets 404 and no sink', async () => {
    // Breaks if a non-owner non-admin were resolved (e.g. via ACL): the
    // account is dedicated, so the sink would be reached with a 200.
    (getSession as any).mockReturnValue(user);
    workspaceOwnedByOther();
    (resolveWorkspaceAccessByOid as any).mockResolvedValue({
      workspace: { id: 'ws-1', tenantId: 'creator-oid', storageAccountId: ACCOUNT_ARM_ID },
      role: 'Admin', via: 'acl', canWrite: true,
    });
    const res = await put();
    expect(res.status).toBe(404);
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
    expect(setLifecyclePolicy).not.toHaveBeenCalled();
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
    const res = await put();
    expect(res.status).toBe(200);
    expect((resolveWorkspaceAccessByOid as any).mock.calls[0][2]).toMatchObject({ callerTid: 't1', tenantAdmin: true });
    expect((setLifecyclePolicy as any).mock.calls[0][1].account).toBe('acctws');
  });

  it('a tenant admin the resolver refuses gets 404, and the sink is never called', async () => {
    // Breaks if a null resolver verdict were treated as an allow.
    (getSession as any).mockReturnValue(admin);
    workspaceOwnedByOther();
    (resolveWorkspaceAccessByOid as any).mockResolvedValue(null);
    const res = await put();
    expect(res.status).toBe(404);
    expect(setLifecyclePolicy).not.toHaveBeenCalled();
  });
});

describe('GET /api/onelake/lifecycle', () => {
  it('a non-admin owner reads the policy, and learns the account is dedicated', async () => {
    // Breaks if GET were gated tenant-admin (403), the owner path were lost,
    // or accountScope stopped reporting the classification (editor gating).
    (getSession as any).mockReturnValue(user);
    const res = await GET(getReq(), {} as any);
    expect(res.status).toBe(200);
    expect((getLifecyclePolicy as any).mock.calls[0][0].account).toBe('acctws');
    expect((await res.json()).accountScope).toBe('dedicated');
  });

  it('reports accountScope "shared" for an unbound workspace (paired with the above)', async () => {
    // Breaks if accountScope were a constant.
    (getSession as any).mockReturnValue(user);
    callerOwnsWorkspace(null);
    const res = await GET(getReq(), {} as any);
    expect(res.status).toBe(200);
    expect((await res.json()).accountScope).toBe('shared');
  });

  it('a non-admin who does not own the workspace gets 404 and no ARM read (no ACL widening)', async () => {
    // Breaks if GET resolved through authorizeWorkspace/allowReadRoles or any
    // path that consults the resolver for a non-admin.
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
