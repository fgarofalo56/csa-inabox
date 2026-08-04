/**
 * `POST /api/cosmos-items/[type]` — who may create an item in a workspace.
 *
 * WHY THIS EXISTS. Adopting the route toolkit here (the R3 hand-rolled-session
 * ratchet) meant reading this handler closely, and it was carrying the SAME
 * defect #2946 removed from `pipeline-binding.ts` and the semantic-model route
 * (#2941 / #2942) — `assertOwner` inlined byte-for-byte:
 *
 *     const { resource } = await ws.item(workspaceId, session.claims.oid).read();
 *     if (!workspace || workspace.tenantId !== session.claims.oid) → 404
 *
 * `workspaces` is partitioned by `/tenantId` and `Workspace.tenantId` holds the
 * workspace CREATOR's Entra oid, so that point read can only ever find a
 * workspace the CALLER created. It answered "did you create this workspace",
 * not "may you write to it". A tenant admin or an ACL Member creating an item
 * through the shared NewItemGate got "Workspace not found" — and, now that
 * creation is what triggers auto-bind, that also meant their item's backing
 * Azure object was never provisioned.
 *
 * The sibling route for the IDENTICAL operation — `POST /api/workspaces/[id]/
 * items` — already used the canonical ladder, so the two disagreed about who
 * could create an item in the same workspace. This route now uses that ladder
 * too (owner → tenant admin → shared ACL), write-scoped.
 *
 * THE TWO INVARIANTS ASSERTED HERE:
 *   1. Everyone the ladder grants WRITE to can create — including the tenant
 *      admin who did not create the workspace (the regression).
 *   2. Nobody else can — a shared read-only Viewer and an unrelated caller are
 *      still refused, and refused with 404 rather than 403 so a workspace id
 *      cannot be probed for existence.
 *
 * The Cosmos mock honours REAL partition-key semantics: a point read against
 * the wrong partition key resolves to `undefined`, exactly as Cosmos does. A
 * mock that returned the doc for any partition key would model the BUGGY code's
 * assumption and let this defect ship past its own regression test — the
 * "fixtures that model the code, not reality" trap.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const CREATOR = 'oid-creator';
const ADMIN = 'oid-tenant-admin';
const MEMBER = 'oid-member';
const VIEWER = 'oid-viewer';
const STRANGER = 'oid-stranger';
const TID = 'entra-tenant-1';

const WS = { id: 'ws-1', tenantId: CREATOR, tid: TID, name: 'Pipelines' };

const world = {
  aclRole: null as string | null,
  admins: new Set<string>([ADMIN]),
  created: [] as any[],
  autoBound: [] as any[],
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => ({
    // REAL partition semantics: the doc is only visible from its own partition.
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
      create: async (doc: any) => { world.created.push(doc); return { resource: doc }; },
      query: () => ({ fetchAll: async () => ({ resources: [] }) }),
    },
  }),
  workspaceRolesContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
  itemPermissionsContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
}));

vi.mock('@/lib/azure/workspace-roles-client', () => ({
  resolveEffectiveRole: vi.fn(async () => world.aclRole),
}));
vi.mock('@/lib/auth/feature-gate', () => ({
  isTenantAdmin: (s: any) => world.admins.has(s?.claims?.oid),
}));
vi.mock('@/lib/azure/loom-search', () => ({
  upsertLoomDoc: vi.fn(async () => {}),
  docForItem: (i: any) => i,
}));
// Auto-bind reaches Azure control planes; record the call instead. That it is
// invoked AT ALL is part of the contract — creation provisions and binds.
vi.mock('@/lib/azure/auto-bind', () => ({
  autoBindOnCreate: vi.fn(async (item: any) => { world.autoBound.push(item); return null; }),
}));

const currentSession = { value: null as any };
vi.mock('@/lib/auth/session', () => ({ getSession: () => currentSession.value }));

function sessionFor(oid: string) {
  currentSession.value = { claims: { oid, tid: TID, groups: [] as string[], upn: `${oid}@x` } };
}

async function createAs(oid: string, workspaceId = WS.id) {
  sessionFor(oid);
  const { POST } = await import('../route');
  const req = new Request('http://localhost/api/cosmos-items/data-pipeline', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, displayName: 'Orders ingest' }),
  }) as any;
  req.nextUrl = new URL('http://localhost/api/cosmos-items/data-pipeline');
  const res = await POST(req, { params: Promise.resolve({ type: 'data-pipeline' }) } as any);
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  world.aclRole = null;
  world.admins = new Set([ADMIN]);
  world.created = [];
  world.autoBound = [];
  currentSession.value = null;
});

describe('POST /api/cosmos-items/[type] — the canonical write ladder', () => {
  it('the workspace CREATOR can create (the unchanged path)', async () => {
    const { status, body } = await createAs(CREATOR);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(world.created).toHaveLength(1);
  });

  it('a TENANT ADMIN who did not create the workspace can create — the regression', async () => {
    // Before this change the owner-only point read missed WS entirely (wrong
    // partition) and this was a 404 "Workspace not found".
    const { status, body } = await createAs(ADMIN);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(world.created).toHaveLength(1);
  });

  it('a shared workspace MEMBER can create', async () => {
    world.aclRole = 'Member';
    const { status } = await createAs(MEMBER);
    expect(status).toBe(200);
    expect(world.created).toHaveLength(1);
  });

  it('a read-only VIEWER is refused — the ladder is WRITE-scoped', async () => {
    world.aclRole = 'Viewer';
    const { status, body } = await createAs(VIEWER);
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
    expect(world.created).toEqual([]);
  });

  it('an unrelated caller is refused', async () => {
    const { status } = await createAs(STRANGER);
    expect(status).toBe(404);
    expect(world.created).toEqual([]);
  });

  it('refuses with 404, not 403, so a workspace id cannot be probed', async () => {
    const missing = await createAs(CREATOR, 'ws-does-not-exist');
    const denied = await createAs(STRANGER);
    // Indistinguishable: "no such workspace" and "not yours" look identical.
    expect(missing.status).toBe(404);
    expect(denied.status).toBe(404);
    expect(missing.body.error).toBe(denied.body.error);
  });
});

describe('POST /api/cosmos-items/[type] — creation PROVISIONS AND BINDS', () => {
  it('auto-binds the created item before answering (auto-bind-by-default §1)', async () => {
    const { status } = await createAs(CREATOR);
    expect(status).toBe(200);
    // The rule's "no second step": the item the caller receives has already
    // been through auto-bind, so the editor it opens next has a canvas.
    expect(world.autoBound).toHaveLength(1);
    expect(world.autoBound[0].displayName).toBe('Orders ingest');
    expect(world.autoBound[0].itemType).toBe('data-pipeline');
  });

  it('does NOT auto-bind when the caller was refused', async () => {
    await createAs(STRANGER);
    expect(world.autoBound).toEqual([]);
  });
});
