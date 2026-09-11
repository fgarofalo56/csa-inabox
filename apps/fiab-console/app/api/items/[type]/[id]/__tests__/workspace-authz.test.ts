/**
 * `GET|PATCH|DELETE /api/items/[type]/[id]` — the authorization ladder, run for
 * real.
 *
 * WHY THIS FILE EXISTS (#4357 review findings 2 and 3). #3941 replaced the
 * owner-only workspace point read in ten `items/[type]/[id]/**` route files with
 * `authorizeItemWorkspace`. Before this file, the entire test surface of that
 * change was:
 *
 *   - `app/api/__tests__/workspace-guard-scope.test.ts` — a STATIC SOURCE SCAN,
 *     asserting SCOPE (`allowReadRoles` per verb) over a population it derives by
 *     grepping. Every population assertion in it was a LOWER BOUND, so deleting
 *     the authorize call from a route removed that route from the population and
 *     cleared every threshold with room to spare. That file now also carries a
 *     DECLARED-MEMBERSHIP block, which is the right instrument for a removal —
 *     but it is still a source scan and still proves nothing about runtime.
 *   - `export-check/__tests__/auth-prologue.test.ts` — pins the 401, and
 *     `vi.mock`s `@/lib/auth/workspace-guard` so `authorizeItemWorkspace` always
 *     returns `null`. `null` is the ALLOW. That test cannot observe a REFUSAL.
 *   - `scripts/ci/check-owner-only-workspace-guard.mjs` — counts occurrences of
 *     the OLD owner-only shape. Deleting the NEW call adds no occurrence.
 *
 * So no test in the change ever executed the ladder and watched it say no. This
 * one does: `@/lib/auth/workspace-guard`, `@/lib/auth/workspace-access`,
 * `@/lib/auth/tenant-boundary` and `@/lib/auth/workspace-denial` are all REAL
 * here. Only the Cosmos containers, the ACL role lookup, `isTenantAdmin` and the
 * session are mocked — the boundary between "our authorization code" and "the
 * data it reads".
 *
 * THE MUTATION IT IS BUILT TO CATCH, stated so it can be re-run: delete the
 * `const denied = await authorizeItemWorkspace(session, {…})` call and the
 * `if (denied)` line from `loadItem` in `../route.ts`, returning `{ item, denied:
 * null }` unconditionally. Every REFUSAL case below goes red — MEASURED, not
 * asserted: with the call removed `vitest run` reports 6 failed / 7 passed;
 * with it present, 13 passed. The seven survivors are the four GRANT cases
 * (which exist so the refusals cannot be satisfied by a handler that refuses
 * everyone) and the three falsy-`workspaceId` cases, which are refused by
 * `loadItem`'s own explicit line BEFORE the ladder is reached and so are
 * correctly unaffected by removing it.
 *
 * THE COSMOS MOCK HONOURS REAL PARTITION SEMANTICS. `workspaces` is partitioned
 * on `/tenantId`, which stores the workspace CREATOR's oid, so a point read with
 * any other partition key resolves to `undefined` — exactly as Cosmos does, and
 * exactly why the owner-only guard this migration replaced could never answer
 * "may you ACCESS this". A mock that returned the doc for any partition key
 * would model the buggy code's assumption instead of the service's behaviour.
 *
 * WHAT THIS DOES NOT ESTABLISH (deploy-integrity.md R7). This is a Node/vitest
 * run against mocked containers on the Commercial code path. It is NOT a live
 * estate receipt, NOT a browser E2E, and says nothing about Gov. It pins the
 * decision logic; it does not prove the deployed console behaves this way.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const OWNER = 'oid-workspace-creator';
const ADMIN = 'oid-tenant-admin';
const MEMBER = 'oid-member';
const VIEWER = 'oid-viewer';
const STRANGER = 'oid-stranger';
const TID = 'entra-tenant-1';

/** Normal workspace: created by OWNER, tenancy stamped. */
const WS = { id: 'ws-1', tenantId: OWNER, tid: TID, name: 'Analytics' };
/** Pre-rel-T11 workspace doc with no `tid` — the 409 `tenant_unconfirmed` case. */
const WS_LEGACY = { id: 'ws-legacy', tenantId: 'oid-someone-else', name: 'Legacy' };

const ITEM = {
  id: 'item-1',
  itemType: 'lakehouse',
  workspaceId: WS.id,
  displayName: 'Bronze',
  state: {},
};
const ITEM_LEGACY = {
  id: 'item-legacy',
  itemType: 'lakehouse',
  workspaceId: WS_LEGACY.id,
  displayName: 'Old',
  state: {},
};
/**
 * An item row whose `workspaceId` is falsy — unscopable. `items` is partitioned
 * on `/workspaceId` so this is close to unreachable in a real container, but
 * "close to unreachable" is a durability argument, not an authorization one.
 */
const ITEM_NO_WS = {
  id: 'item-no-ws',
  itemType: 'lakehouse',
  workspaceId: '',
  displayName: 'Orphan',
  state: {},
};

const WORKSPACES = [WS, WS_LEGACY];
const ITEMS = [ITEM, ITEM_LEGACY, ITEM_NO_WS];

const world = {
  /** ACL role for the current caller, or null for "no workspace-roles row". */
  aclRole: null as string | null,
  admins: new Set<string>([ADMIN]),
  replaced: [] as any[],
  deleted: [] as string[],
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => ({
    // REAL partition semantics: `/tenantId` holds the CREATOR's oid, so the doc
    // is visible from that partition and no other.
    item: (id: string, pk: string) => ({
      read: async () => {
        const doc = WORKSPACES.find((w) => w.id === id && w.tenantId === pk);
        return { resource: doc };
      },
    }),
    items: {
      // `readWorkspaceById` — cross-partition SELECT * WHERE c.id = @id.
      query: (spec: any) => ({
        fetchAll: async () => {
          const id = (spec?.parameters || []).find((p: any) => p.name === '@id')?.value;
          return { resources: WORKSPACES.filter((w) => w.id === id) };
        },
      }),
    },
  }),
  itemsContainer: async () => ({
    item: (id: string, pk: string) => ({
      replace: async (doc: any) => {
        world.replaced.push({ id, pk, doc });
        return { resource: doc };
      },
      delete: async () => {
        world.deleted.push(id);
        return {};
      },
    }),
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const p = (spec?.parameters || []) as Array<{ name: string; value: string }>;
          const id = p.find((x) => x.name === '@id')?.value;
          const t = p.find((x) => x.name === '@t')?.value;
          return { resources: ITEMS.filter((i) => i.id === id && i.itemType === t) };
        },
      }),
    },
  }),
  auditLogContainer: async () => ({ items: { create: async () => ({}) } }),
  workspaceRolesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
  itemPermissionsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
}));

vi.mock('@/lib/azure/workspace-roles-client', () => ({
  resolveEffectiveRole: vi.fn(async () => world.aclRole),
}));
vi.mock('@/lib/auth/feature-gate', () => ({
  isTenantAdmin: (s: any) => world.admins.has(s?.claims?.oid),
}));
// "Recent items" telemetry — best-effort, and reaching it is not the subject.
vi.mock('@/lib/items/record-open', () => ({ recordItemOpen: vi.fn(async () => {}) }));

const currentSession = { value: null as any };
vi.mock('@/lib/auth/session', () => ({ getSession: () => currentSession.value }));

function sessionFor(oid: string, tid: string | undefined = TID) {
  currentSession.value = { claims: { oid, tid, groups: [] as string[], upn: `${oid}@x` } };
}

const ctx = (type: string, id: string) => ({ params: Promise.resolve({ type, id }) }) as any;

async function getAs(oid: string, itemId = ITEM.id) {
  sessionFor(oid);
  const { GET } = await import('../route');
  const req = { nextUrl: new URL(`http://localhost/api/items/lakehouse/${itemId}`) } as any;
  const res = await GET(req, ctx('lakehouse', itemId));
  return { status: res.status, body: await res.json() };
}

async function patchAs(oid: string, body: any = { displayName: 'Renamed' }, itemId = ITEM.id) {
  sessionFor(oid);
  const { PATCH } = await import('../route');
  const req = {
    json: async () => body,
    nextUrl: new URL(`http://localhost/api/items/lakehouse/${itemId}`),
  } as any;
  const res = await PATCH(req, ctx('lakehouse', itemId));
  return { status: res.status, body: await res.json() };
}

async function deleteAs(oid: string, itemId = ITEM.id) {
  sessionFor(oid);
  const { DELETE } = await import('../route');
  const req = { nextUrl: new URL(`http://localhost/api/items/lakehouse/${itemId}`) } as any;
  const res = await DELETE(req, ctx('lakehouse', itemId));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  world.aclRole = null;
  world.admins = new Set([ADMIN]);
  world.replaced = [];
  world.deleted = [];
  currentSession.value = null;
  vi.clearAllMocks();
});

describe('#3941 the ladder GRANTS the population the migration was for', () => {
  it('the workspace OWNER reads the item (the fast path, unchanged by the migration)', async () => {
    const r = await getAs(OWNER);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(ITEM.id);
  });

  it('a shared read-only VIEWER reads it — the #2941/#2942 regression this fixes', async () => {
    world.aclRole = 'Viewer';
    const r = await getAs(VIEWER);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(ITEM.id);
  });

  it('a tenant ADMIN who created nothing reads it (admin-open, positive tid match)', async () => {
    const r = await getAs(ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(ITEM.id);
  });

  it('a write-capable MEMBER may PATCH', async () => {
    world.aclRole = 'Member';
    const r = await patchAs(MEMBER);
    expect(r.status).toBe(200);
    expect(world.replaced).toHaveLength(1);
    expect(world.replaced[0].doc.displayName).toBe('Renamed');
  });
});

describe('#3941 the ladder REFUSES, and the refusal reaches the client', () => {
  it('a caller with NO role on the workspace gets 404, not the item', async () => {
    const r = await getAs(STRANGER);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Item not found');
    expect(r.body.id).toBeUndefined();
  });

  it('a read-only VIEWER cannot PATCH — write scope holds, and nothing was written', async () => {
    world.aclRole = 'Viewer';
    const r = await patchAs(VIEWER);
    expect(r.status).toBe(404);
    expect(world.replaced, 'a read-only Viewer mutated the item').toHaveLength(0);
  });

  it('a read-only VIEWER cannot DELETE — and nothing was deleted', async () => {
    world.aclRole = 'Viewer';
    const r = await deleteAs(VIEWER);
    expect(r.status).toBe(404);
    expect(world.deleted, 'a read-only Viewer deleted the item').toEqual([]);
  });

  it('a caller with no role cannot DELETE', async () => {
    const r = await deleteAs(STRANGER);
    expect(r.status).toBe(404);
    expect(world.deleted).toEqual([]);
  });
});

describe('#3840 a tid-less workspace doc refuses, and says so ONLY to an admin', () => {
  it('tenant admin → 409 tenant_unconfirmed with a remediation, not a false 404', async () => {
    const r = await getAs(ADMIN, ITEM_LEGACY.id);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('tenant_unconfirmed');
    expect(typeof r.body.remediation).toBe('string');
    expect(r.body.remediation.length).toBeGreaterThan(0);
  });

  it('CONTROL — a NON-admin gets a silent 404; the 409 is not an existence oracle', async () => {
    const r = await getAs(STRANGER, ITEM_LEGACY.id);
    expect(r.status).toBe(404);
    expect(r.body.code).not.toBe('tenant_unconfirmed');
  });
});

describe('#4357 review 4 — an item row with a falsy workspaceId is UNSCOPABLE, so it is refused', () => {
  /**
   * `authorizeItemWorkspace` opens with
   *   `if (!workspaceId) { workspaceId = await workspaceIdOfItem(…) || ''; if (!workspaceId) return null; }`
   * and `null` is the ALLOW. The owner-only point read this migration replaced
   * did `ws.item(item.workspaceId, tenantId).read()`, which on a falsy key finds
   * nothing and REFUSED. Without the explicit refusal in `loadItem` these ten
   * routes would move that row shape from refuse to allow for any authenticated
   * caller.
   */
  it('GET on a workspace-less row is 404 for a caller with no claim on it', async () => {
    const r = await getAs(STRANGER, ITEM_NO_WS.id);
    expect(r.status).toBe(404);
    expect(r.body.id).toBeUndefined();
  });

  it('DELETE on a workspace-less row deletes nothing', async () => {
    const r = await deleteAs(STRANGER, ITEM_NO_WS.id);
    expect(r.status).toBe(404);
    expect(world.deleted, 'an unscopable row was deleted by a caller with no role').toEqual([]);
  });

  it('even the workspace OWNER gets 404 — the row names no workspace to authorize against', async () => {
    // Stated rather than smoothed over: this is a REFUSAL for everyone, which is
    // what the replaced point read did. It is not a role decision, because there
    // is no workspace to hold a role on.
    const r = await getAs(OWNER, ITEM_NO_WS.id);
    expect(r.status).toBe(404);
  });
});
