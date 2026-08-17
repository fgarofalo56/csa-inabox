/**
 * POST /api/items/databricks-sql-warehouse/[id]/edit?warehouseId=
 *   body { cluster_size?, min_num_clusters?, max_num_clusters?,
 *          auto_stop_mins?, warehouse_type?, enable_serverless_compute? }
 *   → { ok }
 *
 * Edits / scales an existing SQL Warehouse via the real Databricks REST API
 * (POST /api/2.0/sql/warehouses/{id}/edit). Databricks requires the warehouse
 * to already exist (no upsert) and validates cluster_size against the allowed
 * enum — those errors are surfaced verbatim rather than faked.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `POST(req: NextRequest)` took NO `ctx`, so `[id]` was never read. Behind
 * `getSession()` alone, `?warehouseId=` went verbatim into
 * `editWarehouse(id, spec)` as the Console identity.
 *
 * THIS IS THE MOST CONSEQUENTIAL MUTATION IN THE THREE ROUTES FIXED HERE, and
 * naming the effects matters more than the verb: the spec this route forwards
 * reconfigures another tenant's warehouse in place — `cluster_size` and
 * `min/max_num_clusters` change what it COSTS (a caller could scale a victim's
 * warehouse up and leave it there), `auto_stop_mins` changes how long it idles
 * while billing, and `warehouse_type` / `enable_serverless_compute` change the
 * compute model underneath running workloads. Databricks applies an edit by
 * RESTARTING the warehouse, so a hostile edit is also an availability event for
 * every in-flight query on it.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 0 — AUTHENTICATION via the route-toolkit `withSession` wrapper, placed
 *   ABOVE the `id === 'new'` gate. That ordering is the exact defect an
 *   independent review MEASURED on #3655: `guardSynapseItemRequest` reads the
 *   session itself, so leaning on it for authentication puts the unsaved-item
 *   short-circuit above the session read, and `…/new` then answers 200 to a
 *   caller with NO cookie where it previously returned 401.
 *   `apps/fiab-console` has NO `middleware.ts` (verified), so this handler is
 *   the only enforcement point. `withSession` is unskippable (the handler is an
 *   ARGUMENT), returns the `apiUnauthorized()` envelope, and keeps
 *   `check-route-toolkit`'s ratchet satisfied — a hand-rolled `getSession()`
 *   prologue would put this file straight back into that control.
 *
 * LAYER 1 — OWN THE ROUTE ITEM. `guardSynapseItemRequest` against the SQL
 *   warehouse item, WRITE-SCOPED (no `allowReadRoles`) — the same guard the
 *   sibling `[id]/ctas` runs. 404-not-403.
 *
 * LAYER 3 — NOT PRESENT, and named rather than implied. `warehouseId` stays
 *   caller-named because NO item→warehouse binding exists in this tree, and a
 *   state-anchored one would not close it:
 *   `_lib/databricks-resource-binding.ts:12-27` records that `PATCH
 *   /api/cosmos-items/[type]/[id]` replaces `state` WHOLESALE from the request
 *   body, so the caller would write the value the bound reads. It IS bounded by
 *   construction to this deployment's own Databricks workspace (`dbxFetch` →
 *   `LOOM_DATABRICKS_HOSTNAME`) and is URL-encoded into the path, never
 *   interpolated.
 *
 *   RESIDUAL, RECORDED SO THIS IS NOT READ AS CLOSURE: a caller who can write
 *   ANY `databricks-sql-warehouse` item can still reconfigure any warehouse in
 *   this deployment. LAYER 1 IS A FLOOR, NOT A BOUND — and the floor is
 *   SELF-SERVICE, because `createOwnedItem` (`_lib/item-crud.ts:423`) lets any
 *   session holder create a qualifying item in a workspace they own. The
 *   reachable population moves from "any authenticated session" to "any
 *   authenticated session, plus one POST".
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import { editWarehouse, type WarehouseScaleSpec } from '@/lib/azure/databricks-client';

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
 * REACHABLE, and this is the call site where the WORDING carries weight.
 * `app/items/[type]/[id]/page.tsx:164` renders the editor unconditionally, so
 * `/items/databricks-sql-warehouse/new` mounts it with `id="new"`;
 * `sql-warehouse-editor.tsx` has NO `isNew` anywhere (measured: `grep -c isNew`
 * = 0), and `saveEdit` (:473) gates only on `warehouseId`, which the mount
 * effect fills from the live `listWarehouses()` response — so the Edit dialog
 * is reachable and submittable on an unsaved item.
 *
 * Unlike the sibling `state`/`start` callbacks, which discard the response,
 * `saveEdit` renders `j.error` as the dialog's error text
 * (`setEditError(j.error || …)`). A bare 404 would therefore paint "not found"
 * on a freshly created item — a dead end (`auto-bind-by-default.md`) and a
 * day-one red state (`ux-baseline.md`). The message below is written to be the
 * ACTIONABLE next step in that dialog rather than a refusal.
 *
 * Disclosed deliberately: the stronger fix is for the editor to disable the
 * Edit action on an unsaved item (the shape #3655 applied to
 * `warehouse-alerts.tsx`). `lib/editors/databricks/sql-warehouse-editor.tsx` is
 * OUTSIDE this change's file ownership, so it is named as follow-up rather than
 * edited here.
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
      'Save this SQL warehouse item first, then edit the warehouse — scaling runs in the name of ' +
      'the saved item, and an unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

export const POST = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id: itemId } = params;
  if (itemId === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. WRITE-SCOPED — an edit rewrites size/scaling/type and restarts the
  // warehouse. A shared read role must not reach it.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
  });
  if (guard.res) return guard.res;

  const id = req.nextUrl.searchParams.get('warehouseId');
  if (!id) return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const spec: WarehouseScaleSpec = {};
  if (typeof body?.cluster_size === 'string') spec.cluster_size = body.cluster_size;
  if (typeof body?.min_num_clusters === 'number') spec.min_num_clusters = body.min_num_clusters;
  if (typeof body?.max_num_clusters === 'number') spec.max_num_clusters = body.max_num_clusters;
  if (typeof body?.auto_stop_mins === 'number') spec.auto_stop_mins = body.auto_stop_mins;
  if (body?.warehouse_type === 'CLASSIC' || body?.warehouse_type === 'PRO') {
    spec.warehouse_type = body.warehouse_type;
  }
  if (typeof body?.enable_serverless_compute === 'boolean') {
    spec.enable_serverless_compute = body.enable_serverless_compute;
  }

  try {
    await editWarehouse(id, spec);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
