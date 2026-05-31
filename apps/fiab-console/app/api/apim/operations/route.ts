/**
 * Operations of a single API in the deployment-default APIM service (the APIM
 * navigator → APIs → expand an API). Read-only — operation authoring lives in
 * the API editor / OpenAPI import. Real ARM REST.
 *
 *   GET /api/apim/operations?apiId=NAME   → { ok, operations: [{name, method, urlTemplate, displayName}] }
 *
 * Honest 503 gate when the APIM service is unset. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apimConfigGate, listOperations, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = apimConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `APIM service not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const apiId = req.nextUrl.searchParams.get('apiId')?.trim();
  if (!apiId) return NextResponse.json({ ok: false, error: 'apiId is required' }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, operations: await listOperations(apiId) });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
