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

import { GET, POST, PUT, DELETE } from '../route';

const ctx = (type: string, id: string) => ({ params: Promise.resolve({ type, id }) }) as any;
const postReq = (body: unknown) => ({ json: async () => body }) as any;
const delReq = (roleId: string) =>
  ({ nextUrl: { searchParams: new URLSearchParams(`roleId=${roleId}`) } }) as any;
const getReq = () => ({ nextUrl: { searchParams: new URLSearchParams() } }) as any;

const SESSION = { claims: { oid: 'oid-admin-tenant-A', tid: 'tid-A' } };
/** A lakehouse GUID belonging to ANOTHER tenant — the attacker's only input. */
const FOREIGN_ITEM = '11111111-2222-3333-4444-555555555555';
/**
 * What the canonical authorizer hands back when it refuses. NOT returned to the
 * caller: this route flattens every refusal into its own 404 (see the oracle
 * suite below), so a spec asserting `toBe(REFUSAL)` would be pinning a leak.
 */
const REFUSAL = { status: 404, __refusal: true } as any;
/** The OTHER refusal `authorizeItemWorkspace` can return: `workspaceDenialResponse`,
 *  a 409 `tenant_unconfirmed` CARRYING the resolved workspaceId. */
const TENANT_UNCONFIRMED_409 = {
  status: 409,
  json: async () => ({
    ok: false,
    error: 'this workspace record does not record which Entra tenant it belongs to',
    code: 'tenant_unconfirmed',
    workspaceId: 'ws-in-another-tenant',
    remediation: 'run backfill-workspace-tid.mjs',
  }),
} as any;

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
  // THE ADMIN VERDICT IS TRUE BY EVERY ROUTE AVAILABLE TO THIS CALLER, not just
  // the mocked helper. `isTenantAdmin` is DERIVED from these two env vars
  // (lib/auth/feature-gate.ts), and a bypass can re-derive it without ever
  // naming the function — this file's guard records exactly that spelling as a
  // measured evasion:
  //
  //     if (session.claims.oid === process.env.LOOM_TENANT_ADMIN_OID) return null;
  //
  // Setting them here means such a bypass fires during these tests instead of
  // silently not applying, so the suite discriminates against the token-free
  // spelling too, not only against `isTenantAdmin(...)`.
  process.env.LOOM_TENANT_ADMIN_OID = SESSION.claims.oid;
  process.env.LOOM_TENANT_ADMIN_GROUP_ID = 'group-that-makes-this-caller-an-admin';
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
    expect(res.status).toBe(404);
    expect(applyRoleAcls).not.toHaveBeenCalled();
    expect(upsertRole).not.toHaveBeenCalled();
  });

  it('DELETE revokes NO ADLS ACLs and deletes no role document', async () => {
    const res = await DELETE(delReq('r1'), ctx('lakehouse', FOREIGN_ITEM));
    expect(res.status).toBe(404);
    expect(revokeRoleAcls).not.toHaveBeenCalled();
    expect(deleteRole).not.toHaveBeenCalled();
  });

  it('GET discloses no role definitions', async () => {
    const res = await GET(getReq(), ctx('lakehouse', FOREIGN_ITEM));
    expect(res.status).toBe(404);
    expect(listRoles).not.toHaveBeenCalled();
  });

  it('the gate runs BEFORE any backend call, not alongside it', async () => {
    await POST(postReq(ROLE_BODY), ctx('mirrored-database', FOREIGN_ITEM));
    expect(authorizeItemWorkspace).toHaveBeenCalledTimes(1);
    for (const backend of [listRoles, getRole, upsertRole, applyRoleAcls]) {
      expect(backend).not.toHaveBeenCalled();
    }
  });

  it('EVERY verb x EVERY itemType — a bypass narrowed to one cell must not survive', async () => {
    // REVIEW FOUND THIS LOOP RUNNING POST ONLY, AND THAT WAS THE ENTIRE MARGIN.
    // GET and DELETE were pinned for `lakehouse` alone, so
    //
    //   const deniedDel = (isTenantAdmin(session) && params.type === 'mirrored-database')
    //     ? null : await assertItemAccess(session, params.id, params.type);
    //
    // — #3855 restored, on the verb that reaches `revokeRoleAcls` + `deleteRole`
    // — passed this suite 12/12 AND both CI guards. The narrow bypass is the
    // evasion that works in this repo; a spec that samples one cell of a 3x3
    // grid cannot see one. All nine cells are exercised now, and each asserts
    // that the BACKEND was not reached, not merely that a refusal came back.
    const verbs: Array<[string, (t: string) => Promise<any>]> = [
      ['GET', async (t) => GET(getReq(), ctx(t, FOREIGN_ITEM))],
      ['POST', async (t) => POST(postReq(ROLE_BODY), ctx(t, FOREIGN_ITEM))],
      ['DELETE', async (t) => DELETE(delReq('r1'), ctx(t, FOREIGN_ITEM))],
    ];
    for (const [verb, call] of verbs) {
      for (const type of ['lakehouse', 'mirrored-database', 'mirrored-catalog']) {
        const where = `${verb} ${type}`;
        vi.clearAllMocks();
        getSession.mockReturnValue(SESSION);
        isTenantAdmin.mockReturnValue(true);
        authorizeItemWorkspace.mockResolvedValue(REFUSAL);
        loadOwnedItem.mockResolvedValue(null);

        const res = await call(type);
        expect(res.status, where).toBe(404);
        expect(await res.json(), where).toEqual({ ok: false, error: 'item not found' });
        // The refusal alone is not the assertion — a bypass that returns a 404
        // AFTER touching the lake would satisfy that. No backend, at all.
        for (const [name, backend] of Object.entries({
          listRoles, getRole, upsertRole, deleteRole, applyRoleAcls, revokeRoleAcls,
        })) {
          expect(backend, `${where} reached ${name}`).not.toHaveBeenCalled();
        }
      }
    }
  });

  it('PUT is the POST handler, wrapper and gates included — not a second copy that can drift', async () => {
    for (const type of ['lakehouse', 'mirrored-database', 'mirrored-catalog']) {
      vi.clearAllMocks();
      getSession.mockReturnValue(SESSION);
      isTenantAdmin.mockReturnValue(true);
      authorizeItemWorkspace.mockResolvedValue(REFUSAL);
      loadOwnedItem.mockResolvedValue(null);
      const res = await PUT(postReq(ROLE_BODY), ctx(type, FOREIGN_ITEM));
      expect(res.status, `PUT ${type}`).toBe(404);
      expect(applyRoleAcls, `PUT ${type}`).not.toHaveBeenCalled();
      expect(upsertRole, `PUT ${type}`).not.toHaveBeenCalled();
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

describe('404, not 403, and not 409 — the refusal is not an existence oracle', () => {
  /** Drive one verb to a refusal under the given authorizer verdict. */
  async function refusalFor(verdict: any, id: string) {
    vi.clearAllMocks();
    getSession.mockReturnValue(SESSION);
    isTenantAdmin.mockReturnValue(true);
    authorizeItemWorkspace.mockResolvedValue(verdict);
    loadOwnedItem.mockResolvedValue(null);
    const res = await POST(postReq(ROLE_BODY), ctx('lakehouse', id));
    return { status: res.status, body: await res.json() };
  }

  it('a foreign-tenant id and a nonexistent id are indistinguishable', async () => {
    const missing = await refusalFor(null, FOREIGN_ITEM);
    const foreign = await refusalFor(REFUSAL, '00000000-0000-0000-0000-000000000000');
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
  });

  it('an UNCONFIRMABLE tenancy is indistinguishable too — the 409 never reaches the caller', async () => {
    // REVIEW FOUND THIS ONE, AND THE OLD SPEC COULD NOT SEE IT: it exercised
    // only the mocked null/null case. `authorizeItemWorkspace` returns
    // `workspaceDenialResponse(diag) ?? <404>`, and that first arm is a 409
    // `tenant_unconfirmed` CARRYING the resolved `workspaceId`
    // (lib/auth/workspace-denial.ts). On a workspace-OPEN surface that is the
    // R7-honest answer. Here the caller supplies the itemId, so a 409 says
    // "that GUID names a real item, in workspace <GUID>" while a nonexistent id
    // 404s — an existence + workspace-id oracle, in exactly the tid-less state
    // #3845 proves has a live generator.
    const missing = await refusalFor(null, FOREIGN_ITEM);
    const unconfirmed = await refusalFor(TENANT_UNCONFIRMED_409, FOREIGN_ITEM);

    expect(unconfirmed.status).toBe(404);
    expect(unconfirmed.status).toBe(missing.status);
    expect(unconfirmed.body).toEqual(missing.body);
    // Named explicitly so a future "restore the honest 409 here" reads as the
    // deliberate reversal it would be, not as a tidy-up.
    expect(JSON.stringify(unconfirmed.body)).not.toContain('ws-in-another-tenant');
    expect(JSON.stringify(unconfirmed.body)).not.toContain('tenant_unconfirmed');
    expect(JSON.stringify(unconfirmed.body)).not.toContain('remediation');
  });

  it('the 409 is flattened on EVERY verb, not just the one that was sampled', async () => {
    for (const [verb, call] of [
      ['GET', async () => GET(getReq(), ctx('mirrored-database', FOREIGN_ITEM))],
      ['DELETE', async () => DELETE(delReq('r1'), ctx('mirrored-catalog', FOREIGN_ITEM))],
    ] as Array<[string, () => Promise<any>]>) {
      vi.clearAllMocks();
      getSession.mockReturnValue(SESSION);
      isTenantAdmin.mockReturnValue(true);
      authorizeItemWorkspace.mockResolvedValue(TENANT_UNCONFIRMED_409);
      loadOwnedItem.mockResolvedValue(null);
      const res = await call();
      expect(res.status, verb).toBe(404);
      expect(await res.json(), verb).toEqual({ ok: false, error: 'item not found' });
    }
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

  it('PUT reaches the same authorized path as POST', async () => {
    const res = await PUT(postReq(ROLE_BODY), ctx('lakehouse', FOREIGN_ITEM));
    expect(res.status).toBe(201);
    expect(applyRoleAcls).toHaveBeenCalledTimes(1);
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
