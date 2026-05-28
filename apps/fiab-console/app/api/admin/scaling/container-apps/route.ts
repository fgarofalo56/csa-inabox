/**
 * GET  /api/admin/scaling/container-apps — list Loom container apps + current scale.
 * POST /api/admin/scaling/container-apps — { name, workloadProfileName?, minReplicas?, maxReplicas? }
 *
 * Real ARM PATCH against Microsoft.App/containerApps/{name}. Workload-profile
 * change requires a Premium ACA managed environment with that profile
 * pre-provisioned; switching to D-/E-series on a Consumption-only env will
 * surface ARM's 400 verbatim so the admin sees the bicep change required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listContainerApps, updateContainerAppScale, AcaNotConfiguredError,
} from '@/lib/azure/container-apps-arm-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_PROFILES = new Set([
  'Consumption', 'D4', 'D8', 'D16', 'D32', 'E4', 'E8', 'E16', 'E32',
]);

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const apps = await listContainerApps();
    return NextResponse.json({ ok: true, apps });
  } catch (e: any) {
    if (e instanceof AcaNotConfiguredError) {
      return NextResponse.json({
        ok: false, error: e.message,
        hint: `Set ${e.missing.join(', ')} on loom-console.`,
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as {
    name?: string;
    workloadProfileName?: string;
    minReplicas?: number;
    maxReplicas?: number;
  };
  if (!body?.name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  if (body.workloadProfileName && !VALID_PROFILES.has(body.workloadProfileName)) {
    return NextResponse.json({
      ok: false,
      error: `workloadProfileName must be one of ${[...VALID_PROFILES].join(', ')}`,
    }, { status: 400 });
  }
  if (typeof body.minReplicas === 'number' && body.minReplicas < 0) {
    return NextResponse.json({ ok: false, error: 'minReplicas must be >= 0' }, { status: 400 });
  }
  if (typeof body.maxReplicas === 'number' && (body.maxReplicas < 1 || body.maxReplicas > 1000)) {
    return NextResponse.json({ ok: false, error: 'maxReplicas must be 1-1000' }, { status: 400 });
  }
  try {
    const app = await updateContainerAppScale(body.name, {
      workloadProfileName: body.workloadProfileName,
      minReplicas: body.minReplicas,
      maxReplicas: body.maxReplicas,
    });
    return NextResponse.json({ ok: true, app });
  } catch (e: any) {
    if (e instanceof AcaNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status: e?.status || 502 });
  }
}
