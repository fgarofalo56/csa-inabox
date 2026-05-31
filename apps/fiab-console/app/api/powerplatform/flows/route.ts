/**
 * GET    /api/powerplatform/flows?envId=<env>            → { ok, flows: PowerAutomateFlow[] }
 * POST   /api/powerplatform/flows                        body { envId, id, action:'start'|'stop' } → { ok }
 * DELETE /api/powerplatform/flows?envId=<env>&id=<flow>  → { ok }
 *
 * Cloud flows in a Power Platform environment (Power Automate admin REST,
 * https://service.flow.microsoft.com/.default). Session-guarded; honest 503
 * gate. Real REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listFlows, deleteFlow, setFlowState, powerPlatformConfigGate, PowerPlatformError,
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
    const flows = await listFlows(envId);
    return NextResponse.json({ ok: true, flows });
  } catch (e: any) { return err(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const envId: string = body?.envId;
  const id: string = body?.id;
  const action: string = body?.action;
  if (!envId || !id) return NextResponse.json({ ok: false, error: 'envId and id are required' }, { status: 400 });
  if (action !== 'start' && action !== 'stop') {
    return NextResponse.json({ ok: false, error: "action must be 'start' or 'stop'" }, { status: 400 });
  }
  try {
    await setFlowState(envId, id, action === 'start');
    return NextResponse.json({ ok: true });
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
    await deleteFlow(envId, id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return err(e); }
}
