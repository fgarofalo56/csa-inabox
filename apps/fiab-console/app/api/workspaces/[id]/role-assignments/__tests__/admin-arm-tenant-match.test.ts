/**
 * #3826 site 2 — THE ROLE-ASSIGNMENT LADDER, EXERCISED END-TO-END.
 *
 * Every handler on `/api/workspaces/[id]/role-assignments` (and its
 * `[principalId]` sibling) runs the ladder
 *
 *     role === 'admin' || isTenantAdmin(s) || owningDomainAdmin
 *
 * The middle arm has NO stored grant behind it. `isTenantAdmin` reads
 * `LOOM_TENANT_ADMIN_OID` / `_GROUP_ID` and never looks at the workspace, so it
 * establishes that the caller is AN admin and never WHICH tenant they
 * administer. The exposure was therefore: obtain a workspace DOCUMENT whose
 * tenancy Loom never established, and this ladder converts it into full member
 * ADD and REMOVE — and REMOVE also revokes the mirrored Azure RBAC assignment,
 * so it de-provisions for real.
 *
 * WHY THIS SUITE MOCKS COSMOS AND NOT `resolveWorkspaceRole`. A first draft
 * mocked the resolver to ALLOW and asserted a route-local tenant check. That
 * check has since been deleted — the repo's chokepoint guard correctly called it
 * a fifth private copy of the tenant decision (#3825) — so a resolver-mocking
 * suite would now be asserting the behaviour of its own mock and would stay
 * green if the real boundary were removed entirely. The mock boundary is
 * therefore pushed down to COSMOS: the real `resolveWorkspaceRole`, the real
 * `resolveWorkspaceAccessByOid` and the real `isTenantAdmin` all execute, and
 * the fixtures are documents. That makes these specs a genuine end-to-end proof
 * of the escalation being closed, and it makes them fail if step 4 is loosened.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const WS_ID = 'ws-under-test';
const HOME_TID = '11111111-1111-1111-1111-111111111111';
const FOREIGN_TID = '99999999-9999-9999-9999-999999999999';
const ADMIN_OID = 'oid-tenant-admin';
const OWNER_OID = 'oid-someone-else';

const world: {
  doc: any;
  aclRole: string | null;
  permissionsRow: any;
  session: any;
} = { doc: null, aclRole: null, permissionsRow: undefined, session: null };

const listWorkspaceRoles = vi.fn(async () => []);
const addWorkspaceRole = vi.fn(async () => ({ roleAssignment: { id: 'ra-1' }, rbac: {} }));
const removeWorkspaceRole = vi.fn(async () => ({ removed: true, rbac: {} }));
const resolveEffectiveRole = vi.fn(async () => world.aclRole);

// COSMOS IS THE MOCK BOUNDARY. Everything above it is the real code path.
vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => ({
    // Owner fast-path: the caller does not own it, so the point-read misses.
    item: () => ({ read: async () => ({ resource: undefined }) }),
    items: { query: () => ({ fetchAll: async () => ({ resources: world.doc ? [world.doc] : [] }) }) },
  }),
  workspaceRolesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
  workspacePermissionsContainer: async () => ({
    item: () => ({
      read: async () => {
        if (world.permissionsRow === undefined) {
          const e: any = new Error('not found');
          e.code = 404;
          throw e;
        }
        return { resource: world.permissionsRow };
      },
    }),
  }),
}));
vi.mock('@/lib/azure/workspace-roles-client', () => ({
  resolveEffectiveRole: (...a: any[]) => resolveEffectiveRole(...(a as [])),
  listWorkspaceRoles: (...a: any[]) => listWorkspaceRoles(...(a as [])),
  addWorkspaceRole: (...a: any[]) => addWorkspaceRole(...(a as [])),
  removeWorkspaceRole: (...a: any[]) => removeWorkspaceRole(...(a as [])),
  checkRbacAdminCapability: async () => ({ ok: true }),
  isWorkspaceRoleName: (r: any) => ['Admin', 'Member', 'Contributor', 'Viewer'].includes(r),
}));
vi.mock('@/lib/auth/load-domains', () => ({ loadTenantDomains: async () => [] }));
vi.mock('@/lib/access/assignment-ledger', () => ({
  recordAssignment: vi.fn(async () => {}),
  revokeAssignmentLedger: vi.fn(async () => {}),
}));
vi.mock('@/lib/auth/session', () => ({
  getSession: () => world.session,
  tenantScopeId: (s: any) => s?.claims?.tid || s?.claims?.oid,
}));
vi.mock('@/lib/api/route-toolkit', () => ({
  withSession: (h: any) => (req: any, ctx: any) => h(req, { session: world.session, params: ctx.params }),
}));

import { GET, POST } from '../route';
import { DELETE } from '../[principalId]/route';

/** A workspace owned by somebody else, optionally stamped with a tenant. */
function ws(tid?: string) {
  return { id: WS_ID, tenantId: OWNER_OID, name: 'W', domain: '', ...(tid ? { tid } : {}) };
}

function actAsTenantAdmin(tid: string | undefined) {
  world.session = { claims: { oid: ADMIN_OID, upn: 'admin@contoso.test', tid } };
}

const ctx = { params: Promise.resolve({ id: WS_ID, principalId: 'p-1' }) };
const addBody = {
  json: async () => ({ principalId: 'p-1', principalType: 'User', displayName: 'P', role: 'Admin' }),
} as any;

const priorAdminOid = process.env.LOOM_TENANT_ADMIN_OID;
const priorAcl = process.env.LOOM_MULTIUSER_ACL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  process.env.LOOM_MULTIUSER_ACL = 'on';
  world.doc = ws(HOME_TID);
  world.aclRole = 'Viewer'; // a real ACL grant — so ONLY the tid boundary can refuse
  world.permissionsRow = undefined; // no workspace-permissions row => role stays null
  resolveEffectiveRole.mockImplementation(async () => world.aclRole);
});

afterEach(() => {
  if (priorAdminOid === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = priorAdminOid;
  if (priorAcl === undefined) delete process.env.LOOM_MULTIUSER_ACL;
  else process.env.LOOM_MULTIUSER_ACL = priorAcl;
  world.session = null;
});

describe('the harness itself — the admin arm is GENUINELY what is under test', () => {
  it('CONTROL: on a CONFIRMED tenancy the admin arm really does grant', async () => {
    // Without this every "refused" spec below could be green because the fixture
    // forgot to make the caller an admin, or because the ACL row never existed.
    actAsTenantAdmin(HOME_TID);
    const res: any = await GET({} as any, ctx as any);
    expect(res.status).toBe(200);
    // `callerRole: 'admin'` is the admin ARM firing, not a per-workspace role:
    // the fixture has no workspace-permissions row, so the ladder's `role` is null.
    expect((await res.json()).callerRole).toBe('admin');
  });
});

describe('#3826 — ADD (POST) cannot escalate on an unconfirmed workspace', () => {
  it('GRANTS when the tenancy is CONFIRMED', async () => {
    actAsTenantAdmin(HOME_TID);
    const res: any = await POST(addBody, ctx as any);
    expect(res.status).toBe(201);
    expect(addWorkspaceRole).toHaveBeenCalledTimes(1);
  });

  it('THE EXPLOIT, CLOSED: an UNSTAMPED workspace + an ACL row writes NOTHING', async () => {
    world.doc = ws(undefined);
    actAsTenantAdmin(HOME_TID);
    const res: any = await POST(addBody, ctx as any);
    expect(res.status).toBe(404);
    // The assertion that matters is the absent side effect, not the status.
    expect(addWorkspaceRole).not.toHaveBeenCalled();
  });

  it('the CALLER-side absence is refused too — an admin session with no tid', async () => {
    // This is the state #3845 was generating on every CI login.
    actAsTenantAdmin(undefined);
    const res: any = await POST(addBody, ctx as any);
    expect(res.status).toBe(404);
    expect(addWorkspaceRole).not.toHaveBeenCalled();
  });

  it('a measured DIFFERENT tenant is refused', async () => {
    world.doc = ws(FOREIGN_TID);
    actAsTenantAdmin(HOME_TID);
    const res: any = await POST(addBody, ctx as any);
    expect(res.status).toBe(404);
    expect(addWorkspaceRole).not.toHaveBeenCalled();
  });
});

describe('#3826 — REMOVE (DELETE) is the destructive half and is closed identically', () => {
  it('REMOVES when the tenancy is CONFIRMED', async () => {
    actAsTenantAdmin(HOME_TID);
    const res: any = await DELETE({} as any, ctx as any);
    expect(res.status).toBe(200);
    expect(removeWorkspaceRole).toHaveBeenCalledTimes(1);
  });

  it('THE EXPLOIT, CLOSED: no Cosmos row removed and no RBAC revoked on an UNSTAMPED workspace', async () => {
    world.doc = ws(undefined);
    actAsTenantAdmin(HOME_TID);
    const res: any = await DELETE({} as any, ctx as any);
    expect(res.status).toBe(404);
    expect(removeWorkspaceRole).not.toHaveBeenCalled();
  });

  it('refused when the admin session carries no tid', async () => {
    actAsTenantAdmin(undefined);
    const res: any = await DELETE({} as any, ctx as any);
    expect(res.status).toBe(404);
    expect(removeWorkspaceRole).not.toHaveBeenCalled();
  });
});

describe('#3826 — the READ roster follows the same boundary', () => {
  it('refused, and the roster is never even fetched, on an UNSTAMPED workspace', async () => {
    world.doc = ws(undefined);
    actAsTenantAdmin(HOME_TID);
    const res: any = await GET({} as any, ctx as any);
    expect(res.status).toBe(404);
    expect(listWorkspaceRoles).not.toHaveBeenCalled();
  });
});

describe('#3826 — the narrowing is scoped to the CLAIMS-ONLY arm', () => {
  it('a workspace-permissions ADMIN still acts on a CONFIRMED workspace', async () => {
    // Stored, per-workspace grants are unaffected by design: they are an
    // explicit human decision about this record, which the admin flag is not.
    world.permissionsRow = { role: 'admin' };
    world.session = { claims: { oid: 'oid-plain-member', upn: 'm@contoso.test', tid: HOME_TID } };
    delete process.env.LOOM_TENANT_ADMIN_OID; // NOT a tenant admin at all
    const res: any = await POST(addBody, ctx as any);
    expect(res.status).toBe(201);
    expect(addWorkspaceRole).toHaveBeenCalledTimes(1);
  });

  it('…but that same stored grant is ALSO refused on an unstamped workspace', async () => {
    // `resolveWorkspaceRole`'s second path (`workspace-permissions`) already
    // required a positive match before this change (#3840); this pins it, so a
    // future loosening of EITHER path is a red build.
    world.doc = ws(undefined);
    world.permissionsRow = { role: 'admin' };
    world.session = { claims: { oid: 'oid-plain-member', upn: 'm@contoso.test', tid: HOME_TID } };
    delete process.env.LOOM_TENANT_ADMIN_OID;
    const res: any = await POST(addBody, ctx as any);
    expect(res.status).toBe(404);
    expect(addWorkspaceRole).not.toHaveBeenCalled();
  });
});
