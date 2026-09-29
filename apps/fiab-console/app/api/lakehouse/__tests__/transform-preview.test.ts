/**
 * Backend contract tests for /api/lakehouse/transform-preview (G4 Data Wrangler
 * live transform preview over a Livy-sampled DataFrame). Real Synapse Spark
 * (Livy) only, honest not_configured gate.
 *
 * Item scope: every call names the lakehouse item, needs edit rights on it, and
 * samples only a path inside the item's own container + root. The `jobId` is a
 * signed handle bound to the item, the route, the principal and the scoped
 * path; a poll reads the path from the handle.
 *
 * Refusals read the Livy CALL ROW SET (createLivySessionAsync /
 * submitLivyStatement), not only the status, and each is paired with a positive
 * arm on the same fixture so "nothing reached Spark" cannot be satisfied by a
 * route that never runs anything.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.SESSION_SECRET = 'unit-test-session-secret-for-lakehouse-job-handles';

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
vi.mock('@/lib/azure/lakehouse-abfss', () => ({ resolveLakehouseAbfss: vi.fn() }));
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));

import { POST, GET } from '../transform-preview/route';
import { getSession } from '@/lib/auth/session';
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import { pathToHttpsUrl } from '@/lib/azure/adls-client';
import {
  createLivySessionAsync, getLivySession, submitLivyStatement, getLivyStatement,
} from '@/lib/azure/synapse-dev-client';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { hashJobCode, mintLakehouseJobHandle, verifyLakehouseJobHandle } from '../_lib/job-handle';

function postReq(body: any) { return { json: async () => body } as any; }
function getReq(qs: string) { return { nextUrl: new URL(`http://x/api/lakehouse/transform-preview?${qs}`) } as any; }
const sess = { claims: { oid: 'o1' } };
const CODE = 'df = df.withColumn("x", F.lit(1))';

const LH = 'lh-tp';
const OTHER_LH = 'lh-other';
const CONTAINER = 'landing';
const ROOT = 'lakehouses/Sales--lh-tp';
const INSIDE = `${ROOT}/Files/t.parquet`;
const SCOPE = { lakehouseId: LH, purpose: 'transform-preview' as const, oid: 'o1' };

function editor(canWrite = true) {
  return { item: { id: LH, workspaceId: 'ws-1', itemType: 'lakehouse' }, role: canWrite ? 'Member' : 'Viewer', via: 'workspace', canWrite };
}

/** The abfss path the preview statement loaded, read out of the submitted code. */
function submittedPath(): string | null {
  const call = (submitLivyStatement as any).mock.calls[0];
  if (!call) return null;
  const m = String(call[2]?.code || '').match(/^_path = "([^"]*)"$/m);
  return m ? m[1] : null;
}

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(sess);
  (synapseConfigGate as any).mockReturnValue(null);
  (pathToHttpsUrl as any).mockImplementation((c: string, p: string) => `https://acct.dfs.core.windows.net/${c}/${p}`);
  (resolveItemAccessByOid as any).mockResolvedValue(editor(true));
  (resolveLakehouseAbfss as any).mockResolvedValue({
    abfss: `abfss://${CONTAINER}@acct.dfs.core.windows.net/${ROOT}`, container: CONTAINER, root: ROOT,
  });
  (createLivySessionAsync as any).mockResolvedValue({ id: 7, state: 'starting' });
  (getLivySession as any).mockResolvedValue({ id: 7, state: 'idle' });
  (submitLivyStatement as any).mockResolvedValue({ id: 3, state: 'waiting' });
});

describe('POST /api/lakehouse/transform-preview', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await POST(postReq({}))).status).toBe(401);
  });

  it('503 when Synapse workspace not configured', async () => {
    (synapseConfigGate as any).mockReturnValue({ missing: 'LOOM_SYNAPSE_WORKSPACE' });
    const res = await POST(postReq({ lakehouseId: LH, path: INSIDE, code: CODE }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('not_configured');
  });

  it('400 without code', async () => {
    const res = await POST(postReq({ lakehouseId: LH, path: INSIDE }));
    expect(res.status).toBe(400);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });

  it('requires the lakehouse item id (400, no Spark session)', async () => {
    // Breaks if the route falls back to a container-only form: the same body
    // with lakehouseId added is the positive arm below.
    const res = await POST(postReq({ container: CONTAINER, path: INSIDE, code: CODE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/lakehouseId is required/);
    expect((createLivySessionAsync as any).mock.calls).toEqual([]);
  });

  it('submits the statement over the scoped path when the pool is idle (running)', async () => {
    const res = await POST(postReq({ lakehouseId: LH, container: CONTAINER, path: INSIDE, code: CODE }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.status).toBe('running');
    expect((resolveItemAccessByOid as any).mock.calls).toEqual([[sess, LH, 'lakehouse']]);
    // The handle carries the Livy coordinates and the scoped path.
    expect(verifyLakehouseJobHandle(SCOPE, j.jobId)).toEqual({
      pool: 'loompool', sessionId: 7, stmtId: 3, container: CONTAINER, path: INSIDE, codeHash: hashJobCode(CODE),
    });
    expect(submittedPath()).toBe(`abfss://${CONTAINER}@acct.dfs.core.windows.net/${INSIDE}`);
  });

  it('requires access to the lakehouse item (404, no Spark session)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await POST(postReq({ lakehouseId: LH, path: INSIDE, code: CODE }));
    expect(res.status).toBe(404);
    expect((createLivySessionAsync as any).mock.calls).toEqual([]);
  });

  it('requires edit rights on the lakehouse item (403 for a read-only role, no Spark session)', async () => {
    // Breaks if `write: true` is dropped from the authorization: the Viewer
    // fixture would then reach Livy exactly as the Member fixture above does.
    (resolveItemAccessByOid as any).mockResolvedValue(editor(false));
    const res = await POST(postReq({ lakehouseId: LH, path: INSIDE, code: CODE }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/read-only/);
    expect((createLivySessionAsync as any).mock.calls).toEqual([]);
  });

  it.each([
    ['a sibling root sharing the prefix', 'lakehouses/Sales--lh-tp-archive/Files/t.parquet', 403],
    ['a different lakehouse root', 'lakehouses/Other--lh-x/Files/t.parquet', 403],
    ['a back-reference out of the root', `${ROOT}/../Other--lh-x/Files/t.parquet`, 400],
    ['an absolute path', `/${INSIDE}`, 400],
  ])('confines the sampled path to the item root: %s', async (_label, path, status) => {
    const res = await POST(postReq({ lakehouseId: LH, path, code: CODE }));
    expect(res.status).toBe(status);
    expect((createLivySessionAsync as any).mock.calls).toEqual([]);
  });

  it('confines the sampled path to the item container (403 for another container)', async () => {
    const res = await POST(postReq({ lakehouseId: LH, container: 'gold', path: INSIDE, code: CODE }));
    expect(res.status).toBe(403);
    expect((createLivySessionAsync as any).mock.calls).toEqual([]);
  });

  it('refuses a pool name that is not a Spark pool name (400, no Spark session)', async () => {
    const res = await POST(postReq({ lakehouseId: LH, path: INSIDE, code: CODE, pool: 'loompool/sessions' }));
    expect(res.status).toBe(400);
    expect((createLivySessionAsync as any).mock.calls).toEqual([]);
  });

  it('hands back a warming handle with no statement when the pool is warming', async () => {
    (createLivySessionAsync as any).mockResolvedValue({ id: 9, state: 'starting' });
    (getLivySession as any).mockResolvedValue({ id: 9, state: 'starting' });
    const res = await POST(postReq({ lakehouseId: LH, path: INSIDE, code: CODE, pool: 'loompool2' }));
    const j = await res.json();
    expect(j.status).toBe('warming');
    expect(verifyLakehouseJobHandle(SCOPE, j.jobId)).toMatchObject({ pool: 'loompool2', sessionId: 9, stmtId: null });
    expect(submitLivyStatement).not.toHaveBeenCalled();
  });
});

describe('GET /api/lakehouse/transform-preview (poll)', () => {
  const running = () => mintLakehouseJobHandle(SCOPE, {
    pool: 'loompool', sessionId: 7, stmtId: 3, container: CONTAINER, path: INSIDE, codeHash: hashJobCode(CODE),
  });
  const warming = () => mintLakehouseJobHandle(SCOPE, {
    pool: 'loompool', sessionId: 9, stmtId: null, container: CONTAINER, path: INSIDE, codeHash: hashJobCode(CODE),
  });
  const q = (jobId: string, extra = '') => `lakehouseId=${LH}&jobId=${encodeURIComponent(jobId)}${extra}`;

  it('404 on a jobId that is not a handle', async () => {
    const res = await GET(getReq(q('loompool:7:3')));
    expect(res.status).toBe(404);
    expect((getLivyStatement as any).mock.calls).toEqual([]);
  });

  it('parses LOOM_PREVIEW rows when available', async () => {
    (getLivyStatement as any).mockResolvedValue({
      id: 3, state: 'available',
      output: { status: 'ok', data: { 'text/plain': 'LOOM_PREVIEW:' + JSON.stringify({ columns: ['a', 'x'], rows: [['1', '1']], rowCount: 1, addedColumns: ['x'], removedColumns: [] }) } },
    });
    const res = await GET(getReq(q(running())));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.status).toBe('available');
    expect(j.columns).toEqual(['a', 'x']);
    expect(j.rows).toEqual([['1', '1']]);
    expect(j.addedColumns).toEqual(['x']);
    expect((getLivyStatement as any).mock.calls).toEqual([['loompool', 7, 3]]);
  });

  it('surfaces a candidate transform error honestly', async () => {
    (getLivyStatement as any).mockResolvedValue({
      id: 3, state: 'available',
      output: { status: 'ok', data: { 'text/plain': 'LOOM_PREVIEW:' + JSON.stringify({ error: "name 'F' is not defined" }) } },
    });
    const j = await (await GET(getReq(q(running())))).json();
    expect(j.ok).toBe(false);
    expect(j.status).toBe('transform_error');
    expect(j.error).toContain('not defined');
  });

  it('reports running while the statement is not yet available', async () => {
    (getLivyStatement as any).mockResolvedValue({ id: 3, state: 'running' });
    const j = await (await GET(getReq(q(running())))).json();
    expect(j.ok).toBe(true);
    expect(j.status).toBe('running');
  });

  it('requires access to the lakehouse item on every poll (404, no Livy read)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await GET(getReq(q(running())));
    expect(res.status).toBe(404);
    expect((getLivyStatement as any).mock.calls).toEqual([]);
  });

  it('requires edit rights on the lakehouse item on every poll (403 for a read-only role)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(editor(false));
    const res = await GET(getReq(q(running())));
    expect(res.status).toBe(403);
    expect((getLivyStatement as any).mock.calls).toEqual([]);
  });

  it('refuses a handle minted for another lakehouse item (404, no Livy read)', async () => {
    // The caller can edit LH, and presents a genuine handle minted for OTHER_LH.
    // Breaks if the handle's item id is not compared to the authorized one.
    const other = mintLakehouseJobHandle({ ...SCOPE, lakehouseId: OTHER_LH }, {
      pool: 'loompool', sessionId: 7, stmtId: 3, container: CONTAINER, path: INSIDE,
    });
    const res = await GET(getReq(q(other)));
    expect(res.status).toBe(404);
    expect((getLivyStatement as any).mock.calls).toEqual([]);
  });

  it('refuses a handle minted for another principal (404)', async () => {
    const other = mintLakehouseJobHandle({ ...SCOPE, oid: 'o2' }, {
      pool: 'loompool', sessionId: 7, stmtId: 3, container: CONTAINER, path: INSIDE,
    });
    expect((await GET(getReq(q(other)))).status).toBe(404);
    expect((getLivyStatement as any).mock.calls).toEqual([]);
  });

  it('refuses a handle whose payload was altered (404)', async () => {
    // Swap the payload for one naming another path, keep the original signature.
    const h = running();
    const [, sig] = h.slice('lhjob1.'.length).split('.');
    const forged = Buffer.from(JSON.stringify({
      i: LH, u: 'transform-preview', o: 'o1', p: 'loompool', s: 7, t: 3, c: 'gold', f: 'x/y', at: Date.now(),
    })).toString('base64url');
    expect((await GET(getReq(q(`lhjob1.${forged}.${sig}`)))).status).toBe(404);
    expect((getLivyStatement as any).mock.calls).toEqual([]);
  });

  it('submits once idle when polling a warming job, over the path from the handle', async () => {
    (getLivySession as any).mockResolvedValue({ id: 9, state: 'idle' });
    (submitLivyStatement as any).mockResolvedValue({ id: 5, state: 'waiting' });
    // A container/path in the query is ignored: the handle names the source.
    const res = await GET(getReq(q(warming(), `&container=gold&path=x/y.parquet&code=${encodeURIComponent(CODE)}`)));
    const j = await res.json();
    expect(j.status).toBe('running');
    expect(verifyLakehouseJobHandle(SCOPE, j.jobId)).toMatchObject({ pool: 'loompool', sessionId: 9, stmtId: 5, path: INSIDE });
    expect(submittedPath()).toBe(`abfss://${CONTAINER}@acct.dfs.core.windows.net/${INSIDE}`);
  });

  it('refuses code on a warming poll that differs from the code the kick-off accepted (400)', async () => {
    (getLivySession as any).mockResolvedValue({ id: 9, state: 'idle' });
    const res = await GET(getReq(q(warming(), `&code=${encodeURIComponent('df = df.limit(1)')}`)));
    expect(res.status).toBe(400);
    expect((submitLivyStatement as any).mock.calls).toEqual([]);
  });

  it('400 without lakehouseId', async () => {
    const res = await GET(getReq(`jobId=${encodeURIComponent(running())}`));
    expect(res.status).toBe(400);
    expect((resolveItemAccessByOid as any).mock.calls).toEqual([]);
  });
});
