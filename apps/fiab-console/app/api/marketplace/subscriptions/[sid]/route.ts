/**
 * PATCH  /api/marketplace/subscriptions/[sid]  — rename / change state
 *     body: { displayName?, state?: 'active'|'suspended'|'cancelled' }
 * DELETE /api/marketplace/subscriptions/[sid]  — cancel + remove the subscription
 *
 * Real Azure REST against Microsoft.ApiManagement/service/subscriptions:
 *   PATCH  .../subscriptions/{sid}      (updateSubscription)
 *   DELETE .../subscriptions/{sid}      (deleteSubscription)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { updateSubscription, deleteSubscription, ApimError } from '@/lib/azure/apim-client';
import { apimGate, gateResponse } from '../../_gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
}

const STATES = new Set(['active', 'suspended', 'cancelled']);

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ sid: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gated = gateResponse(apimGate());
  if (gated) return gated;
  const sid = (await ctx.params).sid;
  if (!sid) return NextResponse.json({ ok: false, error: 'sid is required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const displayName = body?.displayName ? String(body.displayName).slice(0, 100) : undefined;
  const state = body?.state && STATES.has(String(body.state)) ? (String(body.state) as 'active' | 'suspended' | 'cancelled') : undefined;
  if (!displayName && !state) {
    return NextResponse.json({ ok: false, error: 'provide displayName and/or a valid state (active|suspended|cancelled)' }, { status: 400 });
  }
  try {
    const subscription = await updateSubscription(sid, { displayName, state });
    return NextResponse.json({ ok: true, subscription });
  } catch (e: any) { return handleErr(e); }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ sid: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gated = gateResponse(apimGate());
  if (gated) return gated;
  const sid = (await ctx.params).sid;
  if (!sid) return NextResponse.json({ ok: false, error: 'sid is required' }, { status: 400 });
  try {
    await deleteSubscription(sid);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return handleErr(e); }
}
