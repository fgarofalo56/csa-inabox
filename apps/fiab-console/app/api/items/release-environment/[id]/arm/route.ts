/**
 * GET /api/items/release-environment/[id]/arm → { ok, deployments } | { ok:false, gate }
 *   Real Azure Resource Manager deployment history across the Loom resource
 *   groups (reuses the deployment-pipelines ARM client). Honest gate when
 *   LOOM_SUBSCRIPTION_ID / Loom RGs aren't configured. Azure-native; no Fabric.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listArmDeployments, DeploymentsNotConfiguredError, ArmDeploymentsError,
} from '@/lib/azure/arm-deployments-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const deployments = await listArmDeployments();
    return NextResponse.json({ ok: true, deployments });
  } catch (e) {
    if (e instanceof DeploymentsNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, reason: e.message, remediation: 'Set LOOM_SUBSCRIPTION_ID and the Loom resource-group env vars on the Console. No Microsoft Fabric required.' } });
    }
    const status = e instanceof ArmDeploymentsError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
