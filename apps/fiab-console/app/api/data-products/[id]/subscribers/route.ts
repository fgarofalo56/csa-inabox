/**
 * GET /api/data-products/[id]/subscribers?page=0&pageSize=10
 *
 * Paginated list of approved subscribers (access-requests) for a data product.
 * Real Cosmos query against the Azure-native `access-requests` container — no
 * Fabric/Purview dependency. Used by the owner details page (F3) subscribers
 * list. Owner-only: the data product is loaded via the tenant-scoped workspace
 * path, so a non-owner gets 404 and never sees the subscriber list.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  itemsContainer,
  workspacesContainer,
  accessRequestsContainer,
} from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import type { AccessRequestDoc } from '@/lib/types/data-product';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

function err(error: string, status: number, code: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  const tenantId = session.claims.oid;

  const page = Math.max(0, Number(req.nextUrl.searchParams.get('page') || 0) || 0);
  const pageSize = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get('pageSize') || 10) || 10));

  // Tenant isolation — confirm the product exists and belongs to this tenant
  // (via its owning workspace) before exposing its subscriber list.
  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT c.id, c.workspaceId FROM c WHERE c.id = @id AND c.itemType = @t',
        parameters: [
          { name: '@id', value: id },
          { name: '@t', value: ITEM_TYPE },
        ],
      })
      .fetchAll();
    const product = resources[0];
    if (!product) return err('Data product not found', 404, 'not_found');
    const ws = await workspacesContainer();
    try {
      const { resource } = await ws.item(product.workspaceId, tenantId).read<Workspace>();
      if (!resource || resource.tenantId !== tenantId) return err('Data product not found', 404, 'not_found');
    } catch (e: any) {
      if (e?.code === 404) return err('Data product not found', 404, 'not_found');
      throw e;
    }
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
