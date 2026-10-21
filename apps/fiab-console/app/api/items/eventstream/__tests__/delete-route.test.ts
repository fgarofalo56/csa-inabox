/**
 * DELETE /api/items/eventstream/[id] must tear down the backing Event Hub +
 * Stream Analytics job, not just the Cosmos doc (the leak: the route deleted
 * only the doc, so every deleted eventstream stranded an `asa-loom-<id8>` job).
 *
 * Breaking inputs:
 *   - teardown asserted BEFORE the Cosmos delete: fails if the order flips
 *     (refs would be gone) or if teardown is removed.
 *   - a teardown error row must reach the response as `warning` and the item
 *     must STILL be deleted: fails if the failure is swallowed or blocks.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const order: string[] = [];
const deleteDoc = vi.fn(async () => { order.push('cosmos-delete'); });
const teardown = vi.fn(async (_i: any, _t: string) => { order.push('teardown'); return { itemId: 'i', itemType: 'eventstream', displayName: 'es', resources: [] as any[] }; });

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(() => ({ claims: { oid: 'oid1' } })) }));
vi.mock('@/lib/azure/kusto-client', () => {
  class KustoError extends Error { status = 500; }
  return {
    KustoError,
    loadKustoItem: vi.fn(async () => ({ id: 'abcdef12-0000', workspaceId: 'w1', displayName: 'es', state: { transportHub: 'h' } })),
    saveItemState: vi.fn(),
  };
});
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({ item: () => ({ delete: deleteDoc }) })),
}));
vi.mock('@/lib/azure/resource-teardown', () => ({ teardownItemBackend: (i: any, t: string) => teardown(i, t) }));
vi.mock('@/lib/items/record-open', () => ({ recordItemOpen: vi.fn() }));

import { DELETE } from '../[id]/route';

const ctx = { params: Promise.resolve({ id: 'abcdef12-0000' }) };

beforeEach(() => { order.length = 0; deleteDoc.mockClear(); teardown.mockClear(); });

describe('DELETE /api/items/eventstream/[id]', () => {
  it('tears down the backend BEFORE deleting the Cosmos doc', async () => {
    const res = await DELETE({} as any, ctx);
    expect(res.status).toBe(200);
    expect(order).toEqual(['teardown', 'cosmos-delete']);
    expect(teardown.mock.calls[0][0]).toMatchObject({ id: 'abcdef12-0000', itemType: 'eventstream', state: { transportHub: 'h' } });
    expect(teardown.mock.calls[0][1]).toBe('oid1');
    const body = await res.json();
    expect(body.warning).toBeUndefined();
  });

  it('surfaces a failed teardown as a warning and still deletes the item', async () => {
    teardown.mockImplementationOnce(async () => {
      order.push('teardown');
      return { itemId: 'i', itemType: 'eventstream', displayName: 'es', resources: [{ kind: 'stream-analytics-job', ref: 'asa-loom-abcdef12', result: 'error', error: '403' }] };
    });
    const res = await DELETE({} as any, ctx);
    const body = await res.json();
    expect(deleteDoc).toHaveBeenCalledTimes(1);
    expect(body.ok).toBe(true);
    expect(body.warning).toContain('stream-analytics-job asa-loom-abcdef12');
  });
});
