/**
 * WS-10.4 Living Marketplace — SUBSCRIBE to a unified product.
 *
 *   POST /api/marketplace/products/[id]/subscribe
 *
 * Real end-to-end (no-vaporware / G1):
 *   1. Entitlement — writes a REAL access-governance ledger grant
 *      (source 'marketplace'). `open` products grant active; `request`
 *      products grant eligible (owner still approves via the access inbox).
 *   2. Billing — meters the product's `lcuPerSubscription` to the subscriber's
 *      tenant chargeback through the real cost-attribution ledger.
 *   3. Bumps the product subscriber counter.
 *
 * A product can only be subscribed when it is `certified` — that is the whole
 * point of auto-certification (you cannot subscribe to something whose backend
 * gates are blocked). A failed-cert product returns 409 with the remediation.
 */
import { NextRequest } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiConflict, apiServerError } from '@/lib/api/respond';
import { getProduct, incrementSubscriberCount } from '@/lib/marketplace/product-store';
import { subscribeToProduct } from '@/lib/marketplace/subscribe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const { id } = await ctx.params;
    const tenantId = tenantScopeId(session);

    const product = await getProduct(tenantId, id);
    if (!product) return apiNotFound('product not found');

    if (product.publishStatus === 'deprecated') {
      return apiConflict('product is deprecated and no longer subscribable');
    }
    if (product.certification !== 'certified') {
      const missing = (product.certGates || []).flatMap((g) => g.missing).filter(Boolean);
      return apiError(
        `product is not certified — resolve its gates before subscribing${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
        409,
        { code: 'not_certified', blockers: missing },
      );
    }

    const result = await subscribeToProduct(product, {
      oid: session.claims.oid,
      upn: session.claims.upn,
      name: session.claims.name,
      tenantId,
    });

    // Best-effort subscriber counter (never fails the subscribe).
    await incrementSubscriberCount(tenantId, id);

    return apiOk({
      subscribed: true,
      entitlementState: result.entitlementState,
      entitled: result.entitled,
      metered: result.metered,
      lcu: result.lcu,
      estCostUsd: result.estCostUsd,
      product: { id: product.id, displayName: product.displayName, productKind: product.productKind },
    });
  } catch (e) {
    return apiServerError(e, 'failed to subscribe to product', 'marketplace_subscribe_failed');
  }
}
