/**
 * DBX-4 — lakebase-store: read/merge/effective-backend + history capping.
 * Cosmos is mocked; asserts the persisted state.lakebase shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const replace = vi.fn(async (next: any) => ({ resource: next }));
const itemFn = vi.fn(() => ({ replace }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({ item: itemFn })),
}));

import {
  readLakebase, effectiveBackend, saveLakebase, recordSnapshot, recordBranch,
} from '../lakebase-store';

const baseItem: any = { id: 'i1', workspaceId: 'ws1', itemType: 'lakebase-postgres', displayName: 'LB', state: {} };

beforeEach(() => { vi.clearAllMocks(); });

describe('readLakebase / effectiveBackend', () => {
  it('returns empty state and defaults to the Azure-native postgres backend', () => {
    expect(readLakebase(baseItem)).toEqual({});
    expect(effectiveBackend(baseItem)).toBe('postgres');
  });
  it('reports databricks only when explicitly selected', () => {
    expect(effectiveBackend({ ...baseItem, state: { lakebase: { backend: 'databricks' } } })).toBe('databricks');
    expect(effectiveBackend({ ...baseItem, state: { lakebase: { backend: 'postgres' } } })).toBe('postgres');
  });
});

describe('saveLakebase', () => {
  it('merges a patch onto state.lakebase and persists via replace', async () => {
    const updated = await saveLakebase(baseItem, { server: { name: 's', id: '/s', fqdn: 's.pg' }, backend: 'postgres' });
    expect((updated.state as any).lakebase.server.name).toBe('s');
    expect((updated.state as any).lakebase.backend).toBe('postgres');
    expect(replace).toHaveBeenCalledOnce();
    expect(itemFn).toHaveBeenCalledWith('i1', 'ws1');
  });
});

describe('recordSnapshot / recordBranch', () => {
  it('prepends and caps history at 50', async () => {
    const many = Array.from({ length: 55 }, (_, i) => ({ id: `s${i}`, label: `l${i}`, pointInTimeUTC: 'x', createdAt: 'x' }));
    const item = { ...baseItem, state: { lakebase: { snapshots: many } } };
    const updated = await recordSnapshot(item, { id: 'new', label: 'newest', pointInTimeUTC: 'x', createdAt: 'x' });
    const snaps = (updated.state as any).lakebase.snapshots;
    expect(snaps[0].id).toBe('new');
    expect(snaps.length).toBe(50);
  });
  it('records a branch newest-first', async () => {
    const updated = await recordBranch(baseItem, { id: 'b1', name: 'branch', pointInTimeUTC: 'x', createdAt: 'x' });
    expect((updated.state as any).lakebase.branches[0].name).toBe('branch');
  });
});
