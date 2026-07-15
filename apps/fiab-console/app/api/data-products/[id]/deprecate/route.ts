/**
 * POST /api/data-products/[id]/deprecate  (DP-9)
 *
 * The humane deprecation workflow. Body:
 *   { action: 'deprecate', sunsetAt, noticeDays, replacementProductId?, migrationNote? }
 *   { action: 'retire' }        — flip to retired now (also happens lazily at sunset)
 *   { action: 'reactivate' }    — undo, back to published
 *
 * A deprecate transition (rides DP-1's canonical lifecycle: published →
 * deprecated → retired) records a sunset date + replacement pointer + migration
 * note + notice-lead window, keeps the product QUERYABLE through the window
 * (parallel-run), notifies active subscribers, and re-projects the marketplace
 * doc. Owner-only. Azure-native Cosmos; no Fabric dependency.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem, jerr } from '@/app/api/items/_lib/item-crud';
import { upsertDataProductDoc, docForDataProduct } from '@/lib/azure/loom-data-products-search';
import { setLifecycleState, resolveLifecycleState } from '@/lib/dataproducts/lifecycle';
import type { DeprecationRecord } from '@/lib/dataproducts/versioning';
import { emitLoomEvent } from '@/lib/events/webhook-emitter';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';
const NOTICE_DAYS = [30, 60, 90];

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || 'deprecate');
  if (!['deprecate', 'retire', 'reactivate'].includes(action)) {
    return jerr('action must be deprecate | retire | reactivate', 400);
  }

  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('data-product item not found', 404);
    const state = (item.state || {}) as Record<string, unknown>;
    const now = new Date().toISOString();

    let nextState: Record<string, unknown>;
    if (action === 'reactivate') {
      const { deprecation, ...rest } = state;
      void deprecation;
      nextState = setLifecycleState(rest, 'published');
    } else if (action === 'retire') {
      nextState = setLifecycleState(state, 'retired');
    } else {
      // deprecate — validate the form.
      const sunsetRaw = String(body?.sunsetAt || '');
      const sunsetMs = Date.parse(sunsetRaw);
      if (!Number.isFinite(sunsetMs)) return jerr('sunsetAt must be a valid date', 400);
      const noticeDays = NOTICE_DAYS.includes(Number(body?.noticeDays)) ? Number(body.noticeDays) : 60;
      const record: DeprecationRecord = {
        deprecatedAt: now,
        deprecatedBy: session.claims.upn || session.claims.email || session.claims.oid,
        sunsetAt: new Date(sunsetMs).toISOString(),
        noticeDays,
        ...(body?.replacementProductId ? { replacementProductId: String(body.replacementProductId) } : {}),
        ...(body?.migrationNote ? { migrationNote: String(body.migrationNote).slice(0, 2000) } : {}),
      };
      nextState = setLifecycleState({ ...state, deprecation: record }, 'deprecated');
    }

    const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: nextState });
    if (!updated) return jerr('Cosmos write failed', 500);

    // Best-effort: notify subscribers + re-project the discovery doc.
    if (action === 'deprecate') {
      try {
        emitLoomEvent({
          type: 'marketplace.listing.deprecated',
          tenantId: session.claims.oid,
          subject: id,
          subjectName: item.displayName,
          actor: { oid: session.claims.oid, upn: session.claims.upn || session.claims.email },
          data: { sunsetAt: (nextState.deprecation as DeprecationRecord)?.sunsetAt, replacementProductId: (nextState.deprecation as DeprecationRecord)?.replacementProductId },
        });
      } catch { /* notification is best-effort */ }
    }
    try { await upsertDataProductDoc(docForDataProduct(updated, session.claims.oid)); } catch { /* derived */ }

    return NextResponse.json({
      ok: true,
      lifecycleState: resolveLifecycleState(nextState),
      deprecation: nextState.deprecation ?? null,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}
