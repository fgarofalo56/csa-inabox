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

function postReq(body: any) { return { json: async () => body } as any; }
function getReq(qs: string) { return { nextUrl: new URL(`http://x/api/notebook/nb1/execute?${qs}`) } as any; }

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ userId: 'u1' });
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-test';
  delete process.env.LOOM_NOTEBOOK_BACKEND;
  delete process.env.LOOM_CLOUD_TIER;
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
    (getLivySession as any).mockResolvedValue({ id: 7, state: 'idle' });
    const res = await sessionPost(postReq({ pool: 'pool1', existingSessionId: 7 }));
    const j = await res.json();
    expect(j.sessionId).toBe(7);
    expect(createLivySession).not.toHaveBeenCalled();
  });

  it('creates a fresh session when the existing one is dead', async () => {
    (getLivySession as any).mockResolvedValue({ id: 7, state: 'dead' });
    (createLivySession as any).mockResolvedValue({ id: 8, state: 'starting' });
    const res = await sessionPost(postReq({ pool: 'pool1', existingSessionId: 7 }));
    const j = await res.json();
    expect(j.sessionId).toBe(8);
    expect(createLivySession).toHaveBeenCalled();
  });

  it('returns 400 when pool missing', async () => {
    const res = await sessionPost(postReq({}));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/notebook/[id]/session', () => {
  it('probe returns the backend', async () => {
    const res = await sessionGet({ nextUrl: new URL('http://x/api/notebook/nb1/session?probe=1') } as any);
    const j = await res.json();
    expect(j.backend).toBe('synapse');
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
