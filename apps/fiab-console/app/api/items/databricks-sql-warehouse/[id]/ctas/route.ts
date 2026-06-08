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
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeStatement, getWarehouse, databricksConfigGate } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, error: `Databricks not configured: ${gate.missing}`, code: 'not_configured' },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const sql = (body?.sql || '').toString().trim().replace(/;+\s*$/, '');
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
