/**
 * GET  /api/admin/scaling/foundry-compute — list AML computes on the Foundry hub.
 * POST /api/admin/scaling/foundry-compute — { name, vmSize?, minNodeCount?, maxNodeCount? }
 *
 * Real ARM PATCH against Microsoft.MachineLearningServices/workspaces/{n}/computes/{c}.
 * Only AmlCompute supports PATCH; ComputeInstance must be deleted + recreated
 * to change vmSize (Azure ML restriction). The route returns 409 with a clear
 * message in that case.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import { listComputes, getCompute, updateAmlComputeScale } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
  // AML compute scaling requires a real Microsoft.MachineLearningServices/workspaces resource
  // (kind=Hub or standalone). LOOM_FOUNDRY_NAME alone is insufficient — it may point at an
  // Azure OpenAI / AIServices account which is NOT an ML workspace and will produce an opaque
  // ARM 404 when computes are listed. Resolve via resolve-aml-target (LOOM_AML_WORKSPACE first,
  // LOOM_FOUNDRY_NAME as a back-compat fallback) and surface a precise gate when unconfigured.
  try {
    const computes = await listComputes();
    return NextResponse.json({ ok: true, computes });
  } catch (e: any) {
    // AmlNotConfiguredError (re-thrown as NotDeployedError from foundry-client::amlWorkspaceBase)
    // is an honest gate: list the exact env vars and the bicep path so admins know what to set.
    if (e?.service === 'Azure Machine Learning workspace' || e?.name === 'AmlNotConfiguredError') {
      return NextResponse.json({
        ok: false,
        error: 'AML compute scaling requires a Microsoft.MachineLearningServices/workspaces resource (kind=Hub or standalone workspace) — not an Azure OpenAI / AIServices account.',
        hint: (
          'Set LOOM_AML_WORKSPACE (and optionally LOOM_AML_RG / LOOM_AML_SUB if the workspace is in a different resource group or subscription) to a deployed Azure ML workspace. ' +
          'Alternatively, deploy AI Foundry with aiFoundryEnabled=true and foundryPortalEnabled=true in bicep/modules/ai-foundry.bicep to provision a Hub-kind workspace automatically. ' +
          'Then grant the Console UAMI the "AzureML Data Scientist" role on the workspace.'
        ),
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
  const body = await req.json().catch(() => ({})) as {
    name?: string;
    vmSize?: string;
    minNodeCount?: number;
    maxNodeCount?: number;
    nodeIdleTimeBeforeScaleDown?: string;
  };
  if (!body?.name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  try {
    const existing = await getCompute(body.name);
    if (!existing) return NextResponse.json({ ok: false, error: 'compute not found' }, { status: 404 });
    if (existing.computeType !== 'AmlCompute') {
      return NextResponse.json({
        ok: false,
        error: `Cannot PATCH ${existing.computeType}; only AmlCompute supports in-place scale. Delete + recreate ComputeInstance to change vmSize.`,
      }, { status: 409 });
    }
    const result = await updateAmlComputeScale(body.name, {
      vmSize: body.vmSize,
      minNodeCount: body.minNodeCount,
      maxNodeCount: body.maxNodeCount,
      nodeIdleTimeBeforeScaleDown: body.nodeIdleTimeBeforeScaleDown,
    });
    return NextResponse.json({ ok: true, compute: result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
