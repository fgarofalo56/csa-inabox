/**
 * #2941 — regression tests for `authorizeItemWorkspace`, the guard that replaced
 *
 *     if (workspaceId && !(await assertOwner(workspaceId, session.claims.oid)))
 *       return 404
 *
 * on the semantic-model `[id]/model` + `[id]/ingest` routes and the notebook
 * `[id]/assist` route.
 *
 * Three properties are asserted, each of which goes RED if the corresponding
 * half of the fix is reverted:
 *
 *   (a) a tenant-admin NON-OWNER is ADMITTED on a read with the item's correct
 *       workspaceId.                              ← reverting to `assertOwner` → RED
 *   (b) omitting `workspaceId` does NOT bypass the check — an unauthorized
 *       caller is still refused.                  ← restoring `workspaceId &&`  → RED
 *   (c) a genuinely unauthorized caller still gets 404 (not 403, no existence
 *       leak) on BOTH paths, and a read-only role that may GET may NOT mutate.
 *
 * THE COSMOS MOCK MODELS REAL COSMOS, NOT THE CODE. `workspacesContainer().item(id, pk)`
 * is a PARTITION-KEYED point read: the `workspaces` container is partitioned by
 * `/tenantId` (cosmos-client.ts) and `Workspace.tenantId` holds the workspace
 * CREATOR's oid, so a read with any OTHER oid as the partition key resolves to
 * `undefined` — exactly what real Cosmos does, and exactly why `assertOwner`
 * 404'd a tenant admin live. A mock that returned the doc for any partition key
 * would model the code's assumption instead of the service and would let this
 * whole bug class pass its own guard.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const OWNER = 'oid-creator';
const ADMIN = 'oid-tenant-admin';
const STRANGER = 'oid-stranger';
const VIEWER = 'oid-viewer';

const WS_ID = 'ws-1';
const ITEM_ID = 'item-1';
const ITEM_TYPE = 'semantic-model';
const NOT_FOUND = 'semantic model not found';

/** The one workspace in the estate — created by OWNER, so it lives in OWNER's partition. */
const workspaceDoc = { id: WS_ID, tenantId: OWNER, tid: 'entra-tenant-1', name: 'WS' };
/** The one item — lives in WS_ID. */
const itemDoc = { id: ITEM_ID, itemType: ITEM_TYPE, workspaceId: WS_ID, displayName: 'Model' };

const world = {
  items: [itemDoc] as any[],
  /** oid → workspace role returned by the (mocked) ACL resolver. */
  aclRole: null as string | null,
  admins: new Set<string>([ADMIN]),
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => ({
    // REAL partition semantics: a point read only resolves in the partition the
    // doc actually lives in (`/tenantId` === the creator's oid).
    item: (id: string, pk: string) => ({
      read: async () =>
        id === workspaceDoc.id && pk === workspaceDoc.tenantId
          ? { resource: workspaceDoc }
          : { resource: undefined },
    }),
    // Cross-partition lookup by id (readWorkspaceById) — finds it regardless.
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const idParam = (spec?.parameters || []).find((p: any) => p.name === '@id');
          return { resources: idParam?.value === workspaceDoc.id ? [workspaceDoc] : [] };
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
          const t = params.find((p) => p.name === '@t')?.value;
          return { resources: world.items.filter((d) => d.id === id && d.itemType === t) };
        },
      }),
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

// `ambientCallerTid` dynamically imports this to recover the tid; give it the
// session under test so the cross-tenant boundary is exercised, not skipped.
const currentSession = { value: null as any };
vi.mock('@/lib/auth/session', () => ({ getSession: () => currentSession.value }));

vi.mock('@/lib/clients/workspaces-client', () => ({ loadWorkspaceAdmin: vi.fn(async () => null) }));

function sessionFor(oid: string) {
  return { claims: { oid, tid: 'entra-tenant-1', groups: [] as string[] } } as any;
}

async function authorize(oid: string, opts: { workspaceId?: string | null; allowReadRoles?: boolean }) {
  const { authorizeItemWorkspace } = await import('@/lib/auth/workspace-guard');
  const session = sessionFor(oid);
  currentSession.value = session;
  return authorizeItemWorkspace(session, {
    workspaceId: opts.workspaceId,
    itemId: ITEM_ID,
    itemType: ITEM_TYPE,
    allowReadRoles: opts.allowReadRoles,
    notFound: NOT_FOUND,
  });
}

beforeEach(() => {
  world.items = [itemDoc];
  world.aclRole = null;
  world.admins = new Set([ADMIN]);
  currentSession.value = null;
});

describe('#2941 (a) the guard admits a tenant-admin NON-OWNER on a read', () => {
  it('the creator (owner) is admitted — the unchanged fast path', async () => {
    expect(await authorize(OWNER, { workspaceId: WS_ID, allowReadRoles: true })).toBeNull();
  });

  it('a TENANT ADMIN who did not create the workspace is admitted with the correct workspaceId', async () => {
    // This is the live repro: `GET .../model?workspaceId=<the item's own ws>`
    // 404'd for a tenant admin because assertOwner point-reads the CALLER's
    // partition, where this workspace does not exist.
    expect(await authorize(ADMIN, { workspaceId: WS_ID, allowReadRoles: true })).toBeNull();
  });

  it('a shared ACL MEMBER who does not own the workspace is admitted', async () => {
    world.aclRole = 'Member';
    expect(await authorize(STRANGER, { workspaceId: WS_ID, allowReadRoles: true })).toBeNull();
  });
});

describe('#2941 (b) omitting workspaceId does NOT bypass authorization', () => {
  it('refuses an unauthorized caller when the param is absent (workspace resolved from the item)', async () => {
    const res = await authorize(STRANGER, { workspaceId: null, allowReadRoles: true });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it('refuses on an empty-string / whitespace param too (no truthiness escape hatch)', async () => {
    for (const wsId of ['', '   ']) {
      const res = await authorize(STRANGER, { workspaceId: wsId, allowReadRoles: true });
      expect(res, `workspaceId=${JSON.stringify(wsId)} must not bypass`).not.toBeNull();
      expect(res!.status).toBe(404);
    }
  });

  it('still admits an authorized caller when the param is absent', async () => {
    expect(await authorize(ADMIN, { workspaceId: null, allowReadRoles: true })).toBeNull();
    expect(await authorize(OWNER, { workspaceId: null, allowReadRoles: true })).toBeNull();
  });

  it('refuses an unauthorized caller on a MUTATION with no param', async () => {
    const res = await authorize(STRANGER, { workspaceId: null });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });
});

describe('#2941 (c) unauthorized stays 404, and read access never confers write', () => {
  it('404s (not 403) with the route wording, leaking nothing', async () => {
    for (const wsId of [WS_ID, null]) {
      const res = await authorize(STRANGER, { workspaceId: wsId, allowReadRoles: true });
      expect(res!.status).toBe(404);
      expect(await res!.json()).toEqual({ ok: false, error: NOT_FOUND });
    }
  });

  it('a read-only Viewer may READ but may NOT mutate', async () => {
    world.aclRole = 'Viewer';
    // read surface (allowReadRoles) → admitted
    expect(await authorize(VIEWER, { workspaceId: WS_ID, allowReadRoles: true })).toBeNull();
    // write surface (no allowReadRoles) → refused
    const res = await authorize(VIEWER, { workspaceId: WS_ID });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it('a Contributor (read-only in this model) likewise cannot mutate', async () => {
    world.aclRole = 'Contributor';
    expect(await authorize(VIEWER, { workspaceId: WS_ID, allowReadRoles: true })).toBeNull();
    expect(await authorize(VIEWER, { workspaceId: WS_ID })).not.toBeNull();
  });

  it('a cross-tenant caller is refused even holding an ACL row (tid boundary)', async () => {
    world.aclRole = 'Member';
    const { authorizeItemWorkspace } = await import('@/lib/auth/workspace-guard');
    const foreign = { claims: { oid: STRANGER, tid: 'entra-tenant-OTHER', groups: [] } } as any;
    currentSession.value = foreign;
    const res = await authorizeItemWorkspace(foreign, {
      workspaceId: WS_ID, itemId: ITEM_ID, itemType: ITEM_TYPE,
      allowReadRoles: true, notFound: NOT_FOUND,
    });
    expect(res!.status).toBe(404);
  });
});

describe('#2941 the documented pass-through: an id that names no item at all', () => {
  it('proceeds (nothing of another tenant to gate) — the handlers are oid-partitioned from there', async () => {
    world.items = [];
    expect(await authorize(STRANGER, { workspaceId: null })).toBeNull();
  });

  it('but an item that EXISTS in another tenant is still found and still refused', async () => {
    // The resolution query is cross-partition, so "no workspaceId" can never be
    // used to hide a real item from the guard.
    expect(world.items).toHaveLength(1);
    const res = await authorize(STRANGER, { workspaceId: null });
    expect(res!.status).toBe(404);
  });
});
