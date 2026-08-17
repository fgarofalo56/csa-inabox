/**
 * GET /api/items/databricks-sql-warehouse/[id]/query-history?warehouseId=<id>&maxResults=50&pageToken=<...>
 *
 * Lists recent SQL statements via Databricks /api/2.0/sql/history/queries.
 * The [id] segment is the item id for routing continuity; the real
 * filter is the `warehouseId` query param (when set, results are
 * limited to that warehouse).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GET(req: NextRequest)` took NO `ctx`, so `[id]` was never read — the header
 * above said so out loud ("the item id for routing continuity"), which is an
 * accurate description of a route that authorizes nothing. `getSession()` was
 * the entire authorization.
 *
 * BE PRECISE ABOUT WHAT LEAKED, because "query history" understates it.
 * `warehouseId` is OPTIONAL here: omit it and `listQueryHistory({ warehouseId:
 * undefined })` returns recent statements across the ENTIRE shared Databricks
 * workspace — every tenant's. Each entry carries `query_text`, `user_name` and
 * timings, so an unowned caller could read other tenants' SQL verbatim, and
 * harvest the `statement_id`s that the sibling `[id]/query-profile` expands into
 * full execution profiles.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 0 — AUTHENTICATION via `withSession`, ABOVE the `id === 'new'` gate
 *   (the ordering defect MEASURED on #3655; no `middleware.ts` exists here).
 *
 * LAYER 1 — OWN THE ROUTE ITEM, READ-SCOPED (`allowReadRoles: true`): the
 *   handler only lists history and writes nothing.
 *
 * LAYER 3 — NOT PRESENT, AND THE RESIDUAL IS UNUSUALLY SHARP HERE, so it is
 *   named rather than folded into the generic ledger: because `warehouseId` is
 *   optional AND caller-supplied, an authorized caller can still omit it and
 *   read workspace-wide history. Layer 1 moves that from "any authenticated
 *   session" to "any authenticated session, plus one POST"
 *   (`createOwnedItem`, `_lib/item-crud.ts:423`) — a FLOOR, NOT A BOUND.
 *   Bounding it needs the item→warehouse binding tracked in #3669; filtering
 *   here on an unbound `warehouseId` would be theatre, since the caller
 *   supplies that value too.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import { listQueryHistory } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'databricks-sql-warehouse';

/** 404 body naming BOTH causes and asserting neither (`deploy-integrity.md` R7). */
const ITEM_UNREACHABLE =
  'This SQL warehouse item is not available to you. Either it does not exist, or you have no ' +
  'role in its workspace. Ask a workspace owner to share it with you.';

/**
 * The unsaved-item honest gate — after authentication, before the guard.
 *
 * REACHABLE: `openQueryHistory` → `loadQueryHistory`
 * (`sql-warehouse-editor.tsx:766`) is a ribbon action with no `isNew` guard in
 * that file (measured, `grep -c isNew` = 0). 200 + `code:'unsaved_item'`:
 * `loadQueryHistory` throws on `!j.ok` and renders the message as the history
 * dialog's error text, so the actionable sentence is what the user sees rather
 * than a bare 404 dead end.
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this SQL warehouse item first — query history is read in the name of the saved item, ' +
      'and an unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id: itemId } = params;
  if (itemId === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. READ-SCOPED — this handler only lists history.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;

  const warehouseId = req.nextUrl.searchParams.get('warehouseId') || undefined;
  const max = Number(req.nextUrl.searchParams.get('maxResults') || '50');
  const pageToken = req.nextUrl.searchParams.get('pageToken') || undefined;
  try {
    const out = await listQueryHistory({
      warehouseId,
      maxResults: Number.isFinite(max) ? max : 50,
      pageToken,
    });
    return NextResponse.json({ ok: true, ...out });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
