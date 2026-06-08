/**
 * Unity Catalog granular-security wizards — BFF route (column masks + row
 * filters). This is the Databricks-side companion to the Synapse-only
 * `sql-security/route.ts` (object/column GRANT + RLS + DDM over TDS).
 *
 *   GET  /api/items/[type]/[id]/security?warehouseId=<id>&catalog=<c>&schema=<s>
 *        → live state for the wizard pickers + state panel:
 *          { ok, backend:'databricks-uc', catalog, columnMasks[], rowFilters[],
 *            tables[], columns[] }
 *        (tables[] requires schema; columns[] requires schema + table.)
 *
 *   POST /api/items/[type]/[id]/security
 *        body { wizard:'column-mask'|'row-filter', params, preview?, warehouseId, catalog? }
 *          - preview:true  → { ok, sql } WITHOUT executing
 *          - preview:false → executes CREATE FUNCTION then ALTER TABLE and returns
 *                            { ok, sql, executionMs, executedBy }
 *        body { action:'drop-mask'|'drop-filter', params, warehouseId, catalog? }
 *        body { action:'verify', verify:{ catalog, schema, tableName }, warehouseId }
 *          - runs the sample SELECT (admin/UAMI view) + reads information_schema
 *            to prove the mask/filter binding is live, and explains how the
 *            constrained principal sees the effect at query time.
 *
 * Backends dispatched by [type] (Azure-native — NO Microsoft Fabric):
 *   - databricks-sql-warehouse → Databricks Unity Catalog via executeStatement
 *
 * AUTH: the Databricks client builds every request with the Container App MI's
 * Microsoft Entra bearer token (no PAT). The client NEVER sends raw SQL — it
 * sends structured params; the SQL is built server-side by
 * lib/sql/uc-security-builders.ts (back-tick-quoted identifiers + allowlisted
 * types + escaped literals), so there is no injection path.
 *
 * BOUNDARY GATE: Unity Catalog (Entra-connected metastore) is a Commercial/GCC
 * capability. At GCC-High / IL5 / DoD the route returns an honest gate pointing
 * to the Synapse Dedicated SQL pool column-GRANT + RLS path instead.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  executeStatement,
  databricksConfigGate,
  listWarehouses,
  type QueryResult,
} from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  buildUcColumnMask,
  buildUcDropColumnMask,
  buildUcRowFilter,
  buildUcDropRowFilter,
  ucListColumnMasks,
  ucListRowFilters,
  ucListSchemas,
  ucListTablesInSchema,
  ucListColumnsForTable,
  ucSelectSample,
  UcBuildError,
  type UcColumnMaskParams,
  type UcRowFilterParams,
  type UcSecurityDdl,
} from '@/lib/sql/uc-security-builders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPPORTED_TYPES = new Set(['databricks-sql-warehouse']);

/** Honest gate object — UI renders a MessageBar with `error`. */
interface Gate { gated: true; error: string }

function rowsToObjects(r: QueryResult): Record<string, unknown>[] {
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}

/**
 * Resolve gating for this request. Returns an honest gate or null (good to go).
 * Order: item-type support → Databricks config → sovereign-boundary support.
 */
function resolveGate(type: string): Gate | null {
  if (!SUPPORTED_TYPES.has(type)) {
    return {
      gated: true,
      error:
        `Unity Catalog column masks and row filters apply to Databricks SQL Warehouse items. ` +
        `For Synapse / warehouse items use the SQL granular-security wizards (Column GRANT + RLS) instead.`,
    };
  }
  const cfg = databricksConfigGate();
  if (cfg) {
    return {
      gated: true,
      error:
        `Databricks is not configured in this deployment. Set ${cfg.missing} on the Console ` +
        `(landing-zone bicep deploys the Databricks workspace and stamps LOOM_DATABRICKS_HOSTNAME).`,
    };
  }
  if (isGovCloud()) {
    return {
      gated: true,
      error:
        `Unity Catalog column masks and row filters are not available at the ${cloudBoundaryLabel()} boundary. ` +
        `UC requires a Commercial or GCC Databricks workspace (Microsoft Entra-connected metastore). ` +
        `At this boundary, use the Synapse Dedicated SQL pool column-level GRANT ` +
        `(GRANT SELECT ON [s].[t](cols) TO [principal]) and Row-Level Security (CREATE SECURITY POLICY) ` +
        `wizards instead — open the warehouse / dedicated-pool editor's "Column & Row security" dialog.`,
    };
  }
  return null;
}

/**
 * Resolve the SQL warehouse to run against. Honours an explicit warehouseId
 * (the editor's warehouse picker); otherwise falls back to the first RUNNING
 * warehouse, then any warehouse (executeStatement tolerates STARTING).
 */
async function resolveWarehouseId(requested?: string): Promise<string> {
  if (requested) return requested;
  const warehouses = await listWarehouses();
  const running = warehouses.find((w) => w.state === 'RUNNING') || warehouses[0];
  if (!running) {
    throw new Error('No SQL warehouse found. Create or start a SQL warehouse in the Databricks workspace.');
  }
  return running.id;
}

async function ctxParams(ctx: { params: Promise<{ type: string; id: string }> }) {
  return ctx.params;
}

// ============================================================
// GET — live UC security state for the pickers + state panel
// ============================================================

export async function GET(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { type } = await ctxParams(ctx);
  const gate = resolveGate(type);
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  const catalog = req.nextUrl.searchParams.get('catalog') || undefined;
  const schema = req.nextUrl.searchParams.get('schema') || undefined;
  const table = req.nextUrl.searchParams.get('table') || undefined;
  const warehouseIdParam = req.nextUrl.searchParams.get('warehouseId') || undefined;

  if (!catalog) {
    // Without a catalog there is no information_schema to read. The panel asks
    // the user to pick a catalog first; return an empty-but-ok shell.
    return NextResponse.json({
      ok: true, backend: 'databricks-uc', catalog: null,
      columnMasks: [], rowFilters: [], tables: [], columns: [],
      needsCatalog: true,
    });
  }

  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(warehouseIdParam);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  async function safe(label: string, sql: string): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
    try {
      const r = await executeStatement(warehouseId, sql);
      return { rows: rowsToObjects(r) };
    } catch (e: any) {
      return { rows: [], error: `${label}: ${e?.message || String(e)}` };
    }
  }

  try {
    const reads: Promise<{ rows: Record<string, unknown>[]; error?: string }>[] = [
      safe('columnMasks', ucListColumnMasks(catalog)),
      safe('rowFilters', ucListRowFilters(catalog)),
      safe('schemas', ucListSchemas(catalog)),
      schema ? safe('tables', ucListTablesInSchema(catalog, schema)) : Promise.resolve({ rows: [] }),
      schema && table
        ? safe('columns', ucListColumnsForTable(catalog, schema, table))
        : Promise.resolve({ rows: [] }),
    ];
    const [masks, filters, schemas, tables, columns] = await Promise.all(reads);

    const warnings = [masks.error, filters.error, schemas.error, tables.error, columns.error].filter(Boolean) as string[];

    return NextResponse.json({
      ok: true,
      backend: 'databricks-uc',
      catalog,
      schema: schema || null,
      table: table || null,
      columnMasks: masks.rows,
      rowFilters: filters.rows,
      schemas: schemas.rows,
      tables: tables.rows,
      columns: columns.rows,
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

// ============================================================
// POST — preview / execute a wizard, drop a binding, or verify
// ============================================================

export async function POST(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { type } = await ctxParams(ctx);
  const gate = resolveGate(type);
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || 'wizard');
  const catalog = body?.catalog ? String(body.catalog) : undefined;

  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(body?.warehouseId ? String(body.warehouseId) : undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  // ---- Verify: prove the mask/filter binding is live + show the admin view ----
  if (action === 'verify') {
    const v = body?.verify || {};
    const vCatalog = String(v.catalog || catalog || '');
    const vSchema = String(v.schema || '');
    const vTable = String(v.tableName || v.table || '');
    if (!vCatalog || !vSchema || !vTable) {
      return NextResponse.json({ ok: false, error: 'verify requires catalog, schema and tableName' }, { status: 400 });
    }
    let sampleSql: string;
    let masksSql: string;
    let filtersSql: string;
    try {
      sampleSql = ucSelectSample(vCatalog, vSchema, vTable, Number(v.limit) || 10);
      masksSql = ucListColumnMasks(vCatalog);
      filtersSql = ucListRowFilters(vCatalog);
    } catch (e: any) {
      const status = e instanceof UcBuildError ? 400 : 500;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
    try {
      const sample = await executeStatement(warehouseId, sampleSql);
      const masks = rowsToObjects(await executeStatement(warehouseId, masksSql))
        .filter((m) => String(m.table_name) === vTable && String(m.schema_name) === vSchema);
      const filters = rowsToObjects(await executeStatement(warehouseId, filtersSql))
        .filter((f) => String(f.table_name) === vTable && String(f.schema_name) === vSchema);
      return NextResponse.json({
        ok: true,
        sql: sampleSql,
        adminView: { columns: sample.columns, rows: sample.rows, rowCount: sample.rowCount },
        masksApplied: masks,
        rowFiltersApplied: filters,
        executedBy: session.claims.upn,
        note:
          'The sample SELECT runs as the Console managed identity (an admin view — unmasked values, ' +
          'all rows). The bound column masks / row filter above are evaluated at query time via ' +
          'CURRENT_USER() / IS_ACCOUNT_GROUP_MEMBER(): a constrained principal running the same ' +
          'SELECT sees masked column values and only the rows the row filter permits.',
      });
    } catch (e: any) {
      return NextResponse.json({ ok: false, sql: sampleSql, error: e?.message || String(e), code: e?.code }, { status: 502 });
    }
  }

  // ---- Drop a binding (single statement) ----
  if (action === 'drop-mask' || action === 'drop-filter') {
    const params = body?.params ?? {};
    let sql: string;
    try {
      sql = action === 'drop-mask'
        ? buildUcDropColumnMask({
            catalog: String(params.catalog || catalog || ''),
            schema: String(params.schema || ''),
            tableName: String(params.tableName || ''),
            columnName: String(params.columnName || ''),
          })
        : buildUcDropRowFilter({
            catalog: String(params.catalog || catalog || ''),
            schema: String(params.schema || ''),
            tableName: String(params.tableName || ''),
          });
    } catch (e: any) {
      const status = e instanceof UcBuildError ? 400 : 500;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
    if (body?.preview === true) return NextResponse.json({ ok: true, preview: true, sql });
    try {
      const r = await executeStatement(warehouseId, sql);
      return NextResponse.json({ ok: true, sql, executionMs: r.executionMs, executedBy: session.claims.upn });
    } catch (e: any) {
      return NextResponse.json({ ok: false, sql, error: e?.message || String(e), code: e?.code }, { status: 502 });
    }
  }

  // ---- Wizard: build the two-statement DDL from structured params ----
  const wizard = String(body?.wizard || '');
  const preview = body?.preview === true;
  const params = body?.params ?? {};

  let ddl: UcSecurityDdl;
  try {
    if (wizard === 'column-mask') {
      ddl = buildUcColumnMask({ ...params, catalog: params.catalog || catalog } as UcColumnMaskParams);
    } else if (wizard === 'row-filter') {
      ddl = buildUcRowFilter({ ...params, catalog: params.catalog || catalog } as UcRowFilterParams);
    } else {
      return NextResponse.json({ ok: false, error: `unknown wizard: ${wizard}` }, { status: 400 });
    }
  } catch (e: any) {
    const status = e instanceof UcBuildError ? 400 : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }

  // Preview pane: return the generated SQL without touching the warehouse.
  if (preview) {
    return NextResponse.json({ ok: true, preview: true, sql: ddl.combined, functionName: ddl.functionName });
  }

  // Execute: CREATE OR REPLACE FUNCTION first, then ALTER TABLE … SET MASK/FILTER.
  const started = Date.now();
  try {
    await executeStatement(warehouseId, ddl.functionSql);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, sql: ddl.combined, stage: 'create-function', error: e?.message || String(e), code: e?.code },
      { status: 502 },
    );
  }
  try {
    await executeStatement(warehouseId, ddl.alterSql);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, sql: ddl.combined, stage: 'alter-table', error: e?.message || String(e), code: e?.code },
      { status: 502 },
    );
  }
  return NextResponse.json({
    ok: true,
    sql: ddl.combined,
    functionName: ddl.functionName,
    executionMs: Date.now() - started,
    executedBy: session.claims.upn,
  });
}
