/**
 * Backend contract tests for /api/lakehouse/transform-preview (G4 Data Wrangler
 * live transform preview over a Livy-sampled DataFrame). Real Synapse Spark
 * (Livy) only, honest not_configured gate.
 *
 *   POST 401 / gate 503 / 400 (no code) / warming vs running kick-off
 *   GET  poll: malformed jobId / warming / running / available (parses
 *        LOOM_PREVIEW) / transform_error (candidate threw)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/synapse-artifacts-client', () => ({ synapseConfigGate: vi.fn(() => null) }));
vi.mock('@/lib/azure/adls-client', () => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing'],
  pathToHttpsUrl: vi.fn((c: string, p: string) => `https://acct.dfs.core.windows.net/${c}/${p}`),
}));
vi.mock('@/lib/azure/synapse-dev-client', () => ({
  createLivySessionAsync: vi.fn(),
  getLivySession: vi.fn(),
  submitLivyStatement: vi.fn(),
  getLivyStatement: vi.fn(),
}));

import { POST, GET } from '../transform-preview/route';
import { getSession } from '@/lib/auth/session';
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import { pathToHttpsUrl } from '@/lib/azure/adls-client';
import {
  createLivySessionAsync, getLivySession, submitLivyStatement, getLivyStatement,
} from '@/lib/azure/synapse-dev-client';

function postReq(body: any) { return { json: async () => body } as any; }
function getReq(qs: string) { return { nextUrl: new URL(`http://x/api/lakehouse/transform-preview?${qs}`) } as any; }
const sess = { claims: { oid: 'o1' } };
const CODE = 'df = df.withColumn("x", F.lit(1))';

beforeEach(() => {
  vi.clearAllMocks();
  (synapseConfigGate as any).mockReturnValue(null);
  (pathToHttpsUrl as any).mockImplementation((c: string, p: string) => `https://acct.dfs.core.windows.net/${c}/${p}`);
});

describe('POST /api/lakehouse/transform-preview', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await POST(postReq({}))).status).toBe(401);
  });

  it('503 when Synapse workspace not configured', async () => {
    (getSession as any).mockReturnValue(sess);
    (synapseConfigGate as any).mockReturnValue({ missing: 'LOOM_SYNAPSE_WORKSPACE' });
    const res = await POST(postReq({ container: 'bronze', path: 't.parquet', code: CODE }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('not_configured');
  });

  it('400 without code', async () => {
    (getSession as any).mockReturnValue(sess);
    const res = await POST(postReq({ container: 'bronze', path: 't.parquet' }));
    expect(res.status).toBe(400);
  });

  it('submits the statement when the pool is idle (running)', async () => {
    (getSession as any).mockReturnValue(sess);
    (createLivySessionAsync as any).mockResolvedValue({ id: 7, state: 'starting' });
    (getLivySession as any).mockResolvedValue({ id: 7, state: 'idle' });
    (submitLivyStatement as any).mockResolvedValue({ id: 3, state: 'waiting' });
    const res = await POST(postReq({ container: 'bronze', path: 't.parquet', code: CODE }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.status).toBe('running');
    expect(j.jobId).toBe('loompool:7:3');
    expect(submitLivyStatement).toHaveBeenCalled();
  });

  it('hands back a stmt-less jobId when the pool is warming', async () => {
    (getSession as any).mockReturnValue(sess);
    (createLivySessionAsync as any).mockResolvedValue({ id: 9, state: 'starting' });
    (getLivySession as any).mockResolvedValue({ id: 9, state: 'starting' });
    const res = await POST(postReq({ container: 'bronze', path: 't.parquet', code: CODE, pool: 'loompool2' }));
    const j = await res.json();
    expect(j.status).toBe('warming');
    expect(j.jobId).toBe('loompool2:9:');
    expect(submitLivyStatement).not.toHaveBeenCalled();
  });
});

describe('GET /api/lakehouse/transform-preview (poll)', () => {
  it('400 on malformed jobId', async () => {
    (getSession as any).mockReturnValue(sess);
    const res = await GET(getReq('jobId=notvalid'));
    expect(res.status).toBe(400);
  });

  it('parses LOOM_PREVIEW rows when available', async () => {
    (getSession as any).mockReturnValue(sess);
    (getLivyStatement as any).mockResolvedValue({
      id: 3, state: 'available',
      output: { status: 'ok', data: { 'text/plain': 'LOOM_PREVIEW:' + JSON.stringify({ columns: ['a', 'x'], rows: [['1', '1']], rowCount: 1, addedColumns: ['x'], removedColumns: [] }) } },
    });
    const res = await GET(getReq('jobId=loompool:7:3'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.status).toBe('available');
    expect(j.columns).toEqual(['a', 'x']);
    expect(j.rows).toEqual([['1', '1']]);
    expect(j.addedColumns).toEqual(['x']);
  });

  it('surfaces a candidate transform error honestly', async () => {
    (getSession as any).mockReturnValue(sess);
    (getLivyStatement as any).mockResolvedValue({
      id: 3, state: 'available',
      output: { status: 'ok', data: { 'text/plain': 'LOOM_PREVIEW:' + JSON.stringify({ error: "name 'F' is not defined" }) } },
    });
    const res = await GET(getReq('jobId=loompool:7:3'));
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.status).toBe('transform_error');
    expect(j.error).toContain('not defined');
  });

  it('reports running while the statement is not yet available', async () => {
    (getSession as any).mockReturnValue(sess);
    (getLivyStatement as any).mockResolvedValue({ id: 3, state: 'running' });
    const res = await GET(getReq('jobId=loompool:7:3'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.status).toBe('running');
  });

  it('submits once idle when polling a stmt-less warming job', async () => {
    (getSession as any).mockReturnValue(sess);
    (getLivySession as any).mockResolvedValue({ id: 9, state: 'idle' });
    (submitLivyStatement as any).mockResolvedValue({ id: 5, state: 'waiting' });
    const res = await GET(getReq('jobId=loompool:9:&container=bronze&path=t.parquet&code=' + encodeURIComponent(CODE)));
    const j = await res.json();
    expect(j.status).toBe('running');
    expect(j.jobId).toBe('loompool:9:5');
  });
});
