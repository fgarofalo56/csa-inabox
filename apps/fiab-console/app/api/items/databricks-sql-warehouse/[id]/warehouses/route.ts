/**
 * GET /api/items/databricks-sql-warehouse/[id]/warehouses
 * Lists the SQL Warehouses available as the Azure-native warehouse backend.
 *
 *   - Commercial / GCC  → Databricks SQL Warehouses (listWarehouses).
 *   - GCC-High / DoD     → Synapse Dedicated SQL pools (listDedicatedSqlPools),
 *                          mapped into the same { id, name, state, cluster_size }
 *                          shape the W1 list consumes. Databricks SQL Warehouses
 *                          are not a Gov-boundary offering, so the dedicated pool
 *                          is the parity backend there (no Fabric dependency).
 *
 * `gov` tells the editor which Create dialog to render (Databricks advanced
 * options vs. Synapse DWU SKU picker).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THIS ONE IS DIFFERENT. READ THE `new` CARVE-OUT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `export async function GET()` — no `req`, no `ctx`, so `[id]` was never read
 * and could not have been. `getSession()` was the entire authorization. It is a
 * DISCOVERY LIST: it enumerates every SQL warehouse (or Gov dedicated pool) in
 * the deployment, with id, name, state and size. That is the reconnaissance
 * input for every other route in this family — it is where an attacker gets the
 * `warehouseId` values the siblings accept.
 *
 * ── THE CARVE-OUT, STATED PLAINLY SO IT IS NOT MISTAKEN FOR CLOSURE ─────────
 *
 * On a REAL id this route now requires the caller to reach the item, read-scoped.
 *
 * On `id === 'new'` IT REMAINS SESSION-ONLY, deliberately, and that is a
 * behaviour this change does NOT improve. The editor's mount effect
 * (`sql-warehouse-editor.tsx:245`) calls this route FIRST and unconditionally,
 * before anything else, and fills `warehouseId` from the response; every other
 * control in the editor gates on `warehouseId`. That file has NO `isNew`
 * anywhere (measured, `grep -c isNew` = 0), so on `/items/databricks-sql-warehouse/new`
 * this fires with `id="new"`. Returning a gate body there sets
 * `warehousesError` (`:250`) — a red banner on the first open of a freshly
 * created item, forbidden by `ux-baseline.md` — and leaves the editor with no
 * warehouse, i.e. every subsequent control dead. That is the exact dead end
 * `auto-bind-by-default.md` forbids, and it is why the honest-gate pattern the
 * siblings use is WRONG here: those routes act on a resource, this one is how
 * the user finds the resource in the first place.
 *
 * WHAT THE CARVE-OUT COSTS, measured rather than hand-waved: an authenticated
 * caller can still enumerate the deployment's warehouses by asking for
 * `.../new/warehouses`. That is EXACTLY the pre-existing exposure, unchanged —
 * this change strictly narrows the real-id path and narrows nothing else. It
 * costs nothing extra against the calibrated attacker either: `createOwnedItem`
 * (`_lib/item-crud.ts:423`) is self-service, so a caller who wanted the list
 * from an owned id is one POST away regardless. Closing it properly needs the
 * item→warehouse binding tracked in #3669, after which this route would return
 * the item's OWN warehouse rather than the deployment's list, and the `new`
 * path would return the empty set without being a dead end.
 *
 * LAYER 0 — AUTHENTICATION is via `withSession` and applies to BOTH paths,
 *   including `new`. That is the load-bearing half of the ordering rule
 *   MEASURED on #3655: the carve-out sits INSIDE the wrapper, so an
 *   unauthenticated request to `.../new/warehouses` still gets 401, not 200.
 *   Asserted in `__tests__/ghsa-v2g8-warehouse-reads.test.ts`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import { listWarehouses } from '@/lib/azure/databricks-client';
import { listDedicatedSqlPools } from '@/lib/azure/synapse-dev-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'databricks-sql-warehouse';

/** 404 body naming BOTH causes and asserting neither (`deploy-integrity.md` R7). */
const ITEM_UNREACHABLE =
  'This SQL warehouse item is not available to you. Either it does not exist, or you have no ' +
  'role in its workspace. Ask a workspace owner to share it with you.';

/** The list itself — identical on both paths, so the carve-out changes WHO may
 *  call it and nothing about what it returns. */
async function listForCloud(): Promise<NextResponse> {
  if (isGovCloud()) {
    try {
      const pools = await listDedicatedSqlPools();
      // Dedicated pools are addressed by name — name IS the warehouse id. Map the
      // ARM status ('Online'|'Paused'|'Scaling'…) onto the W1 state vocabulary.
      const warehouses = pools.map((p) => ({
        id: p.name,
        name: p.name,
        state: p.status === 'Online' ? 'RUNNING' : p.status === 'Paused' ? 'STOPPED' : (p.status || 'UNKNOWN'),
        cluster_size: p.sku?.name,
      }));
      return NextResponse.json({ ok: true, warehouses, gov: true });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e), gov: true }, { status: 502 });
    }
  }

  try {
    const warehouses = await listWarehouses();
    return NextResponse.json({ ok: true, warehouses, gov: false });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), gov: false }, { status: 502 });
  }
}

export const GET = withSession<{ id: string }>(async (_req: NextRequest, { params }) => {
  const { id: itemId } = params;

  // THE CARVE-OUT. Authentication has already run (it is the wrapper). See the
  // header: gating the editor's first, unconditional call would be a day-one
  // dead end, and the pre-existing exposure is unchanged rather than widened.
  if (itemId === UNSAVED_ITEM_ID) return listForCloud();

  // LAYER 1. READ-SCOPED — enumeration only; a shared Viewer needs the picker.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;

  return listForCloud();
});
