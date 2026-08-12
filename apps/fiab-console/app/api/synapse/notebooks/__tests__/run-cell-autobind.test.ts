/**
 * #3171 — /api/synapse/notebooks/[name]/run-cell must AUTO-BIND its Spark pool.
 *
 * This is the notebook-designer "Run cell" path (the third of the three sibling
 * routes that read `body.pool` and 400'd when it was absent). The Livy + ARM
 * boundaries are mocked; the route's own resolution behaviour is under test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/synapse-dev-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/synapse-dev-client');
  return {
    ...actual,
    listSparkPools: vi.fn(),
    createLivySessionAsync: vi.fn(),
    getLivySession: vi.fn(),
    submitLivyStatement: vi.fn(),
    getLivyStatement: vi.fn(),
  };
});

import { POST as runCellPost, GET as runCellGet } from '../[name]/run-cell/route';
import { getSession } from '@/lib/auth/session';
import {
  listSparkPools, createLivySessionAsync, getLivySession, submitLivyStatement, getLivyStatement,
} from '@/lib/azure/synapse-dev-client';
import { resetSparkPoolListCache } from '@/lib/azure/spark-pool-resolver';

const postReq = (body: any) => ({ json: async () => body }) as any;
const getReq = (qs: string) => ({ nextUrl: new URL(`http://x/api/synapse/notebooks/nb/run-cell?${qs}`) }) as any;
const armPool = (name: string) => ({ name, id: `/x/bigDataPools/${name}`, properties: { provisioningState: 'Succeeded' } });

beforeEach(() => {
  vi.resetAllMocks();
  resetSparkPoolListCache();
  (getSession as any).mockReturnValue({ userId: 'u1' });
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-test';
  delete process.env.LOOM_SYNAPSE_SPARK_POOL;
  delete process.env.LOOM_SPARK_POOL;
  delete process.env.LOOM_DEFAULT_SPARK_POOL;
  (listSparkPools as any).mockResolvedValue([armPool('loompool2')]);
});

describe('POST /api/synapse/notebooks/[name]/run-cell', () => {
  it('401s when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await runCellPost(postReq({ code: 'print(1)' }), {} as any)).status).toBe(401);
  });

  it('AUTO-BINDS the workspace pool when the body carries none (was 400)', async () => {
    (createLivySessionAsync as any).mockResolvedValue({ id: 3, state: 'idle' });
    (getLivySession as any).mockResolvedValue({ id: 3, state: 'idle' });
    (submitLivyStatement as any).mockResolvedValue({ id: 1, state: 'running' });
    const res = await runCellPost(postReq({ code: 'print(1)' }), {} as any);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.pool).toBe('loompool2');
    expect((createLivySessionAsync as any).mock.calls[0][0]).toBe('loompool2');
    expect(submitLivyStatement).toHaveBeenCalledWith('loompool2', 3, { code: 'print(1)', kind: 'pyspark' });
  });

  it('still 400s on an EMPTY cell — the absent-pool fix did not loosen that', async () => {
    const res = await runCellPost(postReq({ pool: 'loompool2', code: '   ' }), {} as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('cell is empty');
  });

  it('re-binds a stale pool name to the pool that actually exists', async () => {
    (createLivySessionAsync as any).mockResolvedValue({ id: 4, state: 'idle' });
    (getLivySession as any).mockResolvedValue({ id: 4, state: 'idle' });
    (submitLivyStatement as any).mockResolvedValue({ id: 2, state: 'running' });
    const res = await runCellPost(postReq({ pool: 'loompool', code: 'print(1)' }), {} as any);
    const j = await res.json();
    expect(j.pool).toBe('loompool2');
    expect(j.poolNote).toContain('is not in workspace "syn-test"');
  });

  it('503s with the EMPTY-list truth when the workspace has no pools', async () => {
    (listSparkPools as any).mockResolvedValue([]);
    const res = await runCellPost(postReq({ code: 'print(1)' }), {} as any);
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.code).toBe('no_spark_pool');
    expect(j.error).toContain('the list came back empty');
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });

  it('502s saying it does not KNOW when the list is unreadable and no hint is set', async () => {
    (listSparkPools as any).mockRejectedValue(new Error('listSparkPools failed 403: Forbidden'));
    const res = await runCellPost(postReq({ code: 'print(1)' }), {} as any);
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.code).toBe('pool_unresolved');
    expect(j.error).toContain('Loom does not know whether a pool exists');
  });
});

describe('GET /api/synapse/notebooks/[name]/run-cell', () => {
  it('polls without a pool query param — the server resolves it', async () => {
    (getLivyStatement as any).mockResolvedValue({ id: 1, state: 'available', output: { status: 'ok' } });
    const res = await runCellGet(getReq('session=3&stmt=1'), {} as any);
    expect(res.status).toBe(200);
    expect(getLivyStatement).toHaveBeenCalledWith('loompool2', 3, 1);
  });

  it('still requires a session id', async () => {
    const res = await runCellGet(getReq('pool=loompool2'), {} as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('session query param required');
  });
});
