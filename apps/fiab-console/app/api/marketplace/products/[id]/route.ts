/**
 * WS-10.4 Living Marketplace — single unified product.
 *
 *   GET  /api/marketplace/products/[id]   point-read one product (single-partition).
 *
 * Cosmos-only (`marketplace` container, PK /tenantId).
 */
import { NextRequest } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import { getProduct } from '@/lib/marketplace/product-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const { id } = await ctx.params;
    const tenantId = tenantScopeId(session);
    const product = await getProduct(tenantId, id);
    if (!product) return apiNotFound('product not found');
    return apiOk({ product });
  } catch (e) {
    return apiServerError(e, 'failed to read marketplace product', 'marketplace_get_failed');
  }
}
