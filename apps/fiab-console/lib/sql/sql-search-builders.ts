/**
 * sql-search-builders — pure, dependency-free T-SQL generators for the SQL
 * Database "Search" management surface: Full-Text Search (FTS) catalogs +
 * indexes and SQL Server 2025 native DiskANN vector indexes.
 *
 * SECURITY MODEL (why this file is injection-safe):
 *   - Every identifier (catalog / schema / object / column / key-index) is
 *     emitted only through {@link bracket} (re-exported from tsql-builders),
 *     which wraps it in [ ] and doubles any embedded `]`. The pickers in the
 *     panel are populated from the live `sys.*` catalog, so the values are real
 *     database object names.
 *   - Free-text names (catalog name) are validated against the strict
 *     allowlist regex via {@link assertSafeName} and throw on violation.
 *   - Distance metrics, change-tracking modes, accent sensitivity, vector type,
 *     and LANGUAGE LCIDs are matched against fixed allowlists / int bounds.
 *
 * All functions return a string of T-SQL. They never touch the network — the
 * route layer executes the returned text over a real TDS + Entra-token
 * connection (see app/api/items/[type]/[id]/sql-search/route.ts). The same
 * string is what the preview-SQL pane renders before the user clicks Execute.
 *
 * Grounded in Microsoft Learn:
 *   CREATE FULLTEXT CATALOG: https://learn.microsoft.com/sql/t-sql/statements/create-fulltext-catalog-transact-sql
 *   CREATE FULLTEXT INDEX:   https://learn.microsoft.com/sql/t-sql/statements/create-fulltext-index-transact-sql
 *   DROP FULLTEXT INDEX:     https://learn.microsoft.com/sql/t-sql/statements/drop-fulltext-index-transact-sql
 *   CREATE VECTOR INDEX:     https://learn.microsoft.com/sql/t-sql/statements/create-vector-index-transact-sql
 *   sys.vector_indexes:      https://learn.microsoft.com/sql/relational-databases/system-catalog-views/sys-vector-indexes-transact-sql
 */

import { bracket, literal, TsqlBuildError } from './tsql-builders';

// Re-export so the route can throw/catch the same error class for 400-mapping.
export { TsqlBuildError } from './tsql-builders';

// A safe SQL "regular identifier" for user-supplied names (catalog name).
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
function assertSafeName(name: string, what: string): string {
  if (!SAFE_NAME.test(name || '')) {
    throw new TsqlBuildError(`${what} must match ^[A-Za-z_][A-Za-z0-9_]* (got "${name}")`);
  }
  return name;
}

function assertInt(v: unknown, what: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new TsqlBuildError(`${what} must be an integer in [${min}, ${max}] (got ${v})`);
  }
  return n;
}

// ============================================================
// Full-Text Search — option sets (allowlists)
// ============================================================

export const FT_CHANGE_TRACKING = ['AUTO', 'MANUAL', 'OFF', 'OFF, NO POPULATION'] as const;
export type FtChangeTracking = (typeof FT_CHANGE_TRACKING)[number];

export const ACCENT_SENSITIVITY = ['ON', 'OFF'] as const;
export type AccentSensitivity = (typeof ACCENT_SENSITIVITY)[number];

// Common LCIDs the portal/SSMS full-text language picker offers. Stored as
// integers — validated as an int in [0, 65535]. 1033 = English (US).
export const FT_LANGUAGES: { lcid: number; label: string }[] = [
  { lcid: 0, label: 'Neutral (no language)' },
  { lcid: 1033, label: 'English (United States)' },
  { lcid: 2057, label: 'English (United Kingdom)' },
  { lcid: 1031, label: 'German' },
  { lcid: 1036, label: 'French' },
  { lcid: 3082, label: 'Spanish' },
  { lcid: 1040, label: 'Italian' },
  { lcid: 1046, label: 'Portuguese (Brazil)' },
  { lcid: 1043, label: 'Dutch' },
  { lcid: 1041, label: 'Japanese' },
  { lcid: 2052, label: 'Chinese (Simplified)' },
  { lcid: 1042, label: 'Korean' },
  { lcid: 1049, label: 'Russian' },
];

// ============================================================
// Full-Text catalog
// ============================================================

export interface FtCatalogParams {
  catalogName: string;
  asDefault?: boolean;
  accentSensitivity?: AccentSensitivity;
}

export function buildCreateFtCatalog(p: FtCatalogParams): string {
  const name = bracket(assertSafeName(p.catalogName, 'catalog name'));
  const parts = [`CREATE FULLTEXT CATALOG ${name}`];
  if (p.accentSensitivity && ACCENT_SENSITIVITY.includes(p.accentSensitivity)) {
    parts.push(`  WITH ACCENT_SENSITIVITY = ${p.accentSensitivity}`);
  }
  if (p.asDefault) parts.push('  AS DEFAULT');
  return parts.join('\n') + ';';
}

export function buildDropFtCatalog(catalogName: string): string {
  return `DROP FULLTEXT CATALOG ${bracket(assertSafeName(catalogName, 'catalog name'))};`;
}

// ============================================================
// Full-Text index
// ============================================================

export interface FtIndexColumn {
  column: string;
  /** Optional LANGUAGE LCID for this column (0 = neutral / omit). */
  languageLcid?: number;
  /** Optional TYPE COLUMN for varbinary(max)/image document columns. */
  typeColumn?: string;
}

export interface FtIndexParams {
  schema: string;
  tableName: string;
  /** One or more columns to include in the full-text index. */
  columns: FtIndexColumn[];
  /** The unique single-column non-nullable index used as the FT KEY INDEX. */
  keyIndex: string;
  /** Catalog the index belongs to. */
  catalogName: string;
  changeTracking?: FtChangeTracking;
}

export function buildCreateFtIndex(p: FtIndexParams): string {
  if (!Array.isArray(p.columns) || p.columns.length === 0) {
    throw new TsqlBuildError('at least one column is required for a full-text index');
  }
  const obj = `${bracket(p.schema)}.${bracket(p.tableName)}`;
  const cols = p.columns.map((c) => {
    let clause = bracket(c.column);
    if (c.typeColumn) clause += ` TYPE COLUMN ${bracket(c.typeColumn)}`;
    if (c.languageLcid) {
      const lcid = assertInt(c.languageLcid, 'LANGUAGE LCID', 0, 65535);
      if (lcid !== 0) clause += ` LANGUAGE ${lcid}`;
    }
    return `    ${clause}`;
  });
  const keyIndex = bracket(p.keyIndex);
  const catalog = bracket(assertSafeName(p.catalogName, 'catalog name'));
  const ct = p.changeTracking && FT_CHANGE_TRACKING.includes(p.changeTracking)
    ? p.changeTracking
    : 'AUTO';
  return [
    `CREATE FULLTEXT INDEX ON ${obj}`,
    `(`,
    cols.join(',\n'),
    `)`,
    `KEY INDEX ${keyIndex} ON ${catalog}`,
    `WITH CHANGE_TRACKING ${ct};`,
  ].join('\n');
}

export function buildDropFtIndex(schema: string, tableName: string): string {
  return `DROP FULLTEXT INDEX ON ${bracket(schema)}.${bracket(tableName)};`;
}

// ============================================================
// SQL Server 2025 — DiskANN vector index
// ============================================================

export const VECTOR_METRICS = ['cosine', 'dot', 'euclidean'] as const;
export type VectorMetric = (typeof VECTOR_METRICS)[number];

export const VECTOR_TYPES = ['DiskANN'] as const;
export type VectorType = (typeof VECTOR_TYPES)[number];

export interface VectorIndexParams {
  indexName: string;
  schema: string;
  tableName: string;
  vectorColumn: string;
  metric: VectorMetric;
  /** Only DiskANN is supported today; default DiskANN. */
  type?: VectorType;
  /** MAXDOP override (0 = server default). */
  maxdop?: number;
}

export function buildCreateVectorIndex(p: VectorIndexParams): string {
  const metric = VECTOR_METRICS.includes(p.metric) ? p.metric : 'cosine';
  const type = p.type && VECTOR_TYPES.includes(p.type) ? p.type : 'DiskANN';
  const idx = bracket(assertSafeName(p.indexName, 'index name'));
  const obj = `${bracket(p.schema)}.${bracket(p.tableName)}`;
  const col = bracket(p.vectorColumn);
  const opts = [`METRIC = ${literal(metric)}`, `TYPE = ${literal(type)}`];
  if (p.maxdop !== undefined && p.maxdop !== null) {
    const md = assertInt(p.maxdop, 'MAXDOP', 0, 64);
    if (md !== 0) opts.push(`MAXDOP = ${md}`);
  }
  return [
    `CREATE VECTOR INDEX ${idx}`,
    `ON ${obj} (${col})`,
    `WITH (`,
    `    ${opts.join(',\n    ')}`,
    `);`,
  ].join('\n');
}

export function buildDropVectorIndex(indexName: string, schema: string, tableName: string): string {
  // Vector indexes are dropped with the standard DROP INDEX ... ON object.
  return `DROP INDEX ${bracket(assertSafeName(indexName, 'index name'))} ON ${bracket(schema)}.${bracket(tableName)};`;
}

// ============================================================
// Wizard dispatch (route builds SQL from structured params only)
// ============================================================

export type SearchWizardKind =
  | 'ft-catalog'
  | 'ft-catalog-drop'
  | 'ft-index'
  | 'ft-index-drop'
  | 'vector-index'
  | 'vector-index-drop';

export function buildSearchWizardSql(wizard: SearchWizardKind, params: any): string {
  switch (wizard) {
    case 'ft-catalog':
      return buildCreateFtCatalog(params as FtCatalogParams);
    case 'ft-catalog-drop':
      return buildDropFtCatalog(String(params?.catalogName || ''));
    case 'ft-index':
      return buildCreateFtIndex(params as FtIndexParams);
    case 'ft-index-drop':
      return buildDropFtIndex(String(params?.schema || ''), String(params?.tableName || ''));
    case 'vector-index':
      return buildCreateVectorIndex(params as VectorIndexParams);
    case 'vector-index-drop':
      return buildDropVectorIndex(
        String(params?.indexName || ''),
        String(params?.schema || ''),
        String(params?.tableName || ''),
      );
    default:
      throw new TsqlBuildError(`unknown search wizard: ${wizard}`);
  }
}

// ============================================================
// Catalog read SQL (read-only sys.* — NO user input in the text)
// ============================================================

/** Full-text catalogs in the database (state panel + FT-index catalog picker). */
export const SQL_LIST_FT_CATALOGS = `
SELECT c.name AS catalog_name,
       c.is_default AS is_default,
       c.is_accent_sensitivity_on AS accent_sensitive,
       FULLTEXTCATALOGPROPERTY(c.name, 'ItemCount') AS item_count
FROM sys.fulltext_catalogs c
ORDER BY c.name;`;

/** Existing full-text indexes with their table + catalog + change-tracking. */
export const SQL_LIST_FT_INDEXES = `
SELECT s.name AS schema_name,
       t.name AS table_name,
       c.name AS catalog_name,
       fi.is_enabled AS is_enabled,
       fi.change_tracking_state_desc AS change_tracking,
       ki.name AS key_index_name,
       STUFF((
         SELECT ', ' + col.name
         FROM sys.fulltext_index_columns fic
         JOIN sys.columns col ON col.object_id = fic.object_id AND col.column_id = fic.column_id
         WHERE fic.object_id = fi.object_id
         ORDER BY col.name
         FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '') AS columns
FROM sys.fulltext_indexes fi
JOIN sys.tables t ON t.object_id = fi.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.fulltext_catalogs c ON c.fulltext_catalog_id = fi.fulltext_catalog_id
LEFT JOIN sys.indexes ki ON ki.object_id = fi.object_id AND ki.index_id = fi.unique_index_id
ORDER BY s.name, t.name;`;

/**
 * Unique, single-column, non-nullable indexes — the only valid FT KEY INDEX
 * candidates. Keyed by schema.table for the wizard picker.
 */
export const SQL_LIST_KEY_INDEX_CANDIDATES = `
SELECT s.name AS schema_name, t.name AS table_name, i.name AS index_name
FROM sys.indexes i
JOIN sys.tables t ON t.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE i.is_unique = 1 AND i.is_disabled = 0 AND i.type IN (1, 2)
  AND t.is_ms_shipped = 0
  AND (SELECT COUNT(*) FROM sys.index_columns ic
       WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0) = 1
  AND NOT EXISTS (
       SELECT 1 FROM sys.index_columns ic2
       JOIN sys.columns col2 ON col2.object_id = ic2.object_id AND col2.column_id = ic2.column_id
       WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id
         AND ic2.is_included_column = 0 AND col2.is_nullable = 1)
ORDER BY s.name, t.name, i.name;`;

/** Full-text-indexable columns (char/varchar/text/xml/varbinary) by schema.table. */
export const SQL_LIST_FT_COLUMN_CANDIDATES = `
SELECT s.name AS schema_name, o.name AS object_name, col.name AS column_name,
       ty.name AS data_type
FROM sys.columns col
JOIN sys.objects o ON o.object_id = col.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.types ty ON ty.user_type_id = col.user_type_id
WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0
  AND ty.name IN ('char','varchar','nchar','nvarchar','text','ntext','xml','image','varbinary')
ORDER BY s.name, o.name, col.column_id;`;

/**
 * Vector-typed columns by schema.table — the create-vector-index picker.
 * `vector` is system type 0xF7 (user_type catalog name 'vector') on SQL 2025.
 */
export const SQL_LIST_VECTOR_COLUMN_CANDIDATES = `
SELECT s.name AS schema_name, o.name AS object_name, col.name AS column_name
FROM sys.columns col
JOIN sys.objects o ON o.object_id = col.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.types ty ON ty.user_type_id = col.user_type_id
WHERE o.type = 'U' AND o.is_ms_shipped = 0
  AND ty.name = 'vector'
ORDER BY s.name, o.name, col.column_id;`;

/** Existing vector indexes (SQL 2025). Empty on engines without the catalog view. */
export const SQL_LIST_VECTOR_INDEXES = `
SELECT s.name AS schema_name, t.name AS table_name,
       i.name AS index_name, vi.distance_metric AS distance_metric,
       vi.vector_index_type AS vector_index_type
FROM sys.vector_indexes vi
JOIN sys.indexes i ON i.object_id = vi.object_id AND i.index_id = vi.index_id
JOIN sys.tables t ON t.object_id = vi.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
ORDER BY s.name, t.name, i.name;`;

/** Probe engine major version + vector type availability (gates the vector UI). */
export const SQL_PROBE_SEARCH_CAPABILITIES = `
SELECT
  CAST(PARSENAME(CONVERT(varchar(64), SERVERPROPERTY('ProductVersion')), 4) AS int) AS major_version,
  CONVERT(varchar(64), SERVERPROPERTY('ProductVersion')) AS product_version,
  CASE WHEN EXISTS (SELECT 1 FROM sys.types WHERE name = 'vector') THEN 1 ELSE 0 END AS has_vector_type,
  CASE WHEN FULLTEXTSERVICEPROPERTY('IsFullTextInstalled') = 1 THEN 1 ELSE 0 END AS fts_installed;`;
