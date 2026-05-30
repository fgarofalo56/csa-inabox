/**
 * GET /api/deployment-pipelines — list the Fabric deployment pipelines the
 * Console UAMI can see (real Fabric REST: GET /v1/deploymentPipelines).
 *
 * Shape: { ok:true, data: { pipelines: DeploymentPipeline[] } }
 * Auth gate: 200 { ok:false, gate } when Fabric returns 401/403 (the UAMI
 * isn't authorized for Fabric APIs) — the page renders the gate MessageBar.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDeploymentPipelines, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const pipelines = await listDeploymentPipelines();
    return NextResponse.json({ ok: true, data: { pipelines } });
  } catch (e) {
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: ['Fabric API authorization'],
          message: e.hint || e.message,
        },
      });
    }
    const status = e instanceof FabricError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
