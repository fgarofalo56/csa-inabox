/**
 * DELETE /api/items/eventstream/[id] must tear down the backing Event Hub +
 * Stream Analytics job, not just the Cosmos doc (the leak: the route deleted
 * only the doc, so every deleted eventstream stranded an `asa-loom-<id8>` job),
 * and (#5046) must require a write-capable workspace role first.
 *
 * Breaking inputs:
 *   - teardown asserted BEFORE the Cosmos delete: fails if the order flips
 *     (refs would be gone) or if teardown is removed.
 *   - a teardown report with orphans must reach the response as `warning` +
 *     `teardown.orphans` and the item must STILL be deleted: fails if the
 *     failure is swallowed or blocks the delete.
 *   - no session -> 401 and nothing touched (fails if withSession is dropped).
 *   - READER (authorizeItemWorkspace returns a 403): fails if the role check is
 *     removed - teardown or the Cosmos delete would run for a read-only caller.
 *   - authorize is called with allowReadRoles:false: fails if flipped to true,
 *     which would admit Viewers.
 *   - unknown id (item null): 404 and NOTHING torn down or deleted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

const order: string[] = [];
const deleteDoc = vi.fn(async () => { order.push('cosmos-delete'); });
const emptyReport = { status: 'ran', orphans: [] as any[], retained: [] as any[], removed: [] as any[] };
const teardown = vi.fn(async (_i: any, _t: string): Promise<any> => { order.push('teardown'); return emptyReport; });
const authorize = vi.fn(async (_s: any, _o: any): Promise<NextResponse | null> => null);

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: (s: any, o: any) => authorize(s, o) }));
vi.mock('@/lib/azure/kusto-client', () => {
  class KustoError extends Error { status = 500; }
  return { KustoError, loadKustoItem: vi.fn(), loadKustoItemUnscoped: vi.fn(), saveItemState: vi.fn() };
});
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({ item: () => ({ delete: deleteDoc }) })),
}));
vi.mock('@/lib/azure/item-teardown-registry', () => ({ teardownForItemDelete: (i: any, t: string) => teardown(i, t) }));
vi.mock('@/lib/items/record-open', () => ({ recordItemOpen: vi.fn() }));

import { getSession } from '@/lib/auth/session';
import { loadKustoItemUnscoped } from '@/lib/azure/kusto-client';
import { DELETE } from '../[id]/route';

const ctx = { params: Promise.resolve({ id: 'abcdef12-0000' }) };
const REQ = { nextUrl: { pathname: '/api/items/eventstream/abcdef12-0000' } } as any;

beforeEach(() => {
  order.length = 0;
  deleteDoc.mockClear();
  teardown.mockClear();
  authorize.mockReset();
  authorize.mockResolvedValue(null);
  (loadKustoItemUnscoped as any).mockReset();
  (getSession as any).mockReturnValue({ claims: { oid: 'oid1' } });
  (loadKustoItemUnscoped as any).mockResolvedValue({ id: 'abcdef12-0000', workspaceId: 'w1', displayName: 'es', state: { transportHub: 'h' } });
});

describe('DELETE /api/items/eventstream/[id]', () => {
  it('tears down the backend BEFORE deleting the Cosmos doc', async () => {
    const res = await DELETE(REQ, ctx);
    expect(res.status).toBe(200);
    expect(order).toEqual(['teardown', 'cosmos-delete']);
    expect(teardown.mock.calls[0][0]).toMatchObject({ id: 'abcdef12-0000', itemType: 'eventstream', state: { transportHub: 'h' } });
    expect(teardown.mock.calls[0][1]).toBe('oid1');
    const body = await res.json();
    expect(body.warning).toBeUndefined();
    expect(body.teardown.status).toBe('ran');
  });

  it('surfaces orphans as a warning + structured list and still deletes the item', async () => {
    const orphan = { kind: 'stream-analytics-job', ref: 'asa-loom-abcdef12', result: 'error', error: '403' };
    teardown.mockImplementationOnce(async () => {
      order.push('teardown');
      return { status: 'ran', orphans: [orphan], retained: [], removed: [], warning: 'Item deleted, but 1 backing resource(s) could not be removed and may still exist: stream-analytics-job asa-loom-abcdef12 (403).' };
    });
    const res = await DELETE(REQ, ctx);
    const body = await res.json();
    expect(deleteDoc).toHaveBeenCalledTimes(1);
    expect(body.ok).toBe(true);
    expect(body.warning).toContain('stream-analytics-job asa-loom-abcdef12');
    expect(body.teardown.orphans).toEqual([orphan]);
  });
});

describe('DELETE role check (#5046)', () => {
  it('authorizes against the item workspace with WRITE roles only (allowReadRoles:false)', async () => {
    await DELETE(REQ, ctx);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0][1]).toMatchObject({
      workspaceId: 'w1', itemId: 'abcdef12-0000', itemType: 'eventstream', allowReadRoles: false,
    });
  });

  it('a READER (guard refuses with 403) gets that refusal and nothing is torn down or deleted', async () => {
    authorize.mockResolvedValueOnce(NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }));
    const res = await DELETE(REQ, ctx);
    expect(res.status).toBe(403);
    expect(teardown, 'a read-only caller reached the backend teardown').not.toHaveBeenCalled();
    expect(deleteDoc, 'a read-only caller deleted the item').not.toHaveBeenCalled();
  });
});

describe('DELETE auth boundary', () => {
  it('returns 401 with no session and touches nothing', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await DELETE(REQ, ctx);
    expect(res.status).toBe(401);
    expect(loadKustoItemUnscoped).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown item and deletes nothing', async () => {
    (loadKustoItemUnscoped as any).mockResolvedValue(null);
    const res = await DELETE(REQ, ctx);
    expect(res.status).toBe(404);
    expect(authorize).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
  });
});
