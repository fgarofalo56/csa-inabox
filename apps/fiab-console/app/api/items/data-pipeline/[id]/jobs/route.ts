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
import { withSession } from '@/lib/api/route-toolkit';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { listPipelineRuns, defaultFactoryName } from '@/lib/azure/adf-client';
import { enforceRateLimitForKey } from '@/lib/azure/rate-limiter';
import { harvestPipelineRunLineage } from '@/lib/lineage/synapse-lineage-harvest';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Same per-principal budget as the Output pane's harvest — the ARM fan-out is
 *  identical and this route is polled by the editor. */
const HARVEST_RATE_LIMITS = { ratePerSec: 5, burst: 20 };

/** Factory name for the OpenLineage job namespace (see the output route). */
function safeFactoryName(): string {
  try { return defaultFactoryName(); } catch { return 'adf'; }
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session: s, params }) => {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, read-scoped.
  {
    const denied = await authorizeItemWorkspace(s, {
      workspaceId, itemId: params.id, itemType: 'data-pipeline',
      allowReadRoles: true,
      notFound: 'pipeline not found',
    });
    if (denied) return denied;
  }
  try {
    const items = await itemsContainer();
    const { resource } = await items.item(params.id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return apiError('pipeline not found', 404);
    const adfName = (resource.state as any)?.adfPipelineName;
    if (!adfName) return NextResponse.json({ ok: true, jobs: [] });
    const runs = await listPipelineRuns(adfName);
    const rows = ((runs as any).value || runs || []) as Array<Record<string, any>>;

    // Harvest the newest succeeded run's lineage (best-effort, deduped,
    // rate-limited per principal — the harvest fans out to ~80 ARM reads and
    // this route is polled).
    const newestSucceeded = rows.find((r) => String(r?.status || '').toLowerCase() === 'succeeded');
    const limited = newestSucceeded
      ? await enforceRateLimitForKey(`adf-harvest:${s.claims.oid}`, 'adf-lineage-harvest', HARVEST_RATE_LIMITS)
      : null;
    const lineage = newestSucceeded && !limited
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
});
