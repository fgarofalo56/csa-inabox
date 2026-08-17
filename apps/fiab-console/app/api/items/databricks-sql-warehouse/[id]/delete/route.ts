/**
 * POST /api/items/databricks-sql-warehouse/[id]/delete
 *   body { warehouseId, force? }
 *   → { ok: true }  |  { ok: false, error, code? }
 *
 * Permanently deletes a SQL Warehouse, completing the lifecycle. Azure-native
 * DEFAULT — NO Fabric dependency:
 *
 *   - Commercial / GCC  → real Databricks REST DELETE /api/2.0/sql/warehouses/{id}
 *                         (databricks-client.deleteWarehouse). A RUNNING-state
 *                         guard returns 409 unless `force` is set — deleting a
 *                         live warehouse drops in-flight queries.
 *   - GCC-High / DoD    → real Synapse Dedicated SQL pool ARM DELETE
 *                         (synapse-dev-client.deleteDedicatedSqlPool). Dedicated
 *                         pools can be deleted regardless of Online/Paused state,
 *                         so no running-state guard is applied on that path.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS WAS THE HIGHEST-SEVERITY MEMBER OF THIS FAMILY, and it is worth stating
 * exactly rather than by category. `export async function POST(req: NextRequest)`
 * — **no `ctx` parameter at all**, so `[id]` was never read. `getSession()` was
 * the entire authorization. `warehouseId` came from the body OR the query
 * string, and reached:
 *
 *   Commercial/GCC → `deleteWarehouse(warehouseId)`        — irreversible
 *   GCC-High/DoD   → `deleteDedicatedSqlPool(warehouseId)` — irreversible,
 *                    and this one takes the DATA with it: an ARM delete of a
 *                    dedicated SQL pool destroys the database, not just compute.
 *
 * So any authenticated session, owning nothing, could permanently destroy any
 * SQL warehouse — or, in a sovereign boundary, any dedicated SQL pool and its
 * contents — in the deployment. The `force` flag only bypassed the RUNNING
 * pre-check; it was never an authorization control, and the Gov branch had no
 * pre-check at all.
 *
 * BOTH BOUNDARIES WERE AFFECTED. Recorded explicitly because this family's
 * other members are Databricks-only, so "Commercial-only finding" would be the
 * natural and WRONG assumption here (`cloud-parity.md`): the Gov branch is not
 * merely also-affected, it is the more destructive of the two.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 0 — AUTHENTICATION via the route-toolkit `withSession` wrapper, placed
 *   ABOVE the `id === 'new'` gate. That ordering is the defect an independent
 *   review MEASURED on #3655: `guardSynapseItemRequest` reads the session
 *   itself, so leaning on it for authentication puts the short-circuit above the
 *   session read and `…/new` answers 200 to a caller with NO cookie.
 *   `apps/fiab-console` has NO `middleware.ts` (verified), so this handler is
 *   the only enforcement point. `withSession` is unskippable (the handler is an
 *   ARGUMENT) and keeps `check-route-toolkit`'s ratchet satisfied, which a
 *   hand-rolled `getSession()` prologue would not.
 *
 * LAYER 1 — OWN THE ROUTE ITEM. `guardSynapseItemRequest` against the SQL
 *   warehouse item, WRITE-SCOPED (no `allowReadRoles`), ABOVE the cloud branch
 *   so BOTH boundaries are covered by one check rather than two that can drift.
 *   404-not-403.
 *
 * LAYER 3 — NOT PRESENT, and named rather than implied. `warehouseId` stays
 *   caller-named: no item→warehouse binding exists in this tree
 *   (`sql-warehouse-editor.tsx` picks it from a live `listWarehouses()` and
 *   never persists it), and a state-anchored binding cannot close it because
 *   `_lib/databricks-resource-binding.ts:12-27` records that `PATCH
 *   /api/cosmos-items/[type]/[id]` replaces `state` WHOLESALE from the request
 *   body — the caller would write the value the bound reads. It IS bounded by
 *   construction to this deployment's own estate (`dbxFetch` →
 *   `LOOM_DATABRICKS_HOSTNAME`; the ARM path composed against
 *   `LOOM_SUBSCRIPTION_ID` / `LOOM_SYNAPSE_WORKSPACE`).
 *
 *   RESIDUAL, AND IT IS THE SHARPEST ONE IN THIS PR because the effect is
 *   IRREVERSIBLE: a caller who can write ANY `databricks-sql-warehouse` item can
 *   still delete any warehouse (or Gov pool) in this deployment. LAYER 1 IS A
 *   FLOOR, NOT A BOUND, and the floor is SELF-SERVICE — `createOwnedItem`
 *   (`_lib/item-crud.ts:423`) lets any session holder create a qualifying item
 *   in a workspace they own, so this moves the reachable population from "any
 *   authenticated session" to "any authenticated session, plus one POST".
 *   Closing it needs a server-attested marker on the warehouse (the
 *   `loom_item_id` tag that module already applies to Jobs and DLT pipelines)
 *   plus a brownfield adoption path — design work with a migration, deliberately
 *   NOT improvised inside a security fix.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import { deleteWarehouse, getWarehouse, databricksConfigGate } from '@/lib/azure/databricks-client';
import { deleteDedicatedSqlPool } from '@/lib/azure/synapse-dev-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';

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
 * REACHABLE, checked at the call site rather than assumed:
 * `app/items/[type]/[id]/page.tsx:164` renders the editor unconditionally, so
 * `/items/databricks-sql-warehouse/new` mounts it with `id="new"`;
 * `sql-warehouse-editor.tsx` has NO `isNew` anywhere (measured: `grep -c isNew`
 * = 0), and `confirmDelete` (:558) gates only on `warehouseId`, which the mount
 * effect fills from the live `listWarehouses()` response. So Delete is
 * reachable on an unsaved item, and `confirmDelete` renders `j.error` verbatim
 * as the delete dialog's error text — a bare 404 there would paint "not found"
 * on a freshly created item, a dead end (`auto-bind-by-default.md`) and a
 * day-one red state (`ux-baseline.md`). The message below is the actionable
 * next step instead.
 *
 * Exact match only — real ids are `crypto.randomUUID()`
 * (`_lib/item-crud.ts:467`), so a substring or prefix test would let a real id
 * skip the ownership check on an IRREVERSIBLE operation.
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this SQL warehouse item first — deleting a warehouse runs in the name of the saved ' +
      'item, and an unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

export const POST = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id: itemId } = params;
  if (itemId === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. WRITE-SCOPED, and ABOVE the cloud branch so Commercial and Gov are
  // covered by ONE check. A permanent delete must never admit a shared read role.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
  });
  if (guard.res) return guard.res;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const warehouseId =
    (typeof body?.warehouseId === 'string' && body.warehouseId) ||
    req.nextUrl.searchParams.get('warehouseId') ||
    '';
  if (!warehouseId) return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });
  const force = body?.force === true;

  // --- Gov boundary: delete the Synapse Dedicated SQL pool by name ---------
  if (isGovCloud()) {
    if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', error: 'Synapse workspace not configured. Set LOOM_SYNAPSE_WORKSPACE.' },
        { status: 503 },
      );
    }
    try {
      await deleteDedicatedSqlPool(warehouseId);
      return NextResponse.json({ ok: true });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // --- Commercial / GCC: Databricks SQL Warehouse --------------------------
  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Databricks not configured. Set ${gate.missing}.` },
      { status: 503 },
    );
  }

  // Running-state guard — a RUNNING warehouse has live compute and possibly
  // in-flight queries. Require an explicit force to delete it. NOTE this is a
  // SAFETY interlock, never an authorization control: it is bypassable by the
  // caller (`force`) by design, which is precisely why Layer 1 above it is the
  // thing doing the authorizing.
  if (!force) {
    try {
      const wh = await getWarehouse(warehouseId);
      if (wh.state === 'RUNNING' || wh.state === 'STARTING') {
        return NextResponse.json(
          {
            ok: false,
            code: 'warehouse_running',
            error: `Warehouse is ${wh.state}. Stop it first, or confirm a forced delete.`,
          },
          { status: 409 },
        );
      }
    } catch (e: any) {
      // If the state read itself fails, surface it rather than silently deleting.
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  try {
    await deleteWarehouse(warehouseId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
