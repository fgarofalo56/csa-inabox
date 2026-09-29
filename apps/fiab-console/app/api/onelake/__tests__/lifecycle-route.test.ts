/**
 * /api/onelake/lifecycle — who may replace a storage account's management
 * policy (#4619), and workspace resolution through `resolveAdminWorkspace`.
 *
 * The PUT replaces ONE storage account's whole policy, and a workspace's
 * `storageAccountId` does not establish that the account is that workspace's
 * alone. So PUT is tenant-admin for EVERY account; a non-admin gets the 403
 * `admin_only` envelope before the body is read or any workspace is looked
 * up. GET is owner-or-admin and reports `accountScope` as information only.
 * Each load-bearing assertion names the input that breaks it.
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
import { LIFECYCLE_ADMIN_ONLY } from '@/lib/util/admin-only-copy';

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
const get = () => GET(getReq(), {} as any);

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

describe('PUT /api/onelake/lifecycle — tenant admin for every account', () => {
  it('401 without a session, and the sink is never called', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await put()).status).toBe(401);
    expect(setLifecyclePolicy).not.toHaveBeenCalled();
  });

  it.each([
    ['a dedicated account', ACCOUNT_ARM_ID],
    ['no account (the shared default)', null],
    ['the shared lake account by id', armId(SHARED_ACCOUNT)],
  ])('403 admin_only for a non-admin OWNER whose workspace binds %s, before any lookup', async (_l, binding) => {
    // Breaks if PUT goes back to owner-scoped on a dedicated account (the
    // round-2 shape: the first row answered 200), or if the gate moves after
    // the workspace lookup (readMock would be called).
    (getSession as any).mockReturnValue(user);
    callerOwnsWorkspace(binding);
    const res = await put();
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.code).toBe('admin_only');
    // The envelope names THIS surface, not the canonical labels/DLP text.
    expect(j.reason).toBe(LIFECYCLE_ADMIN_ONLY.reason);
    expect(readMock).not.toHaveBeenCalled();
    expect(setLifecyclePolicy).not.toHaveBeenCalled();
  });

  it('a tenant admin on a dedicated account reaches the sink with that account (positive pair)', async () => {
    // Breaks if admins are refused too, or the ref stops coming from the binding.
    (getSession as any).mockReturnValue(admin);
    const res = await put();
    expect(res.status).toBe(200);
    expect((setLifecyclePolicy as any).mock.calls[0][0][0].name).toBe('cool-after-30');
    expect((setLifecyclePolicy as any).mock.calls[0][1]).toEqual({
      account: 'acctws', resourceGroup: 'rg-1', subscriptionId: SUB,
    });
  });

  it('a tenant admin on an unbound workspace reaches the sink with the default account', async () => {
    // Breaks if an unbound workspace were refused, or given a made-up ref.
    (getSession as any).mockReturnValue(admin);
    callerOwnsWorkspace(null);
    const res = await put();
    expect(res.status).toBe(200);
    expect(setLifecyclePolicy).toHaveBeenCalledTimes(1);
    expect((setLifecyclePolicy as any).mock.calls[0][1]).toBeUndefined();
  });
});

describe('PUT /api/onelake/lifecycle — rule-name shape (as a tenant admin)', () => {
  const putNamed = (name: string) =>
    PUT(putReq({ workspaceId: 'ws-1', rules: [{ ...RULE, name }] }), {} as any);

  // Each name starts with a VALID prefix, so only the pattern's end anchor
  // (or its 63-char bound) refuses it: drop the `$` and 'ok_bad' matches on
  // 'ok' and the 64-char name matches on its first 63.
  it.each([
    ['a valid prefix then an underscore', 'ok_bad'],
    ['a valid prefix then a space', 'ok bad'],
    ['64 characters', 'a'.repeat(64)],
  ])('422 invalid_rule for %s, before any workspace lookup or ARM write', async (_label, name) => {
    (getSession as any).mockReturnValue(admin);
    const res = await putNamed(name);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('invalid_rule');
    expect(readMock).not.toHaveBeenCalled();
    expect(setLifecyclePolicy).not.toHaveBeenCalled();
  });

  it('a 63-character name is accepted (positive pair for the length bound)', async () => {
    // Breaks if the bound were tightened below 63, or if every name were refused.
    (getSession as any).mockReturnValue(admin);
    const res = await putNamed('a'.repeat(63));
    expect(res.status).toBe(200);
    expect((setLifecyclePolicy as any).mock.calls[0][0][0].name).toBe('a'.repeat(63));
  });
});

describe('PUT /api/onelake/lifecycle — workspace resolution (tenant admin)', () => {
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
    // or accountScope stopped reporting the classification.
    (getSession as any).mockReturnValue(user);
    const res = await get();
    expect(res.status).toBe(200);
    expect((getLifecyclePolicy as any).mock.calls[0][0].account).toBe('acctws');
    expect((await res.json()).accountScope).toBe('dedicated');
  });

  it('asks Cosmos for OTHER workspaces binding the same account', async () => {
    // Breaks if the uniqueness query dropped its self-exclusion or searched another name.
    (getSession as any).mockReturnValue(user);
    await get();
    const spec = queryMock.mock.calls[0][0];
    expect(spec.query).toMatch(/c\.id != @id/);
    expect(spec.parameters).toEqual(expect.arrayContaining([
      { name: '@id', value: 'ws-1' },
      { name: '@needle', value: '/storageaccounts/acctws' },
    ]));
  });

  it('a substring-only hit (another workspace binds "acctws2") still reports dedicated', async () => {
    // CONTAINS is a prefilter; the exact compare decides. Breaks if a
    // substring hit were counted.
    (getSession as any).mockReturnValue(user);
    queryMock.mockResolvedValue({ resources: [{ id: 'ws-2', storageAccountId: armId('acctws2') }] });
    expect((await (await get()).json()).accountScope).toBe('dedicated');
  });

  it.each([
    ['binds no account', null, undefined],
    ['binds the shared account by id', armId(SHARED_ACCOUNT), undefined],
    ['binds the shared account in upper case', armId(SHARED_ACCOUNT.toUpperCase()), undefined],
    ['binds an id with a trailing path segment', `${ACCOUNT_ARM_ID}/x`, undefined],
    ['binds an id with a leading prefix', `/x${ACCOUNT_ARM_ID}`, undefined],
    ['binds an account another workspace also binds', ACCOUNT_ARM_ID, 'also-bound'],
    ['cannot complete the other-workspaces lookup', ACCOUNT_ARM_ID, 'lookup-throws'],
  ])('reports accountScope "shared" when the workspace %s', async (_l, binding, extra) => {
    // Each row is refused by one check in classifyAccount: the shared-account
    // compare (case-insensitive), the anchored ARM-id parse, the uniqueness
    // query, or its fail-closed catch. Breaks if that check is removed: the
    // row would report "dedicated".
    (getSession as any).mockReturnValue(user);
    callerOwnsWorkspace(binding as string | null);
    if (extra === 'also-bound') {
      queryMock.mockResolvedValue({ resources: [{ id: 'ws-2', storageAccountId: ACCOUNT_ARM_ID.toUpperCase() }] });
    }
    if (extra === 'lookup-throws') queryMock.mockRejectedValue(new Error('cosmos down'));
    const res = await get();
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
    const res = await get();
    expect(res.status).toBe(404);
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
    expect(getLifecyclePolicy).not.toHaveBeenCalled();
  });
});
