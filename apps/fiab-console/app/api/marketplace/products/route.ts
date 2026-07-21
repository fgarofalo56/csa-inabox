/**
 * WS-10.4 Living Marketplace (BTB-11) — unified product catalog BFF.
 *
 *   GET  /api/marketplace/products          list this tenant's products
 *        ?kind=data|agent|mcp|app|ontology  filter to one kind
 *        ?certified=1                        certified products only (consumer view)
 *        ?status=published|draft|deprecated  filter by publish status
 *
 *   POST /api/marketplace/products          PUBLISH a product (any of 5 kinds).
 *        Runs the gate registry as AUTO-CERTIFICATION and persists the product
 *        with a REAL certification state (no fake certs). Body:
 *          { productKind, displayName, description?, domain?, tags?,
 *            sourceItemId?, sourceItemType?, sourceWorkspaceId?,
 *            accessModel?, lcuPerSubscription?, grantRole? }
 *
 * Cosmos-only (`marketplace` container, PK /tenantId). No Fabric/Power BI
 * dependency — Gov-safe.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantScopeId } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import {
  buildProduct,
  PRODUCT_KINDS,
  type ProductKind,
  type AccessModel,
  type PublishStatus,
} from '@/lib/marketplace/product-types';
import { runCertification } from '@/lib/marketplace/certification';
import { listProducts, upsertProduct } from '@/lib/marketplace/product-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const tenantId = tenantScopeId(session);
    const url = new URL(req.url);
    const kindParam = url.searchParams.get('kind');
    const kind = kindParam && PRODUCT_KINDS.includes(kindParam as ProductKind) ? (kindParam as ProductKind) : undefined;
    const certifiedOnly = url.searchParams.get('certified') === '1';
    const statusParam = url.searchParams.get('status') as PublishStatus | null;
    const products = await listProducts(tenantId, {
      kind,
      certifiedOnly,
      publishStatus: statusParam || undefined,
    });
    return apiOk({ products });
  } catch (e) {
    return apiServerError(e, 'failed to list marketplace products', 'marketplace_list_failed');
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const tenantId = tenantScopeId(session);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const productKind = String(body.productKind || '') as ProductKind;
    if (!PRODUCT_KINDS.includes(productKind)) {
      return apiError(`productKind must be one of: ${PRODUCT_KINDS.join(', ')}`, 400);
    }
    const displayName = String(body.displayName || '').trim();
    if (!displayName) return apiError('displayName is required', 400);

    const accessModel = (body.accessModel === 'request' ? 'request' : 'open') as AccessModel;

    // 1) Build the base product record.
    const product = buildProduct({
      tenantId,
      productKind,
      displayName,
      description: body.description ? String(body.description) : undefined,
      domain: body.domain ? String(body.domain) : undefined,
      tags: Array.isArray(body.tags) ? (body.tags as unknown[]).map(String) : undefined,
      owner: session.claims.upn,
      ownerOid: session.claims.oid,
      sourceItemId: body.sourceItemId ? String(body.sourceItemId) : undefined,
      sourceItemType: body.sourceItemType ? String(body.sourceItemType) : undefined,
      sourceWorkspaceId: body.sourceWorkspaceId ? String(body.sourceWorkspaceId) : undefined,
      accessModel,
      lcuPerSubscription:
        typeof body.lcuPerSubscription === 'number' ? (body.lcuPerSubscription as number) : undefined,
      grantRole: body.grantRole ? String(body.grantRole) : undefined,
    });

    // 2) AUTO-CERTIFICATION — run the real gate registry for this kind.
    const cert = runCertification(productKind);
    product.certification = cert.certification;
    product.requiredGateIds = cert.requiredGateIds;
    product.certGates = cert.gates;
    if (cert.certification === 'certified') product.certifiedAt = new Date().toISOString();

    // 3) Publish (a certified product is live; a failed cert is published as a
    //    draft-with-remediation so the owner sees exactly which gate to fix).
    product.publishStatus = cert.certification === 'certified' ? 'published' : 'draft';

    // 4) Persist to Cosmos.
    const saved = await upsertProduct(product);

    return apiOk({
      product: saved,
      certification: cert.certification,
      gates: cert.gates,
      blockers: cert.blockers,
    });
  } catch (e) {
    return apiServerError(e, 'failed to publish marketplace product', 'marketplace_publish_failed');
  }
}
