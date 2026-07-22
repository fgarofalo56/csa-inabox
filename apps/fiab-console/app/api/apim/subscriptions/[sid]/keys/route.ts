/**
 * GET /api/apim/subscriptions/{sid}/keys — reveal a subscription's primary +
 * secondary keys via POST .../subscriptions/{sid}/listSecrets (real ARM REST,
 * getSubscriptionKeys). Backs the "Keys" dialog in the admin Subscriptions pane.
 *
 * Keys are sensitive: returned only to an authenticated admin session, never
 * logged. Honest 503 gate when APIM is unconfigured. No mocks.
 */
import { NextResponse } from 'next/server';
import { apimConfigGate, getSubscriptionKeys, ApimError } from '@/lib/azure/apim-client';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// WS-D1: session-only route adopted onto `withSession` (params resolved by the
// wrapper). WS-D2: the inline APIM config gate normalized onto svc-apim.
export const GET = withSession<{ sid: string }>(async (_req, { params }) => {
  const g = apimConfigGate();
  if (g) {
    return apiHonestGateError('svc-apim', {
      missing: [g.missing],
      message: `APIM service not configured: set ${g.missing}.`,
    });
  }
  try {
    const keys = await getSubscriptionKeys(params.sid);
    return NextResponse.json({ ok: true, primaryKey: keys.primaryKey, secondaryKey: keys.secondaryKey });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
});
