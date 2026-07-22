/**
 * Self-hosted gateways registered on the deployment-default APIM service (the
 * APIM navigator → Gateways group). Read-only — gateway provisioning is a
 * tenant/infra action (deploy the gateway container with its token). Real ARM REST.
 *
 *   GET /api/apim/gateways   → { ok, gateways: [{name, description, region}] }
 *
 * Honest 503 gate when the APIM service is unset. No mocks.
 */
import { NextResponse } from 'next/server';
import { apimConfigGate, listGateways, ApimError } from '@/lib/azure/apim-client';
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
export const GET = withSession(async () => {
  const g = gate(); if (g) return g;
  try {
    return NextResponse.json({ ok: true, gateways: await listGateways() });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    // Self-hosted gateways are a Premium/Developer-tier feature. Basic/Standard/
    // Consumption tiers return 400 MethodNotAllowedInPricingTier — that is an
    // honest "not available on this tier" state, not an error: show an empty
    // group with a note instead of breaking the navigator tab.
    const msg = `${e?.message || ''} ${JSON.stringify(e?.body || '')}`;
    if (status === 400 && /pricing tier|MethodNotAllowedInPricingTier/i.test(msg)) {
      return NextResponse.json({
        ok: true,
        gateways: [],
        note: 'Self-hosted gateways require APIM Premium or Developer tier; the current tier does not expose them.',
      });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
});
