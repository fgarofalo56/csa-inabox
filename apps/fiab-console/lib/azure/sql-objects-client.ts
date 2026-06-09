/**
 * sql-objects-client — the Azure SQL Database / Fabric SQL database **schema
 * object** navigator data-plane. Enumerates the database's objects through
 * the `sys.*` catalog views over a real TDS connection (reusing the AAD-token
 * pool in {@link executeQuery} / {@link executeParameterized}), mirroring the
 * SSMS / Azure portal Query-editor object tree.
 *
 * Object enumeration (all read-only catalog SELECTs, no user input in the
 * query text — server/database are resolved per-item, never interpolated):
 *   - Schemas             → sys.schemas (user schemas)
 *   - Tables              → sys.tables  + sys.schemas + row counts (sys.dm_db_partition_stats)
 *   - Views               → sys.views   + sys.schemas
 *   - Stored procedures   → sys.procedures + sys.schemas
 *   - Functions           → sys.objects WHERE type IN ('FN','IF','TF','FS','FT','AF') + sys.schemas
 *   - Table types         → sys.table_types + sys.schemas
 *   - Columns (per table) → sys.columns + sys.types (read-only detail; object resolved by id)
 *
 * Authoring:
 *   - DROP TABLE / VIEW / PROCEDURE / FUNCTION — the object's schema + name
 *     are first looked up in the catalog by id; only the catalog-returned,
 *     bracket-quoted identifier is emitted into the DROP, so there is no
 *     string-injection path. CREATE is intentionally routed to the editor's
 *     T-SQL query tab (CREATE TABLE/proc templates), not faked as a form —
 *     see docs/fiab/parity/sql-database-objects.md.
 *
 * Connection resolution is item-scoped (mirrors the ADX navigator): the
 * caller passes a resolved `{ server, database }`. When neither an item-bound
 * connection nor the env defaults are present, {@link sqlConfigGate} returns
 * the honest infra-gate so the UI shows a precise MessageBar.
 */

import { AzureSqlError, executeParameterized } from './azure-sql-client';

export type SqlObjectGroup = 'table' | 'view' | 'procedure' | 'function' | 'table-type';

export interface SqlObjectRow {
  /** sys object_id — stable handle used for drop/columns (never name-interpolated). */
  objectId: number;
  schema: string;
  name: string;
  /** Two-part name `schema.name` for display. */
  fullName: string;
  /** sys.objects.type code (e.g. 'U','V','P','FN','IF','TF'). */
  type: string;
  typeDesc?: string;
  createDate?: string;
  modifyDate?: string;
  /** Tables only: approximate row count from sys.dm_db_partition_stats. */
  rowCount?: number;
}

export interface SqlSchemaRow { schemaId: number; name: string }

export interface SqlColumnRow {
  columnId: number;
  name: string;
  dataType: string;
  maxLength: number;
  precision: number;
  scale: number;
  isNullable: boolean;
  isIdentity: boolean;
  isComputed: boolean;
  isPrimaryKey: boolean;
}

/**
 * Honest infra-gate for the SQL object navigator. Connection resolution is
 * item-scoped, so the gate fires when the caller could not resolve a server
 * (no bound connection on the item and no env default). Returns `{ missing }`
 * with the env var to set, else `null`.
 */
export function sqlConfigGate(server: string | undefined | null): { missing: string } | null {
  if (!server || !server.trim()) {
    // The editor binds a connection per item; the env fallbacks let the
    // navigator work standalone (dev/smoke) when no item connection exists.
    return { missing: 'NEXT_PUBLIC_LOOM_AZURE_SQL_DEFAULT_SERVER (or bind a connection on the SQL database item)' };
  }
  return null;
}

// ============================================================
// Enumeration (sys.* catalog views — read-only, no user input in SQL text)
// ============================================================

const USER_SCHEMA_FILTER =
  // Exclude the system schemas SSMS hides under "System" by default.
  "s.name NOT IN ('sys','INFORMATION_SCHEMA','guest','db_owner','db_accessadmin'," +
  "'db_securityadmin','db_ddladmin','db_backupoperator','db_datareader'," +
  "'db_datawriter','db_denydatareader','db_denydatawriter')";

export async function listSchemas(server: string, database: string): Promise<SqlSchemaRow[]> {
  const rows = await executeParameterized<any>(
    server,
    database,
    `SELECT s.schema_id AS schemaId, s.name AS name
     FROM sys.schemas s
     WHERE ${USER_SCHEMA_FILTER}
     ORDER BY s.name;`,
  );
  return rows.map((r) => ({ schemaId: Number(r.schemaId), name: String(r.name) }));
}

export async function listTables(server: string, database: string): Promise<SqlObjectRow[]> {
  const rows = await executeParameterized<any>(
    server,
    database,
    `SELECT t.object_id AS objectId, s.name AS [schema], t.name AS name,
            t.type AS type, o.type_desc AS typeDesc,
            t.create_date AS createDate, t.modify_date AS modifyDate,
            ISNULL((
              SELECT SUM(p.row_count)
              FROM sys.dm_db_partition_stats p
              WHERE p.object_id = t.object_id AND p.index_id IN (0,1)
            ), 0) AS rowCount
     FROM sys.tables t
     JOIN sys.schemas s ON s.schema_id = t.schema_id
     JOIN sys.objects o ON o.object_id = t.object_id
     WHERE t.is_ms_shipped = 0
     ORDER BY s.name, t.name;`,
  );
  return rows.map(shapeObject);
}

export async function listViews(server: string, database: string): Promise<SqlObjectRow[]> {
  const rows = await executeParameterized<any>(
    server,
    database,
    `SELECT v.object_id AS objectId, s.name AS [schema], v.name AS name,
            v.type AS type, o.type_desc AS typeDesc,
            v.create_date AS createDate, v.modify_date AS modifyDate
     FROM sys.views v
     JOIN sys.schemas s ON s.schema_id = v.schema_id
     JOIN sys.objects o ON o.object_id = v.object_id
     WHERE v.is_ms_shipped = 0
     ORDER BY s.name, v.name;`,
  );
  return rows.map(shapeObject);
}

export async function listProcedures(server: string, database: string): Promise<SqlObjectRow[]> {
  const rows = await executeParameterized<any>(
    server,
    database,
    `SELECT p.object_id AS objectId, s.name AS [schema], p.name AS name,
            p.type AS type, o.type_desc AS typeDesc,
            p.create_date AS createDate, p.modify_date AS modifyDate
     FROM sys.procedures p
     JOIN sys.schemas s ON s.schema_id = p.schema_id
     JOIN sys.objects o ON o.object_id = p.object_id
     WHERE p.is_ms_shipped = 0
     ORDER BY s.name, p.name;`,
  );
  return rows.map(shapeObject);
}

export async function listFunctions(server: string, database: string): Promise<SqlObjectRow[]> {
  // FN scalar, IF inline TVF, TF multi-statement TVF, FS/FT/AF CLR variants.
  const rows = await executeParameterized<any>(
    server,
    database,
    `SELECT o.object_id AS objectId, s.name AS [schema], o.name AS name,
            o.type AS type, o.type_desc AS typeDesc,
            o.create_date AS createDate, o.modify_date AS modifyDate
     FROM sys.objects o
     JOIN sys.schemas s ON s.schema_id = o.schema_id
     WHERE o.type IN ('FN','IF','TF','FS','FT','AF') AND o.is_ms_shipped = 0
     ORDER BY s.name, o.name;`,
  );
  return rows.map(shapeObject);
}

export async function listTableTypes(server: string, database: string): Promise<SqlObjectRow[]> {
  const rows = await executeParameterized<any>(
    server,
    database,
    `SELECT tt.type_table_object_id AS objectId, s.name AS [schema], tt.name AS name,
            'TT' AS type, 'USER_TABLE_TYPE' AS typeDesc,
            NULL AS createDate, NULL AS modifyDate
     FROM sys.table_types tt
     JOIN sys.schemas s ON s.schema_id = tt.schema_id
     WHERE tt.is_user_defined = 1
     ORDER BY s.name, tt.name;`,
  );
  return rows.map(shapeObject);
}

/** Read-only column detail for a table/view, resolved by object_id (bound). */
export async function listColumns(
  server: string,
  database: string,
  objectId: number,
): Promise<SqlColumnRow[]> {
  if (!Number.isInteger(objectId)) throw new AzureSqlError('objectId must be an integer', 400);
  const rows = await executeParameterized<any>(
    server,
    database,
    `SELECT c.column_id AS columnId, c.name AS name, ty.name AS dataType,
            c.max_length AS maxLength, c.precision AS [precision], c.scale AS scale,
            c.is_nullable AS isNullable, c.is_identity AS isIdentity, c.is_computed AS isComputed,
            CAST(CASE WHEN EXISTS (
              SELECT 1 FROM sys.index_columns ic
              JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
              WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id
            ) THEN 1 ELSE 0 END AS bit) AS isPrimaryKey
     FROM sys.columns c
     JOIN sys.types ty ON ty.user_type_id = c.user_type_id
     WHERE c.object_id = @p0
     ORDER BY c.column_id;`,
    [objectId],
  );
  return rows.map((r) => ({
    columnId: Number(r.columnId),
    name: String(r.name),
    dataType: String(r.dataType),
    maxLength: Number(r.maxLength),
    precision: Number(r.precision),
    scale: Number(r.scale),
    isNullable: !!r.isNullable,
    isIdentity: !!r.isIdentity,
    isComputed: !!r.isComputed,
    isPrimaryKey: !!r.isPrimaryKey,
  }));
}

// ============================================================
// DROP (catalog-verified — no string injection)
// ============================================================

/** Bracket-quote an identifier the SQL way (double any `]`). */
function bracket(ident: string): string {
  return `[${ident.replace(/]/g, ']]')}]`;
}

const DROP_KEYWORD: Record<SqlObjectGroup, string> = {
  'table': 'TABLE',
  'view': 'VIEW',
  'procedure': 'PROCEDURE',
  'function': 'FUNCTION',
  'table-type': 'TYPE',
};

/**
 * Resolve `schema.name` for an object_id from the catalog, then DROP it. The
 * schema + name come back from `sys.objects` (or `sys.table_types`) — never
 * from the caller — so the emitted DDL is built only from catalog-verified,
 * bracket-quoted identifiers.
 */
export async function dropObject(
  server: string,
  database: string,
  group: SqlObjectGroup,
  objectId: number,
): Promise<{ ok: true; dropped: string } | { ok: false; error: string; status: number }> {
  if (!Number.isInteger(objectId)) return { ok: false, error: 'objectId must be an integer', status: 400 };
  try {
    let resolved: Array<{ schema: string; name: string }>;
    if (group === 'table-type') {
      resolved = await executeParameterized<any>(
        server, database,
        `SELECT s.name AS [schema], tt.name AS name
         FROM sys.table_types tt JOIN sys.schemas s ON s.schema_id = tt.schema_id
         WHERE tt.type_table_object_id = @p0 AND tt.is_user_defined = 1;`,
        [objectId],
      );
    } else {
      const wantTypes =
        group === 'table' ? "('U')"
        : group === 'view' ? "('V')"
        : group === 'procedure' ? "('P','PC')"
        : "('FN','IF','TF','FS','FT','AF')"; // function
      resolved = await executeParameterized<any>(
        server, database,
        `SELECT s.name AS [schema], o.name AS name
         FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE o.object_id = @p0 AND o.is_ms_shipped = 0 AND o.type IN ${wantTypes};`,
        [objectId],
      );
    }
    const hit = resolved[0];
    if (!hit) return { ok: false, error: `${group} not found for object_id ${objectId}`, status: 404 };
    const fq = `${bracket(hit.schema)}.${bracket(hit.name)}`;
    await executeParameterized(server, database, `DROP ${DROP_KEYWORD[group]} ${fq};`);
    return { ok: true, dropped: `${hit.schema}.${hit.name}` };
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return { ok: false, error: e?.message || String(e), status };
  }
}

// ============================================================
// Query Store / Query Performance Insight (Performance dashboard)
//
// Reads the real `sys.query_store_*` catalog views over the same AAD-token TDS
// pool used by the object navigator. This is the Azure-native QPI surface
// (Azure SQL Database has Query Store ON by default); no Microsoft Fabric or
// Power BI dependency. All numeric window/top-N inputs are clamped to integer
// literals server-side; the single user value that varies per row (`queryId`)
// is bound as a parameter (@p0) so there is no string-injection path.
// ============================================================

/** Metric the top-queries list is ranked by (column aliases, never raw input). */
export type PerfMetric = 'cpu' | 'duration' | 'logical-reads' | 'executions';

const PERF_ORDER_COL: Record<PerfMetric, string> = {
  cpu: 'totalCpuMs',
  duration: 'totalDurationMs',
  'logical-reads': 'totalLogicalReads',
  executions: 'totalExecutions',
};

export interface QueryStoreStatus {
  /** 'OFF' | 'READ_ONLY' | 'READ_WRITE' | 'ERROR' | 'READ_CAPTURE_SECONDARY'. */
  actualState: string;
  /** Bit map explaining why actual is READ_ONLY when desired is READ_WRITE (null when N/A). */
  readonlyReason: number | null;
  currentStorageSizeMb: number;
  maxStorageSizeMb: number;
  /** 'ALL' | 'AUTO' | 'NONE' | 'CUSTOM'. */
  captureMode: string;
  /** True when Query Store is actively collecting (READ_WRITE). */
  collecting: boolean;
}

export interface TopQueryRow {
  queryId: number;
  /** First 4000 chars of the normalized query_sql_text. */
  queryText: string;
  /** SUM(avg_cpu_time µs * count_executions) / 1000 → milliseconds. */
  totalCpuMs: number;
  totalDurationMs: number;
  /** SUM(avg_logical_io_reads * count_executions) → 8 KB pages. */
  totalLogicalReads: number;
  totalExecutions: number;
  /** ISO timestamp of the most recent interval the query ran in. */
  lastExecutionTime: string | null;
}

export interface QueryTimeSeriesPoint {
  intervalStart: string;
  intervalEnd: string;
  executions: number;
  avgCpuMs: number;
  avgDurationMs: number;
  avgLogicalReads: number;
}

export interface QueryPlanResult {
  planId: number;
  queryPlanXml: string | null;
  lastCompileTime: string | null;
}

/** Reads sys.database_query_store_options to determine if Query Store is collecting. */
export async function queryStoreStatus(
  server: string,
  database: string,
): Promise<QueryStoreStatus> {
  const rows = await executeParameterized<any>(
    server,
    database,
    `SELECT actual_state_desc        AS actualState,
            readonly_reason          AS readonlyReason,
            current_storage_size_mb  AS currentStorageSizeMb,
            max_storage_size_mb      AS maxStorageSizeMb,
            query_capture_mode_desc  AS captureMode
     FROM sys.database_query_store_options;`,
  );
  const r = rows[0] || {};
  const actualState = String(r.actualState || 'OFF');
  return {
    actualState,
    readonlyReason: r.readonlyReason == null ? null : Number(r.readonlyReason),
    currentStorageSizeMb: Number(r.currentStorageSizeMb || 0),
    maxStorageSizeMb: Number(r.maxStorageSizeMb || 0),
    captureMode: String(r.captureMode || 'AUTO'),
    collecting: actualState === 'READ_WRITE',
  };
}

/**
 * Turns Query Store ON (READ_WRITE) on the currently-connected database. This
 * runs REAL DDL — the console identity must hold ALTER on the database. The
 * statement is idempotent (re-running on an already-ON database is a no-op),
 * and we always re-read + return the post-DDL status as the receipt.
 */
export async function enableQueryStore(
  server: string,
  database: string,
): Promise<QueryStoreStatus> {
  await executeParameterized(
    server,
    database,
    `ALTER DATABASE CURRENT SET QUERY_STORE = ON (OPERATION_MODE = READ_WRITE);`,
  );
  return queryStoreStatus(server, database);
}

/**
 * Top-N queries ranked by a resource metric over a trailing window (hours).
 * `windowHours` ∈ [1,720] and `topN` ∈ [1,50] are clamped to safe integer
 * literals by the caller; `metric` maps to a known column alias.
 */
export async function topQueriesByMetric(
  server: string,
  database: string,
  metric: PerfMetric,
  windowHours: number,
  topN: number,
): Promise<TopQueryRow[]> {
  const wh = Math.min(720, Math.max(1, Math.trunc(windowHours) || 24));
  const n = Math.min(50, Math.max(1, Math.trunc(topN) || 10));
  const orderCol = PERF_ORDER_COL[metric] || PERF_ORDER_COL.cpu;
  const rows = await executeParameterized<any>(
    server,
    database,
    `SELECT TOP (${n})
        q.query_id AS queryId,
        LEFT(qt.query_sql_text, 4000) AS queryText,
        SUM(rs.avg_cpu_time          * rs.count_executions) / 1000.0 AS totalCpuMs,
        SUM(rs.avg_duration          * rs.count_executions) / 1000.0 AS totalDurationMs,
        SUM(rs.avg_logical_io_reads  * rs.count_executions)          AS totalLogicalReads,
        SUM(rs.count_executions)                                     AS totalExecutions,
        MAX(rsi.end_time)                                            AS lastExecutionTime
     FROM sys.query_store_query q
     JOIN sys.query_store_query_text qt ON qt.query_text_id = q.query_text_id
     JOIN sys.query_store_plan p        ON p.query_id = q.query_id
     JOIN sys.query_store_runtime_stats rs
          ON rs.plan_id = p.plan_id
     JOIN sys.query_store_runtime_stats_interval rsi
          ON rsi.runtime_stats_interval_id = rs.runtime_stats_interval_id
     WHERE rsi.start_time >= DATEADD(HOUR, -${wh}, GETUTCDATE())
       AND rs.execution_type = 0
     GROUP BY q.query_id, qt.query_sql_text
     ORDER BY ${orderCol} DESC;`,
  );
  return rows.map((r) => ({
    queryId: Number(r.queryId),
    queryText: String(r.queryText ?? ''),
    totalCpuMs: round2(Number(r.totalCpuMs || 0)),
    totalDurationMs: round2(Number(r.totalDurationMs || 0)),
    totalLogicalReads: Math.round(Number(r.totalLogicalReads || 0)),
    totalExecutions: Number(r.totalExecutions || 0),
    lastExecutionTime: r.lastExecutionTime ? new Date(r.lastExecutionTime).toISOString() : null,
  }));
}

/** Per-interval runtime stats time series for a single query_id over a window. */
export async function queryTimeSeries(
  server: string,
  database: string,
  queryId: number,
  windowHours: number,
): Promise<QueryTimeSeriesPoint[]> {
  const wh = Math.min(720, Math.max(1, Math.trunc(windowHours) || 24));
  const qid = Math.trunc(queryId);
  const rows = await executeParameterized<any>(
    server,
    database,
    `SELECT rsi.start_time AS intervalStart, rsi.end_time AS intervalEnd,
            SUM(rs.count_executions)            AS executions,
            AVG(rs.avg_cpu_time)    / 1000.0    AS avgCpuMs,
            AVG(rs.avg_duration)    / 1000.0    AS avgDurationMs,
            AVG(rs.avg_logical_io_reads)        AS avgLogicalReads
     FROM sys.query_store_runtime_stats rs
     JOIN sys.query_store_runtime_stats_interval rsi
          ON rsi.runtime_stats_interval_id = rs.runtime_stats_interval_id
     JOIN sys.query_store_plan p ON p.plan_id = rs.plan_id
     WHERE p.query_id = @p0
       AND rsi.start_time >= DATEADD(HOUR, -${wh}, GETUTCDATE())
       AND rs.execution_type = 0
     GROUP BY rsi.start_time, rsi.end_time
     ORDER BY rsi.start_time;`,
    [qid],
  );
  return rows.map((r) => ({
    intervalStart: r.intervalStart ? new Date(r.intervalStart).toISOString() : '',
    intervalEnd: r.intervalEnd ? new Date(r.intervalEnd).toISOString() : '',
    executions: Number(r.executions || 0),
    avgCpuMs: round2(Number(r.avgCpuMs || 0)),
    avgDurationMs: round2(Number(r.avgDurationMs || 0)),
    avgLogicalReads: Math.round(Number(r.avgLogicalReads || 0)),
  }));
}

/** Latest showplan XML for a query_id (drill-through to the execution plan). */
export async function queryStorePlan(
  server: string,
  database: string,
  queryId: number,
): Promise<QueryPlanResult | null> {
  const qid = Math.trunc(queryId);
  const rows = await executeParameterized<any>(
    server,
    database,
    `SELECT TOP 1 p.plan_id AS planId,
            TRY_CAST(p.query_plan AS nvarchar(MAX)) AS queryPlanXml,
            p.last_compile_start_time AS lastCompileTime
     FROM sys.query_store_plan p
     WHERE p.query_id = @p0
     ORDER BY p.last_compile_start_time DESC;`,
    [qid],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    planId: Number(r.planId),
    queryPlanXml: r.queryPlanXml ? String(r.queryPlanXml) : null,
    lastCompileTime: r.lastCompileTime ? new Date(r.lastCompileTime).toISOString() : null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function shapeObject(r: any): SqlObjectRow {
  const schema = String(r.schema);
  const name = String(r.name);
  return {
    objectId: Number(r.objectId),
    schema,
    name,
    fullName: `${schema}.${name}`,
    type: String(r.type || '').trim(),
    typeDesc: r.typeDesc ? String(r.typeDesc) : undefined,
    createDate: r.createDate ? new Date(r.createDate).toISOString() : undefined,
    modifyDate: r.modifyDate ? new Date(r.modifyDate).toISOString() : undefined,
    rowCount: typeof r.rowCount === 'number' || typeof r.rowCount === 'bigint'
      ? Number(r.rowCount) : undefined,
  };
}
