/**
 * WS-10.4 Living Marketplace — Cosmos store for the unified product catalog.
 *
 * Thin CRUD over the `marketplace` container (PK /tenantId). Every product kind
 * (data|agent|mcp|app|ontology) is one doc shape here, so list/get/upsert are a
 * single code path. No mock arrays — reads/writes hit real Cosmos.
 */
import { marketplaceContainer } from '@/lib/azure/cosmos-client';
import type { MarketplaceProduct, ProductKind, PublishStatus } from './product-types';

/** Upsert a product row (publish / re-certify / status change). */
export async function upsertProduct(product: MarketplaceProduct): Promise<MarketplaceProduct> {
  const c = await marketplaceContainer();
  product.updatedAt = new Date().toISOString();
  const { resource } = await c.items.upsert<MarketplaceProduct>(product);
  return (resource as MarketplaceProduct) || product;
}

/** Point-read one product (single-partition). */
export async function getProduct(tenantId: string, id: string): Promise<MarketplaceProduct | null> {
  const c = await marketplaceContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<MarketplaceProduct>();
    return resource ?? null;
  } catch {
    return null;
  }
}

export interface ListProductsOptions {
  kind?: ProductKind;
  publishStatus?: PublishStatus;
  /** Only certified products (consumer view). */
  certifiedOnly?: boolean;
}

/** List a tenant's products, optionally filtered by kind / status. */
export async function listProducts(tenantId: string, opts: ListProductsOptions = {}): Promise<MarketplaceProduct[]> {
  const c = await marketplaceContainer();
  const where: string[] = ['c.docType = @dt', 'c.tenantId = @t'];
  const parameters: Array<{ name: string; value: unknown }> = [
    { name: '@dt', value: 'marketplace-product' },
    { name: '@t', value: tenantId },
  ];
  if (opts.kind) {
    where.push('c.productKind = @k');
    parameters.push({ name: '@k', value: opts.kind });
  }
  if (opts.publishStatus) {
    where.push('c.publishStatus = @ps');
    parameters.push({ name: '@ps', value: opts.publishStatus });
  }
  if (opts.certifiedOnly) {
    where.push("c.certification = 'certified'");
  }
  const { resources } = await c.items
    .query<MarketplaceProduct>({
      query: `SELECT * FROM c WHERE ${where.join(' AND ')} ORDER BY c.updatedAt DESC`,
      parameters: parameters as never,
    })
    .fetchAll();
  return resources;
}

/** Bump the subscriber counter (best-effort). */
export async function incrementSubscriberCount(tenantId: string, id: string): Promise<void> {
  try {
    const p = await getProduct(tenantId, id);
    if (!p) return;
    p.subscriberCount = (p.subscriberCount || 0) + 1;
    await upsertProduct(p);
  } catch {
    /* best-effort counter — never fail a subscribe */
  }
}

/** Set publish status (deprecate / republish). */
export async function setPublishStatus(
  tenantId: string,
  id: string,
  status: PublishStatus,
): Promise<MarketplaceProduct | null> {
  const p = await getProduct(tenantId, id);
  if (!p) return null;
  p.publishStatus = status;
  return upsertProduct(p);
}
