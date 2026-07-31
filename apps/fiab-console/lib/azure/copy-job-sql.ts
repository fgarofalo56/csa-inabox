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
 * WHAT IS *NOT* A DEFENCE HERE (corrected 2026-07-29):
 *   "The pipeline is rebuilt from the persisted item, not the request body" is
 *   NOT a safety property. `PUT /api/items/copy-job/[id]` stores `state`
 *   verbatim (`item-crud.updateOwnedItem` keeps `patch.state` as-is once it is
 *   an object — no schema, no allow-list), so every field this module receives
 *   is still 100% caller-authored; it merely takes one hop through Cosmos.
 *   That hop is the definition of a SECOND-ORDER injection, not a mitigation.
 *   Dropping the request-body spread removes a confusing second source of
 *   truth — the *security* boundary is the validation below, and nothing else.
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

/**
 * Validate ONE identifier part and return it UNBRACKETED. Use when the consumer
 * does its own quoting (an ADF dataset's `schema` / `table` typeProperties,
 * which the service composes into `[schema].[table]` on our behalf) — the point
 * is still that a name which cannot be a catalog object never leaves Loom.
 */
export function assertCopyJobIdent(raw: unknown, label: string): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) throw new CopyJobSqlError(`${label} is required`);
  if (!IDENT_PART_RE.test(v)) {
    throw new CopyJobSqlError(
      `${label} "${v}" is not a valid SQL identifier — use letters, digits, spaces, _ - $ # @ (max 128, starting with a letter or underscore).`,
    );
  }
  return v;
}

/** Validate + bracket ONE identifier part. Throws on anything unproven. */
export function copyJobIdent(raw: unknown, label: string): string {
  return bracket(assertCopyJobIdent(raw, label));
}

/**
 * Validate + split a (optionally schema-qualified) table reference into its raw
 * parts, for consumers that quote for themselves (ADF datasets). Same grammar
 * and same failures as {@link copyJobTable}.
 */
export function copyJobTableParts(raw: unknown, label: string): { schema: string; table: string } {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) throw new CopyJobSqlError(`${label} is required`);
  const i = v.indexOf('.');
  const schema = i < 0 ? 'dbo' : v.slice(0, i);
  const table = i < 0 ? v : v.slice(i + 1);
  if (table.includes('.')) {
    throw new CopyJobSqlError(`${label} "${v}" must be "table" or "schema.table" (at most one dot).`);
  }
  return {
    schema: assertCopyJobIdent(schema, `${label} schema`),
    table: assertCopyJobIdent(table, `${label} table`),
  };
}

/**
 * Validate + bracket a (optionally schema-qualified) table reference into
 * `[schema].[table]`. An unqualified name defaults to the `dbo` schema, which is
 * what `splitTable()` in the route already assumed.
 */
export function copyJobTable(raw: unknown, label: string): string {
  const { schema, table } = copyJobTableParts(raw, label);
  return `${bracket(schema)}.${bracket(table)}`;
}

/**
 * Quote a value for embedding in a T-SQL string literal. Delegates the doubling
 * rule to the audited `escapeSqlLiteral` and emits the unicode `N'…'` form the
 * control-table columns (`nvarchar`) expect.
 */
export function copyJobLiteral(raw: unknown): string {
  return `N'${escapeSqlLiteral(String(raw ?? ''))}'`;
}

/**
 * The linked service(s) THIS ROUTE drives itself, against the SHARED control
        + 'every tenant watermark and CDC checkpoint in the deployment. Point a copy source or sink at your own data.',
 * checkpoint), as the FACTORY'S system-assigned managed identity.
 *
 * A copy job may never name one as its OWN source or sink. Escaping the
 * identifiers and literals in the generated statements is not enough on its
 * own, because two copy-spec fields carry SQL that this module never sees:
 *
 *   • `source.query` — a documented free-form product feature ("Source query
 *     (optional override)" in the wizard) that ADF ships verbatim as the Copy
 *     activity's `sqlReaderQuery`.
 *   • `sink.table` + `writeMode: 'Overwrite'` — becomes `TRUNCATE TABLE
 *     [schema].[table]` in the sink's `preCopyScript`. `copy_watermark` is a
 *     perfectly valid identifier, so validation cannot reject it.
 *
 * Both run against whatever linked service the spec names. Pointing either at
 * the control linked service therefore reaches the shared control DB with
 * caller-authored SQL — the same impact as the injection the builders close,
 * through a field the builders do not touch. Reserving the name makes that
 * state unrepresentable instead of trying to sanitise the SQL.
 *
 * ADF artifact names are case-insensitive for uniqueness, so the comparison is
 * case-folded and trimmed.
 */
export const RESERVED_LINKED_SERVICES: readonly string[] = Object.freeze([
  'loom-copy-control-sql',
]);

const RESERVED_LS = new Set(RESERVED_LINKED_SERVICES.map((n) => n.toLowerCase()));

/**
 * Validate a caller-chosen linked-service reference for a copy job's source or
 * sink. Throws on a blank name and on any {@link RESERVED_LINKED_SERVICES}
 * entry. Returns the trimmed name to use as the ADF `referenceName`.
 */
export function assertUserLinkedService(raw: unknown, label: string): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) {
    throw new CopyJobSqlError(
      `${label} is required — configure the copy job in the wizard first`,
    );
  }
  if (RESERVED_LS.has(v.toLowerCase())) {
    throw new CopyJobSqlError(
      `"${v}" is reserved for Loom's copy-job watermark / CDC checkpoint control database and cannot be used as a copy ${label.replace(/\.linkedService$/, '')}. Pick the linked service that points at your own data.`,
    );
  }
  return v;
}

/**
 * The NAME check above is necessary but NOT sufficient, and the round-3 review
 * was right to call it bypassable: it keys on the ADF artifact NAME, while what
 * actually matters is the connection TARGET. Nothing stops a caller from
 * creating their own linked service — any name they like — whose connection
 * string points at Loom's shared control database, then naming that as a copy
 * source or sink. The reservation would pass and the SQL would still run
 * against `dbo.copy_watermark` as the factory managed identity.
 *
 * So resolve what the linked service actually POINTS AT and refuse on the
 * target. The name check stays as a cheap first pass (it needs no ARM call and
 * catches the obvious attempt), but this is the one that closes the class.
 *
 * Fails CLOSED: if the definition cannot be read we refuse, because proceeding
 * on an unknown target is exactly the gap.
 */
export async function assertUserLinkedServiceTarget(
  name: string,
  label: string,
  readLinkedService: (n: string) => Promise<{ properties?: { typeProperties?: Record<string, unknown> } }>,
): Promise<void> {
  const controlServer = (process.env.LOOM_COPYJOB_CONTROL_SQL_SERVER || '').trim().toLowerCase();
  // With no control server configured there is no shared control DB to protect.
  if (!controlServer) return;

  let def: { properties?: { typeProperties?: Record<string, unknown> } };
  try {
    def = await readLinkedService(name);
  } catch {
    throw new CopyJobSqlError(
      `${label}: could not read the linked service "${name}" to confirm what it points at. `
        + 'Refusing rather than running SQL against an unverified target.',
    );
  }

  const tp = def?.properties?.typeProperties ?? {};
  // Azure SQL linked services carry the target in a connection string (or, for
  // the newer shape, discrete server/database fields). Check whatever is present.
  const haystack = [
    typeof tp.connectionString === 'string' ? tp.connectionString : '',
    typeof (tp as { server?: unknown }).server === 'string' ? String((tp as { server?: unknown }).server) : '',
    typeof (tp as { fullyQualifiedDomainName?: unknown }).fullyQualifiedDomainName === 'string'
      ? String((tp as { fullyQualifiedDomainName?: unknown }).fullyQualifiedDomainName)
      : '',
  ].join(' ').toLowerCase();

  if (haystack.includes(controlServer)) {
    throw new CopyJobSqlError(
      `${label}: "${name}" points at Loom's copy-job control server (${controlServer}), which holds `
        + 'every tenant watermark and CDC checkpoint in the deployment. Point a copy source or sink at your own data.',
    );
  }
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

/**
 * Merge (upsert) key columns. These are not interpolated by this module — ADF
 * composes the `MERGE … ON` predicate from them service-side — so this is
 * defence in depth rather than a proven sink. It is here because the column
 * names come from the same caller-authored spec as everything else, and an
 * identifier that cannot be a column name has no legitimate reason to reach
 * the service. Returns the trimmed, de-duplicated list.
 */
export function copyJobMergeKeys(raw: unknown): string[] {
  const parts = String(raw ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of parts) {
    if (!IDENT_PART_RE.test(k)) {
      throw new CopyJobSqlError(
        `merge key "${k}" is not a valid column name — use letters, digits, spaces, _ - $ # @ (max 128, starting with a letter or underscore).`,
      );
    }
    const lower = k.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(k);
  }
  return out;
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
