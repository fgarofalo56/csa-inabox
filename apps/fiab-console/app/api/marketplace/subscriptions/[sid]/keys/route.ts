/**
 * POST /api/marketplace/subscriptions/[sid]/keys
 *   Reveals the subscription's primary/secondary keys. APIM never returns keys
 *   on GET — they must be fetched via POST .../listSecrets. The key is resolved
 *   server-side and returned to the authenticated session so the consumer can
 *   call the gateway with Ocp-Apim-Subscription-Key.
 *
 * Real Azure REST:
 *   POST .../subscriptions/{sid}/listSecrets   (getSubscriptionKeys)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getSubscriptionKeys, ApimError } from '@/lib/azure/apim-client';
import { apimGate, gateResponse } from '../../../_gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ sid: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gated = gateResponse(apimGate());
  if (gated) return gated;
  const sid = (await ctx.params).sid;
  if (!sid) return NextResponse.json({ ok: false, error: 'sid is required' }, { status: 400 });
  try {
    const keys = await getSubscriptionKeys(sid);
    return NextResponse.json({ ok: true, ...keys });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
