/**
 * Identifier rules for lakehouse table, schema and column names that reach a
 * SQL statement or a `Tables/` path.
 *
 * A name must match {@link LAKEHOUSE_IDENT_RE} (a letter or underscore, then
 * letters, digits or underscores; at most 128 characters), and is still quoted
 * with `quoteIdent(name, 'databricks-sql')` where it enters SQL. The same rule
 * as `lib/azure/delta-maintenance.ts` uses for column names.
 */

export const LAKEHOUSE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function isLakehouseIdent(name: unknown): name is string {
  return typeof name === 'string' && LAKEHOUSE_IDENT_RE.test(name);
}

/**
 * Normalise a table name the editor may send as `orders`, `Tables/orders` or
 * `/Tables/orders`, then check it. Returns the bare name or null.
 */
export function lakehouseTableName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const bare = raw.trim().replace(/^\/+/, '').replace(/^Tables\//i, '');
  return isLakehouseIdent(bare) ? bare : null;
}

export const IDENT_RULE_TEXT =
  'a letter or underscore, then letters, digits or underscores (at most 128 characters)';
