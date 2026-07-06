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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, hint?: string) {
  return NextResponse.json({ ok: false, error, hint }, { status });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);
  const { id } = await ctx.params;

  let binding;
  try {
    binding = await resolveModelBinding(id, ML_MODEL_ITEM_TYPE, session.claims.oid);
  } catch (e) {
    const { status, body } = modelBindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }

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
      const raw = await readAmlSparkResult(`loom-spark-out/${jobName}/result.json`);
      const text = raw?.textPlain;
      const result = parsePredictResult(text);
      if (raw && raw.status === 'error') {
        return NextResponse.json({
          ok: true, backend: 'aml', status: job.status, runId,
          output: { status: 'error', ename: raw.ename, evalue: raw.evalue, traceback: raw.traceback },
        });
      }
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
    return err(e?.message || String(e), e?.status || 502, e?.hint);
  }
}
