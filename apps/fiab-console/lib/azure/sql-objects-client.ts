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
