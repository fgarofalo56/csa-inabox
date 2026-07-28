/**
 * GET /api/items/data-pipeline/[id]/jobs?workspaceId=...
 *   Returns recent ADF pipeline runs for this Loom pipeline.
 *
 * v3.25: queries ADF pipeline runs filtered to the pipeline name.
 *
 * LU-8: the newest SUCCEEDED run is harvested into OpenLineage and written into
 * the unified-lineage store. This route is what the editor polls, so a
 * pipeline's lineage lands on the canvas from a normal run without anyone
 * opening the Output pane. The harvest is deduped per (workspace, run) per
 * replica, so repeated polls cost nothing after the first.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { listPipelineRuns, defaultFactoryName } from '@/lib/azure/adf-client';
import { harvestPipelineRunLineage } from '@/lib/lineage/synapse-lineage-harvest';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Factory name for the OpenLineage job namespace (see the output route). */
function safeFactoryName(): string {
  try { return defaultFactoryName(); } catch { return 'adf'; }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('pipeline not found', 404);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return apiError('pipeline not found', 404);
    const adfName = (resource.state as any)?.adfPipelineName;
    if (!adfName) return NextResponse.json({ ok: true, jobs: [] });
    const runs = await listPipelineRuns(adfName);
    const rows = ((runs as any).value || runs || []) as Array<Record<string, any>>;

    // Harvest the newest succeeded run's lineage (best-effort, deduped).
    const newestSucceeded = rows.find((r) => String(r?.status || '').toLowerCase() === 'succeeded');
    const lineage = newestSucceeded
      ? await harvestPipelineRunLineage(s, {
          workspaceId,
          adfPipelineName: adfName,
          factoryName: safeFactoryName(),
          runId: String(newestSucceeded.runId),
          runStatus: newestSucceeded.status,
          runEnd: newestSucceeded.runEnd,
        })
      : undefined;

    return NextResponse.json({
      ok: true,
      ...(lineage ? { lineage } : {}),
      jobs: rows.map((r: any) => ({
        id: r.runId,
        status: r.status,
        runStart: r.runStart,
        runEnd: r.runEnd,
        durationMs: r.durationInMs,
        message: r.message,
      })),
    });
  } catch (e: any) {
    return apiError(e?.message || String(e), e?.status || 502);
  }
}
