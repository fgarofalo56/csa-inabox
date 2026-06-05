/**
 * GET /api/deployment-pipelines/[id]/compare?source=<stageId>&target=<stageId>
 * — per-stage compare: pairs the items of two stages and labels each
 * Same / Different / Only-in-source / Not-in-source, with a roll-up summary
 * (the green/orange sync indicator Fabric shows between stages).
 *
 * Real Fabric REST: GET /v1/deploymentPipelines/{id}/stages/{sid}/items
 *   (two calls, paired client-side per Fabric's documented pairing rule —
 *   Fabric exposes no dedicated compare endpoint).
 *   https://learn.microsoft.com/fabric/cicd/deployment-pipelines/compare-pipeline-content
 *   https://learn.microsoft.com/rest/api/fabric/core/deployment-pipelines/list-deployment-pipeline-stage-items
 *
 * Shape: { ok:true, data: StageCompareResult }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { compareDeploymentPipelineStages, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ ok: false, error: 'pipeline id required' }, { status: 400 });

  const source = (req.nextUrl.searchParams.get('source') || '').trim();
  const target = (req.nextUrl.searchParams.get('target') || '').trim();
  if (!source || !target) {
    return NextResponse.json({ ok: false, error: 'source and target stage ids required' }, { status: 400 });
  }

  try {
    const result = await compareDeploymentPipelineStages(id, source, target);
    return NextResponse.json({ ok: true, data: result });
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
