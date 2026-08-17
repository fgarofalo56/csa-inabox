/**
 * POST /api/items/databricks-sql-warehouse/[id]/iqy
 *   body: { sql, warehouseId, catalog?, schema? }
 *
 * Generates an Excel web-query (.iqy) file pointed at the Loom Databricks
 * query route. The .iqy carries the SQL + warehouseId (and optional
 * catalog/schema) so Excel re-executes the same statement on refresh via
 * the BFF, which calls the Databricks Statement Execution API using the
 * Container App MI. Azure-native — no Fabric / Power BI dependency.
 *
 * The .iqy WEB format is 4 lines:
 *   WEB
 *   1
 *   <URL the query is POSTed to>
 *   <JSON POST body>
 * Modern Excel honours POST data when line 4 carries the JSON body.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This route DID take a `ctx` and DID read `[id]` — the one member of the
 * unguarded remainder that does — but only to INTERPOLATE it into the callback
 * URL and the filename. `getSession()` was the entire authorization; nothing
 * ever checked that the caller could reach that item.
 *
 * RATED HONESTLY, because overstating it would be the mirror of the defect this
 * advisory is about. This handler makes NO data-plane call: it formats a string
 * out of values the caller already supplied, so it discloses nothing the caller
 * did not already have. What it produces is a DURABLE CREDENTIAL-SHAPED
 * ARTEFACT — a file that re-POSTs `{sql, warehouseId}` to `[id]/query` on every
 * Excel refresh, carrying the caller's cookie. Left unguarded it would mint
 * those against any `[id]`, including one the caller cannot reach, and each
 * refresh would then be refused by the now-guarded `[id]/query` — a file that
 * silently stops working. Guarding here keeps the artefact and its target
 * consistent.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 0 — AUTHENTICATION via `withSession`, ABOVE the `id === 'new'` gate
 *   (ordering defect MEASURED on #3655).
 *
 * LAYER 1 — OWN THE ROUTE ITEM, READ-SCOPED (`allowReadRoles: true`). Read is
 *   the correct scope on this route's own evidence, not by analogy: the handler
 *   reaches no backend at all, and the artefact it emits targets `[id]/query`,
 *   which enforces its own WRITE scope when Excel actually refreshes. A shared
 *   Viewer exporting a SELECT to Excel is the normal case.
 *
 * LAYER 3 — NOT PRESENT, and named: `warehouseId` and `sql` stay
 *   caller-supplied. FLOOR, NOT BOUND — see #3669.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'databricks-sql-warehouse';

/** 404 body naming BOTH causes and asserting neither (`deploy-integrity.md` R7). */
const ITEM_UNREACHABLE =
  'This SQL warehouse item is not available to you. Either it does not exist, or you have no ' +
  'role in its workspace. Ask a workspace owner to share it with you.';

/**
 * The unsaved-item honest gate — and THE ONE PLACE IN THIS PASS WHERE THE
 * STATUS CODE DIFFERS FROM ITS SIBLINGS. That is deliberate, and it is a
 * decision about THIS caller rather than a copy of the pattern.
 *
 * Every other gated route in this family returns 200 because its caller reads
 * the JSON body and branches on `ok`. `openInExcel`
 * (`sql-warehouse-editor.tsx:649`) does NOT: it branches on
 * `if (!r.ok)` — the HTTP status — and on the success path calls
 * `await r.blob()` and triggers a download. A 200 JSON gate would therefore be
 * SAVED TO DISK AS `loom-databricks-new.iqy`, a corrupt file that fails silently
 * in Excel later. 409 makes `r.ok` false, so the caller reads `j.error` and
 * surfaces it through `setResult` in the results pane — the actionable sentence,
 * visible immediately.
 *
 * Reachable at all because `openInExcel` gates only on `warehouseId && sqlText`,
 * both of which exist on an unsaved item (that file has NO `isNew` — measured,
 * `grep -c` = 0).
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this SQL warehouse item first — the Excel query refreshes in the name of the saved ' +
      'item, and an unsaved item has no owner to check that against yet.',
  }, { status: 409 });
}

export const POST = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id } = params;
  if (id === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. READ-SCOPED — no backend call is made here, and the artefact this
  // emits targets `[id]/query`, which enforces its own write scope on refresh.
  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;

  const body = await req.json().catch(() => ({}));
  const sql = (body?.sql || '').toString().trim();
  const warehouseId = (body?.warehouseId || '').toString().trim();
  if (!sql) return NextResponse.json({ ok: false, error: 'sql is required' }, { status: 400 });
  if (!warehouseId) return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });

  const catalog = body?.catalog ? String(body.catalog) : undefined;
  const schema = body?.schema ? String(body.schema) : undefined;

  // Excel calls back into the same Databricks query route the editor uses.
  const origin = req.nextUrl.origin;
  const target = `${origin}/api/items/databricks-sql-warehouse/${encodeURIComponent(id)}/query`;
  const postBody = JSON.stringify({ sql, warehouseId, ...(catalog && { catalog }), ...(schema && { schema }) });

  const iqy = [
    'WEB',
    '1',
    target,
    postBody,
    '',
    'Selection=AllTables',
    'Formatting=All',
    'PreFormattedTextToColumns=True',
    'ConsecutiveDelimitersAsOne=True',
    'SingleBlockTextImport=False',
    'DisableDateRecognition=False',
    'DisableRedirections=False',
  ].join('\r\n');

  return new NextResponse(iqy, {
    status: 200,
    headers: {
      'content-type': 'text/x-ms-iqy; charset=utf-8',
      'content-disposition': `attachment; filename="loom-databricks-${id}.iqy"`,
      'cache-control': 'no-store',
    },
  });
});
