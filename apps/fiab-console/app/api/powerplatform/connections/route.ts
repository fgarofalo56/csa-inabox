/**
 * GET    /api/powerplatform/connections?envId=<env>                          → { ok, connections: PowerConnection[] }
 * DELETE /api/powerplatform/connections?envId=<env>&connectorId=<c>&id=<n>   → { ok }
 *
 * API connections in a Power Platform environment (Power Apps admin REST,
 * https://service.powerapps.com/.default — the "Connections" tab under
 * Dataverse in make.powerapps.com). Session-guarded; honest 503 gate. Real
 * REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listConnections, deleteConnection, powerPlatformConfigGate, PowerPlatformError,
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
    const connections = await listConnections(envId);
    return NextResponse.json({ ok: true, connections });
  } catch (e: any) { return err(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const envId = req.nextUrl.searchParams.get('envId');
  const connectorId = req.nextUrl.searchParams.get('connectorId');
  const id = req.nextUrl.searchParams.get('id');
  if (!envId || !connectorId || !id) {
    return NextResponse.json({ ok: false, error: 'envId, connectorId and id query params are required' }, { status: 400 });
  }
  try {
    await deleteConnection(envId, connectorId, id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return err(e); }
}
