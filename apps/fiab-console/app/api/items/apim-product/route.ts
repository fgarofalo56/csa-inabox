/**
 * GET  /api/items/apim-product           — list products
 * POST /api/items/apim-product           — upsert product. Body: { id?, displayName, description?, state?, subscriptionRequired?, approvalRequired? }
 *   POST is idempotent: if `id` is supplied (or derived from displayName) and the product exists, it is updated.
 */
import { slugify } from '@/lib/util/trim';
import { NextRequest, NextResponse } from 'next/server';
import { listProducts, upsertProduct, apimConfigGate, ApimError } from '@/lib/azure/apim-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function slug(s: string): string {
  return slugify(s, { max: 80 }) || `product-${Date.now()}`;
}

/**
 * Honest config-gate. Returns a 503 with `code:'not_configured'` + the exact
 * missing env var so the pane's apimFetchJson helper renders a readable Fluent
 * MessageBar (naming the env var) instead of hard-crashing on a non-JSON body.
 */
function gate(): NextResponse | null {
  const g = apimConfigGate();
  if (!g) return null;
  return NextResponse.json({
    ok: false,
    code: 'not_configured',
    missing: g.missing,
    error: `API Management is not configured in this deployment (set ${g.missing}). Provision APIM (platform/fiab/bicep/modules/admin-plane/apim.bicep) and grant the Console UAMI "API Management Service Contributor".`,
  }, { status: 503 });
}

export const GET = withSession(async (_req, { session }) => {
  const g = gate();
  if (g) return g;
  try {
    const products = await listProducts();
    return NextResponse.json({ ok: true, products });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
});

export const POST = withSession(async (req: NextRequest) => {
  const g = gate();
  if (g) return g;
  const body = await req.json().catch(() => ({}));
  if (!body?.displayName) return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  const id = (body.id && String(body.id)) || slug(body.displayName);
  try {
    const product = await upsertProduct(id, {
      displayName: String(body.displayName),
      description: body.description,
      subscriptionRequired: body.subscriptionRequired,
      approvalRequired: body.approvalRequired,
      state: body.state,
      terms: body.terms,
    });
    return NextResponse.json({ ok: true, product });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
  }
});
