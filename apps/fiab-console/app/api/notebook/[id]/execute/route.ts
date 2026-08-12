/**
 * Per-cell execute (submit + poll) for the Synapse Notebook editor (F16).
 * Keyed by the Cosmos notebook item `id`.
 *
 *   POST   /api/notebook/[id]/execute
 *     body { pool, sessionId, code, kind? }
 *     → strips/interprets %%-magic, submits a Livy statement, returns
 *       { ok, sessionId, stmtId, state }. A %%configure cell is intercepted
 *       (not submitted) and returns { ok, configureApplied:true } so the editor
 *       recreates the session with the new compute options.
 *       Databricks opt-in: body { cluster, sessionId:<contextId>, code, kind? }
 *       → executeCommand against the execution context.
 *
 *   GET    /api/notebook/[id]/execute?pool=&sessionId=&stmtId=
 *     → polls the statement, returns { ok, state, output } where output is the
 *       normalized rich result (text/plain, text/html, df table, image/png).
 *
 * The generic /api/notebook/execute (no [id]) stays 501 by design — this [id]
 * route is the real per-cell path. Real Synapse Livy + Databricks Command
 * Execution REST. Honest 503 gate. No mocks.
 *
 * Learn (Livy statement create/get + Synapse magic commands):
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-statement
 *   https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-development-using-notebooks
 */

import { NextRequest, NextResponse } from 'next/server';
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import {
  getLivySession, submitLivyStatement, getLivyStatement,
  parseMagicKind, parseConfigureMagic, normalizeLivyOutput, resolveNotebookBackend,
  type LivyKind, type NormalizedOutput,
} from '@/lib/azure/synapse-livy-client';
import { resolveSparkPool, type SparkPoolResolution } from '@/lib/azure/spark-pool-resolver';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normKind(raw: unknown): LivyKind {
  const l = String(raw || 'pyspark').toLowerCase();
  if (l === 'sql' || l === 'sparksql' || l === 'spark-sql') return 'sql';
  if (l === 'spark' || l === 'scala') return 'spark';
  if (l === 'sparkr' || l === 'r') return 'sparkr';
  return 'pyspark';
}

function dbxLang(kind: LivyKind): 'python' | 'scala' | 'sql' | 'r' {
  if (kind === 'spark') return 'scala';
  if (kind === 'sql') return 'sql';
  if (kind === 'sparkr') return 'r';
  return 'python';
}

function synapseGate(): NextResponse | null {
  const g = synapseConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Synapse workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

/**
 * #3171 — the pool is AUTO-BOUND server-side; `body.pool` / `?pool=` is a HINT,
 * not a requirement. A freshly created notebook has no `properties.bigDataPool`,
 * so the editor legitimately sends none. Only a resolution that genuinely could
 * not be made (empty workspace pool list, or an unreadable one with no hint)
 * reaches the user, and it says exactly what was observed (R7).
 */
function poolGate(r: SparkPoolResolution): NextResponse | null {
  if (r.ok) return null;
  return NextResponse.json(
    { ok: false, code: r.code, error: r.error, hint: r.hint },
    { status: r.status },
  );
}

function il5BlocksDatabricks(): NextResponse | null {
  if ((process.env.LOOM_CLOUD_TIER || '').trim().toUpperCase() === 'IL5') {
    return NextResponse.json(
      { ok: false, code: 'not_authorized', error: 'Databricks backend is not authorized at IL5; use Synapse Livy (unset LOOM_NOTEBOOK_BACKEND).' },
      { status: 403 },
    );
  }
  return null;
}

export const POST = withSession(async (req: NextRequest, { session }) => {

  const body = await req.json().catch(() => ({}));
  const code: string = typeof body?.code === 'string' ? body.code : '';
  if (!code.trim()) return NextResponse.json({ ok: false, error: 'cell is empty' }, { status: 400 });

  // %%configure interception (both backends): not a runnable statement — the
  // editor uses the parsed options to (re)create the session.
  let configureOptions: ReturnType<typeof parseConfigureMagic> = null;
  try { configureOptions = parseConfigureMagic(code); }
  catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 400 }); }
  if (configureOptions) {
    return NextResponse.json({ ok: true, stmtId: null, state: 'configure-applied', configureApplied: true, configureOptions });
  }

  // Detect/strip a language magic (%%sql / %%pyspark / %%spark / %%sparkr).
  const magic = parseMagicKind(code);
  const kind: LivyKind = magic ? magic.kind : normKind(body?.kind);
  const runCode = magic ? magic.strippedCode : code;
  if (!runCode.trim()) return NextResponse.json({ ok: false, error: 'cell has only a magic line — add code below it' }, { status: 400 });

  // ---- Databricks opt-in branch ----
  if (resolveNotebookBackend() === 'databricks') {
    const il5 = il5BlocksDatabricks(); if (il5) return il5;
    if (!process.env.LOOM_DATABRICKS_HOSTNAME) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', error: 'Databricks backend selected but LOOM_DATABRICKS_HOSTNAME is unset.', missing: 'LOOM_DATABRICKS_HOSTNAME' },
        { status: 503 },
      );
    }
    const cluster: string = typeof body?.cluster === 'string' ? body.cluster.trim() : '';
    const contextId: string = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!cluster || !contextId) return NextResponse.json({ ok: false, error: 'cluster and sessionId required' }, { status: 400 });
    const { executeCommand } = await import('@/lib/azure/databricks-client');
    try {
      const cmd = await executeCommand(cluster, contextId, dbxLang(kind), runCode);
      return NextResponse.json({ ok: true, backend: 'databricks', sessionId: contextId, stmtId: cmd.id, state: 'running' });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // ---- AML Compute-Instance Jupyter kernel opt-in branch ----
  if (resolveNotebookBackend() === 'aml-ci') {
    const {
      isJupyterCiConfigured, getNotebookToken, sessionsCreate, executeViaKernelWs,
    } = await import('@/lib/clients/jupyter-server-client');
    if (!isJupyterCiConfigured()) {
      return NextResponse.json(
        {
          ok: false, code: 'not_configured',
          error: 'AML Compute-Instance Jupyter backend selected but LOOM_AML_WORKSPACE / LOOM_SUBSCRIPTION_ID are unset.',
          missing: ['LOOM_AML_WORKSPACE', 'LOOM_SUBSCRIPTION_ID'],
        },
        { status: 503 },
      );
    }
    const notebookPath: string = typeof body?.notebookPath === 'string' ? body.notebookPath.trim() : '';
    const kernelName: string = typeof body?.kernelName === 'string' && body.kernelName.trim() ? body.kernelName.trim() : 'python3';
    let kernelId: string = typeof body?.kernelId === 'string' ? body.kernelId.trim() : '';
    let amlSessionId: string = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    try {
      const token = await getNotebookToken();
      // Allocate a session (and a kernel on a running CI) when one wasn't reused.
      if (!kernelId) {
        if (!notebookPath) {
          return NextResponse.json({ ok: false, error: 'notebookPath is required to start a kernel session' }, { status: 400 });
        }
        const sess = await sessionsCreate(token, notebookPath, kernelName);
        kernelId = sess.kernelId;
        amlSessionId = sess.sessionId;
      }
      // The kernel WebSocket execute is synchronous — it returns the normalized
      // output once execute_reply arrives, so there is no separate poll step.
      const output = await executeViaKernelWs(token, kernelId, amlSessionId, runCode);
      return NextResponse.json({
        ok: output.status !== 'error',
        backend: 'aml-ci',
        sessionId: amlSessionId,
        kernelId,
        state: output.status === 'error' ? 'error' : 'available',
        output,
      });
    } catch (e: any) {
      const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  // ---- Synapse Livy default ----
  const g = synapseGate(); if (g) return g;
  const requestedPool: string = typeof body?.pool === 'string' ? body.pool.trim() : '';
  const sessionId = typeof body?.sessionId === 'number' ? body.sessionId : Number(body?.sessionId);
  // Statement submit is paired with a LIVE session id, so an already-bound pool
  // is honoured verbatim (verifyRequested defaults false); only an ABSENT pool
  // is resolved against the workspace.
  const resolution = await resolveSparkPool(requestedPool);
  const pg = poolGate(resolution); if (pg) return pg;
  const pool = (resolution as Extract<SparkPoolResolution, { ok: true }>).pool;
  const poolMeta = resolution.ok
    ? { pool, poolSource: resolution.source, poolVerified: resolution.verified, poolNote: resolution.note }
    : {};
  if (!Number.isFinite(sessionId) || sessionId <= 0) return NextResponse.json({ ok: false, error: 'sessionId is required' }, { status: 400 });

  try {
    const s = await getLivySession(pool, sessionId);
    if (['error', 'dead', 'killed', 'shutting_down', 'success'].includes(String(s.state))) {
      return NextResponse.json({ ok: false, error: `Session is ${s.state} — create a new session`, sessionDead: true, ...poolMeta }, { status: 409 });
    }
    if (s.state !== 'idle') {
      // Still warming — editor polls the session GET until idle then re-POSTs.
      return NextResponse.json({ ok: true, sessionId, stmtId: null, state: s.state, sessionWarming: true, ...poolMeta });
    }
    const stmt = await submitLivyStatement(pool, sessionId, runCode, kind);
    return NextResponse.json({ ok: true, sessionId, stmtId: stmt.id, state: stmt.state || 'running', ...poolMeta });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), ...poolMeta }, { status: 502 });
  }
});

// Map a Databricks command result into the same NormalizedOutput shape the
// editor renders for Livy.
function normalizeDbxResults(status: string, results: any): NormalizedOutput | null {
  if (!results) return status === 'Error' ? { status: 'error', evalue: 'command error' } : null;
  const rt = results.resultType;
  if (rt === 'error') {
    return { status: 'error', ename: 'CommandError', evalue: results.summary || results.cause || 'error', traceback: results.cause ? [results.cause] : undefined };
  }
  if (rt === 'image') {
    const data = typeof results.data === 'string' ? results.data : '';
    const b64 = data.startsWith('data:image') ? data.split(',')[1] : data;
    return { status: 'ok', imageBase64: b64 || undefined };
  }
  if (rt === 'table') {
    const cols = Array.isArray(results.schema) ? results.schema.map((c: any) => String(c?.name ?? '')) : undefined;
    const rows = Array.isArray(results.data) ? results.data.slice(0, 200).map((row: any) => (Array.isArray(row) ? row.map((c: any) => (c == null ? '' : String(c))) : [String(row)])) : undefined;
    return { status: 'ok', tableColumns: cols, tableRows: rows };
  }
  // text / default
  return { status: 'ok', textPlain: results.data != null ? String(results.data) : '' };
}

export const GET = withSession(async (req: NextRequest) => {

  if (resolveNotebookBackend() === 'databricks') {
    const cluster = req.nextUrl.searchParams.get('cluster')?.trim() || '';
    const contextId = req.nextUrl.searchParams.get('sessionId')?.trim() || '';
    const commandId = req.nextUrl.searchParams.get('stmtId')?.trim() || '';
    if (!cluster || !contextId || !commandId) return NextResponse.json({ ok: false, error: 'cluster, sessionId, stmtId required' }, { status: 400 });
    const { getCommandStatus } = await import('@/lib/azure/databricks-client');
    try {
      const st = await getCommandStatus(cluster, contextId, commandId);
      const done = st.status === 'Finished' || st.status === 'Error' || st.status === 'Cancelled';
      const livyState = st.status === 'Finished' ? 'available' : st.status === 'Error' ? 'error' : st.status === 'Cancelled' ? 'cancelled' : 'running';
      return NextResponse.json({ ok: true, backend: 'databricks', state: livyState, output: done ? normalizeDbxResults(st.status || '', st.results) : null });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // AML CI: execute is synchronous over the kernel WebSocket (the POST already
  // returned the output), so GET only reports session/kernel state — used by the
  // editor to poll while a cold compute instance is still warming.
  if (resolveNotebookBackend() === 'aml-ci') {
    const { isJupyterCiConfigured, getNotebookToken, sessionsGet } = await import('@/lib/clients/jupyter-server-client');
    if (!isJupyterCiConfigured()) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', error: 'AML Compute-Instance Jupyter backend not configured.', missing: ['LOOM_AML_WORKSPACE', 'LOOM_SUBSCRIPTION_ID'] },
        { status: 503 },
      );
    }
    const sid = req.nextUrl.searchParams.get('sessionId')?.trim() || '';
    if (!sid) return NextResponse.json({ ok: false, error: 'sessionId query param required' }, { status: 400 });
    try {
      const token = await getNotebookToken();
      const s = await sessionsGet(token, sid);
      return NextResponse.json({ ok: true, backend: 'aml-ci', sessionId: s.sessionId, kernelId: s.kernelId, state: s.state || 'unknown', output: null });
    } catch (e: any) {
      const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  const g = synapseGate(); if (g) return g;
  const requestedPool = req.nextUrl.searchParams.get('pool')?.trim() || '';
  // ABSENT is not 0: `Number(null)` and `Number('')` are both 0 and finite, so
  // presence is checked on the raw param. The `!pool` term used to mask this.
  const sessionParam = req.nextUrl.searchParams.get('sessionId');
  const stmtParam = req.nextUrl.searchParams.get('stmtId');
  const sessionId = Number(sessionParam);
  const stmtId = Number(stmtParam);
  if (!sessionParam || !stmtParam || !Number.isFinite(sessionId) || !Number.isFinite(stmtId)) {
    return NextResponse.json({ ok: false, error: 'sessionId and stmtId query params required' }, { status: 400 });
  }
  const resolution = await resolveSparkPool(requestedPool);
  const pg = poolGate(resolution); if (pg) return pg;
  const pool = (resolution as Extract<SparkPoolResolution, { ok: true }>).pool;
  try {
    const st = await getLivyStatement(pool, sessionId, stmtId);
    const output = st.output ? normalizeLivyOutput(st.output) : null;
    return NextResponse.json({ ok: true, sessionId, stmtId, state: st.state, output, progress: st.progress });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
