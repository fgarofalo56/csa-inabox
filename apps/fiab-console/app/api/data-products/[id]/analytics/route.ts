/**
 * GET /api/data-products/[id]/analytics — publisher listing analytics (W18).
 *   → { ok, analytics: { views, subscribes, distinctSubscribers, lastViewedAt,
 *        lastSubscribedAt }, approvedSubscribers, freshness }
 *
 * Owner-only (the caller must own the product's workspace) — analytics are a
 * publisher surface. Real Cosmos counters (data-product-analytics) + real
 * approved-access-request count + real freshness derived from the item's
 * updatedAt. No synthetic numbers (no-vaporware.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer, accessRequestsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiError, apiServerError } from '@/lib/api/respond';
import { getListingAnalytics } from '@/lib/marketplace/listing-analytics';
import { computeFreshness } from '@/lib/marketplace/sla';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function loadOwnedProduct(id: string, oid: string): Promise<WorkspaceItem | null> {
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
  if (!item) return null;
  const ws = await workspacesContainer();
  const { resources: wsRes } = await ws.items
    .query<{ tenantId: string }>({
      query: 'SELECT c.tenantId FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: item.workspaceId }],
    })
    .fetchAll();
  if (wsRes[0]?.tenantId !== oid) return null; // not the owner
  return item;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const { id } = await ctx.params;
  try {
    const item = await loadOwnedProduct(id, s.claims.oid);
    if (!item) return apiError('data product not found or not owned by caller', 404);

    const analytics = await getListingAnalytics(id);

    // Real approved-subscriber count from the access-request workflow.
    const arc = await accessRequestsContainer();
    const { resources: approved } = await arc.items
      .query<{ requesterId: string }>({
        query: "SELECT c.requesterId FROM c WHERE c.dataProductId = @id AND c.status = 'approved'",
        parameters: [{ name: '@id', value: id }],
      })
      .fetchAll();

    const freshness = computeFreshness(item);

    return NextResponse.json({
      ok: true,
      analytics: {
        views: analytics.views,
        subscribes: analytics.subscribes,
        distinctSubscribers: analytics.subscriberOids.length,
        lastViewedAt: analytics.lastViewedAt ?? null,
        lastSubscribedAt: analytics.lastSubscribedAt ?? null,
      },
      approvedSubscribers: new Set(approved.map((a) => a.requesterId)).size,
      freshness,
    });
  } catch (e) {
    return apiServerError(e);
  }
}
