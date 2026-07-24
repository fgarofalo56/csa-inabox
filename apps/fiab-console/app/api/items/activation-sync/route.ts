/**
 * GET  /api/items/activation-sync   — list activation-sync items owned by tenant.
 * POST /api/items/activation-sync   body { workspaceId, displayName, description?, state? }
 *
 * `state` is an ActivationSyncSpec (lib/activation/types) — source (lake Delta
 * location) + destination (Dataverse / webhook / Event Grid / Service Bus) +
 * dropdown-picked field mapping. Runs are driven by the [id]/run route (full or
 * Delta-CDF incremental). No Fabric dependency.
 */

import { NextResponse } from 'next/server';
import { createOwnedItem, jerr, listOwnedItems } from '../_lib/item-crud';
import { apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { coerceSpec } from '@/lib/activation/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'activation-sync';

export const GET = withSession(async (_req, { session }) => {
  try {
    const items = await listOwnedItems(ITEM_TYPE, session.claims.oid);
    return NextResponse.json({ ok: true, items });
  } catch (e: any) {
    return apiServerError(e);
  }
});

export const POST = withSession(async (req, { session }) => {
  const body = await req.json().catch(() => ({}));
  try {
    // Coerce any provided state so no freeform config leaks into the item.
    const create = { ...body, ...(body?.state ? { state: coerceSpec(body.state) } : {}) };
    const r = await createOwnedItem(session, ITEM_TYPE, create);
    if (!r.ok) return jerr(r.error, r.status);
    return NextResponse.json({ ok: true, item: r.item }, { status: 201 });
  } catch (e: any) {
    return apiServerError(e);
  }
});
