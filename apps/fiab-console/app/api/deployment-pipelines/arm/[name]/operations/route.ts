/**
 * GET /api/deployment-pipelines/arm/{name}/operations?rg={resourceGroup}
 *
 * The per-resource "step" breakdown for one ARM / bicep deployment — what the
 * Azure portal shows when you expand a deployment in the deployment history.
 *
 * Real Azure REST:
 *   GET .../resourceGroups/{rg}/providers/Microsoft.Resources/deployments/{name}/operations
 * Shape: { ok:true, data: { operations: ArmDeploymentOperation[] } }
 * Honest gate: 200 { ok:false, gate } when LOOM_SUBSCRIPTION_ID / Loom RGs
 * aren't configured.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listArmDeploymentOperations,
  DeploymentsNotConfiguredError,
  ArmDeploymentsError,
} from '@/lib/azure/arm-deployments-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { name } = await params;
  const rg = req.nextUrl.searchParams.get('rg');
  if (!name || !rg) {
    return NextResponse.json(
      { ok: false, error: 'both the deployment name (path) and rg (query) are required' },
      { status: 400 },
    );
  }

  try {
    const operations = await listArmDeploymentOperations(rg, name);
    return NextResponse.json({ ok: true, data: { operations } });
  } catch (e) {
    if (e instanceof DeploymentsNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
    }
    const status = e instanceof ArmDeploymentsError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
