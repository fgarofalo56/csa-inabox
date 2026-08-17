/**
 * GET  /api/items/databricks-sql-warehouse/[id]/state?warehouseId=
 *      → { ok, state, name, cluster_size }
 * POST /api/items/databricks-sql-warehouse/[id]/state?warehouseId=
 *      body { action: 'stop' }
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GET(req: NextRequest)` and `POST(req: NextRequest)` — NEITHER took a `ctx`,
 * so `[id]` sat in the URL and was read nowhere. `getSession()` was the entire
 * authorization on both verbs, and the warehouse acted on came from
 * `req.nextUrl.searchParams.get('warehouseId')` verbatim.
 *
 * THIS IS THE MEMBER THE FAMILY WAS FIRST NOTICED THROUGH, and describing the
 * family through its GET is what made the population read as disclosure-only.
 * Stated precisely so that mistake is not repeated: the GET is read-shaped, but
 * the POST in the same file reaches `stopWarehouse(id)` — it STOPS a
 * caller-named warehouse, killing its live compute and any in-flight query on
 * it. That is a denial-of-service against another tenant's running warehouse,
 * available to any authenticated session, and it is a mutation, not a read.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 0 — AUTHENTICATION, as the route-toolkit `withSession` wrapper rather
 *   than a line inside the handler. The placement is deliberate and is the
 *   defect an independent review MEASURED on #3655: `guardSynapseItemRequest`
 *   reads the session itself, so leaning on it for authentication too puts the
 *   `id === 'new'` gate ABOVE the session read, and `…/new` then answers **200
 *   to a caller with no cookie** where it previously returned 401.
 *   `apps/fiab-console` has NO `middleware.ts` (verified), so the route handler
 *   is the ONLY enforcement point. `withSession` makes the check unskippable
 *   (the handler is an ARGUMENT), returns the `apiUnauthorized()` envelope —
 *   `{ ok:false, error:'unauthenticated' }`, a superset of the `{ error }` this
 *   file used to return — and keeps `check-route-toolkit`'s ratchet satisfied,
 *   which a hand-rolled `getSession()` prologue would not.
 *
 * LAYER 1 — OWN THE ROUTE ITEM. `guardSynapseItemRequest`, the same
 *   backend-agnostic Layer-1 guard the sibling `[id]/ctas` already runs.
 *   READ-SCOPED on the GET (`allowReadRoles: true`) because that handler
 *   genuinely only reads; WRITE-SCOPED on the POST, because `stopWarehouse` is
 *   a mutation and a shared read role must not reach it. 404-not-403.
 *
 * LAYER 3 — NOT PRESENT, and named rather than implied. `warehouseId` stays
 *   caller-named because NO item→warehouse binding exists in this tree:
 *   `sql-warehouse-editor.tsx` picks it from a LIVE `listWarehouses()` response
 *   and never persists it to item state. It is bounded by construction to this
 *   deployment's own Databricks workspace (`dbxFetch` →
 *   `LOOM_DATABRICKS_HOSTNAME`) and is URL-encoded into the path, never
 *   interpolated.
 *
 *   RESIDUAL, RECORDED SO THE FIX IS NOT OVERSOLD: an authenticated caller who
 *   can write a `databricks-sql-warehouse` item can still read the state of —
 *   and STOP — any warehouse in this deployment. LAYER 1 IS A FLOOR HERE, NOT A
 *   BOUND, **and the floor is SELF-SERVICE**: `createOwnedItem`
 *   (`_lib/item-crud.ts:423`) lets any session holder create a qualifying item
 *   in a workspace they own, so the reachable attacker population moves from
 *   "any authenticated session" to "any authenticated session, plus one POST".
 *
 *   A STATE-ANCHORED BINDING WOULD NOT CLOSE IT EITHER, and the repo already
 *   knows why: `_lib/databricks-resource-binding.ts:12-27` records that `PATCH
 *   /api/cosmos-items/[type]/[id]` replaces `state` WHOLESALE from the request
 *   body, so a binding read from item state is writable by the very caller it
 *   is meant to bound. Closing this class needs a server-attested marker on the
 *   warehouse (the `loom_item_id` tag that module already applies to Jobs and
 *   DLT pipelines) plus a brownfield adoption path — design work with a
 *   migration, deliberately NOT improvised inside a security fix.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import { getWarehouse, stopWarehouse } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'databricks-sql-warehouse';

/**
 * The 404 body for an item the caller cannot reach — naming BOTH causes and
 * asserting NEITHER (`deploy-integrity.md` R7). `loadOwnedItem` returns null for
 * "absent" and for "no write role" alike, and the route cannot tell them apart
 * without a second read, which is exactly the cross-tenant existence probe
 * 404-not-403 exists to prevent. So the status stays 404 and the message states
 * the disjunction rather than picking a side.
 */
const ITEM_UNREACHABLE =
  'This SQL warehouse item is not available to you. Either it does not exist, or you have no ' +
  'role in its workspace. Ask a workspace owner to share it with you.';

/**
 * The unsaved-item honest gate, returned INSTEAD of Layer 1's 404 and AFTER
 * authentication but BEFORE the ownership guard.
 *
 * REACHABLE — checked at the call sites, not assumed. `app/items/[type]/[id]/
 * page.tsx:164` renders `<Editor item={item} id={id} …>` UNCONDITIONALLY, so
 * `/items/databricks-sql-warehouse/new` mounts the editor with `id="new"`
 * (`lib/editors/__tests__/databricks-sql-warehouse.test.tsx:23` renders exactly
 * that). `sql-warehouse-editor.tsx` contains NO `isNew` anywhere — measured,
 * `grep -c isNew` = 0 — and its mount effect populates `warehouseId` from the
 * live `listWarehouses()` response, so `refreshState` (:267) and `stop` (:439)
 * both fire on an unsaved item. `guardSynapseItemRequest` FAILS CLOSED on an id
 * naming no item — correctly — so without this gate a freshly created item
 * would 404 on first open. That is a dead end (`auto-bind-by-default.md`) and a
 * day-one error state (`ux-baseline.md`, "new-item first-open is clean").
 *
 * 200, NOT 4xx, and deliberately: this is the "not yet applicable" state of a
 * lifecycle surface, not a refusal of a hostile request, and the editor's own
 * branches key off the body rather than the status (`refreshState` assigns the
 * whole payload and reads `warehouseState?.state || 'UNKNOWN'`, so a gate body
 * renders as UNKNOWN — not as a red banner).
 *
 * Match `UNSAVED_ITEM_ID` EXACTLY. Real ids are `crypto.randomUUID()`
 * (`_lib/item-crud.ts:467`), so special-casing the literal `new` downgrades
 * nothing; a substring or prefix test would let a real id skip the guard.
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this SQL warehouse item first — its warehouse state is read and changed in the name ' +
      'of the saved item, and an unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

function requireWarehouseId(req: NextRequest): string | null {
  return req.nextUrl.searchParams.get('warehouseId');
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id: itemId } = params;
  if (itemId === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. Read-scoped: this handler only reads warehouse metadata, so shared
  // read roles are admitted — the same scope the sibling `[type]/[id]/
  // statistics` GET carries.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;

  const id = requireWarehouseId(req);
  if (!id) return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });
  try {
    const w = await getWarehouse(id);
    return NextResponse.json({
      ok: true,
      state: w.state,
      name: w.name,
      cluster_size: w.cluster_size,
      warehouse_type: w.warehouse_type,
      serverless: w.enable_serverless_compute,
      min_num_clusters: w.min_num_clusters,
      max_num_clusters: w.max_num_clusters,
      auto_stop_mins: w.auto_stop_mins,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});

export const POST = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id: itemId } = params;
  if (itemId === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. WRITE-SCOPED — no `allowReadRoles`. `stopWarehouse` kills live
  // compute and any in-flight query; a shared read role must not reach it.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
  });
  if (guard.res) return guard.res;

  const id = requireWarehouseId(req);
  if (!id) return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  if (body?.action !== 'stop') {
    return NextResponse.json({ ok: false, error: 'unsupported action' }, { status: 400 });
  }
  try {
    await stopWarehouse(id);
    return NextResponse.json({ ok: true, state: 'STOPPING' });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
