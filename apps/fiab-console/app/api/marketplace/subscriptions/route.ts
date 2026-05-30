/**
 * GET  /api/marketplace/subscriptions   — list the tenant's APIM subscriptions
 * POST /api/marketplace/subscriptions   — subscribe / request access
 *     body: { displayName?, product?, api?, allApis?, sid?, state? }
 *     exactly one of { product, api, allApis } is required.
 *
 * Mirrors the APIM developer-portal "Subscribe" button. A product with
 * approvalRequired=true yields a subscription in 'submitted' (pending) state
 * until an administrator approves it; the route surfaces that state verbatim.
 *
 * Real Azure REST:
 *   GET .../subscriptions                 (listSubscriptions)
 *   PUT .../subscriptions/{sid}           (createSubscription)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listSubscriptions, createSubscription, ApimError,
} from '@/lib/azure/apim-client';
import { apimGate, gateResponse } from '../_gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gated = gateResponse(apimGate());
  if (gated) return gated;
  try {
    const subscriptions = await listSubscriptions();
    return NextResponse.json({ ok: true, subscriptions });
  } catch (e: any) { return handleErr(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gated = gateResponse(apimGate());
  if (gated) return gated;

  const body = await req.json().catch(() => ({}));
  const product = body?.product ? String(body.product) : undefined;
  const api = body?.api ? String(body.api) : undefined;
  const allApis = body?.allApis === true;

  const targets = [product, api, allApis ? 'allApis' : undefined].filter(Boolean);
  if (targets.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'one of product, api, or allApis is required' },
      { status: 400 },
    );
  }
  if (targets.length > 1) {
    return NextResponse.json(
      { ok: false, error: 'provide exactly one of product, api, or allApis' },
      { status: 400 },
    );
  }

  const displayName = String(
    body?.displayName || product || api || 'all-apis',
  ).slice(0, 100);
  const state = body?.state === 'active' ? 'active' : undefined; // default → submitted

  try {
    const subscription = await createSubscription({
      sid: body?.sid ? String(body.sid) : undefined,
      displayName,
      product,
      api,
      allApis,
      state,
    });
    return NextResponse.json({ ok: true, subscription }, { status: 201 });
  } catch (e: any) { return handleErr(e); }
}
