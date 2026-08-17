/**
 * GET /api/items/databricks-sql-warehouse/[id]/connection?warehouseId=
 *
 * Connection details (server hostname, HTTP path, JDBC URL, CLI snippet) read
 * from the real Databricks warehouse `odbc_params`. Delegates to the shared
 * connection-handler. `warehouseId` query param pins a specific warehouse;
 * otherwise LOOM_DATABRICKS_SQL_WAREHOUSE_ID is used.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GET(req: NextRequest)` took NO `ctx`, so `[id]` was never read. `getSession()`
 * was the entire authorization and `?warehouseId=` was passed straight to
 * `handleConnectionDetails`, which reads that warehouse's real `odbc_params`.
 *
 * Read-only, and rated as such — but it is the RECONNAISSANCE member of this
 * family: it returns another tenant's warehouse hostname, HTTP path and a
 * ready-made JDBC URL, i.e. the exact coordinates for reaching that warehouse
 * from outside Loom. It also confirms a caller-guessed `warehouseId` exists,
 * which is the cross-tenant existence probe 404-not-403 exists to prevent.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 0 — AUTHENTICATION via `withSession`, ABOVE the `id === 'new'` gate
 *   (ordering defect MEASURED on #3655; no `middleware.ts` here, verified).
 *
 * LAYER 1 — OWN THE ROUTE ITEM, READ-SCOPED (`allowReadRoles: true`) — the
 *   handler only reads connection metadata, and a shared Viewer legitimately
 *   needs it to connect a client.
 *
 * LAYER 3 — NOT PRESENT, and named: `warehouseId` stays caller-supplied.
 *   FLOOR, NOT BOUND — see #3669.
 *
 * ITEM-TYPE AXIS, WALKED RATHER THAN ASSUMED (the axis that shipped a dead end
 * in #3664). The only in-product caller is `ConnectionDetailsPanel`
 * (`lib/editors/components/connection-details.tsx:140`), which builds
 * `/api/items/${engine}/${id}/connection` from an `engine` PROP — so a wrong
 * pairing here would 404 a working dialog. All four mount sites were checked:
 * `sql-warehouse-editor.tsx:1533` is the ONLY one passing
 * `engine="databricks-sql-warehouse"`, and it passes its own route `id`. The
 * other three (`sql-analytics-endpoint-editor.tsx:597`,
 * `synapse-serverless-sql-editor.tsx:542`, `synapse-sql-editors.tsx:1233`) pass
 * Synapse engines with their own ids and never reach this file. So a single
 * `ITEM_TYPE` is correct here — unlike `adx/anomaly`, which is legitimately
 * called with a `kql-dashboard` id.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import { handleConnectionDetails } from '@/app/api/items/_lib/connection-handler';

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
 * REACHABLE: the panel is rendered inside the Connection dialog
 * (`sql-warehouse-editor.tsx:1533`), which is openable on an unsaved item — that
 * file has NO `isNew` anywhere (measured, `grep -c` = 0). 200 +
 * `code:'unsaved_item'`, checked against the caller: `ConnectionDetailsPanel`
 * reads `j.ok` and branches on `j.code`, rendering an unrecognised code as a
 * MessageBar carrying `j.error`. So the actionable sentence is what appears,
 * not a bare "not found".
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this SQL warehouse item first — connection details are read in the name of the saved ' +
      'item, and an unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id: itemId } = params;
  if (itemId === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. READ-SCOPED — connection metadata only; a shared Viewer needs it.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;

  const warehouseId = req.nextUrl.searchParams.get('warehouseId') ?? undefined;
  return handleConnectionDetails('databricks-sql-warehouse', warehouseId);
});
