/**
 * POST /api/marketplace/subscriptions/[sid]/keys/regenerate?which=primary|secondary
 *   Regenerates a subscription key, then returns the fresh key pair so the
 *   consumer can copy the new value immediately.
 *
 * Real Azure REST:
 *   POST .../subscriptions/{sid}/regeneratePrimaryKey | regenerateSecondaryKey
 *   POST .../subscriptions/{sid}/listSecrets          (re-read after regen)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { regenerateSubscriptionKey, getSubscriptionKeys, ApimError } from '@/lib/azure/apim-client';
import { apimGate, gateResponse } from '../../../../_gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ sid: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gated = gateResponse(apimGate());
  if (gated) return gated;
  const sid = (await ctx.params).sid;
  if (!sid) return NextResponse.json({ ok: false, error: 'sid is required' }, { status: 400 });
  const which = req.nextUrl.searchParams.get('which') === 'secondary' ? 'secondary' : 'primary';
  try {
    await regenerateSubscriptionKey(sid, which);
    const keys = await getSubscriptionKeys(sid);
    return NextResponse.json({ ok: true, which, ...keys });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
