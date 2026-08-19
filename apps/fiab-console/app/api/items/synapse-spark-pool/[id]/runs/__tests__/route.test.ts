/**
 * GET /api/items/synapse-spark-pool/[id]/runs — review of PR #3689, blocker 2.
 *
 * This route was described as "list recent Livy batches for the pool" and
 * defaulted `from` to 0. Livy lists batches in ASCENDING batch-id order and
 * `from` is an index into that list, so the default handed the editor the
 * pool's OLDEST batches. The editor (`azure-services-editors.tsx`) calls
 * `?size=20` with NO `from` and never pages, so that default WAS the surface.
 *
 * Reviewers of #3689 counted this route as already-correct because it forwards
 * `truncatedBy` via a `...res` spread. Forwarding the field does not make the
 * ROWS right — that is a separate defect, fixed here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const listRecent = vi.fn();
const listOffset = vi.fn();

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'tenant-1' } }),
}));

vi.mock('@/lib/azure/synapse-dev-client', () => ({
  listRecentSparkBatchJobs: (...a: unknown[]) => listRecent(...a),
  listSparkBatchJobs: (...a: unknown[]) => listOffset(...a),
}));

import { NextRequest } from 'next/server';
import { GET } from '../route';

const call = (qs: string) =>
  GET(new NextRequest(`http://localhost/api/items/synapse-spark-pool/loompool/runs${qs}`), {
    params: Promise.resolve({ id: 'loompool' }),
  });

beforeEach(() => {
  listRecent.mockReset();
  listOffset.mockReset();
  listRecent.mockResolvedValue({ sessions: [{ id: 99 }], total: 500, scanned: 20, truncatedBy: null });
  listOffset.mockResolvedValue({ from: 40, total: 500, sessions: [{ id: 40 }], truncatedBy: null });
});

describe('/api/items/synapse-spark-pool/[id]/runs', () => {
  it('defaults to the MOST RECENT batches — the editor never sends `from`', async () => {
    const body = await (await call('?size=20')).json();

    expect(listRecent).toHaveBeenCalledWith('loompool', 20);
    expect(listOffset).not.toHaveBeenCalled();
    expect(body.sessions.map((s: { id: number }) => s.id)).toEqual([99]);
  });

  it('honors an EXPLICIT `from` as a raw offset window, with no recency claim', async () => {
    await call('?size=20&from=40');

    expect(listOffset).toHaveBeenCalledWith('loompool', 40, 20);
    expect(listRecent).not.toHaveBeenCalled();
  });

  it('forwards truncatedBy from either path', async () => {
    listRecent.mockResolvedValue({ sessions: [], total: 900, scanned: 20, truncatedBy: 'time' });
    expect((await (await call('')).json()).truncatedBy).toBe('time');

    listOffset.mockResolvedValue({ from: 0, total: 900, sessions: [], truncatedBy: 'pages' });
    expect((await (await call('?from=0')).json()).truncatedBy).toBe('pages');
  });
});
