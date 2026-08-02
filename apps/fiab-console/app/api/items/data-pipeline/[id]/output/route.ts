/**
 * GET /api/items/data-pipeline/[id]/output?workspaceId=...&runId=...
 *
 * Returns per-activity output for a single pipeline run. Fabric's Output
 * pane shows this same view.
 *
 * When no runId is supplied, returns the most recent N pipeline runs as
 * { runs: [...] } so the Output pane can render the "last N runs" table.
 *
 * Log Analytics fallback: ADF's native monitoring API only retains 45 days of
 * run history. When the native query returns no rows and
 * LOOM_ADF_LOG_ANALYTICS_WORKSPACE is configured, we fall back to the typed
 * ADFPipelineRun / ADFActivityRun tables in Log Analytics (full workspace
 * retention). `source: 'log-analytics'` / `laFallback: true` tell the UI to
 * show the historical-runs banner.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import {
  listActivityRuns, listPipelineRuns, getPipelineRun,
  listActivityRunsFromLA, listPipelineRunsFromLA, adfLogAnalyticsWorkspace,
  defaultFactoryName,
} from '@/lib/azure/adf-client';
import { enforceRateLimitForKey } from '@/lib/azure/rate-limiter';
import { harvestPipelineRunLineage } from '@/lib/lineage/synapse-lineage-harvest';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `?runId=` is caller-supplied and now drives a WRITE (the LU-8 lineage
 * harvest) plus an ARM fan-out of ~80 reads, so the same per-principal budget
 * the OpenLineage ingest route applies to the equivalent work applies here.
 * Generous for a polling Output pane, bounding for a `?runId=` cycler.
 */
const HARVEST_RATE_LIMITS = { ratePerSec: 5, burst: 20 };

/** Factory name for the OpenLineage job namespace. `defaultFactoryName()`
 *  throws when the ADF env is unset; the run we are reading came FROM a
 *  factory, so fall back to a stable label rather than failing the response. */
function safeFactoryName(): string {
  try { return defaultFactoryName(); } catch { return 'adf'; }
}



export const GET = withSession<{ id: string }>(async (req: NextRequest, { session: s, params }) => {
  const { id } = params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('pipeline not found', 404);
  const runId = req.nextUrl.searchParams.get('runId');

  try {
    const items = await itemsContainer();
    const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return apiError('pipeline not found', 404);
    const adfName = (resource.state as any)?.adfPipelineName;
    if (!adfName) {
      // No ADF backing yet — honest empty array, not a fake.
      return NextResponse.json({ ok: true, runs: [], activities: [] });
    }

    if (runId) {
      // OWNERSHIP — `runId` arrives on the query string. Prove it belongs to
      // THIS pipeline before reading its activities or harvesting it: ADF run
      // ids are factory-scoped, so without this an authenticated owner of any
      // Loom pipeline could read another pipeline's activity input/output
      // payloads and stamp its datasets into their own lineage graph.
      //
      // The oracle has TWO sources, deliberately, because the first cut of this
      // gate (`getPipelineRun(runId).catch(() => null)` → 404) broke the very
      // fallback this file exists for:
      //   1. ARM `Pipeline Runs - Get` — authoritative inside ADF's 45-day
      //      retention window. Returns null ONLY on a real 404; a transient
      //      429/5xx THROWS (no `.catch`) and surfaces as a 502, so throttling
      //      can never tell an owner their run does not exist.
      //   2. Log Analytics — past 45 days ARM 404s every run, even ones the
      //      runs LIST below still shows via `laFallback: true`. The LA query
      //      is `PipelineName == adfName`-filtered and returns exactly the same
      //      last-50 set that list renders, so every historical run the UI
      //      invites the user to click is decidable here, and a run belonging
      //      to another pipeline is absent from it by construction.
      let run: Awaited<ReturnType<typeof getPipelineRun>> = await getPipelineRun(runId);
      let runSource: 'adf' | 'log-analytics' = 'adf';
      if (!run) {
        const laWsForOwnership = adfLogAnalyticsWorkspace();
        if (laWsForOwnership) {
          const laRuns = await listPipelineRunsFromLA(laWsForOwnership, adfName).catch(() => []);
          const hit = laRuns.find((r) => r.runId === runId);
          if (hit) { run = hit; runSource = 'log-analytics'; }
        }
      }
      if (!run || run.pipelineName !== adfName) return apiError('run not found', 404);

      let activities = await listActivityRuns(runId);
      let source: 'adf' | 'log-analytics' = runSource;
      const laWs = adfLogAnalyticsWorkspace();
      if (activities.length === 0 && laWs) {
        try {
          const la = await listActivityRunsFromLA(laWs, runId);
          if (la.length > 0) { activities = la; source = 'log-analytics'; }
        } catch { /* LA unavailable — keep the honest (empty) ADF result */ }
      }
      // LU-8: harvest this run's Copy activities into OpenLineage and write
      // the edges into unified-lineage. The activity runs are already in hand,
      // so the harvest costs only the pipeline/dataset/linked-service reads it
      // needs to name datasets canonically. Best-effort + deduped per run per
      // replica; never throws into the Output pane. `runStatus` is passed from
      // the AUTHORITATIVE run record so the succeeded-only gate applies here
      // exactly as it does on the jobs route — opening the Output pane on a
      // failed run must not stamp lineage.
      const limited = await enforceRateLimitForKey(`adf-harvest:${s.claims.oid}`, 'adf-lineage-harvest', HARVEST_RATE_LIMITS);
      const lineage = limited
        ? { ok: false as const, events: 0, written: 0, skipped: 0, denied: 0, code: 'harvest_rate_limited' as const, reason: 'rate limited — lineage harvest skipped for this poll' }
        : await harvestPipelineRunLineage(s, {
            workspaceId,
            adfPipelineName: adfName,
            factoryName: safeFactoryName(),
            runId,
            runStatus: run.status,
            runEnd: run.runEnd || activities[activities.length - 1]?.activityRunEnd,
            activityRuns: activities,
          });
      return NextResponse.json({
        ok: true,
        runId,
        source,
        lineage,
        activities: activities.map((a) => ({
          id: a.activityRunId,
          name: a.activityName,
          type: a.activityType,
          status: a.status,
          start: a.activityRunStart,
          end: a.activityRunEnd,
          durationMs: a.durationInMs,
          input: a.input,
          output: a.output,
          error: a.error?.message || null,
          errorCode: a.error?.errorCode || null,
        })),
      });
    }

    // No runId — return the last N pipeline runs for this pipeline.
    let runs = await listPipelineRuns(adfName);
    let laFallback = false;
    const laWs = adfLogAnalyticsWorkspace();
    if (runs.length === 0 && laWs) {
      try {
        const la = await listPipelineRunsFromLA(laWs, adfName);
        if (la.length > 0) { runs = la; laFallback = true; }
      } catch { /* LA unavailable — keep the honest (empty) ADF result */ }
    }
    return NextResponse.json({
      ok: true,
      laFallback,
      runs: runs.map((r) => ({
        runId: r.runId,
        status: r.status,
        start: r.runStart,
        end: r.runEnd,
        durationMs: r.durationInMs,
        invokedBy: r.invokedBy?.invokedByType || (laFallback ? 'Historical (Log Analytics)' : 'Manual'),
        message: r.message || null,
      })),
    });
  } catch (e: any) {
    return apiError(e?.message || String(e), e?.status || 502);
  }
});
