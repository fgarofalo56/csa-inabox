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
 * double-quotes; MySQL and Databricks SQL back-tick.
 */
export type SqlDialect =
  | 'tsql'
  | 'synapse'
  | 'generic-sql'
  | 'postgres'
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

/**
 * Quote a full SQL string literal: doubles embedded quotes AND wraps. Handles
 * the common scalar types (numbers/booleans inline, null/undefined → `NULL`).
 * The T-SQL family emits the unicode `N'…'` form; other dialects emit `'…'`.
 *
 * Prefer this in NEW code. The existing migration kept each call site's own
 * wrapper (`'…'` vs `N'…'`) and only centralised the inner escape via
 * {@link escapeSqlLiteral}, because the N-prefix choice was not uniformly
 * dialect-driven in the legacy code and byte-parity was the priority.
 */
export function quoteLiteral(
  value: string | number | boolean | null | undefined,
  dialect?: SqlDialect,
): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  const inner = escapeSqlLiteral(String(value));
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
