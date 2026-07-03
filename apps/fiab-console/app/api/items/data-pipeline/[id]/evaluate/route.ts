/**
 * POST /api/items/data-pipeline/[id]/evaluate?workspaceId=...
 *
 * Backs the "Evaluate expression" (F9) sample-value pre-fill in the pipeline
 * dynamic-content builder. Fabric's evaluator is purely client-side and the
 * resolver in evaluate-expression.ts mirrors that. This route is the optional
 * Loom enhancement: it returns the LAST real ADF run's per-activity outputs +
 * run system-variables so the UI can pre-populate the sample-value fields with
 * REAL data instead of forcing the user to hand-type every activity output.
 *
 * It does NOT trigger a new run. (ADF's ARM API has no synchronous
 * expression-evaluate / single-activity-breakpoint endpoint; debugPipeline
 * would queue a minutes-long async run and charge compute — not how Fabric's
 * F9 works.) Both reads (listPipelineRuns + listActivityRuns) are covered by
 * the existing Data Factory Contributor grant on the Loom factory.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { listPipelineRuns, listActivityRuns, adfConfigGate } from '@/lib/azure/adf-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const { id } = await ctx.params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('pipeline not found', 404);

  try {
    const items = await itemsContainer();
    const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return apiError('pipeline not found', 404);

    const adfName = (resource.state as any)?.adfPipelineName;
    if (!adfName) {
      // No ADF backing yet — honest empty pre-fill; the client still renders
      // the sample-value fields for manual entry (Fabric-parity behaviour).
      return NextResponse.json({
        ok: true,
        suggestedSampleValues: { activityOutputs: {}, systemVars: {} },
        source: 'none',
      });
    }

    // Honest Azure infra gate — names the exact missing env var.
    const gate = adfConfigGate();
    if (gate) {
      return NextResponse.json({
        ok: true,
        suggestedSampleValues: { activityOutputs: {}, systemVars: { Pipeline: adfName } },
        source: 'config-gate',
        gate: { missing: gate.missing },
      });
    }

    // Most-recent run for this pipeline (7-day query window, first = latest).
    const runs = await listPipelineRuns(adfName);
    if (!runs.length) {
      return NextResponse.json({
        ok: true,
        suggestedSampleValues: { activityOutputs: {}, systemVars: { Pipeline: adfName } },
        source: 'no-runs',
      });
    }
    const lastRun = runs[0];

    const activities = await listActivityRuns(lastRun.runId);
    const activityOutputs: Record<string, unknown> = {};
    for (const a of activities) {
      if (a.output != null) activityOutputs[a.activityName] = a.output;
    }

    const systemVars: Record<string, string> = { Pipeline: lastRun.pipelineName };
    if (lastRun.runId) systemVars.RunId = lastRun.runId;
    if (lastRun.runGroupId) systemVars.GroupId = lastRun.runGroupId;
    if (lastRun.invokedBy?.invokedByType) systemVars.TriggerType = lastRun.invokedBy.invokedByType;
    if (lastRun.invokedBy?.name) systemVars.TriggerName = lastRun.invokedBy.name;
    if (lastRun.invokedBy?.id) systemVars.TriggerId = lastRun.invokedBy.id;
    if (lastRun.runStart) systemVars.TriggerTime = lastRun.runStart;

    return NextResponse.json({
      ok: true,
      suggestedSampleValues: { activityOutputs, systemVars },
      source: 'last-run',
      lastRunId: lastRun.runId,
      lastRunStatus: lastRun.status,
    });
  } catch (e: any) {
    return apiError(e?.message || String(e), e?.status || 502);
  }
}
