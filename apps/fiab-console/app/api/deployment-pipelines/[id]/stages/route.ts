/**
 * GET /api/deployment-pipelines/[id]/stages — the ordered stages (dev → test
 * → prod) of a Fabric deployment pipeline, each with its assigned workspace.
 *
 * Real Fabric REST: GET /v1/deploymentPipelines/{id}/stages
 * Shape: { ok:true, data: { stages: DeploymentPipelineStage[] } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDeploymentPipelineStages, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ ok: false, error: 'pipeline id required' }, { status: 400 });
  try {
    const stages = await listDeploymentPipelineStages(id);
    return NextResponse.json({ ok: true, data: { stages } });
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
