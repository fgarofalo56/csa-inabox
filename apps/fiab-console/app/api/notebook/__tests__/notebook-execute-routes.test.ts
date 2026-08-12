/**
 * Unit tests for the F16 per-cell notebook execution routes:
 *   /api/notebook/[id]/execute  (submit + poll)
 *   /api/notebook/[id]/session  (create/reuse + keepalive + kill)
 *
 * Network-touching Livy client functions are mocked; the pure magic-parsing and
 * output-normalizing helpers run for real (vi.importActual) so the tests
 * exercise the route's actual %%-magic interception + output shaping. The
 * default backend (Synapse) is used — LOOM_NOTEBOOK_BACKEND is left unset.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
// #3171 — the routes now AUTO-BIND the Spark pool from the workspace's real ARM
// bigDataPools list, so that boundary is mocked too.
vi.mock('@/lib/azure/synapse-dev-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/synapse-dev-client');
  return { ...actual, listSparkPools: vi.fn() };
});
vi.mock('@/lib/azure/synapse-livy-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/synapse-livy-client');
  return {
    ...actual, // keep parseMagicKind / parseConfigureMagic / normalizeLivyOutput / resolveNotebookBackend
    createLivySession: vi.fn(),
    getLivySession: vi.fn(),
    killLivySession: vi.fn(),
    keepaliveLivySession: vi.fn(),
    submitLivyStatement: vi.fn(),
    getLivyStatement: vi.fn(),
  };
});

import { POST as executePost, GET as executeGet } from '../[id]/execute/route';
import { POST as sessionPost, GET as sessionGet, DELETE as sessionDelete } from '../[id]/session/route';
import { getSession } from '@/lib/auth/session';
import {
  createLivySession, getLivySession, killLivySession, keepaliveLivySession,
  submitLivyStatement, getLivyStatement,
} from '@/lib/azure/synapse-livy-client';
import { listSparkPools } from '@/lib/azure/synapse-dev-client';
import { resetSparkPoolListCache } from '@/lib/azure/spark-pool-resolver';

function postReq(body: any) { return { json: async () => body } as any; }
function getReq(qs: string) { return { nextUrl: new URL(`http://x/api/notebook/nb1/execute?${qs}`) } as any; }
const armPool = (name: string) => ({ name, id: `/x/bigDataPools/${name}`, properties: { provisioningState: 'Succeeded' } });

beforeEach(() => {
  vi.resetAllMocks();
  resetSparkPoolListCache();
  (getSession as any).mockReturnValue({ userId: 'u1' });
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-test';
  delete process.env.LOOM_NOTEBOOK_BACKEND;
  delete process.env.LOOM_CLOUD_TIER;
  delete process.env.LOOM_SYNAPSE_SPARK_POOL;
  delete process.env.LOOM_SPARK_POOL;
  delete process.env.LOOM_DEFAULT_SPARK_POOL;
  // Default: the workspace has one real pool, so auto-bind has something to bind to.
  (listSparkPools as any).mockResolvedValue([armPool('loompool2')]);
});

describe('POST /api/notebook/[id]/execute', () => {
  it('returns 401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await executePost(postReq({ pool: 'p', sessionId: 1, code: 'x' }));
    expect(res.status).toBe(401);
  });

  it('returns 503 when LOOM_SYNAPSE_WORKSPACE unset', async () => {
    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    const res = await executePost(postReq({ pool: 'p', sessionId: 1, code: 'print(1)' }));
    expect(res.status).toBe(503);
    expect((await res.json()).missing).toBe('LOOM_SYNAPSE_WORKSPACE');
  });

  it('strips %%sql magic and submits with kind sql', async () => {
    (getLivySession as any).mockResolvedValue({ id: 5, state: 'idle' });
    (submitLivyStatement as any).mockResolvedValue({ id: 9, state: 'running' });
    const res = await executePost(postReq({ pool: 'pool1', sessionId: 5, code: '%%sql\nSELECT 1' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.stmtId).toBe(9);
    expect(submitLivyStatement).toHaveBeenCalledWith('pool1', 5, 'SELECT 1', 'sql');
  });

  it('strips %%pyspark magic and submits with kind pyspark', async () => {
    (getLivySession as any).mockResolvedValue({ id: 5, state: 'idle' });
    (submitLivyStatement as any).mockResolvedValue({ id: 1, state: 'running' });
    await executePost(postReq({ pool: 'pool1', sessionId: 5, code: '%%pyspark\ndisplay(spark.range(5))' }));
    expect(submitLivyStatement).toHaveBeenCalledWith('pool1', 5, 'display(spark.range(5))', 'pyspark');
  });

  it('intercepts a %%configure cell without submitting a statement', async () => {
    const res = await executePost(postReq({ pool: 'p', sessionId: 5, code: '%%configure\n{ "numExecutors": 4 }' }));
    const j = await res.json();
    expect(j.configureApplied).toBe(true);
    expect(j.configureOptions.numExecutors).toBe(4);
    expect(submitLivyStatement).not.toHaveBeenCalled();
  });

  it('rejects a %%configure cell with malformed JSON (400)', async () => {
    const res = await executePost(postReq({ pool: 'p', sessionId: 5, code: '%%configure\n{ not json' }));
    expect(res.status).toBe(400);
  });

  it('returns sessionWarming when the session is not idle', async () => {
    (getLivySession as any).mockResolvedValue({ id: 5, state: 'starting' });
    const res = await executePost(postReq({ pool: 'p', sessionId: 5, code: 'print(1)' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.sessionWarming).toBe(true);
    expect(j.stmtId).toBe(null);
    expect(submitLivyStatement).not.toHaveBeenCalled();
  });

  it('returns 409 sessionDead when the session is terminal', async () => {
    (getLivySession as any).mockResolvedValue({ id: 5, state: 'dead' });
    const res = await executePost(postReq({ pool: 'p', sessionId: 5, code: 'print(1)' }));
    expect(res.status).toBe(409);
    expect((await res.json()).sessionDead).toBe(true);
  });

  // ── #3171 ──
  it('AUTO-BINDS the pool when the body carries none (was 400 "pool is required")', async () => {
    (getLivySession as any).mockResolvedValue({ id: 5, state: 'idle' });
    (submitLivyStatement as any).mockResolvedValue({ id: 3, state: 'running' });
    const res = await executePost(postReq({ sessionId: 5, code: 'print(1)' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.pool).toBe('loompool2');
    expect(submitLivyStatement).toHaveBeenCalledWith('loompool2', 5, 'print(1)', 'pyspark');
  });

  it('honours an already-bound pool verbatim without an ARM round-trip', async () => {
    (getLivySession as any).mockResolvedValue({ id: 5, state: 'idle' });
    (submitLivyStatement as any).mockResolvedValue({ id: 4, state: 'running' });
    await executePost(postReq({ pool: 'already-bound', sessionId: 5, code: 'print(1)' }));
    expect(submitLivyStatement).toHaveBeenCalledWith('already-bound', 5, 'print(1)', 'pyspark');
    expect(listSparkPools).not.toHaveBeenCalled();
  });
});

describe('GET /api/notebook/[id]/execute', () => {
  it('normalizes text/plain output', async () => {
    (getLivyStatement as any).mockResolvedValue({ id: 9, state: 'available', output: { status: 'ok', data: { 'text/plain': 'res0: Long = 5' } } });
    const res = await executeGet(getReq('pool=p&sessionId=5&stmtId=9'));
    const j = await res.json();
    expect(j.state).toBe('available');
    expect(j.output.textPlain).toBe('res0: Long = 5');
  });

  it('normalizes application/json into df table rows', async () => {
    (getLivyStatement as any).mockResolvedValue({
      id: 9, state: 'available',
      output: { status: 'ok', data: { 'application/json': { schema: { fields: [{ name: 'id' }] }, data: [['0'], ['1']] } } },
    });
    const res = await executeGet(getReq('pool=p&sessionId=5&stmtId=9'));
    const j = await res.json();
    expect(j.output.tableColumns).toEqual(['id']);
    expect(j.output.tableRows.length).toBe(2);
  });

  it('polls without a pool query param — the server resolves it (#3171)', async () => {
    (getLivyStatement as any).mockResolvedValue({ id: 9, state: 'available', output: { status: 'ok', data: { 'text/plain': 'ok' } } });
    const res = await executeGet(getReq('sessionId=5&stmtId=9'));
    expect(res.status).toBe(200);
    expect(getLivyStatement).toHaveBeenCalledWith('loompool2', 5, 9);
  });

  it('surfaces error output with ename/evalue/traceback', async () => {
    (getLivyStatement as any).mockResolvedValue({
      id: 9, state: 'error',
      output: { status: 'error', ename: 'AnalysisException', evalue: 'bad', traceback: ['line1'] },
    });
    const res = await executeGet(getReq('pool=p&sessionId=5&stmtId=9'));
    const j = await res.json();
    expect(j.output.status).toBe('error');
    expect(j.output.ename).toBe('AnalysisException');
    expect(j.output.traceback).toEqual(['line1']);
  });
});

describe('POST /api/notebook/[id]/session', () => {
  it('creates a new session when no existingSessionId', async () => {
    (createLivySession as any).mockResolvedValue({ id: 7, state: 'starting' });
    const res = await sessionPost(postReq({ pool: 'pool1' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.sessionId).toBe(7);
    expect(createLivySession).toHaveBeenCalled();
  });

  it('reuses an alive existing session', async () => {
    // The saved pool must exist in the workspace for the binding to survive —
    // a name ARM does not report is re-bound instead (see the stale-pool test).
    (listSparkPools as any).mockResolvedValue([armPool('pool1')]);
    (getLivySession as any).mockResolvedValue({ id: 7, state: 'idle' });
    const res = await sessionPost(postReq({ pool: 'pool1', existingSessionId: 7 }));
    const j = await res.json();
    expect(j.sessionId).toBe(7);
    expect(createLivySession).not.toHaveBeenCalled();
  });

  it('creates a fresh session when the existing one is dead', async () => {
    // Pool exists — so this exercises the DEAD-session path, not a re-bind.
    (listSparkPools as any).mockResolvedValue([armPool('pool1')]);
    (getLivySession as any).mockResolvedValue({ id: 7, state: 'dead' });
    (createLivySession as any).mockResolvedValue({ id: 8, state: 'starting' });
    const res = await sessionPost(postReq({ pool: 'pool1', existingSessionId: 7 }));
    const j = await res.json();
    expect(j.sessionId).toBe(8);
    expect(createLivySession).toHaveBeenCalled();
  });

  // ── #3171: pool auto-bind. A freshly created notebook has no bigDataPool, so
  //    the editor sends no pool at all; the platform must bind one, not 400. ──
  it('AUTO-BINDS the workspace pool when the request carries none (was 400)', async () => {
    (createLivySession as any).mockResolvedValue({ id: 11, state: 'starting' });
    const res = await sessionPost(postReq({}));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.pool).toBe('loompool2');
    expect(j.poolSource).toBe('workspace');
    expect((createLivySession as any).mock.calls[0][0]).toBe('loompool2');
  });

  it('re-binds a STALE saved pool to the pool that actually exists', async () => {
    (createLivySession as any).mockResolvedValue({ id: 12, state: 'starting' });
    const res = await sessionPost(postReq({ pool: 'loompool' }));   // the dead pre-incident name
    const j = await res.json();
    expect(j.pool).toBe('loompool2');
    expect(j.poolNote).toContain('Requested Spark pool "loompool" is not in workspace');
    expect((createLivySession as any).mock.calls[0][0]).toBe('loompool2');
  });

  it('does NOT reuse a session id across a re-bind to a different pool', async () => {
    (createLivySession as any).mockResolvedValue({ id: 13, state: 'starting' });
    const res = await sessionPost(postReq({ pool: 'loompool', existingSessionId: 7 }));
    expect((await res.json()).sessionId).toBe(13);
    expect(getLivySession).not.toHaveBeenCalled();
    expect(createLivySession).toHaveBeenCalled();
  });

  it('re-binds once when the resolved pool 404s on session create, then succeeds', async () => {
    (listSparkPools as any).mockResolvedValue([armPool('loompool'), armPool('loompool2')]);
    (createLivySession as any)
      .mockRejectedValueOnce(new Error('createLivySession(loompool) failed 404: pool not found'))
      .mockResolvedValueOnce({ id: 14, state: 'starting' });
    const res = await sessionPost(postReq({ pool: 'loompool' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.pool).toBe('loompool2');
    expect(j.poolNote).toContain('returned HTTP 404 from the Livy session API');
  });

  it('503s with the EMPTY-list truth when the workspace really has no pools', async () => {
    (listSparkPools as any).mockResolvedValue([]);
    const res = await sessionPost(postReq({}));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.code).toBe('no_spark_pool');
    expect(j.error).toContain('the list came back empty');
    expect(createLivySession).not.toHaveBeenCalled();
  });

  it('502s saying it does not KNOW when the pool list is unreadable and no hint is set', async () => {
    (listSparkPools as any).mockRejectedValue(new Error('listSparkPools failed 403: Forbidden'));
    const res = await sessionPost(postReq({}));
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.code).toBe('pool_unresolved');
    expect(j.error).toContain('Loom does not know whether a pool exists');
    expect(j.error).not.toContain('came back empty');
  });
});

describe('GET /api/notebook/[id]/session', () => {
  it('probe returns the backend AND the auto-bound pool (#3171)', async () => {
    const res = await sessionGet({ nextUrl: new URL('http://x/api/notebook/nb1/session?probe=1') } as any);
    const j = await res.json();
    expect(j.backend).toBe('synapse');
    // The editor adopts this so a freshly created notebook opens ATTACHED.
    expect(j.pool).toBe('loompool2');
    expect(j.poolSource).toBe('workspace');
  });

  it('keepalives and returns state', async () => {
    (keepaliveLivySession as any).mockResolvedValue(undefined);
    (getLivySession as any).mockResolvedValue({ id: 5, state: 'idle' });
    const res = await sessionGet({ nextUrl: new URL('http://x/api/notebook/nb1/session?pool=p&sessionId=5') } as any);
    const j = await res.json();
    expect(keepaliveLivySession).toHaveBeenCalledWith('p', 5);
    expect(j.state).toBe('idle');
  });
});

describe('DELETE /api/notebook/[id]/session', () => {
  it('kills the session', async () => {
    (killLivySession as any).mockResolvedValue(undefined);
    const res = await sessionDelete({ nextUrl: new URL('http://x/api/notebook/nb1/session?pool=p&sessionId=5') } as any);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(killLivySession).toHaveBeenCalledWith('p', 5);
  });
});
