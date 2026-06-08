import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Cosmos client BEFORE importing the module under test.
const itemsQuery = vi.fn();
const wsRead = vi.fn();
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    items: { query: (spec: any) => ({ fetchAll: () => itemsQuery(spec) }) },
  })),
  workspacesContainer: vi.fn(async () => ({
    item: (_id: string, _pk: string) => ({ read: () => wsRead() }),
  })),
}));
// Stub the side-effect modules item-crud imports so we don't pull @azure/* at load.
vi.mock('@/lib/azure/loom-search', () => ({
  upsertLoomDoc: vi.fn(), deleteLoomDoc: vi.fn(), docForItem: vi.fn(() => ({})),
}));
vi.mock('@/lib/azure/purview-autoonboard', () => ({ autoOnboardToPurview: vi.fn() }));

import { applyLabelInheritance } from '../item-crud';

const TENANT = 'tenant-1';

beforeEach(() => {
  itemsQuery.mockReset();
  wsRead.mockReset();
  // Default: any workspace lookup resolves to the caller's tenant (owned).
  wsRead.mockResolvedValue({ resource: { tenantId: TENANT } });
});

describe('applyLabelInheritance (F16)', () => {
  it('inherits the parent label when the child has none', async () => {
    itemsQuery.mockResolvedValue({
      resources: [{ id: 'parent', workspaceId: 'ws-1', displayName: 'Gold LH', state: { sensitivityLabel: 'Confidential' } }],
    });
    const state = await applyLabelInheritance({ lakehouseId: 'parent' }, TENANT);
    expect(state.sensitivityLabel).toBe('Confidential');
    expect(state.sensitivityLabelInherited).toBe(true);
    expect(state.sensitivityLabelSource).toEqual({ itemId: 'parent', displayName: 'Gold LH', label: 'Confidential' });
  });

  it('honors an explicit override and marks it non-inherited', async () => {
    itemsQuery.mockResolvedValue({
      resources: [{ id: 'parent', workspaceId: 'ws-1', displayName: 'Gold LH', state: { sensitivityLabel: 'Internal' } }],
    });
    const state = await applyLabelInheritance({ lakehouseId: 'parent', sensitivityLabel: 'Restricted' }, TENANT);
    expect(state.sensitivityLabel).toBe('Restricted');
    expect(state.sensitivityLabelInherited).toBe(false);
    // Provenance still recorded so the UI can show what upstream carried.
    expect(state.sensitivityLabelSource).toEqual({ itemId: 'parent', displayName: 'Gold LH', label: 'Internal' });
  });

  it('picks the MOST restrictive among multiple sources', async () => {
    itemsQuery
      .mockResolvedValueOnce({ resources: [{ id: 'a', workspaceId: 'ws-1', displayName: 'A', state: { sensitivityLabel: 'General' } }] })
      .mockResolvedValueOnce({ resources: [{ id: 'b', workspaceId: 'ws-1', displayName: 'B', state: { sensitivityLabel: 'Highly Confidential' } }] });
    const state = await applyLabelInheritance({ lakehouseId: 'a', warehouseId: 'b' }, TENANT);
    expect(state.sensitivityLabel).toBe('Highly Confidential');
  });

  it('does not inherit from a source owned by a different tenant', async () => {
    itemsQuery.mockResolvedValue({
      resources: [{ id: 'parent', workspaceId: 'ws-x', displayName: 'Foreign', state: { sensitivityLabel: 'Confidential' } }],
    });
    wsRead.mockResolvedValue({ resource: { tenantId: 'other-tenant' } });
    const state = await applyLabelInheritance({ lakehouseId: 'parent' }, TENANT);
    expect(state.sensitivityLabel).toBeUndefined();
    expect(state.sensitivityLabelInherited).toBeUndefined();
  });

  it('is a no-op when there is no upstream reference', async () => {
    const state = await applyLabelInheritance({ foo: 'bar' }, TENANT);
    expect(state).toEqual({ foo: 'bar' });
    expect(itemsQuery).not.toHaveBeenCalled();
  });
});
