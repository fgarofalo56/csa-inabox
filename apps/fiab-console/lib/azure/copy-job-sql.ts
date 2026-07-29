/**
 * lib/azure/copy-job-sql.ts — validated T-SQL construction for the copy-job
 * pipeline payload.
 *
 * WHY THIS FILE EXISTS (security — second-order SQL injection):
 *   `app/api/items/copy-job/[id]/run` does NOT execute its SQL locally. It ships
 *   the SQL inside an Azure Data Factory pipeline definition
 *   (`typeProperties.source.sqlReaderQuery`, `sink.preCopyScript`, and Script
 *   activity `scripts[].text`) and ADF then executes it against the linked
 *   services — including `loom-copy-control-sql`, the SHARED control database
 *   that holds every copy job's watermark / CDC LSN checkpoint, as the FACTORY'S
 *   managed identity.
 *
 *   Because the sink is a JSON body posted to ARM rather than a local
 *   `query()` call, neither CodeQL's `js/sql-injection` nor
 *   `scripts/ci/check-sql-quoting.mjs` saw it: the route interpolated the
 *   caller-supplied `sourceName` / `sourceTable` / `watermarkCol` /
 *   `cdcCaptureInstance` / `sink.table` straight into SQL text with no quoting
 *   at all. `scripts/ci/check-sql-quoting.mjs` RULE C now forbids that shape;
 *   this module is where the quoting lives.
 *
 * EVERY export here validates first and quotes second, and throws
 * {@link CopyJobSqlError} rather than emitting anything it could not prove safe
 * — so the route cannot construct a divergent statement by construction.
 *
 * Grounded in:
 *   T-SQL delimited identifiers — https://learn.microsoft.com/sql/relational-databases/databases/database-identifiers
 *   ADF Script activity          — https://learn.microsoft.com/azure/data-factory/transform-data-using-script
 *   CDC net-changes function     — https://learn.microsoft.com/sql/relational-databases/system-functions/cdc-fn-cdc-get-net-changes-capture-instance-transact-sql
 */

import { bracket, escapeSqlLiteral } from '@/lib/sql/quoting';

export class CopyJobSqlError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'CopyJobSqlError';
  }
}

/**
 * One identifier part. Deliberately narrower than what T-SQL permits inside
 * brackets: a guided wizard only ever produces catalog object names, so the
 * closed set below covers every realistic name while leaving no room for a
 * delimiter, a statement terminator, or a comment introducer.
 */
const IDENT_PART_RE = /^[A-Za-z_][A-Za-z0-9_$#@ -]{0,127}$/;

/**
 * A CDC capture instance is spliced into an OBJECT NAME
 * (`cdc.fn_cdc_get_net_changes_<instance>`), where bracketing cannot help
 * because the prefix and the instance form one identifier. Restrict it to the
 * `sys.sp_cdc_enable_table` default grammar (`<schema>_<table>`): letters,
 * digits and underscores only.
 */
const CAPTURE_INSTANCE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Validate + bracket ONE identifier part. Throws on anything unproven. */
export function copyJobIdent(raw: unknown, label: string): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) throw new CopyJobSqlError(`${label} is required`);
  if (!IDENT_PART_RE.test(v)) {
    throw new CopyJobSqlError(
      `${label} "${v}" is not a valid SQL identifier — use letters, digits, spaces, _ - $ # @ (max 128, starting with a letter or underscore).`,
    );
  }
  return bracket(v);
}

/**
 * Validate + bracket a (optionally schema-qualified) table reference into
 * `[schema].[table]`. An unqualified name defaults to the `dbo` schema, which is
 * what `splitTable()` in the route already assumed.
 */
export function copyJobTable(raw: unknown, label: string): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) throw new CopyJobSqlError(`${label} is required`);
  const i = v.indexOf('.');
  const schema = i < 0 ? 'dbo' : v.slice(0, i);
  const table = i < 0 ? v : v.slice(i + 1);
  if (table.includes('.')) {
    throw new CopyJobSqlError(`${label} "${v}" must be "table" or "schema.table" (at most one dot).`);
  }
  return `${copyJobIdent(schema, `${label} schema`)}.${copyJobIdent(table, `${label} table`)}`;
}

/**
 * Quote a value for embedding in a T-SQL string literal. Delegates the doubling
 * rule to the audited `escapeSqlLiteral` and emits the unicode `N'…'` form the
 * control-table columns (`nvarchar`) expect.
 */
export function copyJobLiteral(raw: unknown): string {
  return `N'${escapeSqlLiteral(String(raw ?? ''))}'`;
}

/** Validate a CDC capture-instance name (spliced into an object name). */
export function copyJobCaptureInstance(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) throw new CopyJobSqlError('a CDC capture instance is required');
  if (!CAPTURE_INSTANCE_RE.test(v)) {
    throw new CopyJobSqlError(
      `CDC capture instance "${v}" is not valid — sys.sp_cdc_enable_table names use letters, digits and underscores only (max 128).`,
    );
  }
  return v;
}

// ── Statement builders (the only SQL the route ships) ────────────────────────

/** `TRUNCATE TABLE [schema].[table]` — the Overwrite write-mode pre-copy script. */
export function buildTruncateSql(sinkTable: unknown): string {
  return `TRUNCATE TABLE ${copyJobTable(sinkTable, 'destination table')}`;
}

/** `SELECT * FROM [schema].[table]` — the Full-mode source read. */
export function buildFullSelectSql(sourceTable: unknown): string {
  return `SELECT * FROM ${copyJobTable(sourceTable, 'source table')}`;
}

/**
 * Watermark lookup against the SHARED control DB. `source` / `table_name` are
 * bound as escaped `N''` literals — this is the statement that previously let a
 * crafted `sourceName` break out of the literal and run arbitrary T-SQL against
 * `loom-control` as the factory MI.
 */
export function buildWatermarkLookupSql(
  sourceName: unknown,
  sourceTable: unknown,
  column: 'last_value' | 'last_lsn_hex',
): string {
  const projection =
    column === 'last_value'
      ? "SELECT ISNULL(last_value, '1900-01-01T00:00:00Z') AS last_value "
      : 'SELECT last_value AS last_lsn_hex ';
  return (
    projection +
    `FROM dbo.copy_watermark WHERE source = ${copyJobLiteral(sourceName)} ` +
    `AND table_name = ${copyJobLiteral(sourceTable)}`
  );
}

/** `SELECT MAX([col]) AS new_value FROM [schema].[table]` — new-watermark probe. */
export function buildMaxWatermarkSql(watermarkCol: unknown, sourceTable: unknown): string {
  return (
    `SELECT MAX(${copyJobIdent(watermarkCol, 'watermark column')}) AS new_value ` +
    `FROM ${copyJobTable(sourceTable, 'source table')}`
  );
}

/**
 * The bounded incremental read. `oldExpr` / `newExpr` are ADF pipeline
 * EXPRESSIONS (`@{activity(...)}`) authored by this codebase, never by a
 * caller — they are the one intentional interpolation and are asserted to match
 * the ADF activity-output grammar so a future edit cannot smuggle a value in.
 */
export function buildBoundedSelectSql(
  sourceTable: unknown,
  watermarkCol: unknown,
  oldExpr: string,
  newExpr: string,
): string {
  const col = copyJobIdent(watermarkCol, 'watermark column');
  return (
    `SELECT * FROM ${copyJobTable(sourceTable, 'source table')} ` +
    `WHERE ${col} > '${assertAdfExpression(oldExpr)}' AND ${col} <= '${assertAdfExpression(newExpr)}'`
  );
}

/** The CDC net-changes read (`cdc.fn_cdc_get_net_changes_<instance>`). */
export function buildCdcNetChangesSql(
  captureInstance: unknown,
  oldLsnExpr: string,
  maxLsnExpr: string,
): string {
  const inst = copyJobCaptureInstance(captureInstance);
  return (
    `DECLARE @from_lsn binary(10) = CONVERT(binary(10), '${assertAdfExpression(oldLsnExpr)}', 1); ` +
    `DECLARE @to_lsn binary(10) = CONVERT(binary(10), '${assertAdfExpression(maxLsnExpr)}', 1); ` +
    `IF @from_lsn IS NULL SET @from_lsn = sys.fn_cdc_get_min_lsn('${inst}'); ` +
    `ELSE SET @from_lsn = sys.fn_cdc_increment_lsn(@from_lsn); ` +
    `SELECT * FROM cdc.fn_cdc_get_net_changes_${inst}(@from_lsn, @to_lsn, 'all');`
  );
}

/**
 * ADF activity-output expressions are the ONLY thing this module interpolates
 * verbatim. They are compile-time constants in the route; asserting the grammar
 * here means a refactor that accidentally routes a request value through this
 * argument fails loudly instead of reopening the injection.
 */
const ADF_ACTIVITY_OUTPUT_RE =
  /^@\{activity\('[A-Za-z][A-Za-z0-9]{0,63}'\)\.output\.resultSets\[0\]\.rows\[0\]\.[A-Za-z_][A-Za-z0-9_]{0,63}\}$/;

export function assertAdfExpression(expr: string): string {
  if (!ADF_ACTIVITY_OUTPUT_RE.test(expr)) {
    throw new CopyJobSqlError('internal: only ADF activity-output expressions may be interpolated into copy-job SQL');
  }
  return expr;
}
