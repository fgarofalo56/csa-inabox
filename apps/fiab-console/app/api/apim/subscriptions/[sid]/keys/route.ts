/**
 * GET /api/apim/subscriptions/{sid}/keys — reveal a subscription's primary +
 * secondary keys via POST .../subscriptions/{sid}/listSecrets (real ARM REST,
 * getSubscriptionKeys). Backs the "Keys" dialog in the admin Subscriptions pane.
 *
 * Keys are sensitive: returned only to an authenticated admin session, never
 * logged. Honest 503 gate when APIM is unconfigured. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apimConfigGate, getSubscriptionKeys, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ sid: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = apimConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `APIM service not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  try {
    const keys = await getSubscriptionKeys((await ctx.params).sid);
    return NextResponse.json({ ok: true, primaryKey: keys.primaryKey, secondaryKey: keys.secondaryKey });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
