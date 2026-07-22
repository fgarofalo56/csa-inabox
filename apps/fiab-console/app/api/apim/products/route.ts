/**
 * Products in the deployment-default APIM service (the APIM navigator →
 * Products group). Lists / creates / deletes products via the real ARM REST.
 *
 *   GET    /api/apim/products             → { ok, products: [{name, displayName, state, ...}] }
 *   POST   /api/apim/products             body { displayName, name? } → create (notPublished)
 *   DELETE /api/apim/products?id=NAME     → delete (also deletes its subscriptions)
 *
 * Honest 503 gate when the APIM service is unset. Real ARM REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apimConfigGate, listProducts, upsertProduct, deleteProduct, ApimError } from '@/lib/azure/apim-client';
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

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || `product-${Date.now()}`;
}

function fail(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

// WS-D1: session-only routes adopted onto `withSession`.
export const GET = withSession(async () => {
  const g = gate(); if (g) return g;
  try {
    return NextResponse.json({ ok: true, products: await listProducts() });
  } catch (e: any) { return fail(e); }
});

export const POST = withSession(async (req: NextRequest) => {
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  if (!body?.displayName) return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  const id = (body.id && String(body.id)) || slug(body.displayName);
  try {
    const product = await upsertProduct(id, {
      displayName: String(body.displayName),
      description: body.description || undefined,
      subscriptionRequired: body.subscriptionRequired,
      approvalRequired: body.approvalRequired,
      state: 'notPublished',
    });
    return NextResponse.json({ ok: true, product });
  } catch (e: any) { return fail(e); }
});

export const DELETE = withSession(async (req: NextRequest) => {
  const g = gate(); if (g) return g;
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  try {
    await deleteProduct(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return fail(e); }
});
