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
 */
import { NextRequest, NextResponse } from 'next/server';
import { executeStatement, getWarehouse, databricksConfigGate } from '@/lib/azure/databricks-client';
import { stripTrailingSemicolons } from '@/lib/util/trim';
import { guardSynapseItemRequest } from '../../../_lib/synapse-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WAREHOUSE_NOT_FOUND = 'databricks sql warehouse not found';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
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
}
