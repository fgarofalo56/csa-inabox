import { describe, it, expect, vi, beforeEach } from 'vitest';

// All Cosmos ops mocked via vi.hoisted so the hoisted vi.mock factory can use them.
const h = vi.hoisted(() => ({
  query: vi.fn(),
  upsert: vi.fn(),
  itemDelete: vi.fn(),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  threadEdgesContainer: vi.fn(async () => ({
    items: {
      query: (spec: any) => ({ fetchAll: () => h.query(spec) }),
      upsert: (doc: any) => h.upsert(doc),
    },
    item: (id: string, pk: string) => ({ delete: () => h.itemDelete(id, pk) }),
  })),
}));

import {
  reconcileThreadEdgesOnDelete, restoreThreadEdgesForItem, listThreadEdges,
  type ThreadEdge,
} from '../thread-edges';

const TENANT = 'tenant-1';
const session = { claims: { oid: TENANT, upn: 'a@contoso.com' } } as any;

const edge = (over: Partial<ThreadEdge> = {}): ThreadEdge => ({
  id: 'edge_1', tenantId: TENANT,
  fromItemId: 'lh-1', fromType: 'lakehouse', fromName: 'Sales LH',
  toItemId: 'nb-1', toType: 'notebook', toName: 'Explore',
  action: 'analyze-in-notebook', createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => { Object.values(h).forEach((fn) => fn.mockReset()); });

describe('reconcileThreadEdgesOnDelete', () => {
  it("mode:'remove' hard-deletes every edge touching the item (partition-keyed)", async () => {
    h.query.mockResolvedValue({ resources: [edge({ id: 'edge_1' }), edge({ id: 'edge_2', toItemId: 'lh-1', fromItemId: 'wh-9' })] });
    await reconcileThreadEdgesOnDelete(TENANT, 'lh-1', { mode: 'remove' });
    expect(h.itemDelete).toHaveBeenCalledWith('edge_1', TENANT);
    expect(h.itemDelete).toHaveBeenCalledWith('edge_2', TENANT);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("mode:'tombstone' stamps deletedAt + staleItemIds instead of deleting", async () => {
    h.query.mockResolvedValue({ resources: [edge()] });
    await reconcileThreadEdgesOnDelete(TENANT, 'lh-1', { mode: 'tombstone' });
    expect(h.itemDelete).not.toHaveBeenCalled();
    const doc = h.upsert.mock.calls[0][0] as ThreadEdge;
    expect(typeof doc.deletedAt).toBe('string');
    expect(doc.staleItemIds).toEqual(['lh-1']);
  });

  it('accumulates a second tombstoning endpoint without duplicating', async () => {
    h.query.mockResolvedValue({ resources: [edge({ deletedAt: '2026-02-01T00:00:00.000Z', staleItemIds: ['lh-1'] })] });
    await reconcileThreadEdgesOnDelete(TENANT, 'nb-1', { mode: 'tombstone' });
    const doc = h.upsert.mock.calls[0][0] as ThreadEdge;
    expect(doc.staleItemIds).toEqual(['lh-1', 'nb-1']);
    expect(doc.deletedAt).toBe('2026-02-01T00:00:00.000Z'); // keeps original tombstone time
  });

  it('is best-effort — swallows query errors and never throws', async () => {
    h.query.mockRejectedValue(new Error('cosmos down'));
    await expect(reconcileThreadEdgesOnDelete(TENANT, 'lh-1', { mode: 'remove' })).resolves.toBeUndefined();
  });

  it('no-ops when tenantId or itemId is missing', async () => {
    await reconcileThreadEdgesOnDelete('', 'lh-1', { mode: 'remove' });
    await reconcileThreadEdgesOnDelete(TENANT, '', { mode: 'remove' });
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('restoreThreadEdgesForItem', () => {
  it('clears deletedAt + staleItemIds when the last tombstoning item is restored', async () => {
    h.query.mockResolvedValue({ resources: [edge({ deletedAt: '2026-02-01T00:00:00.000Z', staleItemIds: ['lh-1'] })] });
    await restoreThreadEdgesForItem(TENANT, 'lh-1');
    const doc = h.upsert.mock.calls[0][0] as ThreadEdge;
    expect(doc.deletedAt).toBeUndefined();
    expect(doc.staleItemIds).toBeUndefined();
  });

  it('keeps the edge tombstoned while another endpoint is still deleted', async () => {
    h.query.mockResolvedValue({ resources: [edge({ deletedAt: '2026-02-01T00:00:00.000Z', staleItemIds: ['lh-1', 'nb-1'] })] });
    await restoreThreadEdgesForItem(TENANT, 'lh-1');
    const doc = h.upsert.mock.calls[0][0] as ThreadEdge;
    expect(doc.staleItemIds).toEqual(['nb-1']);
    expect(doc.deletedAt).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('listThreadEdges', () => {
  it('excludes tombstoned edges by default (no stale lineage)', async () => {
    h.query.mockResolvedValue({ resources: [edge()] });
    await listThreadEdges(session);
    const spec = h.query.mock.calls[0][0];
    expect(spec.query).toContain('NOT IS_DEFINED(c.deletedAt)');
  });

  it('includes tombstoned edges when includeStale is set', async () => {
    h.query.mockResolvedValue({ resources: [edge()] });
    await listThreadEdges(session, { includeStale: true });
    const spec = h.query.mock.calls[0][0];
    expect(spec.query).not.toContain('deletedAt');
  });
});
