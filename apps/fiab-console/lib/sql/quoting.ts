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
// Every character, control characters included, is carried: neither helper
// throws. Both grammars accept any Unicode character in a regular literal; the
// only characters that need an escape are the backslash, the quote, and (per
// engine, below) the ones whose raw form the engine reads differently.
//
// Both helpers assume the engine's default parser settings. Spark's legacy
// `spark.sql.parser.escapedStringLiterals=true` switches escape processing off;
// Databricks SQL warehouses and Loom's Spark pools leave it at the default.
// ---------------------------------------------------------------------------

/** Two-digit octal tail: Spark reads `\0` + two of these as ONE octal escape. */
const OCTAL_DIGIT = /[0-7]/;

/**
 * Escape a string for the INSIDE of a regular single-quoted Databricks / Spark
 * SQL literal (`'…'`, not `r'…'`). Returns the inner text only; the caller
 * wraps it. Never throws.
 *
 *   `\` → `\\`, `'` → `\'`, TAB/LF/CR → `\t`/`\n`/`\r`, NUL → `\0`.
 *   Every other character, other control characters included, is passed raw —
 *   the Databricks literal grammar takes "any character from the Unicode
 *   character set".
 *
 * NUL is the one control character whose raw form is not used: it becomes the
 * documented `\0` escape. Spark's decoder (`SparkParserUtils.unescapeSQLString`)
 * also reads `\` + a three-digit octal number (`[01][0-7][0-7]`) as one
 * character, so `\0` followed by two octal digits would merge with them (`NUL`
 * then `12` would decode as LF). When the next two characters are both octal
 * digits, NUL is written as `\u0000` instead, which the same decoder reads as
 * exactly four hex digits.
 */
export function escapeSparkSqlLiteral(value: string): string {
  const s = String(value);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    switch (c) {
      case '\\': out += '\\\\'; break;
      case "'": out += "\\'"; break;
      case '\t': out += '\\t'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\u0000':
        out += OCTAL_DIGIT.test(s[i + 1] ?? '') && OCTAL_DIGIT.test(s[i + 2] ?? '') ? '\\u0000' : '\\0';
        break;
      default: out += c;
    }
  }
  return out;
}

/**
 * Escape a string for the INSIDE of a regular single-quoted KQL literal (`'…'`
 * or the obfuscated `h'…'`) — Azure Data Explorer, Log Analytics / Azure
 * Monitor, and Azure Resource Graph all share this grammar. Returns the inner
 * text only. Never throws.
 *
 *   `\` → `\\`, `'` → `\'`, TAB/LF/CR → `\t`/`\n`/`\r`, and every other C0
 *   control character and DEL → `\uXXXX` (four hex digits, the documented
 *   Unicode escape). Every other character is passed raw.
 *
 * NOT for verbatim literals (`@'…'`), whose rule is quote doubling.
 */
export function escapeKqlLiteral(value: string): string {
  const s = String(value);
  let out = '';
  for (const c of s) {
    switch (c) {
      case '\\': out += '\\\\'; break;
      case "'": out += "\\'"; break;
      case '\t': out += '\\t'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      default: {
        const cp = c.charCodeAt(0);
        out += cp <= 0x1f || cp === 0x7f ? `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}` : c;
      }
    }
  }
  return out;
}

/**
 * The inner-literal escape for a {@link SqlDialect}: the Spark SQL rule for
 * `databricks-sql`, the T-SQL / ANSI doubling rule ({@link escapeSqlLiteral})
 * for every other dialect. For sites that already choose their own wrapper.
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
