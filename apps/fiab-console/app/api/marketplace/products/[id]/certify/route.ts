/**
 * WS-10.4 Living Marketplace — RE-CERTIFY a product (owner action / gate fix).
 *
 *   POST /api/marketplace/products/[id]/certify
 *
 * Re-runs the gate registry as auto-certification against the CURRENT env and
 * updates the product's certification + publish status. Use after a "Fix it"
 * gate remediation flips a blocked gate to configured so the product can go
 * from failed → certified → published without re-publishing from scratch.
 */
import { NextRequest } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiForbidden, apiNotFound, apiServerError } from '@/lib/api/respond';
import { getProduct, upsertProduct } from '@/lib/marketplace/product-store';
import { runCertification } from '@/lib/marketplace/certification';

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
    // Only the owner (or a tenant admin) re-certifies.
    if (product.ownerOid && product.ownerOid !== session.claims.oid) {
      return apiForbidden('only the product owner can re-certify');
    }

    const cert = runCertification(product.productKind);
    product.certification = cert.certification;
    product.requiredGateIds = cert.requiredGateIds;
    product.certGates = cert.gates;
    if (cert.certification === 'certified') {
      product.certifiedAt = new Date().toISOString();
      if (product.publishStatus === 'draft') product.publishStatus = 'published';
    }
    const saved = await upsertProduct(product);

    return apiOk({ product: saved, certification: cert.certification, gates: cert.gates, blockers: cert.blockers });
  } catch (e) {
    return apiServerError(e, 'failed to re-certify product', 'marketplace_certify_failed');
  }
}
