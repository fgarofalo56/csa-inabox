/**
 * Table maintenance OPTIMIZE / ANALYZE — BFF route. Azure-native, NO Fabric.
 *
 *   POST /api/items/[type]/[id]/optimize
 *        body { warehouseId, catalog, schema, tableName, zorderColumns?,
 *               analyzeAfter?, container?, storagePrefix? }
 *
 * Engine dispatch by [type]:
 *   - databricks-sql-warehouse  → OPTIMIZE [ZORDER BY] (real Delta compaction on
 *     the ADLS-backed table). When container + storagePrefix are supplied, the
 *     route lists the table's Parquet data files BEFORE and AFTER via ADLS so the
 *     receipt proves compaction (file count drops). Databricks also returns its
 *     own file-level metrics (numFilesAdded / numFilesRemoved), surfaced raw.
 *     analyzeAfter:true chains ANALYZE TABLE … COMPUTE STATISTICS FOR ALL COLUMNS.
 *   - synapse-dedicated-sql-pool / warehouse → 400 code:'not_applicable'. OPTIMIZE
 *     is a Delta Lake Spark command; Dedicated SQL pool uses clustered columnstore
 *     indexes — use UPDATE STATISTICS (statistics route) or ALTER INDEX … REBUILD.
 *
 * V-Order (Fabric write-time Parquet encoding) is NOT executed here — it has no
 * Azure 1:1 and is surfaced as an honest MessageBar in the dialog.
 *
 * No raw SQL crosses the wire: the OPTIMIZE / ANALYZE statements are built
 * server-side from validated identifiers (statistics-client.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate, executeStatement, getWarehouse } from '@/lib/azure/databricks-client';
import { countParquetFiles, getAccountName } from '@/lib/azure/adls-client';
import {
  buildDatabricksOptimizeSQL,
  buildDatabricksAnalyzeSQL,
  type Built,
} from '@/lib/azure/statistics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SYNAPSE_TYPES = new Set(['synapse-dedicated-sql-pool', 'warehouse']);
const DATABRICKS_TYPES = new Set(['databricks-sql-warehouse']);

function unwrap(b: Built): string {
  if (!b.ok) {
    const e = new Error(b.error) as Error & { httpStatus?: number };
    e.httpStatus = 400;
    throw e;
  }
  return b.sql;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { type } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  // Synapse Dedicated SQL pool — OPTIMIZE does not apply (columnstore, not Delta).
  if (SYNAPSE_TYPES.has(type)) {
    return NextResponse.json({
      ok: false,
      code: 'not_applicable',
      error:
        'OPTIMIZE is a Delta Lake Spark command and does not apply to a Synapse Dedicated SQL pool, ' +
        'which stores data in clustered columnstore indexes (not Delta files). For query-optimizer ' +
        'maintenance run UPDATE STATISTICS on the Statistics tab, or rebuild indexes via ' +
        'ALTER INDEX ALL ON [schema].[table] REBUILD.',
    }, { status: 400 });
  }

  if (!DATABRICKS_TYPES.has(type)) {
    return NextResponse.json(
      { ok: false, error: `OPTIMIZE is not available for item type "${type}".` },
      { status: 404 },
    );
  }

  // ---- Databricks SQL Warehouse ----
  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false,
      gated: true,
      error: `Databricks SQL Warehouse is not configured. Set ${gate.missing} on the Console Container App (admin-plane bicep apps[].env).`,
    }, { status: 200 });
  }

  const warehouseId = String(body?.warehouseId || '').trim();
  const catalog = String(body?.catalog || '').trim();
  const schema = String(body?.schema || '').trim();
  const tableName = String(body?.tableName || '').trim();
  const analyzeAfter = body?.analyzeAfter === true;
  const container = String(body?.container || '').trim();
  const storagePrefix = String(body?.storagePrefix || '').trim();
  const zorderColumns = Array.isArray(body?.zorderColumns) ? body.zorderColumns : [];

  if (!warehouseId) return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });

  let optSql: string;
  let anSql: string | undefined;
  try {
    optSql = unwrap(buildDatabricksOptimizeSQL(catalog, schema, tableName, zorderColumns));
    if (analyzeAfter) anSql = unwrap(buildDatabricksAnalyzeSQL(catalog, schema, tableName));
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.httpStatus || 400 });
  }

  // State pre-check — bail fast with 409 so the UI can prompt Start.
  const w = await getWarehouse(warehouseId).catch(() => null);
  if (w && w.state !== 'RUNNING') {
    return NextResponse.json(
      { ok: false, error: `Warehouse is ${w.state}. Start it first.`, state: w.state },
      { status: 409 },
    );
  }

  // File count BEFORE — best-effort (ADLS read). Never blocks OPTIMIZE.
  let filesBefore: number | undefined;
  let filesBeforeError: string | undefined;
  if (container && storagePrefix) {
    try {
      const acct = getAccountName();
      const before = await countParquetFiles(container, storagePrefix, acct);
      filesBefore = before.count;
    } catch (e: any) {
      filesBeforeError = e?.message || String(e);
    }
  }

  // Run OPTIMIZE — the primary, real backend call.
  let optimizeResult: { columns: string[]; rows: unknown[][]; executionMs: number };
  try {
    const r = await executeStatement(warehouseId, optSql, catalog || undefined, schema);
    optimizeResult = { columns: r.columns, rows: r.rows, executionMs: r.executionMs };
  } catch (e: any) {
    return NextResponse.json({ ok: false, sql: optSql, error: e?.message || String(e), code: e?.code }, { status: 502 });
  }

  // Optional ANALYZE after compaction.
  let analyzeMs: number | undefined;
  let analyzeError: string | undefined;
  if (anSql) {
    try {
      const ar = await executeStatement(warehouseId, anSql, catalog || undefined, schema);
      analyzeMs = ar.executionMs;
    } catch (e: any) {
      analyzeError = e?.message || String(e);
    }
  }

  // File count AFTER — proves compaction (count should drop).
  let filesAfter: number | undefined;
  if (container && storagePrefix && filesBeforeError === undefined) {
    try {
      const acct = getAccountName();
      const after = await countParquetFiles(container, storagePrefix, acct);
      filesAfter = after.count;
    } catch {
      // before succeeded but after failed — leave undefined; Databricks metrics still prove it
    }
  }

  return NextResponse.json({
    ok: true,
    engine: 'databricks',
    sql: optSql,
    analyzeSql: anSql,
    optimizeResult,
    filesBefore,
    filesAfter,
    filesBeforeError,
    analyzeMs,
    analyzeError,
    warehouseId,
    executionMs: optimizeResult.executionMs,
    executedBy: session.claims.upn,
  });
}
