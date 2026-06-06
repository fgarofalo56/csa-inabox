/**
 * sql-guard — validate a user-supplied query is a read-only single SELECT.
 *
 * Used by the Loom Thread edges that let a user provide a custom SQL query as
 * the source ("Build a Power BI model from a query", "Publish a query as an
 * API"). The query is always wrapped as a derived table / view by the caller
 * (no identifier interpolation), so this verb/statement check is defense in
 * depth — it keeps the query read-only and single-statement.
 */
export type SqlGuardResult = { ok: true; sql: string } | { ok: false; error: string };

export function readOnlySelect(q: string): SqlGuardResult {
  const sql = (q || '').trim().replace(/;+\s*$/, ''); // allow a single trailing semicolon
  if (!sql) return { ok: false, error: 'Enter a SQL query.' };
  if (sql.includes(';')) return { ok: false, error: 'Only a single SELECT statement is allowed (no semicolons).' };
  if (!/^(select|with)\b/i.test(sql)) return { ok: false, error: 'The query must start with SELECT (or a WITH … SELECT CTE).' };
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke)\b/i.test(sql)) {
    return { ok: false, error: 'Only read-only SELECT queries are allowed here.' };
  }
  return { ok: true, sql };
}
