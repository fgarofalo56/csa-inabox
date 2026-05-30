/**
 * GET /api/deployment-pipelines/[id]/stages/[stageId]/items — the supported
 * items in the workspace assigned to a deployment-pipeline stage. Drives the
 * per-stage item list + the selective-deploy picker.
 *
 * Real Fabric REST: GET /v1/deploymentPipelines/{id}/stages/{stageId}/items
 * Shape: { ok:true, data: { items: DeploymentPipelineStageItem[] } }
 *
 * A stage with no assigned workspace returns Fabric 400 — we surface that as
 * an empty list (the UI shows "no workspace assigned") rather than an error.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDeploymentPipelineStageItems, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; stageId: string }> },
) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id, stageId } = await ctx.params;
  if (!id || !stageId) {
    return NextResponse.json({ ok: false, error: 'pipeline id and stageId required' }, { status: 400 });
  }
  try {
    const items = await listDeploymentPipelineStageItems(id, stageId);
    return NextResponse.json({ ok: true, data: { items } });
  } catch (e) {
    if (e instanceof FabricError && e.status === 400) {
      // Stage has no assigned workspace → no items to list.
      return NextResponse.json({ ok: true, data: { items: [] } });
    }
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        gate: { missing: ['Fabric API authorization'], message: e.hint || e.message },
      });
    }
    const status = e instanceof FabricError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
