/**
 * POST /api/deployment-pipelines/create — create a new Fabric deployment
 * pipeline with an ordered set of stages (2-10). Stage count/names are
 * permanent once created.
 *
 * Real Fabric REST: POST /v1/deploymentPipelines
 *   https://learn.microsoft.com/rest/api/fabric/core/deployment-pipelines/create-deployment-pipeline
 *
 * Body: { displayName, description?, stages: [{ displayName, description?, isPublic? }] }
 * Shape: { ok:true, data: { pipeline } }
 * Gate: Fabric 401/403 → 200 { ok:false, gate } (SPN/UAMI also needs the admin
 *   tenant toggle "Service principals can create … deployment pipelines").
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createDeploymentPipeline, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  if (!displayName) return NextResponse.json({ ok: false, error: 'displayName required' }, { status: 400 });

  const rawStages = Array.isArray(body?.stages) ? body.stages : [];
  const stages = rawStages
    .map((st: any) => ({
      displayName: String(st?.displayName || '').trim(),
      description: typeof st?.description === 'string' ? st.description.slice(0, 1024) : undefined,
      isPublic: !!st?.isPublic,
    }))
    .filter((st: { displayName: string }) => st.displayName);
  if (stages.length < 2) {
    return NextResponse.json({ ok: false, error: 'At least 2 named stages are required' }, { status: 400 });
  }
  if (stages.length > 10) {
    return NextResponse.json({ ok: false, error: 'A pipeline can have at most 10 stages' }, { status: 400 });
  }

  try {
    const pipeline = await createDeploymentPipeline({
      displayName,
      description: typeof body?.description === 'string' ? body.description.slice(0, 1024) : undefined,
      stages,
    });
    return NextResponse.json({ ok: true, data: { pipeline } });
  } catch (e) {
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: ['Fabric API authorization', 'Service principals can create deployment pipelines (admin tenant toggle)'],
          message: e.hint || e.message,
        },
      });
    }
    const status = e instanceof FabricError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
