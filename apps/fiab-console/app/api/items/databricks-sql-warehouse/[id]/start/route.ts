/**
 * POST /api/items/databricks-sql-warehouse/[id]/start?warehouseId=
 * Fire-and-poll start. Returns 202; UI polls /state until RUNNING.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `POST(req: NextRequest)` took NO `ctx`, so `[id]` was never read. Behind
 * `getSession()` alone, `?warehouseId=` went verbatim to `getWarehouse(id)` and
 * `startWarehouse(id)` as the Console identity.
 *
 * BE PRECISE ABOUT THE EFFECT rather than rating it by the verb. Starting a
 * warehouse is not destructive and discloses only its state, but it is a
 * MUTATION with a direct, unbounded COST: a SQL warehouse is billed compute, and
 * any authenticated session could spin up every warehouse in the deployment —
 * repeatedly, since `auto_stop_mins` only ends an idle period that a fresh start
 * restarts. It is a spend primitive, and it pairs with the sibling `[id]/state`
 * POST (`stopWarehouse`) to give an unauthorized caller full lifecycle control
 * over another tenant's compute.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 0 — AUTHENTICATION via the route-toolkit `withSession` wrapper, ABOVE
 *   the `id === 'new'` gate. That ordering is the defect an independent review
 *   MEASURED on #3655: `guardSynapseItemRequest` reads the session itself, so
 *   leaning on it for authentication puts the unsaved-item short-circuit above
 *   the session read and `…/new` answers 200 to a caller with NO cookie.
 *   `apps/fiab-console` has no `middleware.ts` (verified), so this handler is
 *   the only enforcement point. The wrapper is unskippable (the handler is an
 *   ARGUMENT) and keeps `check-route-toolkit`'s ratchet satisfied, which a
 *   hand-rolled `getSession()` prologue would not.
 *
 * LAYER 1 — OWN THE ROUTE ITEM. `guardSynapseItemRequest` against the SQL
 *   warehouse item, WRITE-SCOPED (no `allowReadRoles`) because this starts
 *   billed compute. Same guard the sibling `[id]/ctas` runs. 404-not-403.
 *
 * LAYER 3 — NOT PRESENT, and named. `warehouseId` stays caller-named: no
 *   item→warehouse binding exists in this tree (`sql-warehouse-editor.tsx`
 *   picks it from a live `listWarehouses()` and never persists it), and a
 *   state-anchored one would not close it because
 *   `_lib/databricks-resource-binding.ts:12-27` records that `PATCH
 *   /api/cosmos-items/[type]/[id]` replaces `state` WHOLESALE from the request
 *   body — the caller would write the value the bound reads. It IS bounded by
 *   construction to this deployment's own Databricks workspace (`dbxFetch` →
 *   `LOOM_DATABRICKS_HOSTNAME`).
 *
 *   RESIDUAL: a caller who can write ANY `databricks-sql-warehouse` item can
 *   still start any warehouse in this deployment, and creating such an item is
 *   SELF-SERVICE (`createOwnedItem`, `_lib/item-crud.ts:423`). LAYER 1 IS A
 *   FLOOR, NOT A BOUND — it moves the reachable population from "any
 *   authenticated session" to "any authenticated session, plus one POST".
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import { getWarehouse, startWarehouse } from '@/lib/azure/databricks-client';

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
 * REACHABLE, checked rather than assumed: `app/items/[type]/[id]/page.tsx:164`
 * renders the editor unconditionally, so `/items/databricks-sql-warehouse/new`
 * mounts it with `id="new"`; `sql-warehouse-editor.tsx` has NO `isNew` anywhere
 * (measured: `grep -c isNew` = 0) and its `start` callback (:429) gates only on
 * `warehouseId`, which its mount effect fills from the live `listWarehouses()`
 * response. So Start is clickable on an unsaved item, and a bare 404 there is a
 * dead end (`auto-bind-by-default.md`) plus a day-one red state
 * (`ux-baseline.md`). 200 + `code:'unsaved_item'` keeps it an honest, guided
 * "not yet applicable" answer.
 *
 * Exact match only — real ids are `crypto.randomUUID()`
 * (`_lib/item-crud.ts:467`), so a substring test would let a real id skip the
 * ownership check.
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this SQL warehouse item first — starting a warehouse runs in the name of the saved ' +
      'item, and an unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

export const POST = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id: itemId } = params;
  if (itemId === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. WRITE-SCOPED — starting a warehouse starts billed compute.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
  });
  if (guard.res) return guard.res;

  const id = req.nextUrl.searchParams.get('warehouseId');
  if (!id) return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });

  try {
    const current = await getWarehouse(id);
    if (current.state === 'RUNNING') {
      return NextResponse.json({ ok: true, state: 'RUNNING', alreadyRunning: true });
    }
    if (current.state === 'STARTING') {
      return NextResponse.json({ ok: true, state: 'STARTING', alreadyStarting: true }, { status: 202 });
    }
    await startWarehouse(id);
    return NextResponse.json({ ok: true, state: 'STARTING' }, { status: 202 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
