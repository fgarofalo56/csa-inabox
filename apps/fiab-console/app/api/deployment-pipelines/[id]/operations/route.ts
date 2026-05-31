/**
 * GET /api/deployment-pipelines/[id]/operations — deployment history for a
 * Fabric deployment pipeline (recent deploy operations + status).
 *
 * Real Fabric REST: GET /v1/deploymentPipelines/{id}/operations
 * Shape: { ok:true, data: { operations: DeploymentPipelineOperation[] } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDeploymentPipelineOperations, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ ok: false, error: 'pipeline id required' }, { status: 400 });
  try {
    const operations = await listDeploymentPipelineOperations(id);
    return NextResponse.json({ ok: true, data: { operations } });
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
