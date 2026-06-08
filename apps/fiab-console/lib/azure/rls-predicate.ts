/**
 * rls-predicate — dependency-free sanitizer for the F8 free-form row-level
 * security WHERE predicate. Kept in its own module (no Azure SDK / mssql
 * imports) so it can be unit-tested in isolation and imported by both the BFF
 * (via synapse-permissions-client) and, if needed, client code.
 *
 * The predicate body is embedded directly into the inline TVF DDL on the
 * Synapse Dedicated SQL pool, so the rules below close every batch-injection /
 * exfiltration vector. Anything that slips past the regex but is still invalid
 * T-SQL is caught by the parse/bind probe in createRlsPolicyWithPredicate.
 */

/** Max characters for a custom RLS WHERE predicate (mirrored client-side). */
export const RLS_WHERE_MAX = 1000;

/**
 * Validate a free-form RLS WHERE predicate. Single source of truth for the
 * editor's rules:
 *   - ≤ 1000 chars
 *   - no `;`             → can't terminate the CREATE FUNCTION batch
 *   - no `--` / comments → can't comment-mask trailing DDL
 *   - no `'` literal     → can't inject a string literal
 *   - no DDL/DML/exec/set-operator/subquery keywords
 *   - must reference `@cmp` (the per-row filter-column value)
 */
export function validateWhereClause(clause: string): { ok: boolean; error?: string } {
  const s = (clause ?? '').trim();
  if (!s) return { ok: false, error: 'Predicate is empty. Enter a WHERE expression that references @cmp.' };
  if (s.length > RLS_WHERE_MAX) {
    return { ok: false, error: `Predicate too long (${s.length} / ${RLS_WHERE_MAX} characters).` };
  }
  if (/;/.test(s)) return { ok: false, error: 'Predicate must not contain a semicolon (statement terminator).' };
  if (/--|\/\*|\*\//.test(s)) return { ok: false, error: 'Predicate must not contain SQL comments (-- or /* */).' };
  if (/'/.test(s)) {
    return {
      ok: false,
      error:
        "Predicate must not contain a single-quote string literal. Compare @cmp to an identity function (USER_NAME(), SUSER_SNAME()) or another column instead.",
    };
  }
  if (
    /\b(CREATE|DROP|ALTER|TRUNCATE|INSERT|UPDATE|DELETE|MERGE|GRANT|REVOKE|DENY|EXEC|EXECUTE|OPENROWSET|OPENQUERY|OPENDATASOURCE|UNION|INTERSECT|EXCEPT|SELECT|WAITFOR|SHUTDOWN|BACKUP|RESTORE)\b/i.test(
      s,
    )
  ) {
    return {
      ok: false,
      error:
        'Predicate contains a disallowed keyword. Use a boolean expression only — no DDL/DML, subqueries, or set operators.',
    };
  }
  if (/\bxp_|\bsp_/i.test(s)) {
    return { ok: false, error: 'Predicate must not reference extended/system stored procedures.' };
  }
  if (!/@cmp\b/i.test(s)) {
    return { ok: false, error: 'Predicate must reference @cmp (the filter-column value evaluated for each row).' };
  }
  return { ok: true };
}
