/**
 * A single consumer subscription in the deployment-default APIM service.
 *
 *   PATCH  /api/apim/subscriptions/{sid}   body { state?: 'active'|'suspended'|'cancelled', displayName? }
 *          → approve / suspend / cancel / rename. Returns the updated subscription.
 *   DELETE /api/apim/subscriptions/{sid}   → delete the subscription.
 *
 * Backs the admin Subscriptions pane's approve / reject / suspend actions
 * (apim-subscriptions-pane.tsx). Real ARM REST (updateSubscription /
 * deleteSubscription). Honest 503 gate when APIM is unconfigured. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  apimConfigGate, updateSubscription, deleteSubscription, ApimError,
} from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_STATES = ['active', 'suspended', 'cancelled'] as const;
type SubState = (typeof ALLOWED_STATES)[number];

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

function fail(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ sid: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const sid = (await ctx.params).sid;
  const body = await req.json().catch(() => ({}));
  const state = body?.state ? String(body.state) : undefined;
  const displayName = body?.displayName ? String(body.displayName) : undefined;
  if (state && !ALLOWED_STATES.includes(state as SubState)) {
    return NextResponse.json(
      { ok: false, error: `Invalid state "${state}". Allowed: ${ALLOWED_STATES.join(', ')}.` },
      { status: 400 },
    );
  }
  if (!state && !displayName) {
    return NextResponse.json({ ok: false, error: 'state or displayName is required' }, { status: 400 });
  }
  try {
    const subscription = await updateSubscription(sid, { state: state as SubState | undefined, displayName });
    return NextResponse.json({ ok: true, subscription });
  } catch (e: any) { return fail(e); }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ sid: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    await deleteSubscription((await ctx.params).sid);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return fail(e); }
}
