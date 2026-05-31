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
import { getSession } from '@/lib/auth/session';
import { apimConfigGate, listGateways, ApimError } from '@/lib/azure/apim-client';

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

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
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
}
