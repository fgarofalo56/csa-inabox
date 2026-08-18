/**
 * #3697 — the canvas collaboration endpoints (canvas-comments / canvas-presence
 * / collab/stream) returned 404 on EVERY canvas open, while
 * `GET /api/cosmos-items/<type>/<id>` returned 200 for the SAME caller in the
 * SAME session on the SAME item.
 *
 * The routes were never missing. All three call
 *
 *     const item = await loadOwnedItem(id, type, session.claims.oid, { allowReadRoles: true });
 *     if (!item) return apiNotFound('item not found');
 *
 * so the 404 was an ITEM-LOOKUP failure, not an absent route.
 *
 * ROOT CAUSE (the same class as #2941 / #2942). `item-crud`'s `accessOptsFor`
 * built the workspace-access options BY HAND and dropped `tenantAdmin`:
 *
 *     return { callerTid: session?.claims.tid, groups: session?.claims.groups };
 *
 * `ambientCallerTid` recovered the tid for oid-only call sites, but the
 * ADMIN-OPEN bypass (`resolveWorkspaceAccessByOid` step 6) had no equivalent, so
 * a tenant admin who did not personally CREATE the workspace resolved to no
 * access. `/api/cosmos-items` disagreed because `resolveItemAccessByOid` DOES
 * pass `tenantAdmin`. `ambientAccessOptsFor` — the helper written to fix exactly
 * this — had two adopters and this, its largest consumer, was not one of them.
 *
 * THE INVARIANT ASSERTED HERE (deliberately the same shape as
 * `lib/azure/__tests__/pipeline-binding-access.test.ts`): an item readable
 * through `/api/cosmos-items/<type>/<id>` MUST be loadable by `loadOwnedItem`
 * for the same caller. Both resolvers are driven off ONE mocked estate, so the
 * test cannot pass by re-implementing either — it COMPARES them.
 *
 * The Cosmos mock honours REAL partition-key semantics (a point read in the
 * wrong partition resolves to `undefined`); a mock that returned the doc for any
 * partition key would model the buggy code's assumption and let this ship past
 * its own regression test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const CREATOR = 'oid-creator';
const ADMIN = 'oid-tenant-admin';
const MEMBER = 'oid-member';
const VIEWER = 'oid-viewer';
const STRANGER = 'oid-stranger';
const TID = 'entra-tenant-1';

const WS = { id: 'ws-f41b6182', tenantId: CREATOR, tid: TID, name: 'Pipelines' };
/** Mirrors the live item from the report: an app-installed pipeline whose
 *  workspace was created by someone other than the caller. */
const ITEM = {
  id: 'item-21c25022',
  itemType: 'adf-pipeline',
  workspaceId: WS.id,
  displayName: 'SAP-to-Lakehouse Extract',
  state: { pipelineName: 'sap_extract' },
};

const world = { aclRole: null as string | null, admins: new Set<string>([ADMIN]) };

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => ({
    // REAL partition semantics: only the CREATOR's partition holds the doc.
    item: (id: string, pk: string) => ({
      read: async () => (id === WS.id && pk === WS.tenantId ? { resource: WS } : { resource: undefined }),
    }),
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const id = (spec?.parameters || []).find((p: any) => p.name === '@id')?.value;
          return { resources: id === WS.id ? [WS] : [] };
        },
      }),
    },
  }),
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const params: Array<{ name: string; value: any }> = spec?.parameters || [];
          const id = params.find((p) => p.name === '@id')?.value;
          const types = params.filter((p) => p.name.startsWith('@t')).map((p) => p.value);
          // POINT LOOKUP (`@id` bound) — unchanged.
          if (id !== undefined) {
            const ok = ITEM.id === id && (types.length === 0 || types.includes(ITEM.itemType));
            return { resources: ok ? [ITEM] : [] };
          }
          // LIST query (`listOwnedItems` / `listAllOwnedItems` bind no `@id`).
          // Without this branch the mock returned [] for EVERY list, which would
          // make an "enumeration returns nothing" assertion a gate that cannot
          // fail — it would pass just as well against the widened code.
          const ws = params.find((p) => p.name === '@w')?.value;
          const matchesType = types.length === 0 || types.includes(ITEM.itemType);
          const matchesWs = ws === undefined || ws === ITEM.workspaceId;
          return { resources: matchesType && matchesWs ? [ITEM] : [] };
        },
      }),
    },
    item: () => ({ replace: async (doc: any) => ({ resource: doc }) }),
  }),
  workspaceRolesContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
  itemPermissionsContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
  tenantSettingsContainer: async () => ({ item: () => ({ read: async () => ({ resource: undefined }) }) }),
}));

vi.mock('@/lib/azure/workspace-roles-client', () => ({
  resolveEffectiveRole: vi.fn(async () => world.aclRole),
}));
vi.mock('@/lib/auth/feature-gate', () => ({
  isTenantAdmin: (s: any) => world.admins.has(s?.claims?.oid),
}));

const currentSession = { value: null as any };
vi.mock('@/lib/auth/session', () => ({ getSession: () => currentSession.value }));

function sessionFor(oid: string, tid = TID) {
  // `groups` is deliberately EMPTY: on the live estate the `groups` claim is
  // never populated (#3175), so the ACL group path cannot be what rescues this.
  const s = { claims: { oid, tid, groups: [] as string[] } } as any;
  currentSession.value = s; // what `ambientAccessOptsFor` recovers
  return s;
}

/** The path the WORKING route (/api/cosmos-items/[type]/[id]) takes. */
async function cosmosItemsCanRead(oid: string) {
  const { resolveItemAccessByOid } = await import('@/lib/auth/item-access');
  return !!(await resolveItemAccessByOid(sessionFor(oid), ITEM.id, ITEM.itemType));
}

/** The path the BROKEN canvas-collab routes take. */
async function collabRouteCanLoad(oid: string) {
  const { loadOwnedItem } = await import('../item-crud');
  sessionFor(oid);
  return !!(await loadOwnedItem(ITEM.id, ITEM.itemType, oid, { allowReadRoles: true }));
}

beforeEach(() => {
  world.aclRole = null;
  world.admins = new Set([ADMIN]);
  currentSession.value = null;
  vi.resetModules();
});

describe('#3697 an item readable via /api/cosmos-items is loadable by loadOwnedItem', () => {
  it('holds for the workspace CREATOR (the unchanged owner fast-path)', async () => {
    expect(await cosmosItemsCanRead(CREATOR)).toBe(true);
    expect(await collabRouteCanLoad(CREATOR)).toBe(true);
  });

  it('holds for a TENANT ADMIN who did not create the workspace — the live #3697 repro', async () => {
    // Before the fix this pair diverged: cosmos-items 200, loadOwnedItem null →
    // every canvas-comments / canvas-presence / collab-stream call 404'd.
    expect(await cosmosItemsCanRead(ADMIN)).toBe(true);
    expect(await collabRouteCanLoad(ADMIN)).toBe(true);
  });

  it('holds for a shared workspace MEMBER', async () => {
    world.aclRole = 'Member';
    expect(await cosmosItemsCanRead(MEMBER)).toBe(true);
    expect(await collabRouteCanLoad(MEMBER)).toBe(true);
  });

  it('the two resolvers agree for every principal in the estate (no divergence)', async () => {
    for (const [oid, role] of [[CREATOR, null], [ADMIN, null], [MEMBER, 'Member'], [VIEWER, 'Viewer'], [STRANGER, null]] as const) {
      world.aclRole = role;
      const readable = await cosmosItemsCanRead(oid);
      const loadable = await collabRouteCanLoad(oid);
      expect(loadable, `divergence for ${oid} (role=${role}): cosmos-items=${readable} loadOwnedItem=${loadable}`)
        .toBe(readable);
    }
  });
});

describe('#3697 the fix does not widen access', () => {
  it('a stranger with no role is still refused by BOTH paths', async () => {
    expect(await cosmosItemsCanRead(STRANGER)).toBe(false);
    expect(await collabRouteCanLoad(STRANGER)).toBe(false);
  });

  it('a cross-tenant caller is refused even holding an ACL row (tid boundary)', async () => {
    world.aclRole = 'Member';
    const { loadOwnedItem } = await import('../item-crud');
    sessionFor(STRANGER, 'entra-tenant-OTHER');
    expect(await loadOwnedItem(ITEM.id, ITEM.itemType, STRANGER, { allowReadRoles: true })).toBeNull();
  });

  it('a cross-tenant ADMIN of a DIFFERENT tenant is refused (the bypass is tid-scoped)', async () => {
    world.admins = new Set([STRANGER]);
    const { loadOwnedItem } = await import('../item-crud');
    sessionFor(STRANGER, 'entra-tenant-OTHER');
    expect(await loadOwnedItem(ITEM.id, ITEM.itemType, STRANGER, { allowReadRoles: true })).toBeNull();
  });

  it('an id that does not exist is still null for an admin', async () => {
    const { loadOwnedItem } = await import('../item-crud');
    sessionFor(ADMIN);
    expect(await loadOwnedItem('no-such-item', ITEM.itemType, ADMIN, { allowReadRoles: true })).toBeNull();
  });

  it('CONTROL — the WRONG itemType still 404s even for the creator (#3698 is a separate defect)', async () => {
    const { loadOwnedItem } = await import('../item-crud');
    sessionFor(CREATOR);
    // This is exactly what the pipeline editor did: ask for the item under the
    // unified head slug rather than its persisted `adf-pipeline` type.
    expect(await loadOwnedItem(ITEM.id, 'data-pipeline', CREATOR, { allowReadRoles: true })).toBeNull();
    expect(await loadOwnedItem(ITEM.id, 'adf-pipeline', CREATOR, { allowReadRoles: true })).toBeTruthy();
  });
});

describe('#3697 WRITE strictness is preserved (read-only roles cannot escalate)', () => {
  it('a Viewer resolves read-only but NOT write through loadOwnedItem', async () => {
    world.aclRole = 'Viewer';
    const { loadOwnedItem } = await import('../item-crud');
    sessionFor(VIEWER);
    expect(await loadOwnedItem(ITEM.id, ITEM.itemType, VIEWER, { allowReadRoles: true })).toBeTruthy();
    // Default (write) scope must still refuse a read-only member.
    expect(await loadOwnedItem(ITEM.id, ITEM.itemType, VIEWER)).toBeNull();
  });
});

/**
 * REVIEW FINDING (post-#3697). Every spec above calls `loadOwnedItem` WITHOUT
 * `opts.session`, so all of them exercise the AMBIENT branch of
 * `accessOptsFor` — `ambientAccessOptsFor(oid)`. The `session` branch the fix
 * ADDED had zero coverage, and it is not symmetric with the ambient one:
 *
 *   ambient : uses the request session ONLY when `s.claims.oid === oid`
 *   session : (as first written) used it for ANY `oid` the caller passed
 *
 * `ambientAccessOptsFor`'s own docstring gives the reason for that rule — "a
 * helper resolving access on behalf of a different principal can never borrow
 * this request's admin status" — and the new branch broke it. That is not
 * theoretical: `app/api/a2a/agent-cards/route.ts` passes
 * `tenantScopeId(session)` (= `claims.tid || claims.oid`) as the `oid`
 * argument while ALSO threading `{ session }`, and `tenantScopeId`'s docstring
 * says it is "deliberately NOT used for the workspaces / items containers".
 *
 * With `oid = tid`: the owner point-read misses (wrong partition), the ACL
 * lookup misses (roles are keyed by user oid), and step 6 then hands back
 * `role:'Admin', canWrite:true` for EVERY workspace in the tenant.
 *
 * These specs pin the principal match in both directions.
 */
describe('#3697 the session branch of accessOptsFor is principal-matched', () => {
  it('GRANTS the admin bypass when the threaded session IS the principal', async () => {
    const { loadOwnedItem } = await import('../item-crud');
    const s = sessionFor(ADMIN);
    // The positive case: same oid, so the session may supply tenantAdmin.
    expect(await loadOwnedItem(ITEM.id, ITEM.itemType, ADMIN, { allowReadRoles: true, session: s })).toBeTruthy();
  });

  it('REFUSES to borrow the session admin status for a DIFFERENT principal', async () => {
    const { loadOwnedItem } = await import('../item-crud');
    const s = sessionFor(ADMIN);
    // The a2a/agent-cards shape, verbatim: oid = tenantScopeId(session) = tid,
    // session = the same admin's session. The tid is not an owner oid and holds
    // no ACL row, so the ONLY thing that could grant access is the bypass — and
    // it must not, because the oid is not this session's principal.
    expect(await loadOwnedItem(ITEM.id, ITEM.itemType, TID, { allowReadRoles: true, session: s })).toBeNull();
  });

  it('REFUSES for an unrelated third-party oid too (not just the tid alias)', async () => {
    const { loadOwnedItem } = await import('../item-crud');
    const s = sessionFor(ADMIN);
    expect(await loadOwnedItem(ITEM.id, ITEM.itemType, STRANGER, { allowReadRoles: true, session: s })).toBeNull();
  });

  it('ENUMERATION is principal-matched too — the a2a list path returns nothing for oid=tid', async () => {
    // The finding is a LIST surface, so pin the list path, not only the point
    // read: `listOwnedItems(kind, tenantScopeId(session), { session })`.
    const { listOwnedItems } = await import('../item-crud');
    const s = sessionFor(ADMIN);
    expect(await listOwnedItems(ITEM.itemType, TID, { session: s })).toEqual([]);
    // ...while the same admin listing under their OWN oid still gets the
    // admin-open enumeration the fix intends.
    expect((await listOwnedItems(ITEM.itemType, ADMIN, { session: s })).length).toBe(1);
  });
});

