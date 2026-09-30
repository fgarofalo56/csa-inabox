/**
 * lib/sql/quoting.ts — the single home for SQL identifier + string-literal
 * quoting across CSA Loom's server code (lib/azure + app/api).
 *
 * WHY THIS FILE EXISTS (security-adjacent):
 *   Identifier bracketing and single-quote doubling were copy-pasted ~70 times
 *   across the codebase (7 private `quoteIdent` variants + ~69 inline
 *   `.replace(/'/g, "''")` calls). Every copy is part of the SQL-injection
 *   defence, so a single divergent copy is a latent vulnerability. This module
 *   makes the escaping rules live in ONE audited place. The
 *   `scripts/ci/check-sql-quoting.mjs` guard forbids new inline copies so the
 *   surface can only shrink.
 *
 *   The escaping behaviour here is BYTE-IDENTICAL to the inline forms it
 *   replaces — the codemod that introduced it only moved the existing rule into
 *   a named function; it did not change what gets escaped.
 *
 * Grounded in the source grammars:
 *   T-SQL delimited identifiers: https://learn.microsoft.com/sql/relational-databases/databases/database-identifiers
 *   T-SQL string literals (N''): https://learn.microsoft.com/sql/t-sql/data-types/constants-transact-sql
 *   OData/$filter string literals also double the single quote (Graph, Azure AI
 *   Search), which is why the same primitive serves those callers.
 */

/**
 * SQL dialects Loom targets. The T-SQL family (`tsql` / `synapse` /
 * `generic-sql`) bracket-quotes identifiers and caps with `TOP n`; PostgreSQL
 * and Trino double-quote (ANSI delimited identifiers); MySQL and Databricks SQL
 * back-tick. `trino` is the N7e Federated-SQL engine — ANSI/SQL-standard
 * `"ident"` delimiters and `'literal'` strings, same escaping rule as postgres.
 */
export type SqlDialect =
  | 'tsql'
  | 'synapse'
  | 'generic-sql'
  | 'postgres'
  | 'trino'
  | 'mysql'
  | 'databricks-sql';

/**
 * Escape a string for embedding inside a single-quoted SQL/KQL/DAX string
 * literal — doubles every embedded single quote (`'` → `''`). Returns the INNER
 * text only (no surrounding quotes); callers wrap with `'…'` or the T-SQL
 * unicode form `N'…'` as their grammar requires.
 *
 * This is the exact rule the ~69 inline `x.replace(/'/g, "''")` sites used, now
 * in one place. It is ALSO the OData / Azure AI Search `$filter` string-literal
 * escape (identical doubling), so those callers reuse it too.
 *
 * NOTE: this only doubles the quote — it does not coerce non-strings. Callers
 * that previously wrapped the receiver in `String(...)` keep doing so, which
 * preserves byte-for-byte behaviour (e.g. `escapeSqlLiteral(String(v ?? ''))`).
 */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// Engines whose literal grammar is NOT the T-SQL one.
//
// Doubling the quote is the T-SQL / ANSI / OData / DAX rule. Two engines Loom
// sends text to read a single-quoted literal differently:
//
//   Databricks / Spark SQL — a regular literal processes backslash escape
//   sequences (`\\`, `\'`, `\n`, `\t`, `\r`, `\0`, …; `\<other char>` becomes
//   `<other char>`), and adjacent literals are chained, so `'a''b'` reads as
//   `ab`, not `a'b`. A raw literal `r'…'` has no escape character.
//   https://learn.microsoft.com/azure/databricks/sql/language-manual/data-types/string-type
//
//   KQL — a single-quoted literal escapes the enclosing quote and the backslash
//   itself with a backslash (`\'`, `\\`, plus `\t`, `\n`, `\r`), and adjacent
//   literals are concatenated, so `'a''b'` again reads as `ab`. A verbatim
//   literal `@'…'` is the exception: there the quote IS doubled (see
//   lib/azure/kql-escape.ts `kqlVerbatimSingle`).
//   https://learn.microsoft.com/kusto/query/scalar-data-types/string
//
// For both, the backslash MUST be escaped before the quote: escaping the quote
// first and the backslash second would turn the `\'` just written into `\\'`.
//
// Both helpers assume the engine's default parser settings. Spark's legacy
// `spark.sql.parser.escapedStringLiterals=true` switches escape processing off;
// Databricks SQL warehouses and Loom's Spark pools leave it at the default.
// ---------------------------------------------------------------------------

/** The engine a {@link LiteralEscapeError} was raised for. */
export type LiteralEngine = 'spark-sql' | 'kql';

/**
 * Raised when a value holds a character the target literal grammar cannot carry
 * safely: NUL, or a C0 control / DEL other than tab, LF and CR (which both
 * engines carry as `\t`, `\n`, `\r`). Callers that surface build errors as a 400
 * catch this by type. The message names the code point and its offset, never the
 * value itself, so it is safe to return to the client and to log.
 */
export class LiteralEscapeError extends Error {
  readonly engine: LiteralEngine;
  readonly codePoint: number;
  readonly index: number;
  constructor(engine: LiteralEngine, codePoint: number, index: number) {
    const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
    super(`value contains control character U+${hex} at offset ${index}, which a ${engine} string literal cannot carry`);
    this.name = 'LiteralEscapeError';
    this.engine = engine;
    this.codePoint = codePoint;
    this.index = index;
  }
}

// NUL, C0 controls except TAB (09) / LF (0A) / CR (0D), and DEL.
const UNCARRIABLE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function refuseControlChars(value: string, engine: LiteralEngine): void {
  const m = UNCARRIABLE_CONTROL.exec(value);
  if (m) throw new LiteralEscapeError(engine, m[0].charCodeAt(0), m.index);
}

/** Backslash first, then the quote, then the three carriable controls. */
function backslashEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Escape a string for the INSIDE of a regular single-quoted Databricks / Spark
 * SQL literal (`'…'`, not `r'…'`). Returns the inner text only; the caller
 * wraps it. `\` → `\\`, `'` → `\'`, TAB/LF/CR → `\t`/`\n`/`\r`.
 *
 * @throws {LiteralEscapeError} on NUL or another uncarriable control character.
 */
export function escapeSparkSqlLiteral(value: string): string {
  const s = String(value);
  refuseControlChars(s, 'spark-sql');
  return backslashEscape(s);
}

/**
 * Escape a string for the INSIDE of a regular single-quoted KQL literal (`'…'`
 * or the obfuscated `h'…'`) — Azure Data Explorer, Log Analytics / Azure
 * Monitor, and Azure Resource Graph all share this grammar. Returns the inner
 * text only. `\` → `\\`, `'` → `\'`, TAB/LF/CR → `\t`/`\n`/`\r`.
 *
 * NOT for verbatim literals (`@'…'`), whose rule is quote doubling.
 *
 * @throws {LiteralEscapeError} on NUL or another uncarriable control character.
 */
export function escapeKqlLiteral(value: string): string {
  const s = String(value);
  refuseControlChars(s, 'kql');
  return backslashEscape(s);
}

/**
 * The inner-literal escape for a {@link SqlDialect}: the Spark SQL rule for
 * `databricks-sql`, the T-SQL / ANSI doubling rule ({@link escapeSqlLiteral})
 * for every other dialect. For sites that already choose their own wrapper.
 *
 * @throws {LiteralEscapeError} for `databricks-sql` on an uncarriable control character.
 */
export function escapeLiteralFor(value: string, dialect?: SqlDialect): string {
  return dialect === 'databricks-sql' ? escapeSparkSqlLiteral(value) : escapeSqlLiteral(value);
}

/**
 * Quote a full SQL string literal: escapes per dialect AND wraps. Handles the
 * common scalar types (numbers/booleans inline, null/undefined → `NULL`).
 * The T-SQL family emits the unicode `N'…'` form; `databricks-sql` escapes with
 * the Spark SQL backslash rule ({@link escapeSparkSqlLiteral}); other dialects
 * double the quote and emit `'…'`.
 *
 * Prefer this in NEW code. The existing migration kept each call site's own
 * wrapper (`'…'` vs `N'…'`) and only centralised the inner escape via
 * {@link escapeSqlLiteral}, because the N-prefix choice was not uniformly
 * dialect-driven in the legacy code and byte-parity was the priority.
 *
 * KQL is not a {@link SqlDialect}; build KQL literals with {@link escapeKqlLiteral}.
 *
 * @throws {LiteralEscapeError} for `databricks-sql` on an uncarriable control character.
 */
export function quoteLiteral(
  value: string | number | boolean | null | undefined,
  dialect?: SqlDialect,
): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  const inner = escapeLiteralFor(String(value), dialect);
  return dialect === 'tsql' || dialect === 'synapse' ? `N'${inner}'` : `'${inner}'`;
}

/**
 * Quote a SQL identifier per dialect (injection-safe — doubles the closing
 * delimiter). The T-SQL family (and the `undefined` default) bracket-quote
 * (`]` → `]]`); PostgreSQL double-quotes (`"` → `""`); MySQL / Databricks SQL
 * back-tick (`` ` `` → ``` `` ```).
 *
 * Identifiers must be resolver-whitelisted names (real catalog objects), never
 * raw client text — dialect choice never widens the injection surface. Output
 * is byte-identical to the private `quoteIdent` copies this replaced.
 */
export function quoteIdent(name: string, dialect?: SqlDialect): string {
  switch (dialect) {
    case 'postgres':
    case 'trino':
      // ANSI delimited identifier — double-quote, doubling any embedded ".
      return `"${name.replace(/"/g, '""')}"`;
    case 'mysql':
    case 'databricks-sql':
      return '`' + name.replace(/`/g, '``') + '`';
    default:
      // tsql | synapse | generic-sql | undefined → bracket-quote.
      return `[${name.replace(/]/g, ']]')}]`;
  }
}

/**
 * Bracket-quote a T-SQL identifier (double any `]`). Thin alias for
 * `quoteIdent(name)` kept for call sites that read more clearly as `bracket`.
 */
export function bracket(name: string): string {
  return quoteIdent(name);
}
