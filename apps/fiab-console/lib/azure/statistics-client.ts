/**
 * Statistics + maintenance SQL generators — pure, React/Azure-SDK-free helpers
 * for the StatsMaintenanceDialog and the statistics/optimize BFF routes.
 *
 * Azure-native, NO Fabric. Two engines, the canonical Azure backends per the
 * no-fabric-dependency rule:
 *
 *   - Synapse Dedicated SQL pool  →  CREATE / UPDATE / DROP STATISTICS (T-SQL,
 *     MPP columnstore). Optimizer-statistics maintenance for the warehouse
 *     family. There is NO Delta OPTIMIZE here — Dedicated SQL pool stores data
 *     in clustered columnstore indexes, not Delta files, so file compaction
 *     does not apply (the optimize route returns code:'not_applicable').
 *
 *   - Databricks SQL Warehouse    →  ANALYZE TABLE … COMPUTE STATISTICS (cost-
 *     based-optimizer stats over Unity Catalog) + OPTIMIZE [ZORDER BY] (Delta
 *     file compaction + multi-dimensional clustering on ADLS-backed tables).
 *
 * V-Order (Fabric's write-time `spark.sql.parquet.vorder.default` Parquet layout)
 * has NO Azure 1:1 — it is surfaced in the UI as an honest intent='warning'
 * MessageBar, never executed here. This module deliberately emits no V-Order SQL.
 *
 * Injection safety: every identifier that lands in generated SQL is validated
 * against IDENT_RE *before* it is quoted (bracket-quoting for T-SQL, backtick-
 * quoting for Spark SQL). The BFF passes only the validated, quoted output to
 * executeQuery() / executeStatement(); raw user input never reaches the engine.
 * Kept free of next/Azure imports so it is unit-testable in isolation
 * (statistics-client.test.ts).
 */

/** SQL identifier guard — schema / table / stats / column names must match this
 * exactly. Matches the delta-maintenance IDENT_RE so behavior is consistent. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type Built = { ok: true; sql: string } | { ok: false; error: string };
export type IdentResult = { ok: true; value: string } | { ok: false; error: string };

/** Scan modes for CREATE STATISTICS on Synapse Dedicated SQL pool. Fixed
 * allowlist (no free-form percentages) per the no-freeform-config rule. */
export type ScanMode = 'default' | 'fullscan' | 'sample-20' | 'sample-50';
export const SCAN_MODES: ScanMode[] = ['default', 'fullscan', 'sample-20', 'sample-50'];

/** Bracket-quote a T-SQL identifier, doubling any `]`. Caller MUST have already
 * passed `name` through validateIdent — this is the second layer of defense. */
function bracket(id: string): string {
  return `[${id.replace(/]/g, ']]')}]`;
}

/** Backtick-quote a Spark SQL identifier, stripping any backtick (IDENT_RE
 * already forbids them — defense in depth). */
function backtick(id: string): string {
  return `\`${id.replace(/`/g, '')}\``;
}

/**
 * Validate a single SQL identifier. Returns the trimmed value on success or a
 * precise error (used verbatim in 400 bodies). Rejects empty strings, names
 * with spaces / quotes / semicolons / dots — i.e. anything that could break out
 * of a quoted identifier and inject SQL.
 */
export function validateIdent(name: unknown, label = 'identifier'): IdentResult {
  const v = String(name ?? '').trim();
  if (!v) return { ok: false, error: `${label} is required` };
  if (v.length > 128) return { ok: false, error: `${label} exceeds 128 characters` };
  if (!IDENT_RE.test(v)) {
    return { ok: false, error: `${label} "${v}" is not a valid SQL identifier (letters, digits, underscore; must not start with a digit)` };
  }
  return { ok: true, value: v };
}

/** Validate a list of column identifiers; returns the cleaned, de-duplicated
 * list (order preserved) or the first error. An empty input list is allowed
 * (callers decide whether that means "all columns" or "none"). */
function validateColumns(columns: unknown, label = 'column'): { ok: true; value: string[] } | { ok: false; error: string } {
  const arr = Array.isArray(columns) ? columns : [];
  const out: string[] = [];
  for (const c of arr) {
    const r = validateIdent(c, label);
    if (!r.ok) return r;
    if (!out.includes(r.value)) out.push(r.value);
  }
  return { ok: true, value: out };
}

// ============================================================
// Synapse Dedicated SQL pool — statistics DDL/DMV
// ============================================================

/**
 * List user-created statistics for one table from the system catalog. Joins
 * sys.stats → sys.stats_columns → sys.columns → sys.tables → sys.schemas and
 * filters to user_created = 1 (hides the auto-created stats the optimizer makes).
 * STATS_DATE() gives the last refresh time. Schema/table are validated and
 * embedded as string literals (IDENT_RE forbids quotes, so this is injection-safe).
 */
export function buildSynapseListStatisticsSQL(schema: unknown, table: unknown): Built {
  const s = validateIdent(schema, 'schema');
  if (!s.ok) return s;
  const t = validateIdent(table, 'table');
  if (!t.ok) return t;
  const sql =
    `SELECT st.name AS statsName,\n` +
    `       co.name AS columnName,\n` +
    `       sc.stats_column_id AS columnOrder,\n` +
    `       STATS_DATE(st.object_id, st.stats_id) AS updatedAt,\n` +
    `       st.has_filter AS hasFilter,\n` +
    `       st.auto_created AS autoCreated\n` +
    `FROM sys.stats st\n` +
    `JOIN sys.tables t ON t.object_id = st.object_id\n` +
    `JOIN sys.schemas s ON s.schema_id = t.schema_id\n` +
    `JOIN sys.stats_columns sc ON sc.stats_id = st.stats_id AND sc.object_id = st.object_id\n` +
    `JOIN sys.columns co ON co.column_id = sc.column_id AND co.object_id = st.object_id\n` +
    `WHERE s.name = '${s.value}' AND t.name = '${t.value}' AND st.user_created = 1\n` +
    `ORDER BY st.name, sc.stats_column_id;`;
  return { ok: true, sql };
}

/**
 * List the columns of a table from sys.columns — feeds the create-statistics
 * column picker (real metadata, never a free-form text box). Injection-safe via
 * the same validated-string-literal approach as the stats list.
 */
export function buildSynapseListColumnsSQL(schema: unknown, table: unknown): Built {
  const s = validateIdent(schema, 'schema');
  if (!s.ok) return s;
  const t = validateIdent(table, 'table');
  if (!t.ok) return t;
  const sql =
    `SELECT co.name AS columnName, ty.name AS dataType, co.column_id AS ordinal\n` +
    `FROM sys.columns co\n` +
    `JOIN sys.tables t ON t.object_id = co.object_id\n` +
    `JOIN sys.schemas s ON s.schema_id = t.schema_id\n` +
    `JOIN sys.types ty ON ty.user_type_id = co.user_type_id\n` +
    `WHERE s.name = '${s.value}' AND t.name = '${t.value}'\n` +
    `ORDER BY co.column_id;`;
  return { ok: true, sql };
}

/**
 * CREATE STATISTICS [stat] ON [schema].[table] ([col, …]) [WITH FULLSCAN | SAMPLE n PERCENT].
 * `default` lets Synapse choose its own sampling. At least one column is required.
 */
export function buildSynapseCreateStatisticsSQL(
  schema: unknown,
  table: unknown,
  statsName: unknown,
  columns: unknown,
  mode: ScanMode = 'default',
): Built {
  const s = validateIdent(schema, 'schema');
  if (!s.ok) return s;
  const t = validateIdent(table, 'table');
  if (!t.ok) return t;
  const n = validateIdent(statsName, 'statistics name');
  if (!n.ok) return n;
  const cols = validateColumns(columns, 'statistics column');
  if (!cols.ok) return cols;
  if (cols.value.length === 0) return { ok: false, error: 'at least one column is required to create statistics' };
  if (!SCAN_MODES.includes(mode)) return { ok: false, error: `scan mode must be one of ${SCAN_MODES.join(', ')}` };

  const colList = cols.value.map(bracket).join(', ');
  let clause = '';
  if (mode === 'fullscan') clause = ' WITH FULLSCAN';
  else if (mode === 'sample-20') clause = ' WITH SAMPLE 20 PERCENT';
  else if (mode === 'sample-50') clause = ' WITH SAMPLE 50 PERCENT';

  const sql = `CREATE STATISTICS ${bracket(n.value)} ON ${bracket(s.value)}.${bracket(t.value)} (${colList})${clause};`;
  return { ok: true, sql };
}

/**
 * UPDATE STATISTICS [schema].[table] [([stat])].
 * Omit statsName → refresh every statistics object on the table.
 */
export function buildSynapseUpdateStatisticsSQL(schema: unknown, table: unknown, statsName?: unknown): Built {
  const s = validateIdent(schema, 'schema');
  if (!s.ok) return s;
  const t = validateIdent(table, 'table');
  if (!t.ok) return t;
  const target = `${bracket(s.value)}.${bracket(t.value)}`;
  const hasName = statsName !== undefined && statsName !== null && String(statsName).trim() !== '';
  if (!hasName) return { ok: true, sql: `UPDATE STATISTICS ${target};` };
  const n = validateIdent(statsName, 'statistics name');
  if (!n.ok) return n;
  return { ok: true, sql: `UPDATE STATISTICS ${target} (${bracket(n.value)});` };
}

/**
 * DROP STATISTICS [schema].[table].[stat]  — Synapse uses the 3-part form
 * (schema.table.statsName), unlike SQL Server's 2-part DROP STATISTICS.
 */
export function buildSynapseDropStatisticsSQL(schema: unknown, table: unknown, statsName: unknown): Built {
  const s = validateIdent(schema, 'schema');
  if (!s.ok) return s;
  const t = validateIdent(table, 'table');
  if (!t.ok) return t;
  const n = validateIdent(statsName, 'statistics name');
  if (!n.ok) return n;
  return { ok: true, sql: `DROP STATISTICS ${bracket(s.value)}.${bracket(t.value)}.${bracket(n.value)};` };
}

// ============================================================
// Databricks SQL Warehouse — ANALYZE + OPTIMIZE
// ============================================================

/**
 * ANALYZE TABLE `cat`.`sch`.`tbl` COMPUTE STATISTICS [FOR ALL COLUMNS | FOR COLUMNS …].
 * Empty/undefined columns → FOR ALL COLUMNS (the optimizer's preferred default).
 */
export function buildDatabricksAnalyzeSQL(
  catalog: unknown,
  schema: unknown,
  table: unknown,
  columns?: unknown,
): Built {
  const c = validateIdent(catalog, 'catalog');
  if (!c.ok) return c;
  const s = validateIdent(schema, 'schema');
  if (!s.ok) return s;
  const t = validateIdent(table, 'table');
  if (!t.ok) return t;
  const cols = validateColumns(columns, 'statistics column');
  if (!cols.ok) return cols;
  const fq = `${backtick(c.value)}.${backtick(s.value)}.${backtick(t.value)}`;
  const forClause = cols.value.length === 0
    ? 'FOR ALL COLUMNS'
    : `FOR COLUMNS ${cols.value.map(backtick).join(', ')}`;
  return { ok: true, sql: `ANALYZE TABLE ${fq} COMPUTE STATISTICS ${forClause};` };
}

/**
 * OPTIMIZE `cat`.`sch`.`tbl` [ZORDER BY (`c1`, `c2`)].
 * Compacts small Delta files into ~1 GB files; ZORDER co-locates related values
 * for data-skipping. The Databricks SQL response carries file-level metrics
 * (numFilesAdded / numFilesRemoved) the optimize route surfaces in the receipt.
 */
export function buildDatabricksOptimizeSQL(
  catalog: unknown,
  schema: unknown,
  table: unknown,
  zorderColumns?: unknown,
): Built {
  const c = validateIdent(catalog, 'catalog');
  if (!c.ok) return c;
  const s = validateIdent(schema, 'schema');
  if (!s.ok) return s;
  const t = validateIdent(table, 'table');
  if (!t.ok) return t;
  const z = validateColumns(zorderColumns, 'ZORDER column');
  if (!z.ok) return z;
  const fq = `${backtick(c.value)}.${backtick(s.value)}.${backtick(t.value)}`;
  const zorder = z.value.length ? ` ZORDER BY (${z.value.map(backtick).join(', ')})` : '';
  return { ok: true, sql: `OPTIMIZE ${fq}${zorder};` };
}
