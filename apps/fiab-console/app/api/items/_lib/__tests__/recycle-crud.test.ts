import { describe, it, expect, vi, beforeEach } from 'vitest';

// All mock fns must be created via vi.hoisted so the hoisted vi.mock factories
// below can reference them without the "cannot access before initialization" trap.
const h = vi.hoisted(() => ({
  itemsQuery: vi.fn(),
  itemReplace: vi.fn(),
  itemDelete: vi.fn(),
  wsRead: vi.fn(),
  softDeleteDirectory: vi.fn(),
  unDeleteDirectory: vi.fn(),
  deleteLoomDoc: vi.fn(),
  upsertLoomDoc: vi.fn(),
  deleteGovernanceItem: vi.fn(),
  reconcileThreadEdgesOnDelete: vi.fn(),
  restoreThreadEdgesForItem: vi.fn(),
}));

// ── Cosmos mock: items.query().fetchAll(), item(id,pk).replace()/.delete(),
//    workspaces item(id,pk).read(). ──────────────────────────────────────────
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    items: { query: (spec: any) => ({ fetchAll: () => h.itemsQuery(spec) }) },
    item: (id: string, pk: string) => ({
      replace: (doc: any) => h.itemReplace(id, pk, doc),
      delete: () => h.itemDelete(id, pk),
    }),
  })),
  workspacesContainer: vi.fn(async () => ({
    item: (id: string, pk: string) => ({ read: () => h.wsRead(id, pk) }),
  })),
  tenantSettingsContainer: vi.fn(async () => ({ item: () => ({ read: vi.fn() }) })),
}));

// ── Side-effect indexes — stubbed so we don't pull @azure/* at load. ────────
vi.mock('@/lib/azure/loom-search', () => ({
  upsertLoomDoc: h.upsertLoomDoc, deleteLoomDoc: h.deleteLoomDoc, docForItem: vi.fn(() => ({ id: 'it:x' })),
}));
vi.mock('@/lib/azure/loom-data-products-search', () => ({
  upsertDataProductDoc: vi.fn(), deleteDataProductDoc: vi.fn(), docForDataProduct: vi.fn(() => ({})),
}));
vi.mock('@/lib/azure/governance-catalog-index', () => ({
  upsertGovernanceItem: vi.fn(), deleteGovernanceItem: h.deleteGovernanceItem,
  docForGovernanceItem: vi.fn(() => ({})), isCatalogDataType: vi.fn(() => false),
}));
vi.mock('@/lib/azure/purview-autoonboard', () => ({ autoOnboardToPurview: vi.fn() }));

// ── ADLS soft-delete / restore — the dynamic imports inside item-crud. ──────
vi.mock('@/lib/azure/adls-client', () => ({
  softDeleteDirectory: h.softDeleteDirectory, unDeleteDirectory: h.unDeleteDirectory,
}));

// ── Thread-edge lineage reconcile — best-effort hooks fired on delete/restore. ─
vi.mock('@/lib/thread/thread-edges', () => ({
  reconcileThreadEdgesOnDelete: h.reconcileThreadEdgesOnDelete,
  restoreThreadEdgesForItem: h.restoreThreadEdgesForItem,
}));

import { softDeleteOwnedItem, restoreOwnedItem, purgeRecycledItem } from '../item-crud';

const TENANT = 'tenant-1';

beforeEach(() => {
  Object.values(h).forEach((fn) => fn.mockReset());
  process.env.LOOM_RECYCLE_RETENTION_DAYS = '14';
  h.wsRead.mockResolvedValue({ resource: { tenantId: TENANT } });
  h.itemReplace.mockImplementation((_id: string, _pk: string, doc: any) => ({ resource: doc }));
});

const activeItem = {
  id: 'item-1', workspaceId: 'ws-1', itemType: 'lakehouse',
  displayName: 'Sales LH', state: { sensitivityLabel: 'Confidential' },
  createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('softDeleteOwnedItem', () => {
  it('stamps state._recycled (deletedAt/by/purgeAfter) and removes from indexes', async () => {
    h.itemsQuery.mockResolvedValue({ resources: [activeItem] });
    const out = await softDeleteOwnedItem('item-1', 'lakehouse', TENANT, 'alice@contoso.com');
    expect(out).not.toBeNull();
    const r = (out!.state as any)._recycled;
    expect(r.deletedBy).toBe('alice@contoso.com');
    expect(typeof r.deletedAt).toBe('string');
    // purgeAfter = deletedAt + 14 days.
    const span = new Date(r.purgeAfter).getTime() - new Date(r.deletedAt).getTime();
    expect(span).toBe(14 * 86_400_000);
    // Pre-existing state preserved.
    expect((out!.state as any).sensitivityLabel).toBe('Confidential');
    // Invisible until restored.
    expect(h.deleteLoomDoc).toHaveBeenCalledWith('it:item-1');
    expect(h.deleteGovernanceItem).toHaveBeenCalledWith('item-1');
    // No ADLS hints → no soft-delete calls, no adlsRefs.
    expect(h.softDeleteDirectory).not.toHaveBeenCalled();
    expect(r.adlsRefs).toBeUndefined();
    // Lineage auto-reconcile: tombstone (not hard-remove) the item's edges.
    expect(h.reconcileThreadEdgesOnDelete).toHaveBeenCalledWith(TENANT, 'item-1', { mode: 'tombstone' });
  });

  it('soft-deletes supplied ADLS folders and captures their deletionId', async () => {
    h.itemsQuery.mockResolvedValue({ resources: [activeItem] });
    h.softDeleteDirectory.mockResolvedValue({ deletionId: 'del-99' });
    const out = await softDeleteOwnedItem('item-1', 'lakehouse', TENANT, 'alice', [
      { container: 'bronze', path: 'lakehouses/sales-lh' },
    ]);
    expect(h.softDeleteDirectory).toHaveBeenCalledWith('bronze', 'lakehouses/sales-lh');
    const refs = (out!.state as any)._recycled.adlsRefs;
    expect(refs).toEqual([{ container: 'bronze', path: 'lakehouses/sales-lh', deletionId: 'del-99' }]);
  });

  it('returns null when the item is not owned by the tenant', async () => {
    h.itemsQuery.mockResolvedValue({ resources: [activeItem] });
    h.wsRead.mockResolvedValue({ resource: { tenantId: 'other' } });
    const out = await softDeleteOwnedItem('item-1', 'lakehouse', TENANT, 'alice');
    expect(out).toBeNull();
    expect(h.itemReplace).not.toHaveBeenCalled();
  });
});

describe('restoreOwnedItem', () => {
  const recycledItem = {
    ...activeItem,
    state: {
      sensitivityLabel: 'Confidential',
      _recycled: {
        deletedAt: '2026-02-01T00:00:00.000Z', deletedBy: 'alice', purgeAfter: '2026-02-15T00:00:00.000Z',
        adlsRefs: [{ container: 'bronze', path: 'lakehouses/sales-lh', deletionId: 'del-99' }],
      },
    },
  };

  it('clears _recycled, un-deletes ADLS folders, and re-indexes', async () => {
    h.itemsQuery.mockResolvedValue({ resources: [recycledItem] });
    const out = await restoreOwnedItem('item-1', TENANT);
    expect(out).not.toBeNull();
    expect((out!.state as any)._recycled).toBeUndefined();
    // Other state survives.
    expect((out!.state as any).sensitivityLabel).toBe('Confidential');
    expect(h.unDeleteDirectory).toHaveBeenCalledWith('bronze', 'lakehouses/sales-lh', 'del-99');
    expect(h.upsertLoomDoc).toHaveBeenCalled();
    // Lineage auto-reconcile: un-tombstone the item's edges on restore.
    expect(h.restoreThreadEdgesForItem).toHaveBeenCalledWith(TENANT, 'item-1');
  });

  it('returns null when the id is not a recycled item', async () => {
    h.itemsQuery.mockResolvedValue({ resources: [] });
    const out = await restoreOwnedItem('missing', TENANT);
    expect(out).toBeNull();
    expect(h.itemReplace).not.toHaveBeenCalled();
  });
});

describe('purgeRecycledItem', () => {
  it('hard-deletes a recycled item the tenant owns', async () => {
    h.itemsQuery.mockResolvedValue({ resources: [{ ...activeItem, state: { _recycled: { deletedAt: 'x', deletedBy: 'a', purgeAfter: 'y' } } }] });
    const ok = await purgeRecycledItem('item-1', TENANT);
    expect(ok).toBe(true);
    expect(h.itemDelete).toHaveBeenCalledWith('item-1', 'ws-1');
    expect(h.deleteLoomDoc).toHaveBeenCalledWith('it:item-1');
    expect(h.deleteGovernanceItem).toHaveBeenCalledWith('item-1');
    // Lineage auto-reconcile: hard-remove the item's edges on purge.
    expect(h.reconcileThreadEdgesOnDelete).toHaveBeenCalledWith(TENANT, 'item-1', { mode: 'remove' });
  });

  it('returns false when the item is not in the recycle bin', async () => {
    h.itemsQuery.mockResolvedValue({ resources: [] });
    const ok = await purgeRecycledItem('item-1', TENANT);
    expect(ok).toBe(false);
    expect(h.itemDelete).not.toHaveBeenCalled();
  });
});
