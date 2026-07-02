/**
 * GET /api/items/notebook/[id]/runs/[runId]?workspaceId=...
 *   → { ok, status, output?, runUrl? }
 *
 * Poll endpoint for an in-flight notebook run. Handles the lifecycle:
 *   - For Synapse Spark:
 *       runId = "spark:<pool>:<sessionId>"
 *       If session state is 'starting', poll just returns current state.
 *       When session reaches 'idle' AND no statement has been submitted yet,
 *       submit the notebook code as a statement and persist statementId
 *       in the session's URL. Subsequent polls return statement state +
 *       output once it's 'available'.
 *   - For Databricks: runId = "databricks:<runId>", just polls Jobs API.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { LOOM_DISPLAY_MIME } from '@/lib/types/notebook-cell';
import { buildLoomDisplay, enrichChartRecs } from '@/lib/notebook/display-stats';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



interface RunRecord {
  id: string; status: string; jobType: string; invokeType: string;
  startTimeUtc: string; endTimeUtc: string;
  failureReason?: { errorCode?: string; message?: string } | null;
}

/**
 * Append a terminal run to the notebook's Cosmos run history (drained by
 * /jobs). Idempotent by runId, capped at 50, non-fatal — a write failure must
 * never break a poll. Azure-native: this is the DEFAULT history backend, no
 * Fabric required.
 */
async function recordRun(items: any, nb: WorkspaceItem, workspaceId: string, runId: string, rec: Omit<RunRecord, 'id' | 'jobType' | 'invokeType' | 'startTimeUtc'>): Promise<void> {
  try {
    const state = (nb.state as any) || {};
    const history: RunRecord[] = Array.isArray(state.runHistory) ? state.runHistory : [];
    if (history.some((h) => h.id === runId)) return;
    const startedAt = state.pendingRuns?.[runId]?.startedAt || new Date(Date.now() - 1000).toISOString();
    history.push({ id: runId, jobType: 'NotebookRun', invokeType: 'Manual', startTimeUtc: startedAt, ...rec });
    await items.item(nb.id, workspaceId).replace({
      ...nb, state: { ...state, runHistory: history.slice(-50) }, updatedAt: new Date().toISOString(),
    } as WorkspaceItem);
  } catch { /* non-fatal — history is best-effort */ }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; runId: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);

  const runId = decodeURIComponent((await ctx.params).runId);
  try {
    // Load notebook for code/lang context
    const items = await itemsContainer();
    const { resource: nb } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!nb || nb.itemType !== 'notebook') return apiError('notebook not found', 404);
    const state = (nb.state as any) || {};
    // Per-cell run uses pendingRuns[runId] cached at dispatch; fall back to whole-notebook code.
    const pending = state.pendingRuns?.[runId];
    const code: string = pending?.source || state.code || '';
    // v3.x bug fix: previously 'sparksql' was bucketed into Scala-kind 'spark'
    // which made `show databases` hang because Livy tried to parse SQL as
    // Scala. Use Livy's per-statement kind 'sql' for Spark SQL cells.
    const lang: 'sql' | 'spark' | 'pyspark' | 'sparkr' = (() => {
      const l = (pending?.lang || state.lang || '').toLowerCase();
      if (l === 'sql' || l === 'sparksql' || l === 'spark-sql') return 'sql';
      if (l === 'spark' || l === 'scala') return 'spark';
      if (l === 'sparkr' || l === 'r') return 'sparkr';
      return 'pyspark';
    })();

    // ---- AML Compute Instance Command job poll ----
    // runId = "aml-ci:<jobName>". Maps the AML job status to the cell-output
    // contract the editor already understands. Azure-native — no Fabric.
    if (runId.startsWith('aml-ci:')) {
      const jobName = runId.slice('aml-ci:'.length);
      const { getCiJob, amlJobIsTerminal } = await import('@/lib/azure/aml-client');
      const job = await getCiJob(jobName);
      if (!job) return NextResponse.json({ ok: true, status: 'NotStarted', runId, phase: 'job-pending' });
      const terminal = amlJobIsTerminal(job.status);
      const ok = job.status === 'Completed';
      if (terminal) await recordRun(items, nb, workspaceId, runId, {
        status: ok ? 'Completed' : 'Failed', endTimeUtc: new Date().toISOString(),
        failureReason: ok ? null : { errorCode: job.status, message: `AML job ${jobName} ended with status '${job.status}'` },
      });
      return NextResponse.json({
        ok: true,
        status: job.status || 'NotStarted',
        runId,
        phase: terminal ? 'job-complete' : 'job-running',
        output: terminal ? (ok ? {
          status: 'ok',
          textPlain: `Job ${jobName} completed on the AML Compute Instance. View driver logs + outputs in the run's "Outputs + logs" tab.`,
        } : {
          status: 'error',
          ename: job.status,
          evalue: `AML job ${jobName} ended with status '${job.status}'. Open the run's "Outputs + logs" for the full traceback.`,
        }) : null,
      });
    }

    if (runId.startsWith('spark:')) {
      const [, pool, sessionIdStr, statementIdStr] = runId.split(':');
      const sessionId = Number(sessionIdStr);
      const stmtId = statementIdStr ? Number(statementIdStr) : undefined;
      const { getLivySession, submitLivyStatement, getLivyStatement } = await import('@/lib/azure/synapse-dev-client');

      // Phase 1: session not yet idle — return state
      if (stmtId === undefined) {
        const sess = await getLivySession(pool, sessionId);
        if (sess.state === 'idle') {
          // Promote: submit the code as a statement, embed stmtId in next runId
          const stmt = await submitLivyStatement(pool, sessionId, { code, kind: lang });
          // Clean the pendingRuns entry now that the statement is submitted.
          if (pending) {
            try {
              const nextPending = { ...(state.pendingRuns || {}) };
              delete nextPending[runId];
              await items.item(nb.id, workspaceId).replace({
                ...nb,
                state: { ...state, pendingRuns: nextPending },
                updatedAt: new Date().toISOString(),
              } as WorkspaceItem);
            } catch { /* non-fatal */ }
          }
          return NextResponse.json({
            ok: true,
            status: stmt.state || 'running',
            runId: `spark:${pool}:${sessionId}:${stmt.id}`,
            phase: 'statement-submitted',
          });
        }
        if (['error', 'dead', 'killed'].includes(sess.state)) {
          return NextResponse.json({ ok: false, error: `Spark session ${sessionId} entered terminal state '${sess.state}'`, status: sess.state });
        }
        return NextResponse.json({ ok: true, status: sess.state, runId, phase: 'session-starting' });
      }

      // Phase 2: statement in flight
      const stmt = await getLivyStatement(pool, sessionId, stmtId);
      const out = (stmt as any).output || {};
      // For Spark SQL statements, Livy returns rows under
      //   output.data['application/json'] = { schema:{fields:[]}, data:[[]] }
      // The default textPlain is empty. Format an ASCII table so the cell
      // renders something readable.
      function formatSqlTable(payload: any): string | undefined {
        if (!payload || !Array.isArray(payload.data)) return undefined;
        const cols: string[] = (payload.schema?.fields || []).map((f: any) => f.name || '');
        if (cols.length === 0 && payload.data[0]) {
          for (let i = 0; i < payload.data[0].length; i++) cols.push(`c${i}`);
        }
        const widths = cols.map((c, i) => Math.max(
          c.length,
          ...payload.data.map((row: any[]) => String(row[i] ?? '').length),
        ));
        const fmtRow = (row: any[]) =>
          row.map((v, i) => String(v ?? '').padEnd(widths[i])).join(' | ');
        const header = fmtRow(cols);
        const sep = widths.map((w) => '-'.repeat(w)).join('-+-');
        const body = payload.data.slice(0, 100).map(fmtRow).join('\n');
        const more = payload.data.length > 100 ? `\n… ${payload.data.length - 100} more rows` : '';
        return `${header}\n${sep}\n${body}${more}`;
      }
      const sqlJson = out?.data?.['application/json'];
      const sqlTable = sqlJson && Array.isArray(sqlJson.data) ? formatSqlTable(sqlJson) : undefined;

      // Rich display(): the ai-display.py helper emits
      //   data['application/vnd.loom.display+json'] = LoomDisplayPayload
      // (columns + sampled rows + real stats, chartRecs left empty). Enrich its
      // chart recommendations server-side. FALLBACK: a raw Spark DataFrame
      // (e.g. Spark SQL output, or display() without the helper loaded) arrives
      // as application/json split-orient — profile it here so the grid still
      // renders real column stats + at least one recommended chart.
      const sampleRows = Number(process.env.LOOM_DISPLAY_SAMPLE_ROWS) || 5000;
      let richDisplay: import('@/lib/types/notebook-cell').LoomDisplayPayload | undefined;
      const kernelDisplay = out?.data?.[LOOM_DISPLAY_MIME];
      if (kernelDisplay && Array.isArray(kernelDisplay.columns) && Array.isArray(kernelDisplay.rows)) {
        richDisplay = enrichChartRecs(kernelDisplay as import('@/lib/types/notebook-cell').LoomDisplayPayload);
      } else if (sqlJson && Array.isArray(sqlJson.data) && Array.isArray(sqlJson.schema?.fields)) {
        richDisplay = buildLoomDisplay(sqlJson, sampleRows) || undefined;
      }

      if (out.status === 'ok' || out.status === 'error') await recordRun(items, nb, workspaceId, runId, {
        status: out.status === 'ok' ? 'Completed' : 'Failed', endTimeUtc: new Date().toISOString(),
        failureReason: out.status === 'error' ? { errorCode: out.ename, message: out.evalue } : null,
      });
      return NextResponse.json({
        ok: true,
        status: stmt.state,
        runId,
        phase: 'statement-running',
        output: out.status === 'ok' ? {
          status: 'ok',
          data: out.data || {},
          textPlain: sqlTable || out.data?.['text/plain'] || '(no output)',
          rowCount: sqlJson?.data?.length ?? richDisplay?.totalCount,
          richDisplay,
        } : out.status === 'error' ? {
          status: 'error',
          ename: out.ename,
          evalue: out.evalue,
          traceback: out.traceback,
        } : null,
      });
    }

    if (runId.startsWith('databricks:')) {
      const dbxRunId = Number(runId.slice('databricks:'.length));
      const { getJobRun, getRunOutput } = await import('@/lib/azure/databricks-client');
      const run = await getJobRun(dbxRunId);
      const lifeState = (run as any).state?.life_cycle_state;
      const resultState = (run as any).state?.result_state;
      let output: any = null;
      if (lifeState === 'TERMINATED' || lifeState === 'INTERNAL_ERROR') {
        try {
          const o = await getRunOutput(dbxRunId);
          output = { status: resultState === 'SUCCESS' ? 'ok' : 'error', ...o };
        } catch { /* keep null */ }
        await recordRun(items, nb, workspaceId, runId, {
          status: resultState === 'SUCCESS' ? 'Completed' : 'Failed', endTimeUtc: new Date().toISOString(),
          failureReason: resultState === 'SUCCESS' ? null : { errorCode: resultState, message: (run as any).state?.state_message },
        });
      }
      return NextResponse.json({
        ok: true,
        status: lifeState || 'PENDING',
        resultState,
        runUrl: (run as any).run_page_url,
        runId,
        output,
      });
    }

    return apiError(`unsupported runId format: ${runId}`, 400);
  } catch (e: any) {
    return apiError(e?.message || String(e), e?.status || 502);
  }
}
