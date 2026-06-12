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
  if (!process.env.LOOM_FOUNDRY_NAME) {
    return NextResponse.json({
      ok: false, error: 'AI Foundry hub not configured',
      hint: 'Set LOOM_FOUNDRY_NAME on loom-console.',
    }, { status: 503 });
  }
  try {
    const computes = await listComputes();
    return NextResponse.json({ ok: true, computes });
  } catch (e: any) {
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
