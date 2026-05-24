/**
 * GET  /api/items/apim-product           — list products
 * POST /api/items/apim-product           — upsert product. Body: { id?, displayName, description?, state?, subscriptionRequired?, approvalRequired? }
 *   POST is idempotent: if `id` is supplied (or derived from displayName) and the product exists, it is updated.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listProducts, upsertProduct, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || `product-${Date.now()}`;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const products = await listProducts();
    return NextResponse.json({ ok: true, products });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
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
}
