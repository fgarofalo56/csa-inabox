/**
 * GET /api/items/databricks-sql-warehouse/[id]/schema?warehouseId=&catalog=&schema=
 *
 * Returns the Unity Catalog tree, scoped progressively:
 *   - no catalog              → { catalogs }
 *   - catalog, no schema      → { catalogs, schemas }
 *   - catalog + schema        → { catalogs, schemas, tables, views, functions }
 *
 * Each level runs a single SHOW … statement against the warehouse. At the
 * leaf level tables / views / user-functions enumerate in parallel
 * (SHOW TABLES / SHOW VIEWS / SHOW USER FUNCTIONS).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeStatement, getWarehouse } from '@/lib/azure/databricks-client';

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
  if (!warehouseId) return NextResponse.json({ error: 'warehouseId is required' }, { status: 400 });

  const w = await getWarehouse(warehouseId).catch(() => null);
  if (!w || w.state !== 'RUNNING') {
    return NextResponse.json(
      { ok: false, state: w?.state || 'UNKNOWN', message: 'Warehouse not RUNNING — schema unavailable.' },
      { status: 409 },
    );
  }

  try {
    const catalogsRes = await executeStatement(warehouseId, 'SHOW CATALOGS');
    const catalogs = firstColumn(catalogsRes.rows);

    let schemas: string[] | undefined;
    let tables: string[] | undefined;
    let views: string[] | undefined;
    let functions: string[] | undefined;

    if (catalog) {
      // Quote with backticks; users may pass `system`, `main`, `hive_metastore`, etc.
      const schemasRes = await executeStatement(warehouseId, `SHOW SCHEMAS IN \`${catalog}\``);
      schemas = firstColumn(schemasRes.rows);

      if (schema) {
        const ns = `\`${catalog}\`.\`${schema}\``;
        // Tables, views and user functions enumerate in parallel. Views and
        // functions degrade to [] (not a hard failure) if the principal lacks
        // visibility or the engine version predates the command.
        const [tablesRes, viewsRes, funcsRes] = await Promise.all([
          executeStatement(warehouseId, `SHOW TABLES IN ${ns}`),
          executeStatement(warehouseId, `SHOW VIEWS IN ${ns}`).catch(() => ({ rows: [] as unknown[][] })),
          executeStatement(warehouseId, `SHOW USER FUNCTIONS IN ${ns}`).catch(() => ({ rows: [] as unknown[][] })),
        ]);
        // SHOW TABLES also lists views; subtract the views so each appears once.
        const allTableNames = tableNames(tablesRes.rows);
        views = tableNames(viewsRes.rows);
        const viewSet = new Set(views);
        tables = allTableNames.filter((t) => !viewSet.has(t));
        functions = functionNames(funcsRes.rows);
      }
    }

    return NextResponse.json({ ok: true, state: 'RUNNING', catalogs, schemas, tables, views, functions });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, state: 'RUNNING', error: e?.message || String(e) },
      { status: 502 },
    );
  }
}
