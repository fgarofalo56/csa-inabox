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
import { apimConfigGate, listOperations, ApimError } from '@/lib/azure/apim-client';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// WS-D2: APIM config gate normalized onto the shared svc-apim gate envelope.
function gate() {
  const g = apimConfigGate();
  if (g) {
    return apiHonestGateError('svc-apim', {
      missing: [g.missing],
      message: `APIM service not configured: set ${g.missing}.`,
    });
  }
  return null;
}

// WS-D1: session-only route adopted onto `withSession`.
export const GET = withSession(async (req: NextRequest) => {
  const g = gate(); if (g) return g;
  const apiId = req.nextUrl.searchParams.get('apiId')?.trim();
  if (!apiId) return NextResponse.json({ ok: false, error: 'apiId is required' }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, operations: await listOperations(apiId) });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
});
