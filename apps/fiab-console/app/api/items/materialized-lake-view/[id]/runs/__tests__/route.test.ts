/**
 * /api/items/materialized-lake-view/[id]/runs — review of PR #3689, blocker 2.
 *
 * This route called `listSparkBatchJobs(pool, 0, 100)`. TWO things were wrong
 * and the clamp alone would have hidden the worse one:
 *
 *   • `size=100` is over Livy's documented 20-row maximum, so the call FAILED
 *     LOUDLY with a 400.
 *   • `from=0` is the OLDEST end of Livy's ascending batch-id list. Clamping
 *     `size` without moving the window would have turned that loud 400 into a
 *     silent success serving the pool's most ANCIENT batches into a grid the
 *     editor labels "Runs" — a `no-vaporware.md` violation (a surface that
 *     looks right and shows the wrong rows).
 *
 * The route also DROPPED the client's `truncatedBy`, so a tag filter that ran
 * over a window a paging ceiling had cut short was indistinguishable from an
 * MLV that genuinely had no runs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const listRecent = vi.fn();

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'tenant-1', upn: 'alice@contoso.com' } }),
}));

vi.mock('../../../_lib/load', () => ({
  MLV_TYPE: 'materialized-lake-view',
  loadMlvItem: async () => ({ id: 'mlv-1', itemType: 'materialized-lake-view', workspaceId: 'ws1' }),
}));

vi.mock('@/lib/azure/synapse-dev-client', () => ({
  listRecentSparkBatchJobs: (...args: unknown[]) => listRecent(...args),
}));

vi.mock('@/lib/azure/synapse-livy-client', () => ({
  defaultSparkPool: () => 'loompool',
}));

import { NextRequest } from 'next/server';
import { GET } from '../route';

const req = (qs = '') =>
  new NextRequest(`http://localhost/api/items/materialized-lake-view/mlv-1/runs${qs}`);
const call = (qs = '') => GET(req(qs), { params: Promise.resolve({ id: 'mlv-1' }) });

/** A batch tagged as belonging to this MLV. */
const mine = (id: number) => ({ id, name: `run-${id}`, state: 'success', tags: { loomItemId: 'mlv-1' } });

beforeEach(() => {
  listRecent.mockReset();
  listRecent.mockResolvedValue({ sessions: [], total: 0, scanned: 0, truncatedBy: null });
  process.env.LOOM_SYNAPSE_WORKSPACE = 'ws1';
});

describe('/api/items/materialized-lake-view/[id]/runs', () => {
  it('asks for the pool\'s MOST RECENT batches, never an offset-0 window', async () => {
    await call();

    expect(listRecent).toHaveBeenCalledTimes(1);
    const [pool, limit] = listRecent.mock.calls[0];
    expect(pool).toBe('loompool');
    // A recency limit, not a `from` offset. The old shape was (pool, 0, 100) —
    // a second argument of 0 here would mean the oldest window came back.
    expect(limit).toBeGreaterThan(0);
  });

  it('PROPAGATES truncatedBy instead of dropping it', async () => {
    listRecent.mockResolvedValue({
      sessions: [mine(9)],
      total: 5000,
      scanned: 40,
      truncatedBy: 'time',
    });

    const body = await (await call()).json();

    expect(body.ok).toBe(true);
    expect(body.truncatedBy).toBe('time');
    expect(body.scanned).toBe(40);
    expect(body.poolTotal).toBe(5000);
    // The distinction the old response could not express: this window is NOT
    // the whole run history, so an empty grid does not mean "no runs".
    expect(body.windowComplete).toBe(false);
  });

  it('reports a complete window as complete — silence must mean "this list is whole"', async () => {
    listRecent.mockResolvedValue({
      sessions: [mine(2), mine(1)],
      total: 2,
      scanned: 2,
      truncatedBy: null,
    });

    const body = await (await call()).json();

    expect(body.truncatedBy).toBeNull();
    expect(body.windowComplete).toBe(true);
  });

  it('scans a WIDER window than `size`, because the loomItemId tag filter runs client-side', async () => {
    await call('?size=25');

    const [, limit] = listRecent.mock.calls[0];
    expect(limit).toBeGreaterThan(25);
  });

  it('preserves the run fields the editor renders, newest first as the client returned them', async () => {
    listRecent.mockResolvedValue({
      sessions: [
        { id: 42, name: 'r42', state: 'success', result: 'Succeeded', appId: 'app-42', submittedAt: 't2', tags: { loomItemId: 'mlv-1', loomTrigger: 'schedule' } },
        { id: 41, name: 'r41', state: 'error', result: 'Failed', appId: 'app-41', submittedAt: 't1', tags: { loomItemId: 'other' } },
      ],
      total: 2,
      scanned: 2,
      truncatedBy: null,
    });

    const body = await (await call()).json();

    expect(body.sessions).toEqual([
      { id: 42, name: 'r42', state: 'success', result: 'Succeeded', appId: 'app-42', submittedAt: 't2', trigger: 'schedule' },
    ]);
  });

  it('keeps the honest Synapse gate when the workspace is unconfigured', async () => {
    delete process.env.LOOM_SYNAPSE_WORKSPACE;

    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.gate).toBe('synapse_not_configured');
    expect(listRecent).not.toHaveBeenCalled();
  });
});
