/**
 * GET /api/synapse/sparkjobdefinitions/[name]/run — review of PR #3689, blocker 2.
 *
 * The route's own contract says "list recent batches on the pool", and it
 * called `listSparkBatchJobs(pool, 0, 25)`. Livy lists batches in ASCENDING
 * batch-id order and `from` is an index into that list, so `from=0` returns the
 * OLDEST batches. The over-cap `size=25` at least made that fail loudly with a
 * 400; a bare clamp would have made it succeed silently and fill the Spark job
 * definition editor's Runs tab with the pool's most ancient runs.
 *
 * The route also dropped the client's `truncatedBy`, so a window a paging
 * ceiling had cut short looked exactly like a complete one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const listRecent = vi.fn();
const getDef = vi.fn();

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'tenant-1', upn: 'alice@contoso.com' } }),
}));

vi.mock('@/lib/azure/synapse-artifacts-client', () => ({
  synapseConfigGate: () => (process.env.LOOM_SYNAPSE_WORKSPACE ? null : { missing: 'LOOM_SYNAPSE_WORKSPACE' }),
  getSparkJobDefinition: (...args: unknown[]) => getDef(...args),
}));

vi.mock('@/lib/azure/synapse-dev-client', () => ({
  submitSparkBatchJob: vi.fn(),
  getSparkBatchJob: vi.fn(),
  listRecentSparkBatchJobs: (...args: unknown[]) => listRecent(...args),
}));

import { NextRequest } from 'next/server';
import { GET } from '../route';

const call = () =>
  GET(new NextRequest('http://localhost/api/synapse/sparkjobdefinitions/myjob/run'), {
    params: Promise.resolve({ name: 'myjob' }),
  });

beforeEach(() => {
  listRecent.mockReset();
  getDef.mockReset();
  process.env.LOOM_SYNAPSE_WORKSPACE = 'ws1';
  getDef.mockResolvedValue({ properties: { targetBigDataPool: { referenceName: 'loompool' } } });
  listRecent.mockResolvedValue({ sessions: [], total: 0, scanned: 0, truncatedBy: null });
});

describe('GET /api/synapse/sparkjobdefinitions/[name]/run', () => {
  it('asks for the MOST RECENT batches, not an offset-0 window', async () => {
    await call();

    expect(listRecent).toHaveBeenCalledTimes(1);
    const [pool, limit] = listRecent.mock.calls[0];
    expect(pool).toBe('loompool');
    expect(limit).toBe(25);
  });

  it('PROPAGATES truncatedBy instead of dropping it', async () => {
    listRecent.mockResolvedValue({
      sessions: [{ id: 7, state: 'success', appId: 'a7', result: 'Succeeded', submittedAt: 't' }],
      total: 900,
      scanned: 20,
      truncatedBy: 'pages',
    });

    const body = await (await call()).json();

    expect(body.ok).toBe(true);
    expect(body.truncatedBy).toBe('pages');
    expect(body.scanned).toBe(20);
    expect(body.poolTotal).toBe(900);
  });

  it('reports a complete window as complete', async () => {
    listRecent.mockResolvedValue({
      sessions: [{ id: 2, state: 'success' }],
      total: 1,
      scanned: 1,
      truncatedBy: null,
    });

    const body = await (await call()).json();

    expect(body.truncatedBy).toBeNull();
  });

  it('returns the runs newest-first, in the order the client produced them', async () => {
    listRecent.mockResolvedValue({
      sessions: [
        { id: 99, state: 'running', appId: 'a99', result: 'Uncertain', submittedAt: 't3' },
        { id: 98, state: 'success', appId: 'a98', result: 'Succeeded', submittedAt: 't2' },
      ],
      total: 2,
      scanned: 2,
      truncatedBy: null,
    });

    const body = await (await call()).json();

    expect(body.runs.map((r: { id: number }) => r.id)).toEqual([99, 98]);
  });

  it('keeps the honest gates: no pool set, and workspace unconfigured', async () => {
    getDef.mockResolvedValue({ properties: {} });
    const noPool = await (await call()).json();
    expect(noPool).toEqual({ ok: true, runs: [], note: 'no target pool set' });
    expect(listRecent).not.toHaveBeenCalled();

    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    const res = await call();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('not_configured');
  });
});
