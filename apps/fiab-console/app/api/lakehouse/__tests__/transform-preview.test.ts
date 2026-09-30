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
// `pathToHttpsUrlFor` is the real shape (`dfsUrl(account)/container/path`) over
// the REAL cloud-endpoints `dfsUrl`, so the DFS suffix follows LOOM_CLOUD at
// call time exactly as it does in production. A plain function, not a vi.fn,
// so `vi.resetAllMocks()` cannot strip it.
vi.mock('@/lib/azure/adls-client', async () => {
  const ce: any = await vi.importActual('@/lib/azure/cloud-endpoints');
  return {
    KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing'],
    pathToHttpsUrl: vi.fn((c: string, p: string) => `https://acct.dfs.core.windows.net/${c}/${p}`),
    pathToHttpsUrlFor: (a: string, c: string, p: string) => `${ce.dfsUrl(a)}/${c}/${p.replace(/^\/+/, '')}`,
  };
});
vi.mock('@/lib/azure/synapse-dev-client', () => ({
  createLivySessionAsync: vi.fn(),
  getLivySession: vi.fn(),
  submitLivyStatement: vi.fn(),
  getLivyStatement: vi.fn(),
}));
// `resolveLakehouseStorage` delegates to the `resolveLakehouseAbfss` mock, as in
// download.test.ts: a bound value is `{ ok: true, bound }`, null is `no-storage`.
vi.mock('@/lib/azure/lakehouse-abfss', async () => {
  const actual: any = await vi.importActual('@/lib/azure/lakehouse-abfss');
  const resolveLakehouseAbfss = vi.fn();
  return {
    lakehouseStorageWithheldMessage: actual.lakehouseStorageWithheldMessage,
    resolveLakehouseAbfss,
    resolveLakehouseStorage: async (...a: any[]) => {
      const b: any = await resolveLakehouseAbfss(...a);
      if (b && typeof b === 'object' && 'withheld' in b) return { ok: false, reason: b.withheld };
      return b ? { ok: true, bound: b } : { ok: false, reason: 'no-storage' };
    },
  };
});
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
      account: 'acct',
    });
    expect(submittedPath()).toBe(`abfss://${CONTAINER}@acct.dfs.core.windows.net/${INSIDE}`);
  });

  it.each([
    ['a doubled slash', `${ROOT}//Files/t.parquet`],
    ['backslash separators', `${ROOT.replace(/\//g, '\\')}\\Files\\t.parquet`],
  ])('loads the path rebuilt from its segments, not the request text: %s', async (_label, raw) => {
    // Breaks if the kick-off hands the REQUEST path to Spark or to the handle:
    // `_path` would carry `//` (or be refused for its backslashes) instead of INSIDE.
    const res = await POST(postReq({ lakehouseId: LH, path: raw, code: CODE }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(submittedPath()).toBe(`abfss://${CONTAINER}@acct.dfs.core.windows.net/${INSIDE}`);
    expect(verifyLakehouseJobHandle(SCOPE, j.jobId)).toMatchObject({ path: INSIDE });
  });

  it('writes _path as a JSON string literal', async () => {
    // The file name holds a double quote: not a Spark glob character and not a
    // control character, so it reaches `_path`. Breaks if _path is emitted with a
    // hand-rolled quote (`"${abfss}"`): that line ends `q"t.parquet"` with the
    // inner quote bare, where the JSON literal ends `q\"t.parquet"`. A plain name
    // cannot tell the two apart — both would print the same line.
    const quoted = `${ROOT}/Files/q"t.parquet`;
    const res = await POST(postReq({ lakehouseId: LH, path: quoted, code: CODE }));
    expect(res.status).toBe(200);
    const line = String((submitLivyStatement as any).mock.calls[0][2].code).split('\n').find((l) => l.startsWith('_path = '));
    expect(line).toBe(`_path = ${JSON.stringify(`abfss://${CONTAINER}@acct.dfs.core.windows.net/${quoted}`)}`);
    expect(line).toContain('q\\"t.parquet"');
  });

  it('refuses a path holding a control character (400, no Spark session)', async () => {
    // Breaks if pathSegments stops refusing control characters: the path is
    // otherwise inside the root and would reach Livy (see the positive arm above).
    const res = await POST(postReq({ lakehouseId: LH, path: `${ROOT}/Files/a\nb.parquet`, code: CODE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/control character/);
    expect((createLivySessionAsync as any).mock.calls).toEqual([]);
  });

  it('refuses a Spark wildcard character in the scoped path (400, no Spark session)', async () => {
    // `{x,..` and `..}` are not `..` segments, so this path scopes inside the
    // root; only the Spark-boundary check can refuse it. Breaks if that check
    // is dropped: Livy would be called with a brace pattern.
    const res = await POST(postReq({ lakehouseId: LH, path: `${ROOT}/{x,../..}/Other/t.parquet`, code: CODE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/wildcard/);
    expect((createLivySessionAsync as any).mock.calls).toEqual([]);
    expect((submitLivyStatement as any).mock.calls).toEqual([]);
  });

  it('loads from the item\'s bound storage account, not the deployment default', async () => {
    (resolveLakehouseAbfss as any).mockResolvedValue({
      abfss: `abfss://${CONTAINER}@extacct.dfs.core.windows.net/${ROOT}`, container: CONTAINER, root: ROOT,
    });
    const res = await POST(postReq({ lakehouseId: LH, path: INSIDE, code: CODE }));
    const j = await res.json();
    // Breaks if the URI is built from the primary account (`acct`, what
    // pathToHttpsUrl answers) or the handle drops the bound account.
    expect(submittedPath()).toBe(`abfss://${CONTAINER}@extacct.dfs.core.windows.net/${INSIDE}`);
    expect(verifyLakehouseJobHandle(SCOPE, j.jobId)).toMatchObject({ account: 'extacct' });
  });

  it('builds the URI on the active cloud\'s DFS host (GCC-High)', async () => {
    const prev = process.env.LOOM_CLOUD;
    process.env.LOOM_CLOUD = 'gcc-high';
    try {
      (resolveLakehouseAbfss as any).mockResolvedValue({
        abfss: `abfss://${CONTAINER}@govacct.dfs.core.usgovcloudapi.net/${ROOT}`, container: CONTAINER, root: ROOT,
      });
      const res = await POST(postReq({ lakehouseId: LH, path: INSIDE, code: CODE }));
      expect(res.status).toBe(200);
      // Breaks if the suffix is hard-coded to `.dfs.core.windows.net`.
      expect(submittedPath()).toBe(`abfss://${CONTAINER}@govacct.dfs.core.usgovcloudapi.net/${INSIDE}`);
    } finally {
      if (prev === undefined) delete process.env.LOOM_CLOUD; else process.env.LOOM_CLOUD = prev;
    }
  });

  it('refuses a session with no user object id before any Spark call (401)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: '' } });
    const res = await POST(postReq({ lakehouseId: LH, path: INSIDE, code: CODE }));
    // Breaks if the principal check is dropped: minting then throws inside the
    // try and the answer is a 502 AFTER Livy was already called.
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/user object id/);
    expect((createLivySessionAsync as any).mock.calls).toEqual([]);
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
    const res = await GET(getReq(q(running())));
    const j = await res.json();
    // Breaks if a transform error is answered 200 (the panel then has to guess
    // from the body alone) or with a gateway status.
    expect(res.status).toBe(422);
    expect(j.ok).toBe(false);
    expect(j.status).toBe('transform_error');
    expect(j.error).toContain('not defined');
  });

  it.each([
    ['a Spark statement error', { id: 3, state: 'available', output: { status: 'error', evalue: 'boom', traceback: ['t'] } }, 422, /boom/],
    ['no LOOM_PREVIEW output', { id: 3, state: 'available', output: { status: 'ok', data: { 'text/plain': 'nothing here' } } }, 502, /no LOOM_PREVIEW/],
    ['a statement in the error state', { id: 3, state: 'error' }, 422, /error state/],
    ['a cancelled statement', { id: 3, state: 'cancelled' }, 409, /cancelled/],
  ])('answers a failed poll with a non-2xx status: %s', async (_label, stmt, status, msg) => {
    (getLivyStatement as any).mockResolvedValue(stmt);
    const res = await GET(getReq(q(running())));
    const j = await res.json();
    // Breaks if the failure is answered with the default 200.
    expect(res.status).toBe(status);
    expect(j.ok).toBe(false);
    expect(j.status).toBe('error');
    expect(j.error).toMatch(msg);
  });

  it('answers a dead warming session with 502 and submits nothing', async () => {
    (getLivySession as any).mockResolvedValue({ id: 9, state: 'dead' });
    const res = await GET(getReq(q(warming(), `&code=${encodeURIComponent(CODE)}`)));
    const j = await res.json();
    expect(res.status).toBe(502);
    expect(j.status).toBe('error');
    expect(j.error).toMatch(/dead/);
    expect((submitLivyStatement as any).mock.calls).toEqual([]);
  });

  it('submits a warming job against the bound account carried on the handle', async () => {
    (getLivySession as any).mockResolvedValue({ id: 9, state: 'idle' });
    (submitLivyStatement as any).mockResolvedValue({ id: 5, state: 'waiting' });
    const h = mintLakehouseJobHandle(SCOPE, {
      pool: 'loompool', sessionId: 9, stmtId: null, container: CONTAINER, path: INSIDE,
      codeHash: hashJobCode(CODE), account: 'extacct',
    });
    const res = await GET(getReq(q(h, `&code=${encodeURIComponent(CODE)}`)));
    expect(res.status).toBe(200);
    // Breaks if the poll ignores the handle's account and falls back to the
    // deployment's primary account (`acct`).
    expect(submittedPath()).toBe(`abfss://${CONTAINER}@extacct.dfs.core.windows.net/${INSIDE}`);
  });

  it('refuses a poll from a session with no user object id (401, no Livy read)', async () => {
    const h = running();
    (getSession as any).mockReturnValue({ claims: { oid: '' } });
    const res = await GET(getReq(q(h)));
    // Breaks if the principal check is dropped: the handle then fails to
    // verify and the answer is a 404, not the sign-in reason.
    expect(res.status).toBe(401);
    expect((getLivyStatement as any).mock.calls).toEqual([]);
    expect((resolveItemAccessByOid as any).mock.calls).toEqual([]);
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

describe('POST /api/lakehouse/transform-preview (poll, code in the body)', () => {
  const running = () => mintLakehouseJobHandle(SCOPE, {
    pool: 'loompool', sessionId: 7, stmtId: 3, container: CONTAINER, path: INSIDE, codeHash: hashJobCode(CODE),
  });
  const warming = () => mintLakehouseJobHandle(SCOPE, {
    pool: 'loompool', sessionId: 9, stmtId: null, container: CONTAINER, path: INSIDE, codeHash: hashJobCode(CODE),
  });

  it('a POST carrying jobId polls, and submits a warming job with the code from the body', async () => {
    (getLivySession as any).mockResolvedValue({ id: 9, state: 'idle' });
    (submitLivyStatement as any).mockResolvedValue({ id: 5, state: 'waiting' });
    // No path in the body: breaks if a POST with jobId falls through to the
    // kick-off branch (400 "path is required") instead of polling.
    const res = await POST(postReq({ lakehouseId: LH, jobId: warming(), code: CODE }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.status).toBe('running');
    expect(createLivySessionAsync).not.toHaveBeenCalled();
    expect(submittedPath()).toBe(`abfss://${CONTAINER}@acct.dfs.core.windows.net/${INSIDE}`);
  });

  it('a POST poll still requires edit rights and a matching handle', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(editor(false));
    const ro = await POST(postReq({ lakehouseId: LH, jobId: running() }));
    expect(ro.status).toBe(403);
    (resolveItemAccessByOid as any).mockResolvedValue(editor(true));
    const other = await POST(postReq({ lakehouseId: LH, jobId: 'loompool:7:3' }));
    expect(other.status).toBe(404);
    expect((getLivyStatement as any).mock.calls).toEqual([]);
  });

  it('a POST poll refuses a session with no user object id (401)', async () => {
    const h = running();
    (getSession as any).mockReturnValue({ claims: { oid: '' } });
    const res = await POST(postReq({ lakehouseId: LH, jobId: h }));
    expect(res.status).toBe(401);
    expect((getLivyStatement as any).mock.calls).toEqual([]);
  });

  it('a POST poll refuses code that differs from the kick-off code (400)', async () => {
    (getLivySession as any).mockResolvedValue({ id: 9, state: 'idle' });
    const res = await POST(postReq({ lakehouseId: LH, jobId: warming(), code: 'df = df.limit(1)' }));
    expect(res.status).toBe(400);
    expect((submitLivyStatement as any).mock.calls).toEqual([]);
  });
});
