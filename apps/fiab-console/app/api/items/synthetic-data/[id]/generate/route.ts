/**
 * POST /api/items/synthetic-data/[id]/generate   (W12)
 *   body {
 *     specs: ColumnGenSpec[], rowCount, seed?,
 *     warehouseId, catalog, schema, table, volume  // Databricks write target
 *   }
 *
 * Generate `rowCount` synthetic rows from the per-column strategies and WRITE
 * them to a real Delta table via the Databricks createUcTableFromFile path
 * (CSV → staged UC Volume → CREATE TABLE AS read_files with schema inference).
 * The run (target table, row count, columns) is persisted to state.runs[].
 * Azure-native (Databricks SQL over Delta) — no Microsoft Fabric dependency.
 *
 * Honest gate (no-vaporware): Databricks not configured / no warehouse → 503
 * with the exact env var to set. Preview still works with no backend.
 * Owner-scoped via loadOwnedItem / updateOwnedItem (route-guards).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate, warehouseConfigGate, createUcTableFromFile,
} from '@/lib/azure/databricks-client';
import { generateRows, rowsToCsv, type ColumnGenSpec } from '@/lib/azure/synthetic-data-gen';
import { sanitizeSpecs } from '../../_lib/specs';
import { loadOwnedItem, updateOwnedItem, jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'synthetic-data';
const MAX_ROWS = 200_000;
const DBX_GATE_HINT =
  'Provision an Azure Databricks workspace + SQL Warehouse and set LOOM_DATABRICKS_HOSTNAME (+ LOOM_DATABRICKS_SQL_WAREHOUSE_ID) — the generated rows are written to a real Delta table via Databricks SQL. Preview still runs with no backend.';

export interface SyntheticRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  target: string;          // catalog.schema.table
  requestedRows: number;
  rowsWritten: number | null;
  columns: string[];
  seed: number;
  status: 'succeeded' | 'partial' | 'failed';
  durationMs: number;
  startedBy: string;
  error?: string;
}

const IDENT = /^[A-Za-z0-9_]+$/;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const itemId = (await ctx.params).id;
  const item = await loadOwnedItem(itemId, ITEM_TYPE, session.claims.oid);
  if (!item) return jerr('synthetic-data item not found', 404);

  const body = await req.json().catch(() => ({}));
  const specs: ColumnGenSpec[] = sanitizeSpecs(body?.specs);
  if (specs.length === 0) return NextResponse.json({ ok: false, error: 'At least one valid column spec is required.' }, { status: 400 });

  const rowCount = Math.max(1, Math.min(MAX_ROWS, Number(body?.rowCount) || 0));
  if (!rowCount) return NextResponse.json({ ok: false, error: 'rowCount must be a positive number.' }, { status: 400 });
  const seed = Number.isFinite(body?.seed) ? Math.floor(body.seed) : 1;

  const catalog = String(body?.catalog || '').trim();
  const schema = String(body?.schema || '').trim();
  const table = String(body?.table || '').trim();
  const volume = String(body?.volume || '').trim();
  const warehouseId = String(body?.warehouseId || '').trim();

  if (!catalog || !schema || !table) return NextResponse.json({ ok: false, error: 'catalog, schema and table are required for the write target.' }, { status: 400 });
  if (![catalog, schema, table].every((v) => IDENT.test(v))) {
    return NextResponse.json({ ok: false, error: 'catalog / schema / table may contain only letters, digits and underscores.' }, { status: 400 });
  }
  if (!volume || volume.split('.').length !== 3) {
    return NextResponse.json({ ok: false, error: 'volume (catalog.schema.volume) is required to stage the generated rows.' }, { status: 400 });
  }

  // Honest backend gate — Databricks + a warehouse are needed for the write.
  const dbxGate = databricksConfigGate();
  if (dbxGate) return NextResponse.json({ ok: false, code: 'not_configured', gated: true, error: `Databricks not configured: set ${dbxGate.missing}.`, hint: DBX_GATE_HINT }, { status: 503 });
  const whGate = warehouseConfigGate(warehouseId || null);
  if (whGate) return NextResponse.json({ ok: false, code: 'not_configured', gated: true, error: `No SQL warehouse: set ${whGate.missing} or pick a warehouse.`, hint: DBX_GATE_HINT }, { status: 503 });
  const wid = warehouseId || String(process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID || '');

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // Generate the rows and serialize to CSV for read_files inference.
  const rows = generateRows(specs, rowCount, seed);
  const csv = rowsToCsv(rows, specs);

  let run: SyntheticRun;
  try {
    const result = await createUcTableFromFile({
      catalog_name: catalog, schema_name: schema, table_name: table,
      volume, file_name: `${table}.csv`, content: csv, format: 'csv', warehouse_id: wid, header: true,
    });
    const rowsWritten = result.row_count;
    run = {
      id: crypto.randomUUID(), startedAt, finishedAt: new Date().toISOString(),
      target: result.full_name, requestedRows: rowCount, rowsWritten,
      columns: result.columns.length ? result.columns : specs.map((s) => s.name), seed,
      status: rowsWritten == null ? 'partial' : rowsWritten === rowCount ? 'succeeded' : 'partial',
      durationMs: Date.now() - t0,
      startedBy: session.claims.upn || session.claims.email || session.claims.oid,
    };
  } catch (e: any) {
    run = {
      id: crypto.randomUUID(), startedAt, finishedAt: new Date().toISOString(),
      target: `${catalog}.${schema}.${table}`, requestedRows: rowCount, rowsWritten: null,
      columns: specs.map((s) => s.name), seed, status: 'failed', durationMs: Date.now() - t0,
      startedBy: session.claims.upn || session.claims.email || session.claims.oid,
      error: e?.message || String(e),
    };
    await persistRun(itemId, session.claims.oid, item.state, body, run).catch(() => {});
    return NextResponse.json({ ok: false, error: e?.message || String(e), run }, { status: e?.status || 502 });
  }

  await persistRun(itemId, session.claims.oid, item.state, body, run).catch(() => {});
  return NextResponse.json({ ok: true, run });
}

/** Persist the run into item.state.runs[] and mirror the last-used config. */
async function persistRun(
  itemId: string,
  tenantId: string,
  prevState: Record<string, any> | undefined,
  body: any,
  run: SyntheticRun,
): Promise<void> {
  const state = { ...(prevState || {}) };
  const runs = Array.isArray(state.runs) ? state.runs : [];
  state.runs = [run, ...runs].slice(0, 50);
  state.config = {
    specs: sanitizeSpecs(body?.specs), rowCount: body?.rowCount, seed: body?.seed,
    warehouseId: body?.warehouseId, catalog: body?.catalog, schema: body?.schema, table: body?.table, volume: body?.volume,
  };
  await updateOwnedItem(itemId, ITEM_TYPE, tenantId, { state });
}
