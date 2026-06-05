/**
 * GET /api/powerplatform/environments/operation?url=<operationUrl>
 *   → { ok, operation: { status, done, error } }
 *
 * Polls an async environment lifecycle operation (create/delete) by the
 * Operation-Location URL returned from POST/DELETE. SSRF-guarded: the URL must
 * be on the BAP control-plane host. Session-guarded; honest 503 gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getEnvironmentLifecycleOperation, powerPlatformConfigGate, PowerPlatformError,
} from '@/lib/azure/powerplatform-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BAP_BASE = process.env.LOOM_BAP_BASE || 'https://api.bap.microsoft.com';

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

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const url = req.nextUrl.searchParams.get('url');
  if (!url) return NextResponse.json({ ok: false, error: 'url query param is required' }, { status: 400 });
  // SSRF guard — only allow polling the BAP control plane host the client uses.
  let host: string;
  try { host = new URL(url).host; } catch { return NextResponse.json({ ok: false, error: 'invalid operation url' }, { status: 400 }); }
  const allowedHost = new URL(BAP_BASE).host;
  if (host !== allowedHost) {
    return NextResponse.json({ ok: false, error: `operation url host not allowed (expected ${allowedHost})` }, { status: 400 });
  }
  try {
    const operation = await getEnvironmentLifecycleOperation(url);
    return NextResponse.json({ ok: true, operation });
  } catch (e: any) {
    const status = e instanceof PowerPlatformError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), hint: e?.hint }, { status });
  }
}
