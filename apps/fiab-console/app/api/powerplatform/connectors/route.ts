/**
 * GET /api/powerplatform/connectors?envId=<env> → { ok, connectors: PowerConnector[] }
 *
 * Connectors (built-in + custom) visible in a Power Platform environment
 * (Power Apps admin REST, https://service.powerapps.com/.default). Custom
 * connectors are flagged isCustomApi. Session-guarded; honest 503 gate. Real
 * REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listConnectors, powerPlatformConfigGate, PowerPlatformError,
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
    const connectors = await listConnectors(envId);
    return NextResponse.json({ ok: true, connectors });
  } catch (e: any) { return err(e); }
}
