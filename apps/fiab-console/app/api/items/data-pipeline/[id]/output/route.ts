/**
 * GET /api/items/data-pipeline/[id]/output?workspaceId=...&runId=...
 *
 * Returns per-activity output for a single pipeline run. Fabric's Output
 * pane shows this same view.
 *
 * When no runId is supplied, returns the most recent N pipeline runs as
 * { runs: [...] } so the Output pane can render the "last N runs" table.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { listActivityRuns, listPipelineRuns } from '@/lib/azure/adf-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const runId = req.nextUrl.searchParams.get('runId');

  try {
    const items = await itemsContainer();
    const { resource } = await items.item(ctx.params.id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return err('pipeline not found', 404);
    const adfName = (resource.state as any)?.adfPipelineName;
    if (!adfName) {
      // No ADF backing yet — honest empty array, not a fake.
      return NextResponse.json({ ok: true, runs: [], activities: [] });
    }

    if (runId) {
      const activities = await listActivityRuns(runId);
      return NextResponse.json({
        ok: true,
        runId,
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
    const runs = await listPipelineRuns(adfName);
    return NextResponse.json({
      ok: true,
      runs: runs.map((r) => ({
        runId: r.runId,
        status: r.status,
        start: r.runStart,
        end: r.runEnd,
        durationMs: r.durationInMs,
        invokedBy: r.invokedBy?.invokedByType || 'Manual',
        message: r.message || null,
      })),
    });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502);
  }
}
