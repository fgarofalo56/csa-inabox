/**
 * kusto-rls-predicate — dependency-free validator for an Azure Data Explorer /
 * Eventhouse Row-Level Security (RLS) query.
 *
 * Kept in its own module (no Azure SDK imports) so it can be unit-tested in
 * isolation and imported by both the BFF (`/api/adx/rls`) and the RLS dialog's
 * client-side pre-check. This is the Kusto sibling of `rls-predicate.ts` (which
 * validates the T-SQL Synapse RLS predicate) — the syntax is completely
 * different (KQL, not T-SQL), so it gets its own rules.
 *
 * The ADX RLS `Query` is a full KQL expression string embedded into
 * `.alter table T policy row_level_security enable "<query>"`. It is commonly:
 *   - inline KQL, e.g. `T | where current_principal_is_member_of('aadgroup=...')`
 *   - a stored-function call, e.g. `MyRlsFunction()`
 * We cannot fully parse KQL client-side (no KQL parser available), so we block
 * the obviously-dangerous / clearly-invalid shapes and surface advisory hints
 * for the rest; the cluster itself rejects anything that is still invalid KQL.
 */

/** Practical cap for an RLS query string (ADX has no hard limit). */
export const KUSTO_RLS_QUERY_MAX = 4000;

/**
 * Control commands are NOT valid inside an RLS query (it must be a query
 * expression, not a `.command`). Blocking them also closes a command-injection
 * vector even though the command is embedded in a double-quoted literal.
 */
const FORBIDDEN_DOT_COMMAND = /(^|[\s(|])\.(create|drop|alter|append|set|ingest|delete|purge|rename|move|show|execute)\b/i;

/**
 * Validate a Kusto RLS query string.
 *
 * Rules:
 *   - non-empty (when enabling)
 *   - length <= KUSTO_RLS_QUERY_MAX
 *   - no embedded control command (`.create` / `.drop` / `.ingest` / …)
 *   - no statement separator `;` (an RLS query is a single expression)
 *   - advisory (NOT a hard block): warns when the query references neither
 *     `current_principal*` nor a stored-function call — most real RLS predicates
 *     filter by the calling principal, but a constant-false predicate is valid.
 */
export function validateKustoRlsQuery(query: string): { ok: boolean; error?: string; warning?: string } {
  const s = (query ?? '').trim();
  if (!s) {
    return { ok: false, error: 'RLS query is empty. Enter a KQL predicate (e.g. a `| where current_principal_is_member_of(...)` expression) or a stored-function call.' };
  }
  if (s.length > KUSTO_RLS_QUERY_MAX) {
    return { ok: false, error: `RLS query too long (${s.length} / ${KUSTO_RLS_QUERY_MAX} characters).` };
  }
  if (FORBIDDEN_DOT_COMMAND.test(s)) {
    return { ok: false, error: 'RLS query must be a KQL expression — it cannot contain a control command (.create/.drop/.alter/.ingest/…).' };
  }
  if (s.includes(';')) {
    return { ok: false, error: 'RLS query must be a single KQL expression (no `;` statement separators).' };
  }
  const referencesPrincipal = /current_principal(_is_member_of|_details)?\s*\(/i.test(s);
  const looksLikeFunctionCall = /^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(s);
  if (!referencesPrincipal && !looksLikeFunctionCall) {
    return {
      ok: true,
      warning: "RLS query does not reference current_principal_is_member_of() / current_principal() — confirm this is intentional. Most predicates filter rows by the calling principal.",
    };
  }
  return { ok: true };
}
