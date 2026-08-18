/**
 * GET /api/items/spark-job-definition/[id]/runs — review of PR #3689, blocker 2.
 *
 * Same defect as the synapse-spark-pool runs route: `from` defaulted to 0,
 * which is the OLDEST end of Livy's ascending batch-id list, and the editor
 * (`spark-job-definition-editor.tsx`) calls `?size=25` with no `from` and never
 * pages — so that default WAS the Runs grid. Forwarding `truncatedBy` via
 * `...res` never made those rows recent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const listRecent = vi.fn();
const listOffset = vi.fn();

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'tenant-1' } }),
}));

vi.mock('../../../../_lib/item-crud', () => ({
  jerr: (error: string, status: number) =>
    new Response(JSON.stringify({ ok: false, error }), { status, headers: { 'content-type': 'application/json' } }),
  loadOwnedItem: async () => ({ id: 'sjd-1', state: { spec: { pool: 'loompool' } } }),
}));

vi.mock('@/lib/azure/synapse-dev-client', () => ({
  listRecentSparkBatchJobs: (...a: unknown[]) => listRecent(...a),
  listSparkBatchJobs: (...a: unknown[]) => listOffset(...a),
}));

import { NextRequest } from 'next/server';
import { GET } from '../route';

const call = (qs: string) =>
  GET(new NextRequest(`http://localhost/api/items/spark-job-definition/sjd-1/runs${qs}`), {
    params: Promise.resolve({ id: 'sjd-1' }),
  });

beforeEach(() => {
  listRecent.mockReset();
  listOffset.mockReset();
  listRecent.mockResolvedValue({ sessions: [{ id: 77 }], total: 300, scanned: 25, truncatedBy: null });
  listOffset.mockResolvedValue({ from: 5, total: 300, sessions: [{ id: 5 }], truncatedBy: null });
});

describe('/api/items/spark-job-definition/[id]/runs', () => {
  it('defaults to the MOST RECENT batches at the editor\'s size=25', async () => {
    const body = await (await call('?size=25')).json();

    expect(listRecent).toHaveBeenCalledWith('loompool', 25);
    expect(listOffset).not.toHaveBeenCalled();
    expect(body.pool).toBe('loompool');
    expect(body.sessions.map((s: { id: number }) => s.id)).toEqual([77]);
  });

  it('honors an EXPLICIT `from` as a raw offset window', async () => {
    await call('?size=25&from=5');

    expect(listOffset).toHaveBeenCalledWith('loompool', 5, 25);
    expect(listRecent).not.toHaveBeenCalled();
  });

  it('forwards truncatedBy so a cut-short window is visible', async () => {
    listRecent.mockResolvedValue({ sessions: [], total: 4000, scanned: 20, truncatedBy: 'time' });

    const body = await (await call('')).json();

    expect(body.truncatedBy).toBe('time');
    expect(body.scanned).toBe(20);
    expect(body.total).toBe(4000);
  });
});
