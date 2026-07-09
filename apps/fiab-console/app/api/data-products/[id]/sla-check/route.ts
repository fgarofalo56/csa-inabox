/**
 * POST /api/data-products/[id]/sla-check — evaluate the listing's freshness SLA
 * and, when BREACHED, fan a marketplace.sla.breached event out to the owner's
 * subscribed webhooks (W18).
 *   → { ok, freshness, emitted }
 *
 * Owner-only. Real evaluation over the item's real lastRefreshedAt/updatedAt
 * vs its declared update cadence (lib/marketplace/sla.ts) — no synthetic
 * breach. Callable on demand (owner "Check SLA now" button) or by a scheduled
 * sweep. When no SLA is declared, returns breached:false and emits nothing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiError, apiServerError } from '@/lib/api/respond';
import { computeFreshness } from '@/lib/marketplace/sla';
import { emitLoomEvent } from '@/lib/events/webhook-emitter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const { id } = await ctx.params;
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
    if (!item) return apiError('data product not found', 404);

    // Owner gate — only the owning tenant may run + trip SLA alerts.
    const ws = await workspacesContainer();
    const { resources: wsRes } = await ws.items
      .query<{ tenantId: string }>({
        query: 'SELECT c.tenantId FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: item.workspaceId }],
      })
      .fetchAll();
    if (wsRes[0]?.tenantId !== s.claims.oid) {
      return apiError('only the data product owner can evaluate its SLA', 403);
    }

    const freshness = computeFreshness(item);
    let emitted = false;
    if (freshness.breached) {
      emitLoomEvent({
        type: 'marketplace.sla.breached',
        tenantId: s.claims.oid,
        subject: id,
        subjectName: item.displayName,
        actor: { oid: s.claims.oid, upn: s.claims.upn || s.claims.email },
        data: {
          kind: 'freshness',
          ageHours: freshness.ageHours,
          windowHours: freshness.windowHours,
          frequency: freshness.frequency,
          lastRefreshedAt: freshness.lastRefreshedAt,
        },
      });
      emitted = true;
    }
    return NextResponse.json({ ok: true, freshness, emitted });
  } catch (e) {
    return apiServerError(e);
  }
}
