/**
 * GET /api/items/databricks-sql-warehouse/[id]/schema?warehouseId=&catalog=&schema=
 *
 * Returns the Unity Catalog tree, scoped progressively:
 *   - no catalog              → { catalogs }
 *   - catalog, no schema      → { catalogs, schemas }
 *   - catalog + schema        → { catalogs, schemas, tables }
 *
 * Each level runs a single SHOW … statement against the warehouse.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeStatement, getWarehouse } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function firstColumn(rows: unknown[][]): string[] {
  return rows.map((r) => String(r[0])).filter(Boolean);
}

// SHOW TABLES returns [database, tableName, isTemporary] — name is col 1.
function tableNames(rows: unknown[][]): string[] {
  return rows.map((r) => String(r[1] ?? r[0])).filter(Boolean);
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

    if (catalog) {
      // Quote with backticks; users may pass `system`, `main`, `hive_metastore`, etc.
      const schemasRes = await executeStatement(warehouseId, `SHOW SCHEMAS IN \`${catalog}\``);
      schemas = firstColumn(schemasRes.rows);

      if (schema) {
        const tablesRes = await executeStatement(
          warehouseId,
          `SHOW TABLES IN \`${catalog}\`.\`${schema}\``,
        );
        tables = tableNames(tablesRes.rows);
      }
    }

    return NextResponse.json({ ok: true, state: 'RUNNING', catalogs, schemas, tables });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, state: 'RUNNING', error: e?.message || String(e) },
      { status: 502 },
    );
  }
}
