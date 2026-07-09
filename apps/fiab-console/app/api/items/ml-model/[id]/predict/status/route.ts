/**
 * ML-model PREDICT — batch-scoring job status poller (rel-T84).
 *
 *   GET /api/items/ml-model/[id]/predict/status?runId=<runId>
 *     → { ok, backend, status, phase?, output?, outputRef?, result? }
 *
 * Drives an in-flight PREDICT scoring job to completion, mirroring the
 * notebook %%pyspark poller:
 *   • AML  ("aml:<job>")  → poll the Serverless Spark job, then read
 *     result.json back from the workspace blob store.
 *   • Synapse ("synapse-spark:<pool>:<session>[:<stmt>]") → submit the pending
 *     statement once the session reaches idle, then poll the statement.
 *
 * On success the parsed `LOOM_PREDICT_RESULT` receipt (row count + scored-table
 * location) is returned so the wizard can link to the output. All real Azure
 * REST — no mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  resolveModelBinding, modelBindingErrorResponse, ML_MODEL_ITEM_TYPE,
} from '@/lib/azure/model-binding';
import {
  submitLivyStatement, getLivyStatement, getLivySession, normalizeLivyOutput,
} from '@/lib/azure/synapse-livy-client';
import { parsePredictResult } from '@/lib/azure/predict-codegen';
import { apiError, apiServerError } from '@/lib/api/respond';
import { applyHistoryStatus, type PredictHistoryEntry } from '@/lib/azure/predict-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Honest 4xx gate envelope ({ok:false,error,hint}) — delegates to apiError.
 *  5xx paths use apiServerError so raw exception text never leaks. */
function err(error: string, status: number, hint?: string) {
  return apiError(error, status, hint ? { hint } : undefined);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);
  const { id } = await ctx.params;

  let binding: Awaited<ReturnType<typeof resolveModelBinding>>;
  try {
    binding = await resolveModelBinding(id, ML_MODEL_ITEM_TYPE, session.claims.oid);
  } catch (e) {
    const { status, body } = modelBindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }

  const runId = decodeURIComponent(req.nextUrl.searchParams.get('runId') || '');
  if (!runId) return err('runId required', 400);

  /**
   * Best-effort: stamp a terminal status onto the run's history entry (FGC-18
   * "run history persisted"). Re-reads the item to avoid clobbering a concurrent
   * write, matches the entry by runId (prefix-aware for Synapse), and no-ops when
   * nothing changed. Never throws — history is a convenience, not the job.
   */
  async function markHistory(
    id2: string,
    patch: Partial<Pick<PredictHistoryEntry, 'status' | 'rows' | 'error' | 'finishedAt' | 'outputRef'>>,
  ): Promise<void> {
    try {
      const items = await itemsContainer();
      const { resource } = await items.item(binding.item.id, binding.item.workspaceId).read<any>();
      if (!resource) return;
      const state = resource.state || {};
      const nextHistory = applyHistoryStatus(state.predictHistory, id2, { finishedAt: new Date().toISOString(), ...patch });
      if (nextHistory === state.predictHistory) return; // no matching entry / no change
      await items.item(resource.id, resource.workspaceId).replace({
        ...resource, state: { ...state, predictHistory: nextHistory }, updatedAt: new Date().toISOString(),
      });
    } catch { /* non-fatal */ }
  }

  try {
    // ---- AML Serverless Spark ----
    if (runId.startsWith('aml:')) {
      const jobName = runId.slice('aml:'.length);
      const { getAmlSparkJob, readAmlSparkResult } = await import('@/lib/azure/aml-spark-client');
      const job = await getAmlSparkJob(jobName);
      if (!job.terminal) {
        return NextResponse.json({ ok: true, backend: 'aml', status: job.status, phase: 'job-running', runId });
      }
      const raw = await readAmlSparkResult(`loom-spark-out/${jobName}/result.json`);
      const text = raw?.textPlain;
      const result = parsePredictResult(text);
      if (raw && raw.status === 'error') {
        await markHistory(runId, { status: 'failed', error: `${raw.ename || 'Error'}: ${raw.evalue || 'scoring failed'}` });
        return NextResponse.json({
          ok: true, backend: 'aml', status: job.status, runId,
          output: { status: 'error', ename: raw.ename, evalue: raw.evalue, traceback: raw.traceback },
        });
      }
      await markHistory(runId, job.succeeded
        ? { status: 'succeeded', rows: result?.rows ?? null }
        : { status: 'failed', error: `AML Spark job ${jobName} ended ${job.status}` });
      return NextResponse.json({
        ok: true, backend: 'aml', status: job.status, runId,
        output: job.succeeded
          ? { status: 'ok', textPlain: text || '(job completed)' }
          : { status: 'error', ename: 'SparkJobFailed', evalue: `AML Spark job ${jobName} ended ${job.status}` },
        result: result || undefined,
      });
    }

    // ---- Synapse Livy ----
    if (runId.startsWith('synapse-spark:')) {
      const [, pool, sessionIdStr, stmtIdStr] = runId.split(':');
      const sessionId = Number(sessionIdStr);
      const stmtId = stmtIdStr ? Number(stmtIdStr) : undefined;

      const items = await itemsContainer();
      const item = binding.item;
      const state = (item.state as any) || {};
      const baseRunId = `synapse-spark:${pool}:${sessionId}`;
      const pending = state.predictRuns?.[baseRunId];
      const code: string = pending?.source || '';
      const outputRef: string | undefined = pending?.outputRef;

      // Phase 1: session not yet idle → submit on idle, embed stmtId in runId.
      if (stmtId === undefined) {
        const sess = await getLivySession(pool, sessionId);
        if (sess.state === 'idle') {
          if (!code.trim()) return err('pending scoring job not found — re-run the stepper', 409);
          const stmt = await submitLivyStatement(pool, sessionId, code, 'pyspark');
          try {
            const nextPending = { ...(state.predictRuns || {}) };
            // Preserve the outputRef under the statement-scoped runId for phase 2.
            const nextRunId = `${baseRunId}:${stmt.id}`;
            nextPending[nextRunId] = { ...pending, source: code, outputRef };
            delete nextPending[baseRunId];
            await items.item(item.id, item.workspaceId).replace({
              ...item, state: { ...state, predictRuns: nextPending }, updatedAt: new Date().toISOString(),
            } as WorkspaceItem);
          } catch { /* non-fatal */ }
          return NextResponse.json({
            ok: true, backend: 'synapse', status: stmt.state || 'running',
            runId: `${baseRunId}:${stmt.id}`, phase: 'statement-submitted', outputRef,
          });
        }
        if (['error', 'dead', 'killed'].includes(sess.state)) {
          await markHistory(runId, { status: 'failed', error: `Spark session entered '${sess.state}'` });
          return NextResponse.json({
            ok: true, backend: 'synapse', status: sess.state, runId, phase: 'session-dead',
            output: { status: 'error', ename: 'SessionDead', evalue: `Spark session entered '${sess.state}'` },
          });
        }
        return NextResponse.json({ ok: true, backend: 'synapse', status: sess.state, runId, phase: 'session-starting', outputRef });
      }

      // Phase 2: statement in flight.
      const stmtRunId = `${baseRunId}:${stmtId}`;
      const stmtOutputRef: string | undefined = state.predictRuns?.[stmtRunId]?.outputRef ?? outputRef;
      const stmt = await getLivyStatement(pool, sessionId, stmtId);
      const out = stmt.output ? normalizeLivyOutput(stmt.output) : null;
      const result = out?.status === 'ok' ? parsePredictResult(out.textPlain) : null;
      if (out) {
        await markHistory(runId, out.status === 'ok'
          ? { status: 'succeeded', rows: result?.rows ?? null }
          : { status: 'failed', error: `${out.ename || 'Error'}: ${out.evalue || 'scoring failed'}` });
      }
      return NextResponse.json({
        ok: true, backend: 'synapse', status: stmt.state, runId, phase: 'statement-running', outputRef: stmtOutputRef,
        output: out
          ? (out.status === 'ok'
              ? { status: 'ok', textPlain: out.textPlain ?? '(no output)' }
              : { status: 'error', ename: out.ename, evalue: out.evalue, traceback: out.traceback })
          : null,
        result: result || undefined,
      });
    }

    return err(`unsupported runId format: ${runId}`, 400);
  } catch (e: any) {
    if (e?.status && e.status < 500) return err(e.message, e.status, e?.hint);
    return apiServerError(e, 'scoring status check failed', 'predict_status_error');
  }
}
