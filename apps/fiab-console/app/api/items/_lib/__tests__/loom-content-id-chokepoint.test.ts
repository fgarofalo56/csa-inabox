/**
 * #2830 — the `loom:` bundle-template id resolves at the COSMOS CHOKEPOINTS.
 *
 * THE CLASS. A bundle-installed item is listed under the SYNTHETIC id
 * `loom:<cosmosItemId>` (`_lib/loom-content-id.ts`), and the editor threads
 * whatever the list route handed it into EVERY sub-route. Cosmos stores the item
 * under the BARE id, so any lookup that runs `WHERE c.id = @id` with the
 * prefixed form matched NOTHING and 404'd on an item that exists.
 *
 * That defect shipped four times — #2649 (detail), #2818 (/refreshes), #2822
 * (/roles), #2830 (report /pages) — and each fix resolved the id inside ONE
 * route and left the siblings. The two functions below are where every one of
 * those routes actually reaches Cosmos by id:
 *
 *   loadOwnedItem   — `WHERE c.id = @id AND c.itemType = @t`, and through it
 *                     updateOwnedItem / deleteOwnedItem / softDeleteOwnedItem /
 *                     readModelState / writeModelState / the checkpoint,
 *                     prep-for-ai, verified-queries and scorecard-goal stores.
 *   getModelItem    — an exact `it.id === modelId` match over the owned items,
 *                     and through it listTables / listMeasures / evalDax /
 *                     warmSemanticModel (DAX query, semantic link, model health,
 *                     Prep for AI).
 *
 * Resolving there makes the class impossible rather than fixing its instances.
 *
 * HOW THE MOCKS DISCRIMINATE. The Cosmos mock is a REAL keyed lookup that
 * honours the `@id` / `@t` parameters exactly the way the SQL predicate does, so
 * an unresolved `loom:` prefix misses on its own — it is not asserted into
 * existence.
 *
 * CONTROLS (green with AND without the fix, so an over-broad id rewrite is
 * caught): a plain Cosmos id reaches the query byte-identical; a Power BI-shaped
 * GUID is likewise untouched; a `loom:` id with no backing item still resolves
 * to null; and the workspace-authorization gate still rejects an item the caller
 * cannot see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceItem } from '@/lib/types/workspace';

const h = vi.hoisted(() => ({
  /** Cosmos `items` container contents, keyed by the REAL (bare) doc id. */
  store: new Map<string, any>(),
  /** Every query spec the code sent to Cosmos — the byte-level receipt. */
  queries: [] as Array<{ query: string; parameters: Array<{ name: string; value: any }> }>,
  access: vi.fn(async (_tid: string, _ws: string) => ({ canWrite: true }) as any),
}));

function param(spec: any, name: string) {
  return (spec?.parameters || []).find((p: any) => p.name === name)?.value;
}

vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: (...a: any[]) => h.access(...(a as [string, string])),
  // #3697 — item-crud builds its access options through this helper now. These
  // specs assert the `loom:` id chokepoint, not the admin path, so the stub
  // returns the same "no ambient session" shape the real helper yields
  // off-request.
  ambientAccessOptsFor: async () => ({ callerTid: undefined }),
}));
vi.mock('@/lib/auth/workspace-list-access', () => ({ authorizeWorkspaceList: vi.fn(async () => ({ canWrite: true })) }));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeWorkspace: vi.fn(async () => true) }));
vi.mock('@/lib/auth/session', () => ({ getSession: () => ({ claims: { oid: 'oid-1' } }) }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => {
        h.queries.push(spec);
        const id = param(spec, '@id');
        const type = param(spec, '@t');
        // Mirrors the real predicates: exact id match, optional itemType match,
        // and the type-only listing query used by listOwnedItems.
        const all = [...h.store.values()];
        const resources = all.filter(
          (r) => (id === undefined || r.id === id) && (type === undefined || r.itemType === type),
        );
        return { fetchAll: async () => ({ resources }) };
      },
    },
    item: () => ({ replace: async (d: any) => ({ resource: d }), delete: async () => undefined }),
  }),
  workspacesContainer: async () => ({
    item: () => ({ read: async () => ({ resource: { id: 'ws-1', tenantId: 'oid-1' } }) }),
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
  tenantSettingsContainer: async () => ({
    item: () => ({ read: async () => ({ resource: undefined }) }),
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }), upsert: async () => undefined },
  }),
}));
vi.mock('@/lib/azure/loom-search', () => ({ upsertLoomDoc: vi.fn(), deleteLoomDoc: vi.fn(), docForItem: vi.fn() }));
vi.mock('@/lib/azure/loom-data-products-search', () => ({
  upsertDataProductDoc: vi.fn(), deleteDataProductDoc: vi.fn(), docForDataProduct: vi.fn(),
}));
vi.mock('@/lib/azure/governance-catalog-index', () => ({
  upsertGovernanceItem: vi.fn(), deleteGovernanceItem: vi.fn(),
  docForGovernanceItem: vi.fn(), isCatalogDataType: vi.fn(() => false),
}));
vi.mock('@/lib/azure/purview-autoonboard', () => ({ autoOnboardToPurview: vi.fn(), offboardFromPurview: vi.fn() }));
vi.mock('@/lib/thread/thread-edges', () => ({
  reconcileThreadEdgesOnDelete: vi.fn(), restoreThreadEdgesForItem: vi.fn(),
}));
vi.mock('@/lib/versions/item-version-store', () => ({ recordItemVersion: vi.fn() }));
vi.mock('@/lib/events/webhook-emitter', () => ({ emitLoomEvent: vi.fn() }));

import { loadOwnedItem, updateOwnedItem } from '../item-crud';
import { getModelItem } from '@/lib/azure/tabular-eval-client';

const COSMOS_ID = '8872fd18-f6a8-4a08-aade-7ee7dc3960d3';
const LOOM_ID = `loom:${COSMOS_ID}`;
/** A live Power BI dataset GUID — must never be rewritten. */
const PBI_ID = 'c0ffee11-2233-4455-6677-889900aabbcc';

function seed(id: string, itemType: string, state: Record<string, unknown> = {}) {
  h.store.set(id, {
    id, itemType, workspaceId: 'ws-1', displayName: 'Seeded', state,
    createdBy: 'u', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  } as unknown as WorkspaceItem);
}

/** The `@id` values that actually reached Cosmos. */
const idsQueried = () => h.queries.map((q) => param(q, '@id')).filter((v) => v !== undefined);

beforeEach(() => {
  h.store.clear();
  h.queries.length = 0;
  vi.clearAllMocks();
  h.access.mockImplementation(async () => ({ canWrite: true }) as any);
});

describe('loadOwnedItem — the shared Cosmos-by-id chokepoint', () => {
  it('resolves a `loom:` bundle-template id to the real item (the whole class)', async () => {
    seed(COSMOS_ID, 'report');
    const item = await loadOwnedItem(LOOM_ID, 'report', 'oid-1');
    expect(item?.id).toBe(COSMOS_ID);
    // The prefixed form NEVER reaches the `WHERE c.id = @id` predicate.
    expect(idsQueried()).toEqual([COSMOS_ID]);
    expect(idsQueried()).not.toContain(LOOM_ID);
  });

  it('propagates to updateOwnedItem — a template can be written through the prefixed id', async () => {
    seed(COSMOS_ID, 'semantic-model', { model: {} });
    const saved = await updateOwnedItem(LOOM_ID, 'semantic-model', 'oid-1', {
      state: { model: { securityRoles: [{ name: 'Region Managers' }] } },
    });
    expect(saved).not.toBeNull();
    expect((saved!.state as any).model.securityRoles[0].name).toBe('Region Managers');
  });

  it('CONTROL: a plain Cosmos id reaches the query byte-identical', async () => {
    seed(COSMOS_ID, 'report');
    const item = await loadOwnedItem(COSMOS_ID, 'report', 'oid-1');
    expect(item?.id).toBe(COSMOS_ID);
    expect(idsQueried()).toEqual([COSMOS_ID]);
  });

  it('CONTROL: a Power BI-shaped GUID is passed through untouched', async () => {
    const item = await loadOwnedItem(PBI_ID, 'semantic-model', 'oid-1');
    expect(item).toBeNull();
    expect(idsQueried()).toEqual([PBI_ID]);
  });

  it('CONTROL: a `loom:` id with no backing item still resolves to null', async () => {
    // The store is empty — this resolves an id, it does not invent an item.
    expect(await loadOwnedItem(LOOM_ID, 'report', 'oid-1')).toBeNull();
  });

  it('CONTROL: the workspace-authorization gate still rejects an unreachable item', async () => {
    seed(COSMOS_ID, 'report');
    h.access.mockImplementation(async () => null as any);
    expect(await loadOwnedItem(LOOM_ID, 'report', 'oid-1')).toBeNull();
  });

  it('CONTROL: the itemType predicate still discriminates', async () => {
    seed(COSMOS_ID, 'report');
    expect(await loadOwnedItem(LOOM_ID, 'semantic-model', 'oid-1')).toBeNull();
  });
});

describe('getModelItem — the tabular-eval chokepoint (DAX query / semantic link / model health / Prep for AI)', () => {
  it('resolves a `loom:` semantic-model id instead of throwing "not found"', async () => {
    seed(COSMOS_ID, 'semantic-model');
    const item = await getModelItem(LOOM_ID, 'oid-1');
    expect(item?.id).toBe(COSMOS_ID);
  });

  it('CONTROL: a plain model id still resolves', async () => {
    seed(COSMOS_ID, 'semantic-model');
    expect((await getModelItem(COSMOS_ID, 'oid-1'))?.id).toBe(COSMOS_ID);
  });

  it('CONTROL: an id that matches nothing is still null', async () => {
    seed(COSMOS_ID, 'semantic-model');
    expect(await getModelItem(PBI_ID, 'oid-1')).toBeNull();
  });
});
