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
import { assertOwner } from '@/lib/auth/workspace-guard';
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
async function recordRun(
  items: any,
  nb: WorkspaceItem,
  workspaceId: string,
  runId: string,
  rec: Omit<RunRecord, 'id' | 'jobType' | 'invokeType' | 'startTimeUtc'>,
  // When set, drop this key from pendingRuns in the SAME write — so a finished
  // queued "Run all" both records history AND clears its queue entry in one
  // replace (two separate writes raced on shared state and one clobbered the
  // other; this keeps a single source of truth).
  clearPendingKey?: string,
): Promise<void> {
  try {
    const state = (nb.state as any) || {};
    const history: RunRecord[] = Array.isArray(state.runHistory) ? state.runHistory : [];
    if (history.some((h) => h.id === runId)) return;
    const startedAt = state.pendingRuns?.[runId]?.startedAt || new Date(Date.now() - 1000).toISOString();
    history.push({ id: runId, jobType: 'NotebookRun', invokeType: 'Manual', startTimeUtc: startedAt, ...rec });
    let pendingRuns = state.pendingRuns;
    if (clearPendingKey && pendingRuns && typeof pendingRuns === 'object') {
      pendingRuns = { ...pendingRuns };
      delete pendingRuns[clearPendingKey];
    }
    await items.item(nb.id, workspaceId).replace({
      ...nb,
      state: { ...state, runHistory: history.slice(-50), ...(clearPendingKey ? { pendingRuns } : {}) },
      updatedAt: new Date().toISOString(),
    } as WorkspaceItem);
  } catch { /* non-fatal — history is best-effort */ }
}

/**
 * Drop one or more keys from the notebook's pendingRuns map (R3 #4 — a resume
 * poll that finds the Livy session gone/dead must CLEAN its stale entry so it
 * doesn't re-resume on every reload). Best-effort, non-fatal: a write failure
 * must never break the poll response.
 */
async function clearPendingRuns(
  items: any, nb: WorkspaceItem, workspaceId: string, keys: string[],
): Promise<void> {
  try {
    const state = (nb.state as any) || {};
    const pendingRuns = state.pendingRuns;
    if (!pendingRuns || typeof pendingRuns !== 'object') return;
    let changed = false;
    const next = { ...pendingRuns };
    for (const k of keys) { if (k in next) { delete next[k]; changed = true; } }
    if (!changed) return;
    await items.item(nb.id, workspaceId).replace({
      ...nb, state: { ...state, pendingRuns: next }, updatedAt: new Date().toISOString(),
    } as WorkspaceItem);
  } catch { /* non-fatal */ }
}

// Bounds for surfacing rich output shapes (R3 #5) without bloating the response
// or the persisted pendingRuns.cellOutputs (Cosmos 2MB doc cap).
const IMG_CAP = 2_000_000;   // ~2MB base64 per image; larger is dropped (a partial base64 is useless)
const HTML_CAP = 200_000;    // truncate a runaway text/html repr

/**
 * Keep only the renderable RICH mime shapes from a Livy output.data map —
 * image/* (bounded) + a truncated text/html — so a "Run all" cell can render a
 * matplotlib plot / DataFrame HTML the same as a single-cell run (R3 #5). The
 * bulky application/json is intentionally NOT kept here: the grid renders from
 * richDisplay/textPlain, so re-shipping the raw rows per cell would bloat the
 * response. Returns undefined when there is nothing rich to keep.
 */
function pickRichData(data: any): Record<string, string> | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const kept: Record<string, string> = {};
  for (const k of ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp']) {
    const v = data[k];
    if (typeof v === 'string' && v.length <= IMG_CAP) kept[k] = v;
  }
  const html = data['text/html'];
  if (typeof html === 'string') {
    kept['text/html'] = html.length > HTML_CAP ? html.slice(0, HTML_CAP) + '\n<!-- …truncated -->' : html;
  }
  return Object.keys(kept).length ? kept : undefined;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; runId: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('notebook not found', 404);

  const runId = decodeURIComponent((await ctx.params).runId);
  try {
    // Load notebook for code/lang context
    const items = await itemsContainer();
    const { resource: nb } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!nb || nb.itemType !== 'notebook') return apiError('notebook not found', 404);
    const state = (nb.state as any) || {};
    // Per-cell run uses pendingRuns[runId] cached at dispatch; fall back to whole-notebook code.
    // pendingRuns is keyed by the BASE runId (spark:<pool>:<sessionId>) — a phase-2
    // poll arrives with the statement id appended, so also look up the base key
    // (that's where the whole-notebook per-cell queue lives).
    const basePendingKey = runId.startsWith('spark:') ? runId.split(':').slice(0, 3).join(':') : runId;
    const pending = state.pendingRuns?.[runId] || state.pendingRuns?.[basePendingKey];
    // Whole-notebook "Run all" queue: one Livy statement per code cell, each with
    // its own kind (mixed sparksql/pyspark notebooks can't run as one statement).
    const queue: Array<{ source: string; lang: string; cellId?: string }> = Array.isArray(pending?.queue) ? pending.queue : [];
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
        let sess: { id: number; state: string; appInfo?: any };
        try {
          sess = await getLivySession(pool, sessionId);
        } catch (e: any) {
          // A resume poll (R3 #4) can land on a session Livy already reaped
          // (idle-timeout → 404). Treat a definitive not-found as session-gone:
          // clean the stale pendingRuns entry and return an HONEST cell error
          // (ok:true so the editor renders it on the cell, not a transport 502
          // the client would retry forever). A transient error (not 404)
          // rethrows to the outer catch → 502, leaving the entry intact.
          if (/failed 404\b/.test(String(e?.message || ''))) {
            await clearPendingRuns(items, nb, workspaceId, [runId, basePendingKey]);
            return NextResponse.json({
              ok: true, status: 'dead', runId, phase: 'session-gone',
              output: {
                status: 'error', ename: 'SessionGone',
                evalue: `Spark session ${sessionId} is no longer available — it was recycled or timed out. Re-run the cell.`,
              },
            });
          }
          throw e;
        }
        if (sess.state === 'idle') {
          // Promote: submit the first statement, embed stmtId in next runId.
          // Queued (whole-notebook) runs submit cell 0 with ITS kind and keep
          // the pending entry (qIdx advanced) so phase 2 chains the rest;
          // single-cell runs submit `code` and delete their entry as before.
          const first = queue.length > 0 ? { code: queue[0].source, kind: queue[0].lang as typeof lang } : { code, kind: lang };
          // Preambles (display() + Semantic Link) — the run route cannot inject
          // them while an async-created session is still 'starting' (Livy
          // rejects statements pre-idle), so its try/catch leaves
          // displayLoaded=false. Inject here at first-idle, BEFORE the first
          // cell; Livy FIFO ordering makes them defined by the time the cell
          // runs. Both are idempotent in-kernel; non-fatal on failure.
          const sparkSess = (state as any).sparkSession;
          if ((sparkSess?.kind ?? 'pyspark') === 'pyspark' && sparkSess?.displayLoaded !== true) {
            if ((process.env.LOOM_RICH_DISPLAY || '').trim() !== '0') {
              try {
                const { AI_DISPLAY_PREAMBLE } = await import('@/lib/notebook/ai-display-preamble');
                await submitLivyStatement(pool, sessionId, { code: AI_DISPLAY_PREAMBLE, kind: 'pyspark' });
                if (sparkSess) sparkSess.displayLoaded = true;
              } catch { /* non-fatal — display() degrades to the built-in renderer */ }
            }
            if ((process.env.LOOM_SEMANTIC_LINK || '').trim() !== '0') {
              try {
                const { LOOM_SEMANTIC_LINK_PREAMBLE } = await import('@/lib/notebook/loom-semantic-link-preamble');
                await submitLivyStatement(pool, sessionId, { code: LOOM_SEMANTIC_LINK_PREAMBLE, kind: 'pyspark' });
              } catch { /* non-fatal */ }
            }
          }
          const stmt = await submitLivyStatement(pool, sessionId, first);
          const promotedRunId = `spark:${pool}:${sessionId}:${stmt.id}`;
          if (pending) {
            try {
              const nextPending = { ...(state.pendingRuns || {}) };
              // Persist lastRunId (the in-flight statement's full runId) so a
              // remount can RESUME polling the exact statement instead of
              // re-submitting queue[0] (R3 #4).
              if (queue.length > 0) nextPending[basePendingKey] = { ...pending, qIdx: 1, lastRunId: promotedRunId };
              else delete nextPending[runId];
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
            runId: promotedRunId,
            phase: queue.length > 1 ? `cell 1/${queue.length} running` : 'statement-submitted',
          });
        }
        if (['error', 'dead', 'killed', 'shutting_down'].includes(sess.state)) {
          // Terminal session — clean the stale pendingRuns entry so a resume
          // poll doesn't retry it forever (R3 #4). Surface Livy's REAL failure
          // reason (errorInfo, e.g. the MAX_QUEUED_JOBS queue-jam rejection)
          // instead of an opaque terminal-state message.
          await clearPendingRuns(items, nb, workspaceId, [runId, basePendingKey]);
          const detail = ((sess as { errorInfo?: Array<{ message?: string; errorCode?: string }> | null }).errorInfo || [])
            .map((e) => e?.message || e?.errorCode || '')
            .filter(Boolean)
            .join('; ');
          return NextResponse.json({
            ok: false,
            error: `Spark session ${sessionId} entered terminal state '${sess.state}'${detail ? ` — ${detail}` : ''}`,
            status: sess.state,
          });
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

      // Build the per-statement output ONCE (used for cell attribution + the
      // top-level response). A cancelled/aborted statement (Livy state
      // 'cancelled'/'cancelling' with neither an ok nor error payload) becomes an
      // honest error output instead of a null the client would poll to the 12-min
      // timeout and then show blank (R3 #3).
      const stmtState = String((stmt as any).state || '').toLowerCase();
      const isCancelled = stmtState === 'cancelled' || stmtState === 'cancelling';
      const stmtOutput =
        out.status === 'ok'
          ? {
              status: 'ok' as const,
              data: out.data || {},
              textPlain: sqlTable || out.data?.['text/plain'] || '(no output)',
              rowCount: sqlJson?.data?.length ?? richDisplay?.totalCount,
              richDisplay,
            }
          : out.status === 'error'
            ? { status: 'error' as const, ename: out.ename, evalue: out.evalue, traceback: out.traceback }
            : isCancelled
              ? {
                  status: 'error' as const,
                  ename: 'Cancelled',
                  evalue: `Spark statement ${stmtId} on session ${sessionId} was ${stmtState} before it produced output.`,
                }
              : null;
      const isTerminal = stmtOutput !== null;

      // Accumulate the just-finished cell's output into the queue's cellOutputs
      // map (R3 #2 — "Run all" renders per-cell output). qIdx points at the NEXT
      // statement to submit, so the in-flight statement is queue[qIdx-1]; its
      // cellId attributes the output to a cell (a multi-statement SQL cell keys
      // all its splits to the one cell, last wins — same as a single-cell run).
      // Two copies: a RICH one for the client (bounded images + HTML, R3 #5) and
      // a LEAN one persisted to Cosmos (text only — resume backs the running run).
      const qIdx = Number(pending?.qIdx) || 0;
      // Two different caps (fidelity vs Databricks/Synapse, operator report
      // 2026-07-17: "missing full output"): the CLIENT copy keeps a generous
      // 512 KB of text so large prints / .show(n=big) / collect() render in
      // full, while the PERSISTED (Cosmos-backed resume) copy stays lean at
      // 20 KB so a Run-all with several big outputs can't blow the 2 MB doc cap.
      const RICH_TEXT_CAP = 512_000;
      const LEAN_TEXT_CAP = 20_000;
      const truncText = (rest: Record<string, unknown>, cap: number) => {
        if (typeof rest.textPlain === 'string' && rest.textPlain.length > cap) {
          rest.textPlain = rest.textPlain.slice(0, cap) + `\n… (output truncated at ${Math.round(cap / 1000)} KB)`;
        }
      };
      // RICH (returned to the client): keep richDisplay + a bounded rich data map
      // (image/* + text/html) so a "Run all" cell renders plots/HTML the same as
      // a single-cell run (R3 #5).
      const boundRich = (o: NonNullable<typeof stmtOutput>): Record<string, unknown> => {
        const { data, ...rest } = o as Record<string, unknown>;
        truncText(rest, RICH_TEXT_CAP);
        const rich = pickRichData(data);
        if (rich) rest.data = rich;
        return rest;
      };
      // LEAN (persisted to pendingRuns.cellOutputs): text only, NO images — a
      // Run-all with several plots would otherwise blow the Cosmos 2MB doc cap.
      // The client already applied each cell's rich output live as its statement
      // finished; the persisted copy only backs resume of the STILL-running run.
      const boundLean = (o: NonNullable<typeof stmtOutput>): Record<string, unknown> => {
        const { data: _drop, ...rest } = o as Record<string, unknown>;
        truncText(rest, LEAN_TEXT_CAP);
        return rest;
      };
      let cellOutputs: Record<string, unknown> | undefined;        // rich → client
      let cellOutputsPersist: Record<string, unknown> | undefined; // lean → Cosmos
      if (queue.length > 0 && stmtOutput) {
        const doneCellId = queue[Math.max(0, qIdx - 1)]?.cellId;
        const accRich: Record<string, unknown> = { ...(pending?.cellOutputs || {}) };
        const accLean: Record<string, unknown> = { ...(pending?.cellOutputs || {}) };
        if (doneCellId) { accRich[doneCellId] = boundRich(stmtOutput); accLean[doneCellId] = boundLean(stmtOutput); }
        cellOutputs = accRich;
        cellOutputsPersist = accLean;
      }

      // Whole-notebook queue: previous cell finished OK and more cells remain —
      // submit the next one and keep the client polling (runId promotes to the
      // new statement id). Each poll carries the running cellOutputs tally so the
      // editor patches each cell's output the moment its statement completes.
      if (out.status === 'ok' && queue.length > 0 && qIdx > 0 && qIdx < queue.length) {
        const next = queue[qIdx];
        const nstmt = await submitLivyStatement(pool, sessionId, { code: next.source, kind: next.lang as any });
        try {
          const nextPending = { ...(state.pendingRuns || {}) };
          nextPending[basePendingKey] = {
            ...pending, qIdx: qIdx + 1,
            cellOutputs: cellOutputsPersist ?? pending?.cellOutputs,
            lastRunId: `spark:${pool}:${sessionId}:${nstmt.id}`,
          };
          await items.item(nb.id, workspaceId).replace({
            ...nb, state: { ...state, pendingRuns: nextPending }, updatedAt: new Date().toISOString(),
          } as WorkspaceItem);
        } catch { /* non-fatal */ }
        return NextResponse.json({
          ok: true,
          status: 'running',
          runId: `spark:${pool}:${sessionId}:${nstmt.id}`,
          phase: `cell ${qIdx + 1}/${queue.length} running`,
          cellOutputs,
        });
      }
      // Terminal for a queued run (last cell ok, or any cell errored/cancelled):
      // record history AND drop the queue entry in one write so a re-run starts
      // fresh (clearPendingKey below).
      if (isTerminal) await recordRun(items, nb, workspaceId, runId, {
        status: stmtOutput!.status === 'ok' ? 'Completed' : 'Failed', endTimeUtc: new Date().toISOString(),
        failureReason: stmtOutput!.status === 'error'
          ? { errorCode: (stmtOutput as { ename?: string }).ename, message: (stmtOutput as { evalue?: string }).evalue }
          : null,
      }, queue.length > 0 ? basePendingKey : undefined);
      return NextResponse.json({
        ok: true,
        status: isCancelled ? 'cancelled' : stmt.state,
        runId,
        phase: 'statement-running',
        output: stmtOutput,
        cellOutputs,
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
