/**
 * GET /api/items/databricks-sql-warehouse/[id]/script-out
 *   ?warehouseId=<w>&catalog=<c>&schema=<s>&name=<n>
 *   &type=view|function|table&mode=create|drop
 *
 * Returns a runnable Databricks SQL script for the object:
 *   - create → real DDL via SHOW CREATE TABLE (views/tables) or
 *              SHOW CREATE FUNCTION (Unity Catalog UDFs)
 *   - drop   → DROP VIEW|FUNCTION|TABLE IF EXISTS `c`.`s`.`n`;
 *
 * Identifiers come from the Explorer's SHOW enumeration; each is
 * backtick-escaped before it is interpolated. Returns 409 when the warehouse
 * is not RUNNING (no compute to read DDL from).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GET(req: NextRequest)` took NO `ctx`, so `[id]` was never read. `getSession()`
 * was the entire authorization, and `warehouseId`, `catalog`, `schema` and
 * `name` all came off the query string into
 *
 *     SHOW CREATE TABLE `caller catalog`.`caller schema`.`caller name`
 *
 * run on the shared Databricks workspace as the Console identity. `SHOW CREATE`
 * returns the FULL DEFINITION of the object — a view's entire SELECT body,
 * a UDF's source, a table's DDL including location and properties. So this is a
 * SOURCE-DISCLOSURE primitive over any Unity Catalog object the Console identity
 * can name, and it pairs with `[id]/schema`, which supplies the names.
 *
 * NOTE the header note above ("identifiers come from the Explorer's SHOW
 * enumeration") describes the UI's habit, not a control. Nothing in the handler
 * required that, which is exactly the gap.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 0 — AUTHENTICATION via the route-toolkit `withSession` wrapper, ABOVE
 *   the `id === 'new'` gate (the ordering defect MEASURED on #3655; no
 *   `middleware.ts` exists in `apps/fiab-console`, verified).
 *
 * LAYER 1 — OWN THE ROUTE ITEM, READ-SCOPED (`allowReadRoles: true`), and the
 *   scope is asserted rather than assumed. Both branches are reads: `drop`
 *   FORMATS a `DROP … IF EXISTS` string and returns it WITHOUT EXECUTING IT —
 *   the caller pastes it into the editor and runs it through `[id]/query`,
 *   which is write-scoped — and `create` executes only `SHOW CREATE
 *   TABLE|FUNCTION`. Nothing here mutates. Recorded because "it emits DROP" is
 *   the natural and wrong reason to make this write-scoped.
 *
 * LAYER 3 — NOT PRESENT, and named: `warehouseId` and the three-part object
 *   name stay caller-supplied. FLOOR, NOT BOUND — see #3669.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import { executeStatement, getWarehouse } from '@/lib/azure/databricks-client';

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
 * REACHABLE: `dbxLoadScript` (`sql-warehouse-editor.tsx:386`) is a tree
 * context-menu action gated only on `warehouseId`, which the mount effect fills
 * on an unsaved item (that file has NO `isNew` — measured, `grep -c` = 0).
 * 200 + `code:'unsaved_item'`, checked against the caller: `dbxLoadScript`
 * branches on `j.ok && typeof j.script === 'string'` and otherwise renders
 * `j.error` in the result pane, so the gate surfaces as the actionable sentence
 * rather than a red dead end (`auto-bind-by-default.md`, `ux-baseline.md`).
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this SQL warehouse item first — scripting an object runs in the name of the saved ' +
      'item, and an unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

type DbxObjectType = 'view' | 'function' | 'table';

function backtick(id: string): string {
  return `\`${id.replace(/`/g, '``')}\``;
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id: itemId } = params;
  if (itemId === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. READ-SCOPED — `create` runs SHOW CREATE (introspection) and `drop`
  // only FORMATS a DROP string without executing it. Nothing here mutates.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;

  const sp = req.nextUrl.searchParams;
  const warehouseId = sp.get('warehouseId');
  const catalog = sp.get('catalog');
  const schema = sp.get('schema');
  const name = sp.get('name');
  const typeRaw = sp.get('type');
  const mode = sp.get('mode');

  if (!warehouseId) return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });
  if (!catalog || !schema || !name) {
    return NextResponse.json({ ok: false, error: 'catalog, schema and name are required' }, { status: 400 });
  }
  const type: DbxObjectType = typeRaw === 'function' ? 'function' : typeRaw === 'table' ? 'table' : 'view';
  if (mode !== 'create' && mode !== 'drop') {
    return NextResponse.json({ ok: false, error: 'mode must be create|drop' }, { status: 400 });
  }

  const fqn = `${backtick(catalog)}.${backtick(schema)}.${backtick(name)}`;

  if (mode === 'drop') {
    const keyword = type === 'function' ? 'FUNCTION' : type === 'table' ? 'TABLE' : 'VIEW';
    return NextResponse.json({ ok: true, script: `DROP ${keyword} IF EXISTS ${fqn};` });
  }

  // create — needs a running warehouse to execute SHOW CREATE …
  const w = await getWarehouse(warehouseId).catch(() => null);
  if (!w || w.state !== 'RUNNING') {
    return NextResponse.json(
      { ok: false, state: w?.state || 'UNKNOWN', error: 'Warehouse not RUNNING — start it to script CREATE.' },
      { status: 409 },
    );
  }

  try {
    const stmt = type === 'function'
      ? `SHOW CREATE FUNCTION ${fqn}`
      : `SHOW CREATE TABLE ${fqn}`;
    const res = await executeStatement(warehouseId, stmt, catalog, schema);
    const script = String(res.rows?.[0]?.[0] ?? '').trim();
    if (!script) {
      return NextResponse.json({ ok: false, error: `No definition returned for ${fqn}.` }, { status: 404 });
    }
    // SHOW CREATE TABLE/FUNCTION omits the trailing semicolon — add it so the
    // script is directly runnable in the editor.
    return NextResponse.json({ ok: true, script: script.endsWith(';') ? script : `${script};` });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
