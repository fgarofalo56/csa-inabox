/**
 * query-params-utils — pure (Fluent-free) parameter detection + injection-safe
 * substitution helpers shared by the SQL-editor parameter widgets (T9).
 *
 * Kept dependency-free so it can be unit-tested on the node environment without
 * pulling in the React/Fluent component graph. `query-params.tsx` re-exports
 * these alongside the `QueryParamsBar` component.
 *
 * Security invariant: substitution rewrites ONLY the `{{name}}` placeholder
 * token to the engine-native marker (`:name` Databricks / `@name` Synapse). The
 * user-supplied VALUE is never spliced into the SQL string — it travels
 * out-of-band in the parameters[] array (Databricks Statement Execution API) /
 * via req.input() → sp_executesql (mssql TDS). So a SQL metacharacter in a value
 * cannot alter the statement structure.
 */

export interface QueryParam {
  name: string;
  /** String value as typed; the backend binds it as a typed parameter. */
  value: string;
  /**
   * Optional engine hint. Databricks accepts a `type` per parameter
   * (STRING/INT/DOUBLE/DATE/TIMESTAMP/BOOLEAN). Synapse always binds NVARCHAR
   * and relies on implicit T-SQL conversion. Defaults to STRING.
   */
  type?: QueryParamType;
}

export type QueryParamType = 'STRING' | 'INT' | 'DOUBLE' | 'DATE' | 'TIMESTAMP' | 'BOOLEAN';

export const QUERY_PARAM_TYPES: QueryParamType[] = [
  'STRING', 'INT', 'DOUBLE', 'DATE', 'TIMESTAMP', 'BOOLEAN',
];

/** Matches `{{ name }}` — word chars only, optional inner whitespace. */
const PARAM_RE = /\{\{\s*(\w+)\s*\}\}/g;

/** Extract unique `{{name}}` tokens from SQL preserving first-seen order. */
export function extractParams(sql: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  let m: RegExpExecArray | null;
  PARAM_RE.lastIndex = 0;
  while ((m = PARAM_RE.exec(sql)) !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Rewrite `{{name}}` → `:name` for Databricks. Replaces ONLY the placeholder
 * token with the colon-prefixed marker; the value travels in the
 * `parameters[]` array. Injection-safe (value never reaches the SQL string).
 */
export function substituteDbx(sql: string, _params: QueryParam[]): string {
  return sql.replace(PARAM_RE, (_match, name) => `:${name}`);
}

/**
 * Rewrite `{{name}}` → `@name` for Synapse / mssql TDS. The value is bound via
 * `req.input(name, type, value)` (→ `sp_executesql @stmt, @params, …`), so the
 * value never reaches the SQL string. Injection-safe.
 */
export function substituteSynapse(sql: string, _params: QueryParam[]): string {
  return sql.replace(PARAM_RE, (_match, name) => `@${name}`);
}
