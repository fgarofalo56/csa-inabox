/**
 * #3855 / #3833 — the tenant-admin bypass on `security-roles`, pinned.
 *
 * THE DEFECT THESE SPECS EXIST FOR. `assertItemAccess` opened with
 *
 *     if (isTenantAdmin(session)) return null;   // null == AUTHORIZED
 *
 * ahead of every Cosmos read, over an `itemId` + `itemType` the CALLER supplies
 * in the URL. POST / PUT / DELETE on this route do not read metadata — they call
 * `applyRoleAcls` / `revokeRoleAcls`, which write REAL ADLS Gen2 POSIX ACLs on
 * the DLZ lake. A tenant admin in tenant A holding a lakehouse GUID from tenant B
 * therefore wrote ACLs against tenant B's Delta folders, naming arbitrary Entra
 * object ids as members.
 *
 * WHAT MAKES THESE SPECS FAIL AGAINST THE OLD CODE, rather than merely pass
 * against the new: `isTenantAdmin` is mocked TRUE throughout the bypass suite
 * while the canonical resolver REFUSES. On the old code the first line returned
 * `null` and the handler ran to `applyRoleAcls`; here every one of them 404s with
 * zero ACL calls. That divergence is the whole test.
 *
 * WHAT IS DELIBERATELY NOT MOCKED: `assertItemAccess` itself, and the ORDER in
 * which the route consults its two gates. Cosmos, the ADLS client and the two
 * canonical authorizers are stubbed; the route's own control flow is real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSession = vi.fn();
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<any>('@/lib/auth/session');
  return { ...actual, getSession: () => getSession() };
});

/** The flag the removed bypass consulted. TRUE for every test below — a spec
 *  that mocked it false could not tell the fixed route from the broken one. */
const isTenantAdmin = vi.fn(() => true);
vi.mock('@/lib/auth/feature-gate', () => ({ isTenantAdmin: (...a: any[]) => isTenantAdmin(...(a as [])) }));

/** The canonical item-scoped authorizer (`lib/auth/workspace-guard`). */
const authorizeItemWorkspace = vi.fn();
vi.mock('@/lib/auth/workspace-guard', () => ({
  authorizeItemWorkspace: (...a: any[]) => authorizeItemWorkspace(...a),
}));

/** The canonical item load + workspace-access ladder. */
const loadOwnedItem = vi.fn();
vi.mock('../../../../_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItem(...a),
}));

vi.mock('@/lib/auth/pdp/enforce', () => ({ pdpCheck: async () => null }));
vi.mock('@/lib/azure/cloud-endpoints', () => ({ isGovCloud: () => false }));
vi.mock('@/lib/azure/arm-credential', () => ({
  uamiArmCredential: () => ({ getToken: async () => ({ token: 't' }) }),
}));

const listRoles = vi.fn(async () => []);
const getRole = vi.fn(async () => null);
const upsertRole = vi.fn(async (r: any) => r);
const deleteRole = vi.fn(async () => undefined);
const applyRoleAcls = vi.fn(async () => ({ applied: 1 }));
const revokeRoleAcls = vi.fn(async () => undefined);
vi.mock('@/lib/azure/onelake-security-client', () => ({
  listRoles: (...a: any[]) => listRoles(...(a as [])),
  getRole: (...a: any[]) => getRole(...(a as [])),
  upsertRole: (...a: any[]) => upsertRole(...(a as [any])),
  deleteRole: (...a: any[]) => deleteRole(...(a as [])),
  applyRoleAcls: (...a: any[]) => applyRoleAcls(...(a as [])),
  revokeRoleAcls: (...a: any[]) => revokeRoleAcls(...(a as [])),
  verifyRoleAcls: async () => ({ ok: true }),
  roleDocId: (itemId: string, roleName: string) => `${itemId}:${roleName}`,
  ROLE_NAME_RE: /^[A-Za-z][A-Za-z0-9]{0,127}$/,
  isValidRolePath: (p: string) => p === '*' || p.startsWith('/Tables/') || p.startsWith('/Files/'),
  allowedPermissions: () => ['Read', 'ReadWrite'],
}));

import { GET, POST, DELETE } from '../route';

const ctx = (type: string, id: string) => ({ params: Promise.resolve({ type, id }) }) as any;
const postReq = (body: unknown) => ({ json: async () => body }) as any;
const delReq = (roleId: string) =>
  ({ nextUrl: { searchParams: new URLSearchParams(`roleId=${roleId}`) } }) as any;
const getReq = () => ({ nextUrl: { searchParams: new URLSearchParams() } }) as any;

const SESSION = { claims: { oid: 'oid-admin-tenant-A', tid: 'tid-A' } };
/** A lakehouse GUID belonging to ANOTHER tenant — the attacker's only input. */
const FOREIGN_ITEM = '11111111-2222-3333-4444-555555555555';
const REFUSAL = { status: 404, __refusal: true } as any;

const ROLE_BODY = {
  action: 'create',
  role: {
    roleName: 'Exfil',
    container: 'gold',
    permissions: ['ReadWrite'],
    paths: ['*'],
    members: [{ objectId: '99999999-8888-7777-6666-555555555555', objectType: 'User' }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReturnValue(SESSION);
  isTenantAdmin.mockReturnValue(true);
  process.env.LOOM_ONELAKE_SECURITY_ACL = 'true';
});

describe('#3855 — a tenant admin no longer crosses the boundary on a caller-supplied itemId', () => {
  beforeEach(() => {
    // The canonical resolver REFUSES: the item is in another tenant, or its
    // workspace doc records no `tid` so tenancy could not be confirmed.
    authorizeItemWorkspace.mockResolvedValue(REFUSAL);
    loadOwnedItem.mockResolvedValue(null);
  });

  it('POST writes NO ADLS ACLs and 404s', async () => {
    const res = await POST(postReq(ROLE_BODY), ctx('lakehouse', FOREIGN_ITEM));
    expect(res).toBe(REFUSAL);
    expect(applyRoleAcls).not.toHaveBeenCalled();
    expect(upsertRole).not.toHaveBeenCalled();
  });

  it('DELETE revokes NO ADLS ACLs and deletes no role document', async () => {
    const res = await DELETE(delReq('r1'), ctx('lakehouse', FOREIGN_ITEM));
    expect(res).toBe(REFUSAL);
    expect(revokeRoleAcls).not.toHaveBeenCalled();
    expect(deleteRole).not.toHaveBeenCalled();
  });

  it('GET discloses no role definitions', async () => {
    const res = await GET(getReq(), ctx('lakehouse', FOREIGN_ITEM));
    expect(res).toBe(REFUSAL);
    expect(listRoles).not.toHaveBeenCalled();
  });

  it('the gate runs BEFORE any backend call, not alongside it', async () => {
    await POST(postReq(ROLE_BODY), ctx('mirrored-database', FOREIGN_ITEM));
    expect(authorizeItemWorkspace).toHaveBeenCalledTimes(1);
    for (const backend of [listRoles, getRole, upsertRole, applyRoleAcls]) {
      expect(backend).not.toHaveBeenCalled();
    }
  });

  it('every supported itemType is covered — a bypass scoped to ONE type would pass a single-type spec', async () => {
    for (const type of ['lakehouse', 'mirrored-database', 'mirrored-catalog']) {
      vi.clearAllMocks();
      getSession.mockReturnValue(SESSION);
      isTenantAdmin.mockReturnValue(true);
      authorizeItemWorkspace.mockResolvedValue(REFUSAL);
      loadOwnedItem.mockResolvedValue(null);
      const res = await POST(postReq(ROLE_BODY), ctx(type, FOREIGN_ITEM));
      expect(res, `itemType ${type}`).toBe(REFUSAL);
      expect(applyRoleAcls, `itemType ${type}`).not.toHaveBeenCalled();
    }
  });
});

describe('the SECOND gate — an authorized workspace whose item does not exist', () => {
  it('404s rather than minting ACLs for an item that is not there', async () => {
    // `authorizeItemWorkspace` returns null (ALLOW) when the id names no item of
    // that type anywhere — there is no other tenant's resource to gate. On THIS
    // route that state must still refuse, or a POST would apply ACLs for an item
    // that does not exist. `loadOwnedItem` is what supplies that.
    authorizeItemWorkspace.mockResolvedValue(null);
    loadOwnedItem.mockResolvedValue(null);
    const res = await POST(postReq(ROLE_BODY), ctx('lakehouse', FOREIGN_ITEM));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'item not found' });
    expect(applyRoleAcls).not.toHaveBeenCalled();
  });
});

describe('404, not 403 — the refusal is not an existence oracle', () => {
  it('a foreign-tenant id and a nonexistent id are indistinguishable', async () => {
    authorizeItemWorkspace.mockResolvedValue(null);
    loadOwnedItem.mockResolvedValue(null);
    const missing = await POST(postReq(ROLE_BODY), ctx('lakehouse', FOREIGN_ITEM));
    const missingBody = await missing.json();

    vi.clearAllMocks();
    getSession.mockReturnValue(SESSION);
    isTenantAdmin.mockReturnValue(true);
    authorizeItemWorkspace.mockResolvedValue(null);
    loadOwnedItem.mockResolvedValue(null);
    const foreign = await POST(postReq(ROLE_BODY), ctx('lakehouse', '00000000-0000-0000-0000-000000000000'));

    expect(foreign.status).toBe(missing.status);
    expect(await foreign.json()).toEqual(missingBody);
  });
});

describe('the authorized path still works — this is a boundary fix, not a removal', () => {
  const ITEM = { id: FOREIGN_ITEM, itemType: 'lakehouse', workspaceId: 'ws-1' };

  beforeEach(() => {
    authorizeItemWorkspace.mockResolvedValue(null);
    loadOwnedItem.mockResolvedValue(ITEM);
  });

  it('GET returns the role list', async () => {
    const res = await GET(getReq(), ctx('lakehouse', FOREIGN_ITEM));
    expect(res.status).toBe(200);
    expect(listRoles).toHaveBeenCalledWith(FOREIGN_ITEM);
  });

  it('POST upserts the role and applies the real ADLS ACLs', async () => {
    const res = await POST(postReq(ROLE_BODY), ctx('lakehouse', FOREIGN_ITEM));
    expect(res.status).toBe(201);
    expect(upsertRole).toHaveBeenCalledTimes(1);
    expect(applyRoleAcls).toHaveBeenCalledTimes(1);
  });

  it('both gates are consulted WRITE-scoped — `allowReadRoles` is never passed, GET included', async () => {
    await GET(getReq(), ctx('lakehouse', FOREIGN_ITEM));
    expect(authorizeItemWorkspace.mock.calls[0][1]).toEqual({
      itemId: FOREIGN_ITEM,
      itemType: 'lakehouse',
      notFound: 'item not found',
    });
    // 4th arg is the opts bag; it carries the session and NOT allowReadRoles.
    expect(loadOwnedItem.mock.calls[0][3]).toEqual({ session: SESSION });
  });
});

describe('unauthenticated and unsupported-type refusals are unchanged', () => {
  it('401s with no session, before either gate', async () => {
    getSession.mockReturnValue(null);
    const res = await GET(getReq(), ctx('lakehouse', FOREIGN_ITEM));
    expect(res.status).toBe(401);
    expect(authorizeItemWorkspace).not.toHaveBeenCalled();
    expect(loadOwnedItem).not.toHaveBeenCalled();
  });

  it('400s on an item type this route does not serve', async () => {
    const res = await GET(getReq(), ctx('warehouse', FOREIGN_ITEM));
    expect(res.status).toBe(400);
    expect(authorizeItemWorkspace).not.toHaveBeenCalled();
  });
});
