/**
 * GET /api/data-products/[id]
 *
 * Reads a single data product from the Azure-native `dataproducts` Cosmos
 * container (Purview-Unified-Catalog parity — NO Fabric/Purview dependency on
 * the default path). Returns the full document plus two best-effort derived
 * fields used by the owner details page (F3):
 *
 *   - dqScore   : real data-quality score computed from the tenant's DQ rules
 *                 (tenant-settings doc id `dq-rules:<tenantId>`). null when no
 *                 rules are configured — the UI shows an honest-gate instead of
 *                 a fabricated number (per no-vaporware.md).
 *   - subscriberCount : real count of approved access-requests for this product.
 *
 * Auth: minted session cookie. Tenant isolation: a product whose tenantId does
 * not match the caller's tenant (oid) is treated as not-found / forbidden.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  dataproductsContainer,
  accessRequestsContainer,
  tenantSettingsContainer,
} from '@/lib/azure/cosmos-client';
import type { DataProductDoc } from '@/lib/types/data-product';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code: string) {
  return NextResponse.json({ ok: false, error, code }, { status });
}

/** Minimal shape of the DQ-rules document (see /api/admin/data-quality-rules). */
interface DqRule { id: string; name: string; enabled: boolean; check?: string; scope?: string }
interface DqRulesDoc { id: string; tenantId: string; items?: DqRule[] }

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  const tenantId = session.claims.oid;

  // ---- Load the product (cross-partition query on id) ----
  let product: DataProductDoc | null = null;
  try {
    const c = await dataproductsContainer();
    const { resources } = await c.items
      .query<DataProductDoc>({
        query: 'SELECT * FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: id }],
      })
      .fetchAll();
    product = resources[0] ?? null;
  } catch (e: any) {
    return err(`Cosmos read failed: ${e?.message || String(e)}`, 502, 'cosmos_error');
  }
  if (!product) return err('Data product not found', 404, 'not_found');
  // Tenant isolation — never leak another tenant's product.
  if (product.tenantId && product.tenantId !== tenantId) {
    return err('Forbidden', 403, 'forbidden');
  }

  // ---- DQ score (real, from tenant DQ rules; honest-gate when none) ----
  let dqScore: number | null = null;
  let dqGate: string | null = null;
  try {
    const ts = await tenantSettingsContainer();
    const { resource: dqDoc } = await ts
      .item(`dq-rules:${tenantId}`, tenantId)
      .read<DqRulesDoc>();
    const rules = dqDoc?.items ?? [];
    if (rules.length > 0) {
      const enabled = rules.filter((r) => r.enabled).length;
      dqScore = Math.round((enabled / rules.length) * 100);
    } else {
      dqGate = 'No data-quality rules configured for this tenant. Define rules in Admin › Data Quality Rules to compute a real score.';
    }
  } catch (e: any) {
    // 404 = no rules doc yet → honest-gate, not an error.
    dqGate = 'No data-quality rules configured for this tenant. Define rules in Admin › Data Quality Rules to compute a real score.';
  }

  // ---- Subscriber count (real approved access-requests) ----
  let subscriberCount = 0;
  try {
    const ar = await accessRequestsContainer();
    const { resources: subs } = await ar.items
      .query<{ id: string }>({
        query: 'SELECT c.id FROM c WHERE c.dataProductId = @id AND c.status = "approved"',
        parameters: [{ name: '@id', value: id }],
      })
      .fetchAll();
    subscriberCount = subs.length;
  } catch {
    // best-effort — leave at 0 if the container is unreachable.
  }

  return NextResponse.json({ ok: true, product, dqScore, dqGate, subscriberCount });
}

/**
 * PATCH /api/data-products/[id]
 *
 * Owner-editable contact labels on the details page (F3). Body:
 *   { ownerLabels: { "<ownerOid>": "Primary contact", ... } }
 * Updates `owners[].label` in place for the matching owner ids and persists the
 * real Cosmos doc (partition key = governanceDomainId). Tenant-isolated. Returns
 * the updated product so the UI reflects the saved state. No Fabric/Purview
 * dependency — pure Cosmos write.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  const tenantId = session.claims.oid;

  const body = await req.json().catch(() => null) as { ownerLabels?: Record<string, string> } | null;
  const ownerLabels = body?.ownerLabels;
  if (!ownerLabels || typeof ownerLabels !== 'object') {
    return err('Body must be { ownerLabels: { <ownerId>: <label> } }', 400, 'bad_request');
  }

  let product: DataProductDoc | null = null;
  try {
    const c = await dataproductsContainer();
    const { resources } = await c.items
      .query<DataProductDoc>({
        query: 'SELECT * FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: id }],
      })
      .fetchAll();
    product = resources[0] ?? null;
    if (!product) return err('Data product not found', 404, 'not_found');
    if (product.tenantId && product.tenantId !== tenantId) return err('Forbidden', 403, 'forbidden');

    const owners = (product.owners ?? []).map((o) =>
      Object.prototype.hasOwnProperty.call(ownerLabels, o.id)
        ? { ...o, label: String(ownerLabels[o.id]).trim() || undefined }
        : o,
    );
    const updated: DataProductDoc = { ...product, owners, updatedAt: new Date().toISOString() };
    const { resource } = await c.item(id, product.governanceDomainId).replace<DataProductDoc>(updated);
    return NextResponse.json({ ok: true, product: resource });
  } catch (e: any) {
    return err(`Cosmos write failed: ${e?.message || String(e)}`, 502, 'cosmos_error');
  }
}
