/**
 * N7b — source-schema capture (server; the side-effecting half of the
 * schema-change feed).
 *
 * At each Start the control plane reads the connector's source catalog once and
 * builds a per-table column map (the "schema fingerprint"). `foldSchemaCapture`
 * (pure, in ./connector-plane) diffs it against the previously-stored fingerprint
 * to produce the schema-change events the monitor surfaces — the Azure-native
 * analog of Debezium's source-DDL schema-change stream.
 *
 * Only the two families the built-in engine actually replicates (PostgreSQL,
 * SQL Server) are captured here — one bounded catalog query each, reusing the
 * exact clients the mirror engine uses. The ADF-copy families (MySQL / MongoDB /
 * Oracle) don't run the built-in snapshot, so there is nothing to fingerprint
 * until their copy runtime lands data; capture returns `{}` for them (honest, no
 * fabricated schema). Every call is best-effort: a failure returns `{}` so Start
 * is never blocked by schema capture.
 *
 * IL5: both catalog reads hit the in-boundary source over its private endpoint;
 * no cloud-control-plane call.
 */
import type { SchemaMap, EngineSourceConfig } from './connector-plane';
import { MIRROR_SQL_FAMILY, MIRROR_PG_FAMILY } from '@/lib/azure/mirror-engine';

/** Cap the captured surface so a pathological source can't bloat the fingerprint. */
const MAX_TABLES = Number(process.env.LOOM_MIRROR_MAX_TABLES || 50);

/** Restrict a captured map to the connector's explicit table selection (when any). */
function scopeToSelection(map: SchemaMap, source: EngineSourceConfig): SchemaMap {
  const sel = Array.isArray(source.tables) ? source.tables.filter((t) => t && t.table) : [];
  if (!sel.length) {
    // No explicit subset → cap the enumerated surface deterministically.
    const keys = Object.keys(map).sort().slice(0, MAX_TABLES);
    const out: SchemaMap = {};
    for (const k of keys) out[k] = map[k];
    return out;
  }
  const wanted = new Set(sel.map((t) => `${t.schema}.${t.table}`.toLowerCase()));
  const out: SchemaMap = {};
  for (const [k, v] of Object.entries(map)) if (wanted.has(k.toLowerCase())) out[k] = v;
  return out;
}

/**
 * Capture the connector source's `schema.table → [columns]` map. Best-effort:
 * any read failure or an un-captured (ADF-copy) family returns `{}`.
 */
export async function captureSourceSchema(source: EngineSourceConfig): Promise<SchemaMap> {
  try {
    if (MIRROR_PG_FAMILY.has(source.sourceType)) return scopeToSelection(await capturePostgres(source), source);
    if (MIRROR_SQL_FAMILY.has(source.sourceType)) return scopeToSelection(await captureSql(source), source);
    return {};
  } catch {
    return {};
  }
}

/** SQL family — one query over sys.columns/sys.tables/sys.schemas (user tables only). */
async function captureSql(source: EngineSourceConfig): Promise<SchemaMap> {
  const { executeParameterized } = await import('@/lib/azure/azure-sql-client');
  const recordset = await executeParameterized<{ s: string; t: string; c: string }>(
    source.server, source.database,
    `SELECT sch.name AS s, tbl.name AS t, col.name AS c
       FROM sys.columns col
       JOIN sys.tables tbl ON tbl.object_id = col.object_id
       JOIN sys.schemas sch ON sch.schema_id = tbl.schema_id
      ORDER BY sch.name, tbl.name, col.column_id`,
  );
  const map: SchemaMap = {};
  for (const r of recordset) {
    const key = `${r.s}.${r.t}`;
    (map[key] ||= []).push(String(r.c));
  }
  return map;
}

/** PostgreSQL — one query over information_schema.columns (user schemas only). */
async function capturePostgres(source: EngineSourceConfig): Promise<SchemaMap> {
  const { executePostgresQuery } = await import('@/lib/azure/postgres-flex-client');
  const res = await executePostgresQuery(source.server, source.database,
    `SELECT table_schema, table_name, column_name
       FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name, ordinal_position`);
  const iS = res.columns.indexOf('table_schema');
  const iT = res.columns.indexOf('table_name');
  const iC = res.columns.indexOf('column_name');
  const map: SchemaMap = {};
  for (const row of res.rows) {
    const key = `${String(row[iS])}.${String(row[iT])}`;
    (map[key] ||= []).push(String(row[iC]));
  }
  return map;
}
