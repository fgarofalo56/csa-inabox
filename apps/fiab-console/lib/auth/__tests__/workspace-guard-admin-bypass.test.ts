/**
 * #3825 — the workspace guards must NOT decide the tenant question themselves.
 *
 * THE HOLE THESE PIN. `authorizeWorkspace` opened with
 *
 *     if (isTenantAdmin(session)) return null;   // null == AUTHORIZED
 *
 * so for a tenant admin it returned BEFORE any Cosmos read: no workspace
 * document, no `tid`, nothing to compare. That is strictly worse than the hole
 * #3824 closed in `resolveWorkspaceAccessByOid` step 6 — that one at least
 * performed a comparison (which merely skipped itself when a `tid` was absent);
 * this performed none at all. `resolveAdminWorkspace` had the same shape one
 * level down: `isTenantAdmin(session)` followed by `loadWorkspaceAdmin`, an
 * unfiltered cross-partition `SELECT *`, with no tenant comparison between the
 * flag and the document. And `authorizeWorkspace` never passed `tenantAdmin`
 * into the resolver at all, so the plumbing that lets the repaired boundary
 * decide was only half-wired.
 *
 * Measured against the tree WITH #3824 applied, using the hardest case (both
 * tids present and DIFFERENT — exactly what the repaired resolver refuses):
 *
 *     authorizeWorkspace     -> ALLOWED (null) | resolver consulted = 0
 *     resolveAdminWorkspace  -> ALLOWED via=admin tid=tenant-foreign
 *     CONTROL: a NON-admin is refused by both
 *
 * WHAT MAKES THESE SPECS REAL, AND NOT VACUOUS. The guards under test are the
 * REAL ones and so is the resolver they delegate to — only Cosmos and the
 * session cookie are faked. The admin flag is NOT hand-passed: it is computed by
 * the REAL `isTenantAdmin` from `LOOM_TENANT_ADMIN_OID`. With that env var unset
 * the bypass is simply off and every "DENIED" below would pass while proving
 * nothing about the short-circuit — so `admin_bypass_is_genuinely_on` asserts it
 * is live first, and `the_control_itself_has_teeth` shows that removing the env
 * var makes that control FAIL.
 *
 * `resolverConsulted` counts calls into `resolveWorkspaceAccessByOid`. It is the
 * direct assertion that no short-circuit was re-added: a guard that answers a
 * tenant admin without consulting the chokepoint reads 0 and fails, whatever its
 * verdict happens to be.
 *
 * REGRESSION GUARDS (the whole risk of this change). `via:'owner'` and
 * `via:'acl'` do NOT depend on the tenant bypass and MUST keep working with no
 * `tid` on either side — that is the single-operator estate and every shared
 * workspace. Those specs are written so they stay green when the fix is
 * reverted (verified by mutation), i.e. they are not riding on it.
 *
 * NO PRIVILEGE EXPANSION. `resolveAdminWorkspace` backs the admin plane (/git,
 * /cmk, /identity, /networking, /storage-metrics) and has never admitted a
 * shared-ACL member. `a NON-admin ACL Member is still refused the admin plane`
 * pins that the delegation did not widen it.
 *
 * THE COSMOS DOUBLE MODELS REAL COSMOS, NOT THE CODE (the convention
 * `authorize-item-workspace.test.ts` records): `workspacesContainer().item(id,
 * pk)` is a PARTITION-KEYED point read, and the `workspaces` container is
 * partitioned by `/tenantId` which holds the CREATOR's oid — so a read with any
 * other oid as the partition key resolves to `undefined`, exactly as the service
 * does. Only the cross-partition `SELECT * WHERE c.id = @id` finds a
 * foreign-owned doc.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ADMIN_OID = 'oid-tenant-admin';
const PLAIN_OID = 'oid-plain-user';
const OWNER_OID = 'oid-workspace-owner';
const WS_ID = 'ws-under-test';
const ITEM_ID = 'item-under-test';
const ITEM_TYPE = 'semantic-model';
const ROUTE_NOT_FOUND = 'semantic model not found';
const HOME_TENANT = 'tenant-home';
const FOREIGN_TENANT = 'tenant-foreign';

/** The whole estate, per test. */
const world = {
  /** The workspace doc, or null when no such workspace exists. */
  ws: null as any,
  /** ACL role the (real) role resolver returns for the caller. */
  aclRole: null as string | null,
  /**
   * Item types for which `ITEM_ID` resolves to `WS_ID`. A LIST, not a constant,
   * because the defect this file exists for was scoped to ONE item type and was
   * therefore invisible to a suite that exercises a different one — see
   * `the tenant verdict does not depend on itemType` below.
   */
  itemTypes: [] as string[],
};

const getSession = vi.fn();
const resolveEffectiveRole = vi.fn(async () => world.aclRole);

vi.mock('@/lib/auth/session', () => ({
  getSession: (...a: any[]) => getSession(...a),
  // `feature-gate` imports this; `isTenantAdmin` never calls it, but the module
  // graph must still resolve.
  tenantScopeId: (s: any) => s?.claims?.tid || s?.claims?.oid,
}));

vi.mock('@/lib/azure/workspace-roles-client', () => ({
  resolveEffectiveRole: (...a: any[]) => (resolveEffectiveRole as any)(...a),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => ({
    // REAL partition semantics — a point read only resolves in the partition the
    // doc actually lives in (`/tenantId` === the creator's oid).
    item: (id: string, pk: string) => ({
      read: async () =>
        world.ws && world.ws.id === id && world.ws.tenantId === pk
          ? { resource: world.ws }
          : { resource: undefined },
    }),
    // Cross-partition lookup by id — finds the doc regardless of partition.
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const id = (spec?.parameters || []).find((p: any) => p.name === '@id')?.value;
          return { resources: world.ws && world.ws.id === id ? [world.ws] : [] };
        },
      }),
    },
  }),
  workspaceRolesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
  // `authorizeItemWorkspace` resolves the owning workspace FROM THE ITEM.
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const params: Array<{ name: string; value: any }> = spec?.parameters || [];
          const id = params.find((p) => p.name === '@id')?.value;
          const t = params.find((p) => p.name === '@t')?.value;
          return {
            resources:
              id === ITEM_ID && world.itemTypes.includes(t) ? [{ workspaceId: WS_ID }] : [],
          };
        },
      }),
    },
  }),
  // Pulled in by `feature-gate`'s static import; unused on the isTenantAdmin path.
  featurePermissionsContainer: async () => {
    throw new Error('featurePermissionsContainer must not be reached by isTenantAdmin');
  },
}));

/**
 * Count every entry into the shared chokepoint. A guard that answers a tenant
 * admin WITHOUT consulting it reads 0 here — which is the defect, independent of
 * whatever verdict it returned.
 */
let resolverConsulted = 0;
vi.mock('@/lib/auth/workspace-access', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/workspace-access')>();
  return {
    ...real,
    resolveWorkspaceAccessByOid: (...a: any[]) => {
      resolverConsulted += 1;
      return (real.resolveWorkspaceAccessByOid as any)(...a);
    },
  };
});

import {
  authorizeWorkspace,
  authorizeItemWorkspace,
  requireWorkspace,
  resolveAdminWorkspace,
} from '../workspace-guard';
import { authorizeWorkspaceList } from '../workspace-list-access';
import { isTenantAdmin } from '../feature-gate';

/** A workspace owned by someone else, optionally carrying a recorded tid. */
function foreignWs(tid?: string) {
  return { id: WS_ID, tenantId: OWNER_OID, ...(tid ? { tid } : {}), name: 'Not the caller’s' };
}
/** A workspace the CALLER owns (lives in their own partition). */
function ownWs(oid: string, tid?: string) {
  return { id: WS_ID, tenantId: oid, ...(tid ? { tid } : {}), name: 'Mine' };
}

function sessionFor(oid: string, tid?: string) {
  return { claims: { oid, ...(tid ? { tid } : {}), groups: [] as string[] } } as any;
}

/** Drive a guard exactly as a route does: one session, both for the argument
 *  and as the ambient cookie the resolver may recover the tid from. */
function actAs(oid: string, tid?: string) {
  const session = sessionFor(oid, tid);
  getSession.mockReturnValue(session);
  resolverConsulted = 0;
  return session;
}

async function bodyOf(r: any) {
  return r ? await r.json() : null;
}

const priorAdminOid = process.env.LOOM_TENANT_ADMIN_OID;
const priorAdminGroup = process.env.LOOM_TENANT_ADMIN_GROUP_ID;

beforeEach(() => {
  vi.clearAllMocks();
  // The admin bypass is GENUINELY ON: the single-operator bootstrap binding.
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  world.ws = foreignWs(FOREIGN_TENANT);
  world.aclRole = null;
  world.itemTypes = [ITEM_TYPE];
  resolverConsulted = 0;
});

afterEach(() => {
  if (priorAdminOid === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = priorAdminOid;
  if (priorAdminGroup === undefined) delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  else process.env.LOOM_TENANT_ADMIN_GROUP_ID = priorAdminGroup;
});

// ───────────────────────────────────────────────────────────────────────────
describe('#3825 the harness itself — without this every DENIED below is vacuous', () => {
  it('admin_bypass_is_genuinely_on: isTenantAdmin resolves TRUE for the caller these specs use', () => {
    expect(isTenantAdmin(sessionFor(ADMIN_OID, HOME_TENANT))).toBe(true);
    expect(isTenantAdmin(sessionFor(PLAIN_OID, HOME_TENANT))).toBe(false);
  });

  it('the_control_itself_has_teeth: unsetting LOOM_TENANT_ADMIN_OID makes that control FAIL', () => {
    delete process.env.LOOM_TENANT_ADMIN_OID;
    // This is the exact assertion above; with the env var gone it is false, so
    // the control cannot silently pass in a deployment that never set it.
    expect(isTenantAdmin(sessionFor(ADMIN_OID, HOME_TENANT))).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('#3825 authorizeWorkspace — the tenant verdict comes from the resolver', () => {
  it('CONSULTS the shared resolver for a tenant admin (no short-circuit)', async () => {
    world.ws = foreignWs(HOME_TENANT);
    const s = actAs(ADMIN_OID, HOME_TENANT);
    await authorizeWorkspace(s, WS_ID);
    expect(resolverConsulted).toBeGreaterThan(0);
  });

  it('DENIES a tenant admin when both tids are present and DIFFERENT (the attack)', async () => {
    world.ws = foreignWs(FOREIGN_TENANT);
    const s = actAs(ADMIN_OID, HOME_TENANT);
    const denied = await authorizeWorkspace(s, WS_ID);
    expect(denied).not.toBeNull();
    // 404, not 409: step 4 refuses a CONFIRMED cross-tenant read outright, and we
    // must not leak the existence of another tenant's workspace.
    expect(denied!.status).toBe(404);
    expect(resolverConsulted).toBeGreaterThan(0);
  });

  it('DENIES a tenant admin on a LEGACY tid-less workspace doc — with the honest 409', async () => {
    world.ws = foreignWs(undefined);
    const s = actAs(ADMIN_OID, HOME_TENANT);
    const denied = await authorizeWorkspace(s, WS_ID);
    expect(denied!.status).toBe(409);
    const b = await bodyOf(denied);
    expect(b.code).toBe('tenant_unconfirmed');
    // R7: it must state what was ESTABLISHED, never that the workspace is missing.
    expect(b.error).toMatch(/does not record which Entra tenant/i);
    expect(b.error).not.toMatch(/not found/i);
    expect(b.remediation).toContain('scripts/csa-loom/backfill-workspace-tid.mjs');
    expect(b.workspaceId).toBe(WS_ID);
  });

  it('DENIES a tenant admin whose SESSION carries no tid — 409, naming that cause', async () => {
    world.ws = foreignWs(FOREIGN_TENANT);
    const s = actAs(ADMIN_OID, undefined);
    const denied = await authorizeWorkspace(s, WS_ID);
    expect(denied!.status).toBe(409);
    const b = await bodyOf(denied);
    expect(b.error).toMatch(/sign-?in session does not carry a tenant/i);
  });

  it('CONTROL-GRANT: still ALLOWS a tenant admin when the tenancy is CONFIRMED', async () => {
    // Not a blanket deny — the admin-open capability itself must survive.
    world.ws = foreignWs(HOME_TENANT);
    const s = actAs(ADMIN_OID, HOME_TENANT);
    expect(await authorizeWorkspace(s, WS_ID)).toBeNull();
  });

  it('CONTROL: a NON-admin is refused on the identical fixture (the probe can fail)', async () => {
    world.ws = foreignWs(HOME_TENANT);
    const s = actAs(PLAIN_OID, HOME_TENANT);
    const denied = await authorizeWorkspace(s, WS_ID);
    expect(denied!.status).toBe(404);
  });

  it('a workspace that does not exist at all is 404 for an admin (was: ALLOWED)', async () => {
    world.ws = null;
    const s = actAs(ADMIN_OID, HOME_TENANT);
    const denied = await authorizeWorkspace(s, WS_ID);
    expect(denied!.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('#3825 resolveAdminWorkspace — same delegation, admin plane still admin-only', () => {
  it('CONSULTS the shared resolver for a tenant admin (no unfiltered SELECT *)', async () => {
    world.ws = foreignWs(HOME_TENANT);
    actAs(ADMIN_OID, HOME_TENANT);
    await resolveAdminWorkspace(WS_ID);
    expect(resolverConsulted).toBeGreaterThan(0);
  });

  it('DENIES a tenant admin when both tids are present and DIFFERENT (the attack)', async () => {
    world.ws = foreignWs(FOREIGN_TENANT);
    actAs(ADMIN_OID, HOME_TENANT);
    const r: any = await resolveAdminWorkspace(WS_ID);
    expect(r.ws).toBeUndefined();
    expect(r.resp.status).toBe(404);
  });

  it('DENIES on a LEGACY tid-less doc — 409, not a false "workspace not found"', async () => {
    world.ws = foreignWs(undefined);
    actAs(ADMIN_OID, HOME_TENANT);
    const r: any = await resolveAdminWorkspace(WS_ID);
    expect(r.ws).toBeUndefined();
    expect(r.resp.status).toBe(409);
    const b = await bodyOf(r.resp);
    expect(b.code).toBe('tenant_unconfirmed');
    expect(b.remediation).toContain('backfill-workspace-tid.mjs');
  });

  it('CONTROL-GRANT: still resolves a foreign-owned workspace when the tenancy is CONFIRMED', async () => {
    // The Settings-flyout fix this function exists for must keep working.
    world.ws = foreignWs(HOME_TENANT);
    actAs(ADMIN_OID, HOME_TENANT);
    const r: any = await resolveAdminWorkspace(WS_ID);
    expect(r.resp).toBeUndefined();
    expect(r.via).toBe('admin');
    expect(r.ws.id).toBe(WS_ID);
  });

  it('401s with no session, before anything is read', async () => {
    getSession.mockReturnValue(null);
    resolverConsulted = 0;
    const r: any = await resolveAdminWorkspace(WS_ID);
    expect(r.resp.status).toBe(401);
    expect(resolverConsulted).toBe(0);
  });

  it('NO PRIVILEGE EXPANSION: a NON-admin ACL Member is still refused the admin plane', async () => {
    // The delegation must not let the resolver's ACL step admit a member to
    // /git, /cmk, /identity, /networking — this function never granted that.
    world.ws = foreignWs(HOME_TENANT);
    world.aclRole = 'Member';
    actAs(PLAIN_OID, HOME_TENANT);
    const r: any = await resolveAdminWorkspace(WS_ID);
    expect(r.ws).toBeUndefined();
    expect(r.resp.status).toBe(404);
    // …and it never even reached the resolver: the isTenantAdmin gate is first.
    expect(resolverConsulted).toBe(0);
  });

  it('an ADMIN who also holds an ACL role still resolves (no new refusal)', async () => {
    world.ws = foreignWs(undefined); // tid-less: the ACL grant is the boundary here
    world.aclRole = 'Member';
    actAs(ADMIN_OID, HOME_TENANT);
    const r: any = await resolveAdminWorkspace(WS_ID);
    expect(r.resp).toBeUndefined();
    expect(r.via).toBe('admin');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('#3825 the refusal reaches the callers that render it', () => {
  it('authorizeItemWorkspace keeps the ROUTE wording for an ordinary refusal', async () => {
    world.ws = foreignWs(HOME_TENANT);
    const s = actAs(PLAIN_OID, HOME_TENANT);
    const denied = await authorizeItemWorkspace(s, {
      itemId: ITEM_ID, itemType: ITEM_TYPE, allowReadRoles: true, notFound: ROUTE_NOT_FOUND,
    });
    expect(denied!.status).toBe(404);
    expect(await bodyOf(denied)).toEqual({ ok: false, error: ROUTE_NOT_FOUND });
  });

  it('authorizeItemWorkspace does NOT flatten a tenancy refusal into that 404', async () => {
    world.ws = foreignWs(undefined);
    const s = actAs(ADMIN_OID, HOME_TENANT);
    const denied = await authorizeItemWorkspace(s, {
      itemId: ITEM_ID, itemType: ITEM_TYPE, allowReadRoles: true, notFound: ROUTE_NOT_FOUND,
    });
    expect(denied!.status).toBe(409);
    const b = await bodyOf(denied);
    expect(b.code).toBe('tenant_unconfirmed');
    // "semantic model not found" would be false: Loom read the workspace.
    expect(b.error).not.toContain(ROUTE_NOT_FOUND);
  });

  it('requireWorkspace propagates the 409 to its handler', async () => {
    world.ws = foreignWs(undefined);
    actAs(ADMIN_OID, HOME_TENANT);
    const r: any = await requireWorkspace(WS_ID);
    expect(r.session).toBeUndefined();
    expect(r.resp.status).toBe(409);
  });

  it('requireWorkspace still 401s before any authorization work', async () => {
    getSession.mockReturnValue(null);
    resolverConsulted = 0;
    const r: any = await requireWorkspace(WS_ID);
    expect(r.resp.status).toBe(401);
    expect(resolverConsulted).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('#3825 REGRESSION GUARDS — owner and ACL never depended on the tenant bypass', () => {
  it("via:'owner' — the owner passes with NO tid on either side", async () => {
    world.ws = ownWs(PLAIN_OID);
    const s = actAs(PLAIN_OID, undefined);
    expect(await authorizeWorkspace(s, WS_ID)).toBeNull();
  });

  it("via:'owner' — a tenant ADMIN on their OWN legacy workspace still passes", async () => {
    world.ws = ownWs(ADMIN_OID);
    const s = actAs(ADMIN_OID, undefined);
    expect(await authorizeWorkspace(s, WS_ID)).toBeNull();
  });

  it("via:'owner' — resolveAdminWorkspace's owner point-read is untouched (no tid anywhere)", async () => {
    world.ws = ownWs(PLAIN_OID);
    actAs(PLAIN_OID, undefined);
    const r: any = await resolveAdminWorkspace(WS_ID);
    expect(r.resp).toBeUndefined();
    expect(r.via).toBe('owner');
    // The owner never reaches the resolver — the point-read answers first.
    expect(resolverConsulted).toBe(0);
  });

  it("via:'acl' — a shared Member WRITES with NO tid on either side", async () => {
    world.ws = foreignWs(undefined);
    world.aclRole = 'Member';
    const s = actAs(PLAIN_OID, undefined);
    expect(await authorizeWorkspace(s, WS_ID)).toBeNull();
  });

  it("via:'acl' — a shared Viewer READS with NO tid, and still cannot WRITE", async () => {
    world.ws = foreignWs(undefined);
    world.aclRole = 'Viewer';
    let s = actAs(PLAIN_OID, undefined);
    expect(await authorizeWorkspace(s, WS_ID, { allowReadRoles: true })).toBeNull();
    s = actAs(PLAIN_OID, undefined);
    const denied = await authorizeWorkspace(s, WS_ID);
    expect(denied!.status).toBe(404);
  });

  it("via:'acl' — a Member reaches an ITEM route with NO tid (authorizeItemWorkspace)", async () => {
    world.ws = foreignWs(undefined);
    world.aclRole = 'Member';
    const s = actAs(PLAIN_OID, undefined);
    const denied = await authorizeItemWorkspace(s, {
      itemId: ITEM_ID, itemType: ITEM_TYPE, notFound: ROUTE_NOT_FOUND,
    });
    expect(denied).toBeNull();
  });

  it("via:'acl' still WINS over the admin bypass for an admin who is also a Viewer", async () => {
    // Unchanged resolver semantics: a read-only explicit grant is not silently
    // upgraded, and the admin is not denied their real grant on a READ.
    world.ws = foreignWs(undefined);
    world.aclRole = 'Viewer';
    const s = actAs(ADMIN_OID, HOME_TENANT);
    expect(await authorizeWorkspace(s, WS_ID, { allowReadRoles: true })).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
/**
 * `authorizeWorkspaceList` — THE THIRD AUTHORIZER, previously covered by
 * NOTHING. Recorded rather than quietly added: on 2026-08-21 a review inserted
 * the literal #3825 defect into `lib/auth/workspace-list-access.ts`
 *
 *     if (isTenantAdmin(session)) return { role: 'Admin', canWrite: true };
 *
 * and the entire stack stayed green — the CI guard held a two-entry table that
 * did not name this function, and no spec anywhere called it. It backs the
 * editor pickers, `/api/items`, `/api/items/by-type` and `/api/lakehouse/tables`,
 * so a bypass here lists another tenant's items rather than opening one.
 *
 * ITS ALLOW IS THE INVERSE OF THE GUARDS ABOVE — a NON-NULL access object is the
 * grant and `null` is the refusal. That inversion is exactly why the round-2
 * guard, which modelled an ALLOW as `return null`, found nothing to look at.
 */
describe('#3825 authorizeWorkspaceList — the LIST authorizer delegates too', () => {
  it('CONSULTS the shared resolver for a tenant admin (no short-circuit)', async () => {
    const s = actAs(ADMIN_OID, HOME_TENANT);
    await authorizeWorkspaceList(s, WS_ID);
    expect(resolverConsulted).toBe(1);
  });

  it('DENIES a tenant admin when both tids are present and DIFFERENT (the attack)', async () => {
    world.ws = foreignWs(FOREIGN_TENANT);
    const s = actAs(ADMIN_OID, HOME_TENANT);
    expect(await authorizeWorkspaceList(s, WS_ID)).toBeNull();
    expect(resolverConsulted).toBe(1);
  });

  it('DENIES a tenant admin on a LEGACY tid-less workspace doc', async () => {
    world.ws = foreignWs(undefined);
    const s = actAs(ADMIN_OID, HOME_TENANT);
    expect(await authorizeWorkspaceList(s, WS_ID)).toBeNull();
  });

  it('DENIES a tenant admin whose SESSION carries no tid', async () => {
    world.ws = foreignWs(FOREIGN_TENANT);
    const s = actAs(ADMIN_OID, undefined);
    expect(await authorizeWorkspaceList(s, WS_ID)).toBeNull();
  });

  it('CONTROL-GRANT: still LISTS for a tenant admin when the tenancy is CONFIRMED', async () => {
    world.ws = foreignWs(HOME_TENANT);
    const s = actAs(ADMIN_OID, HOME_TENANT);
    const access = await authorizeWorkspaceList(s, WS_ID);
    expect(access).not.toBeNull();
    expect(access!.role).toBe('Admin');
  });

  it('CONTROL: a NON-admin is refused on the identical fixture (the probe can fail)', async () => {
    world.ws = foreignWs(HOME_TENANT);
    const s = actAs(PLAIN_OID, HOME_TENANT);
    expect(await authorizeWorkspaceList(s, WS_ID)).toBeNull();
  });

  it("REGRESSION: via:'acl' — a shared Viewer still LISTS with NO tid on either side", async () => {
    world.ws = foreignWs(undefined);
    world.aclRole = 'Viewer';
    const s = actAs(PLAIN_OID, undefined);
    const access = await authorizeWorkspaceList(s, WS_ID);
    expect(access).not.toBeNull();
    expect(access!.role).toBe('Viewer');
  });
});

// ───────────────────────────────────────────────────────────────────────────
/**
 * THE ITEM-TYPE SWEEP. `authorizeItemWorkspace` is the 85-importer entry point,
 * and the bypass that survived the whole verification stack on 2026-08-21 was
 * scoped to ONE `itemType`:
 *
 *     if (opts.itemType === 'lakehouse' && isTenantAdmin(session)) return null;
 *
 * Every spec above drives it with `semantic-model`, so every one of them stayed
 * green while `lakehouse` was a live cross-tenant ALLOW. A suite that exercises
 * a single value of a discriminant cannot see a bypass keyed to another value —
 * so this sweeps the discriminant, and its CONTROL proves the sweep can fail.
 */
describe('#3825 the tenant verdict does not depend on itemType', () => {
  const TYPES = ['semantic-model', 'lakehouse', 'data-pipeline', 'warehouse', 'notebook', 'report'];

  it('DENIES every item type on the hardest fixture (both tids present, DIFFERENT)', async () => {
    world.itemTypes = TYPES;
    world.ws = foreignWs(FOREIGN_TENANT);
    for (const itemType of TYPES) {
      const s = actAs(ADMIN_OID, HOME_TENANT);
      const denied = await authorizeItemWorkspace(s, {
        itemId: ITEM_ID, itemType, allowReadRoles: true, notFound: ROUTE_NOT_FOUND,
      });
      expect(denied, `itemType=${itemType} was ALLOWED across tenants`).not.toBeNull();
      // …and it got there by ASKING, not by short-circuiting to a refusal.
      expect(resolverConsulted, `itemType=${itemType} never consulted the resolver`).toBe(1);
    }
  });

  it('CONTROL: every item type is ALLOWED once the tenancy is CONFIRMED', async () => {
    world.itemTypes = TYPES;
    world.ws = foreignWs(HOME_TENANT);
    for (const itemType of TYPES) {
      const s = actAs(ADMIN_OID, HOME_TENANT);
      const denied = await authorizeItemWorkspace(s, {
        itemId: ITEM_ID, itemType, allowReadRoles: true, notFound: ROUTE_NOT_FOUND,
      });
      expect(denied, `itemType=${itemType} was refused on a CONFIRMED tenancy`).toBeNull();
    }
  });

  it('the ALLOW is the DELEGATED verdict: no itemType passes while the resolver refuses', async () => {
    // The direct statement of the rule the CI guard proves structurally. A
    // bypass ORed onto the verdict (`!denied || opts.itemType === 'x'`) fails
    // here for the type it names, whatever it calls itself.
    world.itemTypes = TYPES;
    world.ws = foreignWs(FOREIGN_TENANT);
    const verdicts = [] as Array<{ itemType: string; itemAllowed: boolean; wsAllowed: boolean }>;
    for (const itemType of TYPES) {
      const s = actAs(ADMIN_OID, HOME_TENANT);
      const itemAllowed =
        (await authorizeItemWorkspace(s, {
          itemId: ITEM_ID, itemType, allowReadRoles: true, notFound: ROUTE_NOT_FOUND,
        })) === null;
      const s2 = actAs(ADMIN_OID, HOME_TENANT);
      const wsAllowed = (await authorizeWorkspace(s2, WS_ID, { allowReadRoles: true })) === null;
      verdicts.push({ itemType, itemAllowed, wsAllowed });
    }
    for (const v of verdicts) {
      expect(v.itemAllowed, `itemType=${v.itemType} disagreed with authorizeWorkspace`).toBe(
        v.wsAllowed,
      );
    }
  });
});
