/**
 * %%pyspark cell routing — POST (submit) + GET (poll).
 *
 *   POST /api/items/notebook/[id]/execute-spark?workspaceId=...
 *     body { source, cellId }
 *     → strips the %%pyspark magic, picks a Spark backend, submits one cell:
 *         • Commercial / GCC with LOOM_AML_SPARK set → AML Serverless Spark
 *           standalone job (real ARM job + blob result capture).
 *         • Gov (GCC-High / IL5) OR no AML configured → Synapse Spark via Livy
 *           interactive session/statement on LOOM_SYNAPSE_SPARK_POOL.
 *       Returns { ok, runId, status }. Async by design (Front Door 30s cap):
 *       the client polls the GET below.
 *
 *   GET /api/items/notebook/[id]/execute-spark?workspaceId=...&runId=...
 *     → { ok, status, phase?, output? }. For Synapse: submit-on-idle then poll
 *       the statement (mirrors the whole-notebook /runs poller). For AML: poll
 *       the job, then read result.json back from the workspace blob store.
 *
 * Backend selection is automatic from env — the user never picks AML vs
 * Synapse; %%pyspark always lands on real Spark. No mocks; AML/Synapse errors
 * surface verbatim. Per no-fabric-dependency.md the DEFAULT (no AML, or Gov)
 * is the Azure-native Synapse Livy path and needs no Fabric workspace.
 *
 * Learn:
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-statement
 *   https://learn.microsoft.com/azure/machine-learning/how-to-submit-spark-jobs
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import {
  createLivySession, getLivySession, submitLivyStatement, getLivyStatement,
  parseMagicKind, normalizeLivyOutput,
} from '@/lib/azure/synapse-livy-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, hint?: string) {
  return NextResponse.json({ ok: false, error, hint }, { status });
}

/**
 * Resolve the Spark backend for %%pyspark cells.
 *  - Azure Government (GCC-High / IL5) → always Synapse Livy (AML Serverless
 *    Spark isn't offered in Gov).
 *  - LOOM_CLOUD_TIER=IL5 → Synapse Livy (defense-in-depth alongside isGovCloud).
 *  - Commercial / GCC with LOOM_AML_SPARK set → AML Serverless Spark.
 *  - otherwise → Synapse Livy (Azure-native default).
 */
export function resolveSparkBackend(): 'aml' | 'synapse' {
  if (isGovCloud()) return 'synapse';
  if ((process.env.LOOM_CLOUD_TIER || '').trim().toUpperCase() === 'IL5') return 'synapse';
  if ((process.env.LOOM_AML_SPARK || '').trim()) return 'aml';
  return 'synapse';
}

/** Synapse Spark pool dedicated to notebook %%pyspark cells (falls back to LOOM_SPARK_POOL). */
export function notebookSparkPool(): string {
  return (process.env.LOOM_SYNAPSE_SPARK_POOL || process.env.LOOM_SPARK_POOL || '').trim();
}

async function loadNotebook(id: string, workspaceId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  try {
    const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
    return (resource && resource.itemType === 'notebook') ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

// ============================================================
// POST — submit one %%pyspark cell
// ============================================================

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('notebook not found', 404);
  const body = await req.json().catch(() => ({}));
  const source: string = typeof body?.source === 'string' ? body.source : '';
  const cellId: string = typeof body?.cellId === 'string' ? body.cellId : '';
  if (!source.trim()) return err('cell is empty — write code before running', 400);

  // %%pyspark (and python/spark aliases) → strip the magic, run the body.
  const magic = parseMagicKind(source);
  const code = magic ? magic.strippedCode : source;
  if (!code.trim()) return err('cell has only a magic line — add PySpark code below it', 400);

  try {
    const nb = await loadNotebook((await ctx.params).id, workspaceId);
    if (!nb) return err('notebook not found', 404);
    const backend = resolveSparkBackend();

    if (backend === 'aml') {
      const { submitAmlSparkCell, AmlSparkNotConfiguredError } = await import('@/lib/azure/aml-spark-client');
      try {
        const sub = await submitAmlSparkCell(code, cellId);
        return NextResponse.json({
          ok: true,
          backend: 'aml',
          runId: `aml:${sub.jobName}`,
          status: 'Queued',
          cellId: cellId || null,
        });
      } catch (e: any) {
        if (e instanceof AmlSparkNotConfiguredError) {
          return err(e.message, 503, e.hint);
        }
        throw e;
      }
    }

    // ---- Synapse Livy default ----
    const pool = notebookSparkPool();
    if (!pool) {
      return err(
        'No Synapse Spark pool configured for %%pyspark cells.',
        503,
        'Set LOOM_SYNAPSE_SPARK_POOL (or LOOM_SPARK_POOL) to a deployed Synapse Spark pool, and grant the Console UAMI the "Synapse Compute Operator" role on it.',
      );
    }
    const state = (nb.state as any) || {};
    // Reuse a live pyspark session if one is cached for this pool.
    let sessionId: number | undefined;
    let sessState = 'starting';
    const saved = state.sparkSession;
    if (saved && saved.pool === pool && saved.kind === 'pyspark' && typeof saved.id === 'number') {
      try {
        const live = await getLivySession(pool, saved.id);
        if (['idle', 'busy', 'starting', 'not_started'].includes(live.state)) {
          sessionId = saved.id; sessState = live.state;
        }
      } catch { /* stale → recreate */ }
    }
    if (sessionId === undefined) {
      const sess = await createLivySession(pool, { kind: 'pyspark', name: `loom-pyspark-${Date.now()}` });
      sessionId = sess.id; sessState = sess.state;
    }
    const runId = `synapse-spark:${pool}:${sessionId}`;

    // Persist session + the pending statement so the GET poller can submit it
    // once the session reaches idle (Front Door can't hold a 60-90s cold start).
    try {
      const items = await itemsContainer();
      const pendingRuns = { ...(state.pendingRuns || {}) };
      pendingRuns[runId] = { source: code, lang: 'pyspark', cellId };
      await items.item(nb.id, workspaceId).replace({
        ...nb,
        state: { ...state, pendingRuns, sparkSession: { pool, id: sessionId, kind: 'pyspark' } },
        updatedAt: new Date().toISOString(),
      } as WorkspaceItem);
    } catch { /* non-fatal */ }

    return NextResponse.json({
      ok: true,
      backend: 'synapse',
      runId,
      status: sessState,
      cellId: cellId || null,
    });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502, e?.hint);
  }
}

// ============================================================
// GET — poll an in-flight %%pyspark run
// ============================================================

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('notebook not found', 404);
  const runId = decodeURIComponent(req.nextUrl.searchParams.get('runId') || '');
  if (!runId) return err('runId required', 400);

  try {
    // ---- AML Serverless Spark ----
    if (runId.startsWith('aml:')) {
      const jobName = runId.slice('aml:'.length);
      const { getAmlSparkJob, readAmlSparkResult } = await import('@/lib/azure/aml-spark-client');
      const job = await getAmlSparkJob(jobName);
      if (!job.terminal) {
        return NextResponse.json({ ok: true, backend: 'aml', status: job.status, phase: 'job-running', runId });
      }
      const result = await readAmlSparkResult(`loom-spark-out/${jobName}/result.json`);
      if (!result) {
        // Terminal with no result file — surface the AML outcome honestly.
        return NextResponse.json({
          ok: true, backend: 'aml', status: job.status, runId,
          output: job.succeeded
            ? { status: 'ok', textPlain: '(job completed; no captured output)' }
            : { status: 'error', ename: 'SparkJobFailed', evalue: `AML Spark job ${jobName} ended ${job.status}` },
        });
      }
      return NextResponse.json({
        ok: true, backend: 'aml', status: job.status, runId,
        output: result.status === 'ok'
          ? { status: 'ok', textPlain: result.textPlain || '(no output)' }
          : { status: 'error', ename: result.ename, evalue: result.evalue, traceback: result.traceback },
      });
    }

    // ---- Synapse Livy ----
    if (runId.startsWith('synapse-spark:')) {
      const [, pool, sessionIdStr, stmtIdStr] = runId.split(':');
      const sessionId = Number(sessionIdStr);
      const stmtId = stmtIdStr ? Number(stmtIdStr) : undefined;

      const items = await itemsContainer();
      const { resource: nb } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
      if (!nb || nb.itemType !== 'notebook') return err('notebook not found', 404);
      const state = (nb.state as any) || {};
      const baseRunId = `synapse-spark:${pool}:${sessionId}`;
      const pending = state.pendingRuns?.[baseRunId];
      const code: string = pending?.source || '';

      // Phase 1: session not yet idle → submit on idle, embed stmtId in runId.
      if (stmtId === undefined) {
        const sess = await getLivySession(pool, sessionId);
        if (sess.state === 'idle') {
          if (!code.trim()) return err('pending cell source not found — re-run the cell', 409);
          const stmt = await submitLivyStatement(pool, sessionId, code, 'pyspark');
          try {
            const nextPending = { ...(state.pendingRuns || {}) };
            delete nextPending[baseRunId];
            await items.item(nb.id, workspaceId).replace({
              ...nb, state: { ...state, pendingRuns: nextPending }, updatedAt: new Date().toISOString(),
            } as WorkspaceItem);
          } catch { /* non-fatal */ }
          return NextResponse.json({
            ok: true, backend: 'synapse', status: stmt.state || 'running',
            runId: `${baseRunId}:${stmt.id}`, phase: 'statement-submitted',
          });
        }
        if (['error', 'dead', 'killed'].includes(sess.state)) {
          return NextResponse.json({ ok: true, backend: 'synapse', status: sess.state, runId, phase: 'session-dead',
            output: { status: 'error', ename: 'SessionDead', evalue: `Spark session entered '${sess.state}'` } });
        }
        return NextResponse.json({ ok: true, backend: 'synapse', status: sess.state, runId, phase: 'session-starting' });
      }

      // Phase 2: statement in flight.
      const stmt = await getLivyStatement(pool, sessionId, stmtId);
      const out = stmt.output ? normalizeLivyOutput(stmt.output) : null;
      return NextResponse.json({
        ok: true, backend: 'synapse', status: stmt.state, runId, phase: 'statement-running',
        output: out
          ? (out.status === 'ok'
              ? { status: 'ok', textPlain: out.textPlain ?? '(no output)', data: { tableColumns: out.tableColumns, tableRows: out.tableRows, textHtml: out.textHtml, imageBase64: out.imageBase64 } }
              : { status: 'error', ename: out.ename, evalue: out.evalue, traceback: out.traceback })
          : null,
      });
    }

    return err(`unsupported runId format: ${runId}`, 400);
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502, e?.hint);
  }
}
