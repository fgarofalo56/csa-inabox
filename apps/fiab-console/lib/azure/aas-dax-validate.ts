/**
 * aas-dax-validate — pure, dependency-free RLS DAX validator.
 *
 * Lives in its own module (no `@azure/identity` import) so the client-side
 * Security tab can run the exact same validation as the BFF without pulling the
 * node-only credential chain into the browser bundle. `aas-client.ts`
 * re-exports `validateRlsDax` from here so there is one implementation.
 */

const FORBIDDEN_DAX_KEYWORDS = /\b(EVALUATE|DEFINE|ORDER\s+BY|MEASURE\s|COLUMN\s|TABLE\s)\b/i;

/**
 * Validate an RLS `filterExpression` (a DAX boolean). Catches the common
 * mistakes before the TMSL deploy: empty, over-length, query-shaped (EVALUATE/
 * DEFINE), statement separators, and unbalanced parentheses.
 */
export function validateRlsDax(expr: string): { ok: boolean; error?: string } {
  const e = (expr || '').trim();
  if (!e) return { ok: false, error: 'Filter expression is empty.' };
  if (e.length > 4000) return { ok: false, error: 'Filter expression exceeds 4000 characters.' };
  if (e.includes(';')) {
    return { ok: false, error: 'Semicolons are not allowed in a role filter expression.' };
  }
  if (FORBIDDEN_DAX_KEYWORDS.test(e)) {
    return {
      ok: false,
      error:
        'A role filter must be a DAX boolean expression (e.g. [Region] = "East"), ' +
        'not a query. Remove EVALUATE / DEFINE / MEASURE / ORDER BY.',
    };
  }
  // Balanced parentheses.
  let depth = 0;
  for (const ch of e) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth < 0) return { ok: false, error: 'Unbalanced parentheses.' };
  }
  if (depth !== 0) return { ok: false, error: 'Unbalanced parentheses.' };
  return { ok: true };
}
