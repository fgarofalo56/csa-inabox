/**
 * GET /api/data-products/[id] — consumer (read-only) view of a data product.
 *
 * Unlike /api/cosmos-items/data-product/[id] (which gates on workspace
 * ownership and 404s for non-owners), this route returns ANY data product to
 * any authenticated user — the Purview Unified Catalog model where published
 * data products are discoverable to catalog readers. It resolves the owning
 * workspace's tenantId so the caller can be told whether they own it (and the
 * UI can hide owner-edit controls for non-owners).
 *
 * Cosmos-only (no Fabric/Purview dependency): the item lives in the `items`
 * container and is found by a cross-partition id+itemType query.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
        parameters: [
          { name: '@id', value: id },
          { name: '@t', value: 'data-product' },
        ],
      })
      .fetchAll();
    const item = resources[0];
    if (!item) return NextResponse.json({ ok: false, error: 'Data product not found' }, { status: 404 });

    // Resolve workspace owner — cross-partition query by id (workspace PK = /tenantId).
    let ownerTenantId: string | null = null;
    try {
      const ws = await workspacesContainer();
      const { resources: wsRes } = await ws.items
        .query<{ tenantId: string }>({
          query: 'SELECT c.tenantId FROM c WHERE c.id = @id',
          parameters: [{ name: '@id', value: item.workspaceId }],
        })
        .fetchAll();
      ownerTenantId = wsRes[0]?.tenantId ?? null;
    } catch { /* owner resolution is best-effort; consumer view still renders */ }

    return NextResponse.json({
      ok: true,
      item,
      ownerTenantId,
      isOwner: ownerTenantId !== null && ownerTenantId === s.claims.oid,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
