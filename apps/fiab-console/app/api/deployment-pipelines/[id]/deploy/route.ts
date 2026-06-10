/**
 * POST /api/deployment-pipelines/[id]/deploy — promote content from one
 * stage to the next (dev → test → prod) in a Fabric deployment pipeline.
 *
 * Real Fabric REST: POST /v1/deploymentPipelines/{id}/deploy  (long-running)
 * Body: { sourceStageId, targetStageId, items?, note?, createdWorkspaceDetails? }
 *   - items omitted  → deploy ALL supported items (Deploy all)
 *   - items provided → selective deploy of just those items
 *
 * Shape: { ok:true, data: { accepted:true, location? } } on 202.
 * 400 on missing source/target stage; gate on Fabric 401/403.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  deployStageContent,
  listDeploymentPipelineStages,
  FabricError,
  type DeployItemRef,
} from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ ok: false, error: 'pipeline id required' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const sourceStageId = String(body?.sourceStageId || '').trim();
  const targetStageId = String(body?.targetStageId || '').trim();
  if (!sourceStageId) return NextResponse.json({ ok: false, error: 'sourceStageId required' }, { status: 400 });
  if (!targetStageId) return NextResponse.json({ ok: false, error: 'targetStageId required' }, { status: 400 });

  let items: DeployItemRef[] | undefined;
  if (Array.isArray(body?.items) && body.items.length) {
    items = body.items
      .filter((i: any) => i?.sourceItemId && i?.itemType)
      .map((i: any) => ({ sourceItemId: String(i.sourceItemId), itemType: String(i.itemType) }));
  }
  const note = typeof body?.note === 'string' ? body.note.slice(0, 1024) : undefined;
  const createdWorkspaceDetails =
    body?.createdWorkspaceDetails?.name
      ? {
          name: String(body.createdWorkspaceDetails.name),
          capacityId: body.createdWorkspaceDetails.capacityId
            ? String(body.createdWorkspaceDetails.capacityId)
            : undefined,
        }
      : undefined;

  try {
    // Guard against a self-referential promote: if the source and target
    // stages resolve to the same workspace, the deploy would modify its own
    // source. Fabric also forbids two stages sharing a workspace
    // (learn.microsoft.com/fabric/cicd/deployment-pipelines/assign-pipeline,
    // limitation 1.2), but its REST surface returns an opaque 400 — so we
    // resolve the stage workspaces first and return a Loom-authored message.
    try {
      const stages = await listDeploymentPipelineStages(id);
      const srcWs = stages.find((st) => st.id === sourceStageId)?.workspaceId;
      const tgtWs = stages.find((st) => st.id === targetStageId)?.workspaceId;
      if (srcWs && tgtWs && srcWs === tgtWs) {
        const srcName = stages.find((st) => st.id === sourceStageId)?.displayName || 'source';
        const tgtName = stages.find((st) => st.id === targetStageId)?.displayName || 'target';
        return NextResponse.json(
          {
            ok: false,
            error: `Stages "${srcName}" and "${tgtName}" are bound to the same workspace, so content can't be promoted between them. Re-bind one stage to a distinct workspace, then deploy again.`,
            code: 'duplicate_workspace',
          },
          { status: 400 },
        );
      }
    } catch (e) {
      // A 401/403 here means the caller can't read stages — fall through and
      // let deployStageContent surface the proper Fabric authorization gate.
      if (!(e instanceof FabricError && (e.status === 401 || e.status === 403))) throw e;
    }

    const res = await deployStageContent(id, { sourceStageId, targetStageId, items, note, createdWorkspaceDetails });
    const accepted = (res as any)?._accepted === true;
    return NextResponse.json({
      ok: true,
      data: {
        accepted,
        location: (res as any)?.location,
        operation: accepted ? undefined : res,
      },
    });
  } catch (e) {
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
