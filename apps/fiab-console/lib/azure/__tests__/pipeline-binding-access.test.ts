/**
 * #2942 — the data-pipeline editor rendered no canvas and binding failed with
 *   "Bind failed — Item <id> (adf-pipeline) not found in this tenant."
 * while `GET /api/cosmos-items/data-pipeline/<id>` returned 200 for the SAME
 * caller in the SAME session.
 *
 * ROOT CAUSE (identical to #2941). `loadPipelineItem` authorized with an
 * owner-only PARTITION point read — `assertOwner` inlined byte-for-byte:
 *
 *     const { resource } = await ws.item(item.workspaceId, tenantId).read();
 *     if (!resource || resource.tenantId !== tenantId) return null;
 *
 * The `workspaces` container is partitioned by `/tenantId`, and
 * `Workspace.tenantId` stores the workspace CREATOR's oid, so that read can only
 * find a workspace the CALLER created. `/api/cosmos-items` instead resolves via
 * `resolveItemAccessByOid` → `resolveWorkspaceAccessByOid` (owner → ACL → tid
 * boundary → admin-open), which is why the two disagreed.
 *
 * THE INVARIANT ASSERTED HERE: an item readable through
 * `/api/cosmos-items/<type>/<id>` MUST be resolvable by `resolveBinding` for the
 * same caller. Both resolvers are driven off ONE mocked estate, so the test
 * cannot pass by re-implementing either — it compares them.
 *
 * The Cosmos mock honours REAL partition-key semantics (a point read in the
 * wrong partition resolves to `undefined`); a mock that returned the doc for any
 * partition key would have modelled the buggy code's assumption and let this bug
 * ship past its own regression test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const CREATOR = 'oid-creator';
const ADMIN = 'oid-tenant-admin';
const MEMBER = 'oid-member';
const VIEWER = 'oid-viewer';
const STRANGER = 'oid-stranger';
const TID = 'entra-tenant-1';

const WS = { id: 'ws-f41b6182', tenantId: CREATOR, tid: TID, name: 'Pipelines' };
const ITEM = {
  id: 'item-36f9eb86',
  // The live item was persisted as 'data-pipeline' while the ADF route asks for
  // ['adf-pipeline','data-pipeline'] — the IN(...) alias match, which WORKED.
  itemType: 'data-pipeline',
  workspaceId: WS.id,
  displayName: 'Orders ingest',
  state: { pipelineName: 'ingest_orders' },
};
const ACCEPTED_TYPES = ['adf-pipeline', 'data-pipeline'];

const world = { aclRole: null as string | null, admins: new Set<string>([ADMIN]), replaced: null as any };

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => ({
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
          // pipeline-binding uses `IN (@t0,@t1)`; item-access uses `= @t`.
          const types = params.filter((p) => p.name.startsWith('@t')).map((p) => p.value);
          const ok = ITEM.id === id && (types.length === 0 || types.includes(ITEM.itemType));
          return { resources: ok ? [ITEM] : [] };
        },
      }),
    },
    item: (id: string, pk: string) => ({
      replace: async (doc: any) => { world.replaced = { id, pk, doc }; return { resource: doc }; },
    }),
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

const currentSession = { value: null as any };
vi.mock('@/lib/auth/session', () => ({ getSession: () => currentSession.value }));

function sessionFor(oid: string, tid = TID) {
  const s = { claims: { oid, tid, groups: [] as string[] } } as any;
  currentSession.value = s; // what `ambientAccessOptsFor` recovers
  return s;
}

/** The path the WORKING route (/api/cosmos-items/[type]/[id]) takes. */
async function cosmosItemsCanRead(oid: string) {
  const { resolveItemAccessByOid } = await import('@/lib/auth/item-access');
  return !!(await resolveItemAccessByOid(sessionFor(oid), ITEM.id, ITEM.itemType));
}

/** The path the BROKEN data-pipeline editor takes. */
async function bindingResolves(oid: string) {
  const { resolveBinding } = await import('@/lib/azure/pipeline-binding');
  sessionFor(oid);
  try {
    const b = await resolveBinding(ITEM.id, ACCEPTED_TYPES, oid);
    return b.pipelineName;
  } catch {
    return null;
  }
}

beforeEach(() => {
  world.aclRole = null;
  world.admins = new Set([ADMIN]);
  world.replaced = null;
  currentSession.value = null;
});

describe('#2942 an item readable via /api/cosmos-items is resolvable by resolveBinding', () => {
  it('holds for the workspace CREATOR (the unchanged path)', async () => {
    expect(await cosmosItemsCanRead(CREATOR)).toBe(true);
    expect(await bindingResolves(CREATOR)).toBe('ingest_orders');
  });

  it('holds for a TENANT ADMIN who did not create the workspace — the live #2942 repro', async () => {
    // Before the fix this pair diverged: cosmos-items 200, resolveBinding threw
    // ItemNotFoundError → "Item <id> (adf-pipeline) not found in this tenant."
    expect(await cosmosItemsCanRead(ADMIN)).toBe(true);
    expect(await bindingResolves(ADMIN)).toBe('ingest_orders');
  });

  it('holds for a shared workspace MEMBER', async () => {
    world.aclRole = 'Member';
    expect(await cosmosItemsCanRead(MEMBER)).toBe(true);
    expect(await bindingResolves(MEMBER)).toBe('ingest_orders');
  });

  it('the two resolvers agree for every principal in the estate (no divergence)', async () => {
    for (const [oid, role] of [[CREATOR, null], [ADMIN, null], [MEMBER, 'Member'], [STRANGER, null]] as const) {
      world.aclRole = role;
      const readable = await cosmosItemsCanRead(oid);
      const bindable = (await bindingResolves(oid)) !== null;
      expect(bindable, `divergence for ${oid} (role=${role}): cosmos-items=${readable} binding=${bindable}`)
        .toBe(readable);
    }
  });
});

describe('#2942 the fix does not widen access', () => {
  it('a stranger with no role is still refused by BOTH paths', async () => {
    expect(await cosmosItemsCanRead(STRANGER)).toBe(false);
    expect(await bindingResolves(STRANGER)).toBeNull();
  });

  it('a cross-tenant caller is refused even holding an ACL row (tid boundary)', async () => {
    world.aclRole = 'Member';
    const { resolveBinding } = await import('@/lib/azure/pipeline-binding');
    sessionFor(STRANGER, 'entra-tenant-OTHER');
    await expect(resolveBinding(ITEM.id, ACCEPTED_TYPES, STRANGER)).rejects.toThrow(/not found in this tenant/);
  });

  it('an ItemNotFoundError is still raised for an id that does not exist', async () => {
    const { resolveBinding, ItemNotFoundError } = await import('@/lib/azure/pipeline-binding');
    sessionFor(ADMIN);
    await expect(resolveBinding('no-such-item', ACCEPTED_TYPES, ADMIN)).rejects.toBeInstanceOf(ItemNotFoundError);
  });
});

describe('#2942 WRITE strictness — a read-only role must not be able to re-bind', () => {
  it('a Viewer may READ the item but persistBinding refuses (write-scoped)', async () => {
    world.aclRole = 'Viewer';
    const { loadPipelineItem, persistBinding, ItemNotFoundError } = await import('@/lib/azure/pipeline-binding');
    sessionFor(VIEWER);

    // read-only opt-in resolves...
    expect(await loadPipelineItem(ITEM.id, ACCEPTED_TYPES, VIEWER, { allowReadRoles: true })).toBeTruthy();
    // ...but the default (write) scope, and therefore the bind mutation, does not.
    expect(await loadPipelineItem(ITEM.id, ACCEPTED_TYPES, VIEWER)).toBeNull();
    await expect(persistBinding(ITEM.id, ACCEPTED_TYPES, VIEWER, { pipelineName: 'evil' }))
      .rejects.toBeInstanceOf(ItemNotFoundError);
    expect(world.replaced, 'no Cosmos write may happen for a read-only caller').toBeNull();
  });

  it('a write-capable Member CAN re-bind', async () => {
    world.aclRole = 'Member';
    const { persistBinding } = await import('@/lib/azure/pipeline-binding');
    sessionFor(MEMBER);
    const updated = await persistBinding(ITEM.id, ACCEPTED_TYPES, MEMBER, { pipelineName: 'ingest_orders_v2' });
    expect(updated.state?.pipelineName).toBe('ingest_orders_v2');
    expect(world.replaced?.pk).toBe(WS.id);
  });

  it('a tenant ADMIN can re-bind (canWrite via the admin-open bypass)', async () => {
    const { persistBinding } = await import('@/lib/azure/pipeline-binding');
    sessionFor(ADMIN);
    const updated = await persistBinding(ITEM.id, ACCEPTED_TYPES, ADMIN, { pipelineName: 'ingest_orders_v3' });
    expect(updated.state?.pipelineName).toBe('ingest_orders_v3');
  });
});
