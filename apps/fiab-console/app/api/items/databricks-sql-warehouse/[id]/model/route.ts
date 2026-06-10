/**
 * /api/items/databricks-sql-warehouse/[id]/model — Model view (relationships +
 * measures) for the Databricks SQL Warehouse over Unity Catalog.
 *
 *   GET    …/model?warehouseId=&catalog=&schema=   → tables + UC FK relationships + measures
 *   POST   …/model            {relationship}       → ALTER TABLE ADD CONSTRAINT (real UC FK) + persist
 *   POST   …/model?kind=measure {measure}          → persist Loom measure (usable as CTE)
 *   DELETE …/model?relId=&warehouseId=             → ALTER TABLE DROP CONSTRAINT (best-effort) + remove
 *
 * Unity Catalog supports informational FOREIGN KEY constraints, so a
 * relationship is a REAL backend object (mirrored to Cosmos so Loom's
 * cardinality / cross-filter survive). NO Power BI / Fabric dependency.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeStatement, getWarehouse } from '@/lib/azure/databricks-client';
import {
  readModelState, writeModelState,
  normalizeRelationship, upsertRelationship, removeRelationship,
  normalizeMeasure, upsertMeasure,
  type StoredMeasure, type StoredRelationship,
} from '../../../_lib/model-store';
import {
  handleDescribeAll, handleSaveDescriptions,
  type SaveDescriptionsBody,
} from '../../../_lib/model-describe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'databricks-sql-warehouse';
const MAX_TABLES = 20;

interface ModelTable {
  id: string;
  schema: string;
  name: string;
  columns: Array<{ name: string; type?: string; isPk?: boolean }>;
}

function bt(part: string): string {
  return `\`${part.replace(/`/g, '')}\``;
}

/** Split a relationship table id (`catalog.schema.table` or `schema.table`) into a UC three-part ref. */
function tripart(id: string, defCatalog: string, defSchema: string): { catalog: string; schema: string; table: string } {
  const parts = id.split('.');
  if (parts.length >= 3) return { catalog: parts[0], schema: parts[1], table: parts.slice(2).join('.') };
  if (parts.length === 2) return { catalog: defCatalog, schema: parts[0], table: parts[1] };
  return { catalog: defCatalog, schema: defSchema, table: id };
}

/** First column of each row as a string. SHOW TABLES → [database, tableName, isTemp]. */
function tableNames(rows: unknown[][]): string[] {
  return rows.map((r) => String(r[1] ?? r[0])).filter(Boolean);
}

async function readTables(warehouseId: string, catalog: string, schema: string): Promise<ModelTable[]> {
  const showRes = await executeStatement(warehouseId, `SHOW TABLES IN ${bt(catalog)}.${bt(schema)}`);
  const names = tableNames(showRes.rows).slice(0, MAX_TABLES);
  const out: ModelTable[] = [];
  // Primary-key columns (UC informational PKs) for the whole schema, in one pass.
  const pkByTable = new Map<string, Set<string>>();
  try {
    const pkRes = await executeStatement(
      warehouseId,
      `SELECT kcu.table_name, kcu.column_name
       FROM ${bt(catalog)}.information_schema.table_constraints tc
       JOIN ${bt(catalog)}.information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = '${schema.replace(/'/g, "''")}'`,
      catalog,
      schema,
    );
    for (const row of pkRes.rows) {
      const [tbl, col] = row as [string, string];
      if (!pkByTable.has(tbl)) pkByTable.set(tbl, new Set());
      pkByTable.get(tbl)!.add(col);
    }
  } catch { /* information_schema may be unavailable on hive_metastore — degrade gracefully */ }

  for (const name of names) {
    try {
      const desc = await executeStatement(warehouseId, `DESCRIBE TABLE ${bt(catalog)}.${bt(schema)}.${bt(name)}`);
      const pks = pkByTable.get(name) || new Set<string>();
      const columns: ModelTable['columns'] = [];
      for (const row of desc.rows) {
        const col = String(row[0] || '').trim();
        const type = String(row[1] || '').trim();
        // DESCRIBE TABLE appends a blank row + partition-info section — stop there.
        if (!col || col.startsWith('#')) break;
        columns.push({ name: col, type, isPk: pks.has(col) });
      }
      out.push({ id: `${catalog}.${schema}.${name}`, schema: `${catalog}.${schema}`, name, columns });
    } catch { /* skip tables we cannot describe (permission / view) */ }
  }
  return out;
}

/** Read UC FK relationships for the active schema from INFORMATION_SCHEMA. */
async function readUcRelationships(warehouseId: string, catalog: string, schema: string): Promise<StoredRelationship[]> {
  try {
    const res = await executeStatement(
      warehouseId,
      `SELECT tc.table_schema, tc.table_name, kcu.column_name,
              kcu2.table_schema AS ref_schema, kcu2.table_name AS ref_table, kcu2.column_name AS ref_col,
              tc.constraint_name
       FROM ${bt(catalog)}.information_schema.table_constraints tc
       JOIN ${bt(catalog)}.information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN ${bt(catalog)}.information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
       JOIN ${bt(catalog)}.information_schema.key_column_usage kcu2
         ON kcu2.constraint_name = rc.unique_constraint_name AND kcu2.table_schema = rc.unique_constraint_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '${schema.replace(/'/g, "''")}'`,
      catalog,
      schema,
    );
    return res.rows.map((row) => {
      const [tSchema, tName, col, refSchema, refTable, refCol, cname] = row as [string, string, string, string, string, string, string];
      return {
        id: `uc:${cname}`,
        name: cname,
        fromTable: `${catalog}.${tSchema}.${tName}`,
        fromColumn: col,
        toTable: `${catalog}.${refSchema}.${refTable}`,
        toColumn: refCol,
        cardinality: 'many-to-one',
        crossFilter: 'single',
        active: true,
        source: 'uc',
        createdAt: '',
        updatedAt: '',
      } as StoredRelationship;
    });
  } catch {
    return [];
  }
}

/** Merge UC-discovered FKs with Cosmos relationships (Cosmos wins by from/to columns). */
function mergeRelationships(cosmos: StoredRelationship[], uc: StoredRelationship[]): StoredRelationship[] {
  const key = (r: StoredRelationship) => `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`;
  const seen = new Set(cosmos.map(key));
  return [...cosmos, ...uc.filter((r) => !seen.has(key(r)))];
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const warehouseId = req.nextUrl.searchParams.get('warehouseId') || '';
  const catalog = req.nextUrl.searchParams.get('catalog') || '';
  const schema = req.nextUrl.searchParams.get('schema') || '';

  const { state: model, itemFound } = await readModelState(id, ITEM_TYPE, session.claims.oid);
  if (!itemFound) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });

  if (!warehouseId || !catalog || !schema) {
    return NextResponse.json({
      ok: true,
      tables: [],
      relationships: model.relationships,
      measures: model.measures,
      tableDescriptions: model.tableDescriptions || {},
      computeReady: false,
      notice: 'Select a warehouse, catalog, and schema in the Query tab to load tables into the Model view.',
    });
  }

  const w = await getWarehouse(warehouseId).catch(() => null);
  if (!w || w.state !== 'RUNNING') {
    return NextResponse.json({
      ok: true,
      tables: [],
      relationships: model.relationships,
      measures: model.measures,
      tableDescriptions: model.tableDescriptions || {},
      computeReady: false,
      notice: `Warehouse is ${w?.state || 'UNKNOWN'} — start it to load live tables and create relationships.`,
    });
  }

  try {
    const [tables, ucRels] = await Promise.all([
      readTables(warehouseId, catalog, schema),
      readUcRelationships(warehouseId, catalog, schema),
    ]);
    const tdesc = model.tableDescriptions || {};
    const tablesWithDesc = tables.map((t) => (tdesc[t.id] ? { ...t, description: tdesc[t.id] } : t));
    return NextResponse.json({
      ok: true,
      tables: tablesWithDesc,
      relationships: mergeRelationships(model.relationships, ucRels),
      measures: model.measures,
      tableDescriptions: tdesc,
      computeReady: true,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const kind = req.nextUrl.searchParams.get('kind');
  const warehouseId = req.nextUrl.searchParams.get('warehouseId') || '';
  const defCatalog = req.nextUrl.searchParams.get('catalog') || '';
  const defSchema = req.nextUrl.searchParams.get('schema') || '';
  const body = await req.json().catch(() => ({}));

  const { state: model, itemFound } = await readModelState(id, ITEM_TYPE, session.claims.oid);
  if (!itemFound) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });

  // Bulk AI auto-description — propose descriptions for every measure + table.
  if (kind === 'describe-all') {
    let tables: ModelTable[] = [];
    if (warehouseId && defCatalog && defSchema) {
      const w = await getWarehouse(warehouseId).catch(() => null);
      if (w?.state === 'RUNNING') {
        tables = await readTables(warehouseId, defCatalog, defSchema).catch(() => []);
      }
    }
    return handleDescribeAll({ itemId: id, itemType: ITEM_TYPE, tenantId: session.claims.oid, tables });
  }

  // Persist approved measure + table descriptions to the model catalog.
  if (kind === 'save-descriptions') {
    return handleSaveDescriptions({
      itemId: id, itemType: ITEM_TYPE, tenantId: session.claims.oid, body: body as SaveDescriptionsBody,
    });
  }

  if (kind === 'measure') {
    let measure: StoredMeasure;
    try { measure = normalizeMeasure(body?.measure, 'cosmos'); }
    catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || 'invalid measure' }, { status: 400 }); }
    // Databricks SQL has no persistent inline-TVF measure concept; store as
    // Loom tabular metadata, usable as a query CTE (honest, no vaporware).
    const next = upsertMeasure(model, { ...measure, kind: 'cosmos', schema: undefined });
    await writeModelState(id, ITEM_TYPE, session.claims.oid, next);
    return NextResponse.json({ ok: true, measure: { ...measure, kind: 'cosmos' }, model: next });
  }

  // Relationship → real Unity Catalog informational FK constraint.
  let rel: StoredRelationship;
  try { rel = normalizeRelationship(body?.relationship, 'uc'); }
  catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || 'invalid relationship' }, { status: 400 }); }

  if (!warehouseId) {
    return NextResponse.json({ ok: false, error: 'warehouseId is required to create a UC constraint' }, { status: 400 });
  }
  const w = await getWarehouse(warehouseId).catch(() => null);
  if (!w || w.state !== 'RUNNING') {
    return NextResponse.json({ ok: false, error: `Warehouse is ${w?.state || 'UNKNOWN'} — start it before creating a relationship.` }, { status: 409 });
  }

  const from = tripart(rel.fromTable, defCatalog, defSchema);
  const to = tripart(rel.toTable, defCatalog, defSchema);
  const ddl = `ALTER TABLE ${bt(from.catalog)}.${bt(from.schema)}.${bt(from.table)} `
    + `ADD CONSTRAINT ${bt(rel.name)} FOREIGN KEY (${bt(rel.fromColumn)}) `
    + `REFERENCES ${bt(to.catalog)}.${bt(to.schema)}.${bt(to.table)} (${bt(rel.toColumn)})`;
  try {
    await executeStatement(warehouseId, ddl);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status: 502 });
  }
  const next = upsertRelationship(model, rel);
  await writeModelState(id, ITEM_TYPE, session.claims.oid, next);
  return NextResponse.json({ ok: true, relationship: rel, model: next });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const relId = req.nextUrl.searchParams.get('relId');
  const warehouseId = req.nextUrl.searchParams.get('warehouseId') || '';
  const defCatalog = req.nextUrl.searchParams.get('catalog') || '';
  const defSchema = req.nextUrl.searchParams.get('schema') || '';
  if (!relId) return NextResponse.json({ ok: false, error: 'relId is required' }, { status: 400 });

  const { state: model, itemFound } = await readModelState(id, ITEM_TYPE, session.claims.oid);
  if (!itemFound) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });

  const rel = model.relationships.find((r) => r.id === relId);
  // Best-effort drop of the UC constraint when the warehouse is running.
  if (rel && warehouseId) {
    const from = tripart(rel.fromTable, defCatalog, defSchema);
    try {
      const w = await getWarehouse(warehouseId).catch(() => null);
      if (w?.state === 'RUNNING') {
        await executeStatement(warehouseId, `ALTER TABLE ${bt(from.catalog)}.${bt(from.schema)}.${bt(from.table)} DROP CONSTRAINT IF EXISTS ${bt(rel.name)}`);
      }
    } catch { /* constraint may be UC-discovered only / already gone — ignore */ }
  }
  const next = removeRelationship(model, relId);
  await writeModelState(id, ITEM_TYPE, session.claims.oid, next);
  return NextResponse.json({ ok: true, model: next });
}
