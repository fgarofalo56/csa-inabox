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

import { AzureSqlError, executeParameterized, executeQuery, type QueryResult } from './azure-sql-client';

export type SqlObjectGroup = 'table' | 'view' | 'procedure' | 'function' | 'table-type';

/** A schema-object index row (sys.indexes + sys.index_columns). */
export interface SqlIndexRow {
  indexId: number;
  name: string;
  /** sys.indexes.type: 0=heap,1=clustered,2=nonclustered,5=clustered columnstore,6=nonclustered columnstore,7=hash. */
  type: number;
  typeDesc: string;
  isUnique: boolean;
  isPrimaryKey: boolean;
  isUniqueConstraint: boolean;
  filterDefinition: string | null;
  /** Ordered, bracket-quoted key columns, e.g. `[LastName] ASC, [FirstName] DESC`. */
  keyColumns: string;
  /** Ordered, bracket-quoted INCLUDE (non-key) columns, e.g. `[Email], [Phone]`. */
  includeColumns: string;
}

/** DDL variant for {@link scriptObject}. */
export type ScriptVariant = 'CREATE' | 'ALTER' | 'DROP';

/** Object groups that can be scripted — the navigable groups plus a bare index. */
export type ScriptGroup = SqlObjectGroup | 'index';

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

// ============================================================
// Indexes (sys.indexes + sys.index_columns — read-only, object resolved by id)
// ============================================================

/**
 * List the indexes on a table/view, resolved by object_id (bound `@p0`). Heaps
 * (`type = 0`) are excluded. Key columns and INCLUDE columns are assembled,
 * ordered, with `STRING_AGG … WITHIN GROUP` (GA on Azure SQL DB) — all from the
 * catalog, no user input in the SQL text.
 */
export async function listIndexes(
  server: string,
  database: string,
  objectId: number,
): Promise<SqlIndexRow[]> {
  if (!Number.isInteger(objectId)) throw new AzureSqlError('objectId must be an integer', 400);
  const rows = await executeParameterized<any>(
    server,
    database,
    `SELECT
       i.index_id AS indexId,
       i.name AS name,
       i.type AS type,
       i.type_desc AS typeDesc,
       i.is_unique AS isUnique,
       i.is_primary_key AS isPrimaryKey,
       i.is_unique_constraint AS isUniqueConstraint,
       i.filter_definition AS filterDefinition,
       ISNULL((
         SELECT STRING_AGG('[' + REPLACE(c.name, ']', ']]') + '] '
                + CASE WHEN ic.is_descending_key = 1 THEN 'DESC' ELSE 'ASC' END, ', ')
                WITHIN GROUP (ORDER BY ic.key_ordinal)
         FROM sys.index_columns ic
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0
       ), '') AS keyColumns,
       ISNULL((
         SELECT STRING_AGG('[' + REPLACE(c.name, ']', ']]') + ']', ', ')
                WITHIN GROUP (ORDER BY ic.index_column_id)
         FROM sys.index_columns ic
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal = 0
       ), '') AS includeColumns
     FROM sys.indexes i
     WHERE i.object_id = @p0 AND i.type > 0
     ORDER BY i.is_primary_key DESC, i.name;`,
    [objectId],
  );
  return rows.map((r) => ({
    indexId: Number(r.indexId),
    name: String(r.name ?? ''),
    type: Number(r.type),
    typeDesc: String(r.typeDesc ?? ''),
    isUnique: !!r.isUnique,
    isPrimaryKey: !!r.isPrimaryKey,
    isUniqueConstraint: !!r.isUniqueConstraint,
    filterDefinition: r.filterDefinition ? String(r.filterDefinition) : null,
    keyColumns: String(r.keyColumns ?? ''),
    includeColumns: String(r.includeColumns ?? ''),
  }));
}

/** Resolve a table's `{ schema, name }` + an index name by (object_id, index_id). */
async function resolveIndex(
  server: string,
  database: string,
  tableObjectId: number,
  indexId: number,
): Promise<{ schema: string; table: string; index: string } | null> {
  const rows = await executeParameterized<any>(
    server, database,
    `SELECT s.name AS [schema], t.name AS tname, i.name AS iname
     FROM sys.indexes i
     JOIN sys.tables t ON t.object_id = i.object_id
     JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE i.object_id = @p0 AND i.index_id = @p1 AND i.type > 0 AND t.is_ms_shipped = 0;`,
    [tableObjectId, indexId],
  );
  const hit = rows[0];
  if (!hit || !hit.iname) return null;
  return { schema: String(hit.schema), table: String(hit.tname), index: String(hit.iname) };
}

/**
 * DROP an index. Both ids are integers; the schema/table/index names are read
 * back from the catalog and bracket-quoted, so no caller string is interpolated.
 */
export async function dropIndex(
  server: string,
  database: string,
  tableObjectId: number,
  indexId: number,
): Promise<{ ok: true; dropped: string } | { ok: false; error: string; status: number }> {
  if (!Number.isInteger(tableObjectId) || !Number.isInteger(indexId)) {
    return { ok: false, error: 'tableObjectId and indexId must be integers', status: 400 };
  }
  try {
    const hit = await resolveIndex(server, database, tableObjectId, indexId);
    if (!hit) return { ok: false, error: `index not found for object_id ${tableObjectId}, index_id ${indexId}`, status: 404 };
    await executeParameterized(
      server, database,
      `DROP INDEX ${bracket(hit.index)} ON ${bracket(hit.schema)}.${bracket(hit.table)};`,
    );
    return { ok: true, dropped: `${hit.schema}.${hit.table}.${hit.index}` };
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return { ok: false, error: e?.message || String(e), status };
  }
}

// ============================================================
// Rename (sp_rename — catalog-resolved old name, parameterized new name)
// ============================================================

/** sys.objects type codes per navigable group (for resolution + DROP keyword). */
const GROUP_TYPES: Record<SqlObjectGroup, string> = {
  'table': "('U')",
  'view': "('V')",
  'procedure': "('P','PC')",
  'function': "('FN','IF','TF','FS','FT','AF')",
  'table-type': '', // resolved via sys.table_types, not sys.objects
};

/** Resolve `{ schema, name }` for an object_id within a group. */
async function resolveObject(
  server: string,
  database: string,
  group: SqlObjectGroup,
  objectId: number,
): Promise<{ schema: string; name: string } | null> {
  let rows: Array<{ schema: string; name: string }>;
  if (group === 'table-type') {
    rows = await executeParameterized<any>(
      server, database,
      `SELECT s.name AS [schema], tt.name AS name
       FROM sys.table_types tt JOIN sys.schemas s ON s.schema_id = tt.schema_id
       WHERE tt.type_table_object_id = @p0 AND tt.is_user_defined = 1;`,
      [objectId],
    );
  } else {
    rows = await executeParameterized<any>(
      server, database,
      `SELECT s.name AS [schema], o.name AS name
       FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE o.object_id = @p0 AND o.is_ms_shipped = 0 AND o.type IN ${GROUP_TYPES[group]};`,
      [objectId],
    );
  }
  const hit = rows[0];
  return hit ? { schema: String(hit.schema), name: String(hit.name) } : null;
}

/**
 * Rename a table/view/procedure/function via `sp_rename … @objtype='OBJECT'`.
 *
 * The current `schema.name` is resolved from the catalog by object_id and
 * bracket-quoted into `@objname`; the new bare name is bound as `@p1` (never
 * interpolated). Per Microsoft Learn, `sp_rename` does NOT update the
 * `sys.sql_modules.definition` body for view/procedure/function/trigger — so we
 * flag `warningDefinitionStale` for those, surfacing Microsoft's
 * DROP+CREATE recommendation in the UI.
 */
export async function renameObject(
  server: string,
  database: string,
  group: SqlObjectGroup,
  objectId: number,
  newName: string,
): Promise<
  | { ok: true; renamed: { oldName: string; newName: string }; warningDefinitionStale?: boolean }
  | { ok: false; error: string; status: number }
> {
  if (!Number.isInteger(objectId)) return { ok: false, error: 'objectId must be an integer', status: 400 };
  const bare = (newName || '').trim();
  // sp_rename @newname must be a single-part identifier. Reject schema/bracket
  // chars so the rename can never be coerced into a multi-part move.
  if (!bare || bare.length > 128 || /[.\[\]]/.test(bare)) {
    return { ok: false, error: 'newName must be a non-empty single-part identifier (no ".", "[" or "]", ≤128 chars)', status: 400 };
  }
  try {
    const hit = await resolveObject(server, database, group, objectId);
    if (!hit) return { ok: false, error: `${group} not found for object_id ${objectId}`, status: 404 };
    const objname = `${bracket(hit.schema)}.${bracket(hit.name)}`;
    // @p0 = bracket-quoted catalog name, @p1 = user-supplied bare new name.
    await executeParameterized(
      server, database,
      "EXEC sys.sp_rename @objname = @p0, @newname = @p1, @objtype = 'OBJECT';",
      [objname, bare],
    );
    const warningDefinitionStale = group === 'view' || group === 'procedure' || group === 'function';
    return {
      ok: true,
      renamed: { oldName: `${hit.schema}.${hit.name}`, newName: `${hit.schema}.${bare}` },
      ...(warningDefinitionStale ? { warningDefinitionStale: true } : {}),
    };
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return { ok: false, error: e?.message || String(e), status };
  }
}

// ============================================================
// Data preview (SELECT TOP 1000 — catalog-resolved table/view name)
// ============================================================

/**
 * Return the top-N rows of a table/view as a {@link QueryResult}. The
 * schema/name come exclusively from `sys.objects` (resolved by the integer
 * object_id) and are bracket-quoted into the SELECT, so there is no
 * string-injection path. Defaults to 1000 rows (capped at 5000).
 */
export async function previewObject(
  server: string,
  database: string,
  objectId: number,
  top = 1000,
): Promise<
  | { ok: true; result: QueryResult; objectName: string }
  | { ok: false; error: string; status: number }
> {
  if (!Number.isInteger(objectId)) return { ok: false, error: 'objectId must be an integer', status: 400 };
  const n = Math.max(1, Math.min(5000, Math.floor(top)));
  try {
    const rows = await executeParameterized<any>(
      server, database,
      `SELECT s.name AS [schema], o.name AS name
       FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE o.object_id = @p0 AND o.is_ms_shipped = 0 AND o.type IN ('U','V');`,
      [objectId],
    );
    const hit = rows[0];
    if (!hit) return { ok: false, error: `table/view not found for object_id ${objectId}`, status: 404 };
    const fq = `${bracket(String(hit.schema))}.${bracket(String(hit.name))}`;
    const result = await executeQuery(server, database, `SELECT TOP ${n} * FROM ${fq};`);
    return { ok: true, result, objectName: `${hit.schema}.${hit.name}` };
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return { ok: false, error: e?.message || String(e), status };
  }
}

// ============================================================
// Script as CREATE / ALTER / DROP
// ============================================================

/** Format a SQL type with its length/precision/scale the SSMS way. */
function formatSqlType(typeName: string, maxLength: number, precision: number, scale: number): string {
  const t = typeName.toLowerCase();
  if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) {
    const len = maxLength === -1 ? 'max' : maxLength;
    return `${t}(${len})`;
  }
  if (['nvarchar', 'nchar'].includes(t)) {
    const len = maxLength === -1 ? 'max' : maxLength / 2;
    return `${t}(${len})`;
  }
  if (['decimal', 'numeric'].includes(t)) return `${t}(${precision},${scale})`;
  if (['datetime2', 'time', 'datetimeoffset'].includes(t) && scale > 0) return `${t}(${scale})`;
  return t;
}

/** Build a CREATE TABLE … (and CREATE INDEX for secondary indexes) from the catalog. */
async function scriptTableCreate(server: string, database: string, objectId: number, schema: string, name: string): Promise<string> {
  const cols = await executeParameterized<any>(
    server, database,
    `SELECT c.column_id AS columnId, c.name AS name, ty.name AS typeName,
            c.max_length AS maxLength, c.precision AS prec, c.scale AS scale,
            c.is_nullable AS isNullable, c.is_identity AS isIdentity,
            c.is_computed AS isComputed, c.collation_name AS collationName,
            ic.seed_value AS seedValue, ic.increment_value AS incrementValue,
            cc.definition AS computedDefinition, cc.is_persisted AS isPersisted,
            dc.definition AS defaultDefinition
     FROM sys.columns c
     JOIN sys.types ty ON ty.user_type_id = c.user_type_id
     LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
     LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
     LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
     WHERE c.object_id = @p0
     ORDER BY c.column_id;`,
    [objectId],
  );
  const pk = await executeParameterized<any>(
    server, database,
    `SELECT kc.name AS pkName, i.type_desc AS typeDesc,
            (SELECT STRING_AGG('[' + REPLACE(col.name, ']', ']]') + '] '
                    + CASE WHEN icx.is_descending_key = 1 THEN 'DESC' ELSE 'ASC' END, ', ')
                    WITHIN GROUP (ORDER BY icx.key_ordinal)
             FROM sys.index_columns icx
             JOIN sys.columns col ON col.object_id = icx.object_id AND col.column_id = icx.column_id
             WHERE icx.object_id = kc.parent_object_id AND icx.index_id = i.index_id) AS keyCols
     FROM sys.key_constraints kc
     JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
     WHERE kc.parent_object_id = @p0 AND kc.type = 'PK';`,
    [objectId],
  );

  const lines = cols.map((c) => {
    const colName = bracket(String(c.name));
    if (c.isComputed && c.computedDefinition) {
      return `    ${colName} AS ${c.computedDefinition}${c.isPersisted ? ' PERSISTED' : ''}`;
    }
    const typ = formatSqlType(String(c.typeName), Number(c.maxLength), Number(c.prec), Number(c.scale));
    let line = `    ${colName} ${typ}`;
    if (c.collationName) line += ` COLLATE ${c.collationName}`;
    if (c.isIdentity) line += ` IDENTITY(${Number(c.seedValue ?? 1)},${Number(c.incrementValue ?? 1)})`;
    line += c.isNullable ? ' NULL' : ' NOT NULL';
    if (c.defaultDefinition) line += ` DEFAULT ${c.defaultDefinition}`;
    return line;
  });

  const pkRow = pk[0];
  if (pkRow && pkRow.keyCols) {
    const clustered = String(pkRow.typeDesc || '').toUpperCase().includes('NONCLUSTERED') ? 'NONCLUSTERED' : 'CLUSTERED';
    lines.push(`    CONSTRAINT ${bracket(String(pkRow.pkName))} PRIMARY KEY ${clustered} (${pkRow.keyCols})`);
  }

  let ddl = `CREATE TABLE ${bracket(schema)}.${bracket(name)} (\n${lines.join(',\n')}\n);`;

  // Secondary (non-PK, non-unique-constraint) indexes as separate CREATE INDEX.
  const ixs = await listIndexes(server, database, objectId);
  for (const ix of ixs) {
    if (ix.isPrimaryKey || ix.isUniqueConstraint || !ix.keyColumns) continue;
    ddl += `\n${scriptCreateIndex(ix, schema, name)}`;
  }
  return ddl;
}

/** Build a runnable CREATE INDEX statement from a {@link SqlIndexRow}. */
function scriptCreateIndex(ix: SqlIndexRow, schema: string, table: string): string {
  const clustered = ix.typeDesc.toUpperCase().includes('NONCLUSTERED') ? 'NONCLUSTERED'
    : ix.typeDesc.toUpperCase().includes('CLUSTERED') ? 'CLUSTERED' : 'NONCLUSTERED';
  let s = `CREATE ${ix.isUnique ? 'UNIQUE ' : ''}${clustered} INDEX ${bracket(ix.name)} ON ${bracket(schema)}.${bracket(table)} (${ix.keyColumns})`;
  if (ix.includeColumns) s += ` INCLUDE (${ix.includeColumns})`;
  if (ix.filterDefinition) s += ` WHERE ${ix.filterDefinition}`;
  return `${s};`;
}

/** Build CREATE TYPE … AS TABLE from the catalog (table-type columns). */
async function scriptTableTypeCreate(server: string, database: string, objectId: number, schema: string, name: string): Promise<string> {
  const cols = await executeParameterized<any>(
    server, database,
    `SELECT c.name AS name, ty.name AS typeName, c.max_length AS maxLength,
            c.precision AS prec, c.scale AS scale, c.is_nullable AS isNullable,
            c.collation_name AS collationName
     FROM sys.columns c
     JOIN sys.types ty ON ty.user_type_id = c.user_type_id
     WHERE c.object_id = @p0
     ORDER BY c.column_id;`,
    [objectId],
  );
  const lines = cols.map((c) => {
    const typ = formatSqlType(String(c.typeName), Number(c.maxLength), Number(c.prec), Number(c.scale));
    let line = `    ${bracket(String(c.name))} ${typ}`;
    if (c.collationName) line += ` COLLATE ${c.collationName}`;
    line += c.isNullable ? ' NULL' : ' NOT NULL';
    return line;
  });
  return `CREATE TYPE ${bracket(schema)}.${bracket(name)} AS TABLE (\n${lines.join(',\n')}\n);`;
}

/**
 * Script an object as CREATE / ALTER / DROP DDL.
 *
 *   - view / procedure / function → the exact `sys.sql_modules.definition` body
 *     (CREATE as-is; ALTER = swap the leading CREATE→ALTER; DROP = generated).
 *   - table → reconstructed CREATE TABLE (+ CREATE INDEX) from the catalog
 *     (ALTER is N/A for whole tables — returns the CREATE with a note); DROP TABLE.
 *   - table-type → reconstructed CREATE TYPE … AS TABLE; DROP TYPE.
 *   - index → CREATE/DROP INDEX from sys.indexes (requires `indexId`).
 *
 * All identifiers come from the catalog and are bracket-quoted; no caller string
 * is interpolated into the emitted DDL.
 */
export async function scriptObject(
  server: string,
  database: string,
  group: ScriptGroup,
  objectId: number,
  variant: ScriptVariant,
  indexId?: number,
): Promise<{ ok: true; script: string } | { ok: false; error: string; status: number }> {
  if (!Number.isInteger(objectId)) return { ok: false, error: 'objectId must be an integer', status: 400 };
  try {
    // ---- Index scripting (object_id = table, indexId = the index) ----
    if (group === 'index') {
      if (!Number.isInteger(indexId)) return { ok: false, error: 'indexId is required to script an index', status: 400 };
      const ixs = await listIndexes(server, database, objectId);
      const ix = ixs.find((i) => i.indexId === indexId);
      const resolved = await resolveObject(server, database, 'table', objectId);
      if (!ix || !resolved) return { ok: false, error: `index ${indexId} not found on object_id ${objectId}`, status: 404 };
      if (variant === 'DROP') {
        return { ok: true, script: `DROP INDEX ${bracket(ix.name)} ON ${bracket(resolved.schema)}.${bracket(resolved.name)};` };
      }
      return { ok: true, script: scriptCreateIndex(ix, resolved.schema, resolved.name) };
    }

    // ---- Module-backed objects (view / procedure / function) ----
    if (group === 'view' || group === 'procedure' || group === 'function') {
      const resolved = await resolveObject(server, database, group, objectId);
      if (!resolved) return { ok: false, error: `${group} not found for object_id ${objectId}`, status: 404 };
      const fq = `${bracket(resolved.schema)}.${bracket(resolved.name)}`;
      const keyword = DROP_KEYWORD[group]; // VIEW / PROCEDURE / FUNCTION
      if (variant === 'DROP') {
        return { ok: true, script: `DROP ${keyword} IF EXISTS ${fq};` };
      }
      const mod = await executeParameterized<any>(
        server, database,
        `SELECT m.definition AS definition
         FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id
         WHERE m.object_id = @p0 AND o.is_ms_shipped = 0;`,
        [objectId],
      );
      const def = mod[0]?.definition ? String(mod[0].definition) : '';
      if (!def) {
        return { ok: false, error: `definition unavailable for ${group} ${fq} — the console identity needs VIEW DEFINITION on this object`, status: 403 };
      }
      if (variant === 'ALTER') {
        // Swap the first leading CREATE for ALTER (definition starts with CREATE <kw>).
        return { ok: true, script: def.replace(/\bCREATE\b/i, 'ALTER') };
      }
      return { ok: true, script: def };
    }

    // ---- Table ----
    if (group === 'table') {
      const resolved = await resolveObject(server, database, 'table', objectId);
      if (!resolved) return { ok: false, error: `table not found for object_id ${objectId}`, status: 404 };
      const fq = `${bracket(resolved.schema)}.${bracket(resolved.name)}`;
      if (variant === 'DROP') return { ok: true, script: `DROP TABLE IF EXISTS ${fq};` };
      const create = await scriptTableCreate(server, database, objectId, resolved.schema, resolved.name);
      if (variant === 'ALTER') {
        return { ok: true, script: `-- ALTER of a whole table is not a single statement; the CREATE script is shown.\n-- Edit and run from the Query tab to recreate ${resolved.schema}.${resolved.name}.\n${create}` };
      }
      return { ok: true, script: create };
    }

    // ---- Table type ----
    if (group === 'table-type') {
      const resolved = await resolveObject(server, database, 'table-type', objectId);
      if (!resolved) return { ok: false, error: `table type not found for object_id ${objectId}`, status: 404 };
      const fq = `${bracket(resolved.schema)}.${bracket(resolved.name)}`;
      if (variant === 'DROP') return { ok: true, script: `DROP TYPE ${fq};` };
      const create = await scriptTableTypeCreate(server, database, objectId, resolved.schema, resolved.name);
      if (variant === 'ALTER') {
        return { ok: true, script: `-- Table types cannot be altered in place — DROP + CREATE to change them.\n${create}` };
      }
      return { ok: true, script: create };
    }

    return { ok: false, error: `unsupported script group: ${group}`, status: 400 };
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return { ok: false, error: e?.message || String(e), status };
  }
}
