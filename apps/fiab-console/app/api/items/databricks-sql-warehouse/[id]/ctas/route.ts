/**
 * POST /api/items/databricks-sql-warehouse/[id]/ctas
 * body { warehouseId, sql, catalog, schema, tableName }
 *
 * Save-as-table (CTAS) on the Databricks SQL Warehouse path. Wraps the editor
 * SELECT as a Unity Catalog managed Delta table:
 *
 *   CREATE TABLE `catalog`.`schema`.`tableName` USING DELTA
 *   AS <sql>
 *
 * Executed via /api/2.0/sql/statements (databricks-client.executeStatement),
 * which polls to terminal state. DDL returns 0 rows; we surface { ok, table }.
 *
 * Permissions required on the UC principal (the BFF managed identity):
 *   GRANT USE CATALOG  ON CATALOG <cat>            TO `<mi-app-id>`;
 *   GRANT USE SCHEMA   ON SCHEMA  <cat>.<schema>   TO `<mi-app-id>`;
 *   GRANT CREATE TABLE ON SCHEMA  <cat>.<schema>   TO `<mi-app-id>`;
 * Missing grants surface as a Databricks PERMISSION_DENIED 502 (runtime IAM,
 * not bicep — see deployment runbook).
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r. `POST(req)` took no `ctx`, so `[id]` was never
 * read; behind `getSession()` alone it ran `CREATE TABLE <caller catalog>.<caller
 * schema>.<caller table> AS <caller SELECT>` on the shared Databricks workspace
 * as the Console identity. The `^select` check bounds the STATEMENT SHAPE and
 * nothing else — the SELECT body is unrestricted, so the pair "SELECT from any
 * UC table → land it in a schema you can read" is the advisory's headline
 * materialize-then-read primitive on Unity Catalog.
 *
 * Layer 1 (`guardSynapseItemRequest`) authorizes the caller against the SQL
 * warehouse item, write-scoped. The guard is backend-agnostic; its
 * Synapse-specific `database` field is unused here.
 *
 * NOT closed, and worth naming precisely because it is the strongest residual in
 * this PR: `warehouseId`, `catalog`, `schema` and the SELECT body all remain
 * caller-supplied. Binding `warehouseId` needs a server-attested owner marker on
 * the warehouse (the `loom_item_id` pattern `_lib/databricks-resource-binding.ts`
 * applies to Jobs and DLT pipelines) — SQL warehouses are never stamped today,
 * and `resolveLegacyClaim`'s exclusivity fallback would 409 every estate that
 * shares one warehouse across items, i.e. all of them. Binding `catalog.schema`
 * needs a UC three-level scoping helper that does not exist. Both are design
 * work with a brownfield migration, not a mechanical adoption. FLOOR, not BOUND.
 *
 * ── EIGHTH PASS — THE UNSAVED-ITEM DEAD END, and why it was NOT a one-liner ──
 *
 * `ctas` was guarded but had NO `id === 'new'` gate, so it 404'd on a freshly
 * created item while its TWIN `[id]/clone` returned the honest gate — the same
 * day-one dead end three PRs in this series shipped (`auto-bind-by-default.md`,
 * `ux-baseline.md` "new-item first-open is clean"). Reachable: `submitCtas`
 * (`sql-warehouse-editor.tsx:833`) gates only on the dialog fields, that file
 * has NO `isNew` anywhere (measured, `grep -c isNew` = 0), and it renders
 * `j.error` verbatim as the Save-as-table dialog's error text.
 *
 * ADDING THE GATE REQUIRED ADOPTING `withSession`, and that is the whole lesson
 * of #3655 rather than an incidental refactor. This handler had no session read
 * of its own — `guardSynapseItemRequest` reads the session INTERNALLY. So a bare
 * `if (id === UNSAVED_ITEM_ID) return …` placed above the guard would have sat
 * ABOVE THE ONLY AUTHENTICATION IN THE FILE, and `…/new/ctas` would have
 * answered 200 to a caller with NO cookie where it previously returned 401.
 * That is precisely the regression review MEASURED on #3655, reproduced by the
 * "obvious" one-line fix. `withSession` puts authentication above the gate and
 * makes it unskippable (the handler is an ARGUMENT); the 401-at-`new` case is
 * asserted in the family suite.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { executeStatement, getWarehouse, databricksConfigGate } from '@/lib/azure/databricks-client';
import { stripTrailingSemicolons } from '@/lib/util/trim';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WAREHOUSE_NOT_FOUND = 'databricks sql warehouse not found';

/**
 * The unsaved-item honest gate — after authentication, before the guard.
 *
 * 200, matching the twin `[id]/clone`, and checked against this route's caller:
 * `submitCtas` reads `j.error` and renders it as the dialog's error text, so the
 * body surfaces as the actionable next step rather than "not found".
 *
 * Match `UNSAVED_ITEM_ID` EXACTLY — real ids are `crypto.randomUUID()`
 * (`_lib/item-crud.ts:467`), so a substring test would let a real id skip the
 * ownership check on a route that emits CREATE TABLE.
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this SQL warehouse item first — saving a query as a table runs in the name of the ' +
      'saved item, and an unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

export const POST = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id } = params;
  if (id === UNSAVED_ITEM_ID) return unsavedItemGate();

  // CTAS creates a table — a write. No allowReadRoles.
  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: 'databricks-sql-warehouse',
    notFound: WAREHOUSE_NOT_FOUND,
  });
  if (guard.res) return guard.res;
  const { session } = guard.ctx;

  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, error: `Databricks not configured: ${gate.missing}`, code: 'not_configured' },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const sql = stripTrailingSemicolons((body?.sql || '').toString());
  const warehouseId = (body?.warehouseId || '').toString().trim();
  const catalog = (body?.catalog || '').toString().trim();
  const schema = (body?.schema || '').toString().trim();
  const tableName = (body?.tableName || '').toString().trim();

  if (!warehouseId) return NextResponse.json({ error: 'warehouseId is required' }, { status: 400 });
  if (!catalog) return NextResponse.json({ error: 'catalog is required' }, { status: 400 });
  if (!schema) return NextResponse.json({ error: 'schema is required' }, { status: 400 });
  if (!tableName) return NextResponse.json({ error: 'tableName is required' }, { status: 400 });
  if (!sql) return NextResponse.json({ error: 'sql is required' }, { status: 400 });
  if (!/^select\b/i.test(sql)) {
    return NextResponse.json({ error: 'CTAS: sql must start with SELECT.' }, { status: 400 });
  }
  if (sql.length > 65_536) return NextResponse.json({ error: 'sql too large (>64KB)' }, { status: 413 });

  // Bail fast with 409 if the warehouse isn't RUNNING so the UI can prompt Start.
  const w = await getWarehouse(warehouseId).catch(() => null);
  if (w && w.state !== 'RUNNING') {
    return NextResponse.json(
      { ok: false, error: `Warehouse is ${w.state}. Start it first.`, state: w.state },
      { status: 409 },
    );
  }

  const esc = (x: string) => x.replace(/`/g, '``');
  const ctasSql =
    `CREATE TABLE \`${esc(catalog)}\`.\`${esc(schema)}\`.\`${esc(tableName)}\` USING DELTA\nAS\n${sql}`;

  try {
    const result = await executeStatement(warehouseId, ctasSql, catalog, schema);
    return NextResponse.json({
      ok: true,
      table: `${catalog}.${schema}.${tableName}`,
      executionMs: result.executionMs,
      executedBy: session.claims?.upn,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status: 502 },
    );
  }
});
