/**
 * Shared Model-view BFF handlers for the Synapse-backed engines — the Fabric
 * "Warehouse" (`warehouse`) and the Synapse Dedicated SQL pool
 * (`synapse-dedicated-sql-pool`). Both route to the same wired-in Dedicated SQL
 * pool (`dedicatedTarget()`), so the only per-route difference is the Cosmos
 * `itemType` the model metadata is persisted under.
 *
 *   GET    …/model                      → tables + columns (live) + relationships + measures
 *   POST   …/model      {relationship}  → upsert a Loom relationship (Cosmos)
 *   POST   …/model?kind=measure {measure}→ CREATE OR ALTER FUNCTION (TVF) + persist
 *   DELETE …/model?relId=…              → remove a relationship
 *
 * Synapse Dedicated SQL pool does NOT enforce FOREIGN KEY constraints, so
 * relationships are Loom metadata persisted on the Cosmos item. Measures ARE
 * real inline table-valued functions executed against the live pool. No Power
 * BI / Fabric dependency anywhere on this path.
 *
 * Underscore-prefixed folder — Next.js does not treat this as a route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import {
  readModelState, writeModelState,
  normalizeRelationship, upsertRelationship, removeRelationship,
  normalizeMeasure, upsertMeasure, tvfDdl,
  type LoomModelState, type StoredMeasure,
} from './model-store';

interface ModelTable {
  id: string;
  schema: string;
  name: string;
  columns: Array<{ name: string; type?: string; isPk?: boolean }>;
  rowCount?: number;
}

const TABLES_AND_COLS_SQL = `SELECT TOP 2000
    s.name AS schema_name,
    t.name AS table_name,
    c.name AS column_name,
    tp.name AS type_name,
    c.column_id,
    CASE WHEN ic.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_pk
  FROM sys.tables t
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  JOIN sys.columns c ON c.object_id = t.object_id
  JOIN sys.types tp ON tp.user_type_id = c.user_type_id
  LEFT JOIN sys.indexes ix ON ix.object_id = t.object_id AND ix.is_primary_key = 1
  LEFT JOIN sys.index_columns ic ON ic.object_id = ix.object_id AND ic.index_id = ix.index_id AND ic.column_id = c.column_id
  ORDER BY s.name, t.name, c.column_id`;

// Existing inline/scalar TVFs are surfaced as measures even if created outside Loom.
const FUNCTIONS_SQL = `SELECT s.name AS schema_name, o.name AS fn_name, o.type AS fn_type, m.definition
  FROM sys.sql_modules m
  JOIN sys.objects o ON o.object_id = m.object_id
  JOIN sys.schemas s ON s.schema_id = o.schema_id
  WHERE o.type IN ('FN','IF','TF')
  ORDER BY s.name, o.name`;

async function readTables(): Promise<ModelTable[]> {
  const res = await executeQuery(dedicatedTarget(), TABLES_AND_COLS_SQL);
  const byId = new Map<string, ModelTable>();
  for (const row of res.rows) {
    const [schemaName, tableName, columnName, typeName, , isPk] = row as [string, string, string, string, number, number];
    const id = `${schemaName}.${tableName}`;
    let t = byId.get(id);
    if (!t) { t = { id, schema: schemaName, name: tableName, columns: [] }; byId.set(id, t); }
    t.columns.push({ name: columnName, type: typeName, isPk: Number(isPk) === 1 });
  }
  return [...byId.values()];
}

async function readFunctionMeasures(): Promise<StoredMeasure[]> {
  const res = await executeQuery(dedicatedTarget(), FUNCTIONS_SQL);
  return res.rows.map((row) => {
    const [schemaName, fnName, fnType, definition] = row as [string, string, string, string];
    return {
      id: `udf:${schemaName}.${fnName}`,
      name: fnName,
      schema: schemaName,
      expression: String(definition || '').trim(),
      kind: String(fnType).trim() === 'FN' ? 'scalar' : 'tvf',
      createdAt: '',
      updatedAt: '',
    } as StoredMeasure;
  });
}

/** Merge live UDFs with Cosmos-stored measures (Cosmos wins on name+schema). */
function mergeMeasures(cosmos: StoredMeasure[], live: StoredMeasure[]): StoredMeasure[] {
  const key = (m: StoredMeasure) => `${m.schema || ''}.${m.name}`;
  const seen = new Set(cosmos.map(key));
  return [...cosmos, ...live.filter((m) => !seen.has(key(m)))];
}

export function makeSynapseModelHandlers(itemType: string) {
  async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const session = getSession();
    if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
    const { id } = await ctx.params;

    const { state: model, itemFound } = await readModelState(id, itemType, session.claims.oid);
    if (!itemFound) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });

    const pool = await getPoolState().catch(() => null);
    if (!pool || pool.state !== 'Online') {
      // Compute offline — still render the canvas from persisted metadata.
      return NextResponse.json({
        ok: true,
        tables: [],
        relationships: model.relationships,
        measures: model.measures,
        computeReady: false,
        notice: `Warehouse compute is ${pool?.state || 'offline'} — resume the Dedicated SQL pool to load live tables.`,
      });
    }

    try {
      const [tables, liveMeasures] = await Promise.all([readTables(), readFunctionMeasures()]);
      return NextResponse.json({
        ok: true,
        tables,
        relationships: model.relationships,
        measures: mergeMeasures(model.measures, liveMeasures),
        computeReady: true,
      });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const session = getSession();
    if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
    const { id } = await ctx.params;
    const kind = req.nextUrl.searchParams.get('kind');
    const body = await req.json().catch(() => ({}));

    const { state: model, itemFound } = await readModelState(id, itemType, session.claims.oid);
    if (!itemFound) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });

    if (kind === 'measure') {
      let measure: StoredMeasure;
      try { measure = normalizeMeasure(body?.measure, 'tvf'); }
      catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || 'invalid measure' }, { status: 400 }); }

      // Materialize as a real inline table-valued function on the live pool.
      const pool = await getPoolState().catch(() => null);
      if (!pool || pool.state !== 'Online') {
        return NextResponse.json(
          { ok: false, error: `Warehouse compute is ${pool?.state || 'offline'} — resume the pool before creating a measure.` },
          { status: 409 },
        );
      }
      try {
        await executeQuery(dedicatedTarget(), tvfDdl(measure));
      } catch (e: any) {
        return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status: 502 });
      }
      const next: LoomModelState = upsertMeasure(model, measure);
      await writeModelState(id, itemType, session.claims.oid, next);
      return NextResponse.json({ ok: true, measure, model: next });
    }

    // Default: upsert a relationship (Cosmos — Synapse Dedicated has no enforced FK).
    let rel;
    try { rel = normalizeRelationship(body?.relationship, 'cosmos'); }
    catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || 'invalid relationship' }, { status: 400 }); }
    const next = upsertRelationship(model, rel);
    await writeModelState(id, itemType, session.claims.oid, next);
    return NextResponse.json({ ok: true, relationship: rel, model: next });
  }

  async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const session = getSession();
    if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
    const { id } = await ctx.params;
    const relId = req.nextUrl.searchParams.get('relId');
    if (!relId) return NextResponse.json({ ok: false, error: 'relId is required' }, { status: 400 });

    const { state: model, itemFound } = await readModelState(id, itemType, session.claims.oid);
    if (!itemFound) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });
    const next = removeRelationship(model, relId);
    await writeModelState(id, itemType, session.claims.oid, next);
    return NextResponse.json({ ok: true, model: next });
  }

  return { GET, POST, DELETE };
}
