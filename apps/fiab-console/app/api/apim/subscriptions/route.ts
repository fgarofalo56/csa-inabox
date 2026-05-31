/**
 * Subscriptions in the deployment-default APIM service (the APIM navigator →
 * Subscriptions group). Lists / creates / deletes consumer subscriptions via
 * the real ARM REST.
 *
 *   GET    /api/apim/subscriptions            → { ok, subscriptions: [{name, displayName, scope, state}] }
 *   POST   /api/apim/subscriptions            body { displayName, scope:'allApis'|'product'|'api', target?, productId?, apiId? } → create (active)
 *   DELETE /api/apim/subscriptions?id=SID     → delete
 *
 * Honest 503 gate when the APIM service is unset. Real ARM REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  apimConfigGate, listSubscriptions, createSubscription, deleteSubscription, ApimError,
} from '@/lib/azure/apim-client';

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

function fail(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    return NextResponse.json({ ok: true, subscriptions: await listSubscriptions() });
  } catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const displayName = body?.displayName ? String(body.displayName) : '';
  if (!displayName) return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  // Resolve scope: allApis (default), a product, or a single API.
  const scope = body?.scope || (body?.productId ? 'product' : body?.apiId ? 'api' : 'allApis');
  const target: { product?: string; api?: string; allApis?: boolean } = {};
  if (scope === 'product') {
    const p = body?.productId || body?.target;
    if (!p) return NextResponse.json({ ok: false, error: 'productId is required for a product-scoped subscription' }, { status: 400 });
    target.product = String(p);
  } else if (scope === 'api') {
    const a = body?.apiId || body?.target;
    if (!a) return NextResponse.json({ ok: false, error: 'apiId is required for an api-scoped subscription' }, { status: 400 });
    target.api = String(a);
  } else {
    target.allApis = true;
  }
  try {
    // Admin-minted subscriptions are created active (no developer-portal approval loop).
    const subscription = await createSubscription({ displayName, ...target, state: 'active' });
    return NextResponse.json({ ok: true, subscription });
  } catch (e: any) { return fail(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  try {
    await deleteSubscription(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return fail(e); }
}
