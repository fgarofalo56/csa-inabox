/**
 * GET /api/data-products/[id]/subscribers?page=0&pageSize=10
 *
 * Paginated list of approved subscribers (access-requests) for a data product.
 * Real Cosmos query against the Azure-native `access-requests` container — no
 * Fabric/Purview dependency. Used by the owner details page (F3) subscribers
 * list. Tenant isolation is enforced by first confirming the product belongs
 * to the caller's tenant.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  accessRequestsContainer,
  dataproductsContainer,
} from '@/lib/azure/cosmos-client';
import type { AccessRequestDoc, DataProductDoc } from '@/lib/types/data-product';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code: string) {
  return NextResponse.json({ ok: false, error, code }, { status });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  const tenantId = session.claims.oid;

  const page = Math.max(0, Number(req.nextUrl.searchParams.get('page') || 0) || 0);
  const pageSize = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get('pageSize') || 10) || 10));

  // Tenant isolation — confirm the product belongs to this tenant first.
  try {
    const dp = await dataproductsContainer();
    const { resources } = await dp.items
      .query<DataProductDoc>({
        query: 'SELECT c.id, c.tenantId FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: id }],
      })
      .fetchAll();
    const product = resources[0];
    if (!product) return err('Data product not found', 404, 'not_found');
    if (product.tenantId && product.tenantId !== tenantId) return err('Forbidden', 403, 'forbidden');
  } catch (e: any) {
    return err(`Cosmos read failed: ${e?.message || String(e)}`, 502, 'cosmos_error');
  }

  try {
    const ar = await accessRequestsContainer();
    const { resources } = await ar.items
      .query<AccessRequestDoc>({
        query:
          'SELECT c.id, c.requesterUpn, c.requesterDisplayName, c.grantedAt, c.purpose ' +
          'FROM c WHERE c.dataProductId = @id AND c.status = "approved" ' +
          'ORDER BY c.grantedAt DESC OFFSET @offset LIMIT @limit',
        parameters: [
          { name: '@id', value: id },
          { name: '@offset', value: page * pageSize },
          { name: '@limit', value: pageSize },
        ],
      })
      .fetchAll();
    return NextResponse.json({ ok: true, subscribers: resources, page, pageSize });
  } catch (e: any) {
    return err(`Cosmos read failed: ${e?.message || String(e)}`, 502, 'cosmos_error');
  }
}
