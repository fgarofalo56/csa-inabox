/**
 * GET /api/items/databricks-sql-warehouse/[id]/schema?warehouseId=&catalog=&schema=
 *
 * Returns the Unity Catalog tree, scoped progressively:
 *   - no catalog                    → { catalogs }
 *   - catalog, no schema            → { catalogs, schemas }
 *   - catalog + schema              → { catalogs, schemas, tables, views, functions,
 *                                        streamingTables, materializedViews }
 *   - catalog + schema + table      → { columns }  (DESCRIBE TABLE — IntelliSense)
 *
 * Each level runs a single SHOW … / DESCRIBE statement against the warehouse.
 * At the schema leaf level tables / views / user-functions enumerate in
 * parallel (SHOW TABLES / SHOW VIEWS / SHOW USER FUNCTIONS), and — for DBX-7 —
 * `information_schema.tables.table_type` classifies the DLT-backed
 * STREAMING_TABLE / MATERIALIZED_VIEW objects into their own nodes (best-effort;
 * a catalog without information_schema, e.g. hive_metastore, simply reports
 * none).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeStatement, getWarehouse } from '@/lib/azure/databricks-client';
import { quoteIdent } from '@/lib/sql/quoting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function firstColumn(rows: unknown[][]): string[] {
  return rows.map((r) => String(r[0])).filter(Boolean);
}

// SHOW TABLES / SHOW VIEWS return [namespace, name, isTemporary] — name is col 1.
function tableNames(rows: unknown[][]): string[] {
  return rows.map((r) => String(r[1] ?? r[0])).filter(Boolean);
}

// SHOW USER FUNCTIONS returns one column of fully-qualified names
// (`catalog.schema.func`). Surface just the function name for the tree.
function functionNames(rows: unknown[][]): string[] {
  return rows
    .map((r) => {
      const fq = String(r[0] ?? '');
      const last = fq.split('.').pop();
      return (last || fq).trim();
    })
    .filter(Boolean);
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const warehouseId = req.nextUrl.searchParams.get('warehouseId');
  const catalog = req.nextUrl.searchParams.get('catalog') || undefined;
  const schema = req.nextUrl.searchParams.get('schema') || undefined;
  const table = req.nextUrl.searchParams.get('table') || undefined;
  if (!warehouseId) return NextResponse.json({ error: 'warehouseId is required' }, { status: 400 });

  const w = await getWarehouse(warehouseId).catch(() => null);
  if (!w || w.state !== 'RUNNING') {
    return NextResponse.json(
      { ok: false, state: w?.state || 'UNKNOWN', message: 'Warehouse not RUNNING — schema unavailable.' },
      { status: 409 },
    );
  }

  try {
    // Column-completion request: catalog + schema + table → DESCRIBE TABLE.
    // DESCRIBE returns [col_name, data_type, comment]; rows after a blank /
    // '#'-prefixed line are partition metadata, not columns — stop there.
    if (catalog && schema && table) {
      const descRes = await executeStatement(
        warehouseId,
        `DESCRIBE TABLE \`${catalog}\`.\`${schema}\`.\`${table}\``,
      );
      const columns: string[] = [];
      for (const r of descRes.rows) {
        const name = String(r[0] ?? '').trim();
        if (!name || name.startsWith('#')) break;
        columns.push(name);
      }
      return NextResponse.json({ ok: true, state: 'RUNNING', columns });
    }

    const catalogsRes = await executeStatement(warehouseId, 'SHOW CATALOGS');
    const catalogs = firstColumn(catalogsRes.rows);

    let schemas: string[] | undefined;
    let tables: string[] | undefined;
    let views: string[] | undefined;
    let functions: string[] | undefined;
    let streamingTables: string[] | undefined;
    let materializedViews: string[] | undefined;

    if (catalog) {
      // Quote with backticks; users may pass `system`, `main`, `hive_metastore`, etc.
      const schemasRes = await executeStatement(warehouseId, `SHOW SCHEMAS IN \`${catalog}\``);
      schemas = firstColumn(schemasRes.rows);

      if (schema) {
        const ns = `\`${catalog}\`.\`${schema}\``;
        // Tables, views, user functions, and the DLT-backed object-type map
        // enumerate in parallel. Views / functions / information_schema degrade
        // to [] (not a hard failure) if the principal lacks visibility or the
        // catalog predates the command (e.g. hive_metastore).
        const typeSql =
          `SELECT table_name, table_type FROM ${quoteIdent(catalog, 'databricks-sql')}.information_schema.tables ` +
          `WHERE table_schema = :sch`;
        const [tablesRes, viewsRes, funcsRes, typesRes] = await Promise.all([
          executeStatement(warehouseId, `SHOW TABLES IN ${ns}`),
          executeStatement(warehouseId, `SHOW VIEWS IN ${ns}`).catch(() => ({ rows: [] as unknown[][] })),
          executeStatement(warehouseId, `SHOW USER FUNCTIONS IN ${ns}`).catch(() => ({ rows: [] as unknown[][] })),
          executeStatement(warehouseId, typeSql, undefined, undefined, [{ name: 'sch', value: schema }]).catch(
            () => ({ rows: [] as unknown[][] }),
          ),
        ]);
        const allTableNames = tableNames(tablesRes.rows);
        const rawViews = tableNames(viewsRes.rows);
        functions = functionNames(funcsRes.rows);

        // Classify DLT-backed objects from information_schema.table_type
        // (STREAMING_TABLE / MATERIALIZED_VIEW). Rows are [table_name, table_type].
        const streamingSet = new Set<string>();
        const mvSet = new Set<string>();
        for (const r of typesRes.rows) {
          const nm = String(r[0] ?? '').trim();
          const tt = String(r[1] ?? '').trim().toUpperCase();
          if (!nm) continue;
          if (tt === 'STREAMING_TABLE') streamingSet.add(nm);
          else if (tt === 'MATERIALIZED_VIEW') mvSet.add(nm);
        }
        streamingTables = allTableNames.filter((t) => streamingSet.has(t));
        materializedViews = allTableNames.filter((t) => mvSet.has(t));
        // Views exclude anything reclassified as a streaming table / MV (an MV can
        // surface in SHOW VIEWS), so each object appears under exactly one node.
        views = rawViews.filter((v) => !streamingSet.has(v) && !mvSet.has(v));
        const viewSet = new Set([...views, ...rawViews]);
        // Plain tables exclude views, streaming tables, and materialized views.
        tables = allTableNames.filter(
          (t) => !viewSet.has(t) && !streamingSet.has(t) && !mvSet.has(t),
        );
      }
    }

    return NextResponse.json({
      ok: true,
      state: 'RUNNING',
      catalogs,
      schemas,
      tables,
      views,
      functions,
      streamingTables,
      materializedViews,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, state: 'RUNNING', error: e?.message || String(e) },
      { status: 502 },
    );
  }
}
