/**
 * GET    /api/powerplatform/apps?envId=<env>      → { ok, apps: PowerApp[] }
 * DELETE /api/powerplatform/apps?envId=<env>&id=<appId> → { ok }
 *
 * Power Apps in a Power Platform environment (admin REST,
 * https://service.powerapps.com/.default). Session-guarded; honest 503 gate
 * when LOOM_UAMI_CLIENT_ID is unset. Real REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listPowerApps, deletePowerApp, powerPlatformConfigGate, PowerPlatformError,
} from '@/lib/azure/powerplatform-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = powerPlatformConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Power Platform not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

function err(e: any) {
  const status = e instanceof PowerPlatformError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), hint: e?.hint, endpoint: e?.endpoint },
    { status },
  );
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const envId = req.nextUrl.searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId query param is required' }, { status: 400 });
  try {
    const apps = await listPowerApps(envId);
    return NextResponse.json({ ok: true, apps });
  } catch (e: any) { return err(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const envId = req.nextUrl.searchParams.get('envId');
  const id = req.nextUrl.searchParams.get('id');
  if (!envId || !id) return NextResponse.json({ ok: false, error: 'envId and id query params are required' }, { status: 400 });
  try {
    await deletePowerApp(envId, id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return err(e); }
}
