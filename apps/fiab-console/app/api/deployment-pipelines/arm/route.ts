/**
 * GET /api/deployment-pipelines/arm — the platform's own ARM / bicep
 * deployment history across the Loom resource groups.
 *
 * Real Azure REST: GET .../resourceGroups/{rg}/providers/Microsoft.Resources/deployments
 * Shape: { ok:true, data: { deployments: ArmDeployment[] } }
 * Honest gate: 200 { ok:false, gate } when LOOM_SUBSCRIPTION_ID / Loom RGs
 * aren't configured.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listArmDeployments,
  DeploymentsNotConfiguredError,
  ArmDeploymentsError,
} from '@/lib/azure/arm-deployments-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const deployments = await listArmDeployments();
    return NextResponse.json({ ok: true, data: { deployments } });
  } catch (e) {
    if (e instanceof DeploymentsNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
    }
    const status = e instanceof ArmDeploymentsError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
