/**
 * OneLake Security (F7) — pure validation + naming helpers, with NO Azure SDK
 * imports so they can be unit-tested in isolation (the Azure clients pull in
 * @azure/identity, which the symlinked pnpm store can't resolve under vitest).
 * `onelake-security-client.ts` re-exports everything here.
 */

export type OneLakeSecurityItemType = 'lakehouse' | 'mirrored-database' | 'mirrored-catalog';
export type OneLakePermission = 'Read' | 'ReadWrite';
export type SecurityRoleMemberType = 'User' | 'Group' | 'ServicePrincipal';

/** cosmosId = `${itemId}:${roleName.toLowerCase()}` — one doc per role per item. */
export function roleDocId(itemId: string, roleName: string): string {
  return `${itemId}:${roleName.toLowerCase()}`;
}

/** Fabric's documented role-name rule: starts with a letter, alphanumeric,
 *  max 128 chars. We enforce the same so an opt-in Fabric sync never rejects. */
export const ROLE_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,127}$/;

/** A path is valid when it's '*' or starts with /Tables/ or /Files/. */
export function isValidRolePath(p: string): boolean {
  if (p === '*') return true;
  return /^\/(Tables|Files)\/.+/.test(p) || /^\/(Tables|Files)$/.test(p);
}

/** Mirrored items are read-only mirrors — only Read is a valid permission. */
export function allowedPermissions(itemType: OneLakeSecurityItemType): OneLakePermission[] {
  return itemType === 'lakehouse' ? ['Read', 'ReadWrite'] : ['Read'];
}

// ── Row-Level Security (RLS) + Column-Level Security (CLS) on a role ──────────
// Extend the OneLake security role with optional per-table RLS predicates + CLS
// allowed-column sets. The reconciler (onelake-rls-reconciler.ts) materializes
// them to the SOURCE engines (Synapse SECURITY POLICY + inline TVF for RLS,
// GRANT/DENY SELECT(col) for CLS, ADX row_level_security policy); the PDP
// (lib/auth/pdp) consumes them as obligations. These validators are PURE
// (no Azure SDK) so they run under vitest + at the API + UI layer alike.

/** A row filter on a table: a validated SQL WHERE-subset predicate. */
export interface RowLevelRule { table: string; predicate: string; }
/** A column allow-list on a table (CLS): only these columns are selectable. */
export interface ColumnLevelRule { table: string; allowedColumns: string[]; }

const RLS_PREDICATE_MAX = 4000;
// Whole-word DDL/DML/exec keywords that must never appear in a row predicate.
const RLS_FORBIDDEN =
  /\b(DROP|DELETE|INSERT|UPDATE|MERGE|ALTER|CREATE|GRANT|REVOKE|DENY|TRUNCATE|EXEC|EXECUTE|SHUTDOWN|WAITFOR|OPENROWSET|OPENQUERY|OPENDATASOURCE|BULK|RECONFIGURE|BACKUP|RESTORE)\b|xp_|sp_/i;
// Allowed chars: identifiers, string/number literals, comparison + logical
// operators, parens/brackets, and the SESSION_CONTEXT/USER identity functions.
const RLS_ALLOWED_CHARS = /^[A-Za-z0-9_\s'".,()[\]=<>!+\-*/%@:]+$/;

/**
 * Validate a row-level-security predicate as a SAFE SQL WHERE subset
 * (defense-in-depth — the reconciler still parameterizes the identity value
 * where it can). Rejects statement terminators, SQL comments, backslashes,
 * DDL/DML/exec keywords, disallowed characters, and unbalanced parens/quotes.
 */
export function isValidRlsPredicate(predicate: string): { ok: boolean; error?: string } {
  const p = String(predicate || '').trim();
  if (!p) return { ok: false, error: 'predicate is empty' };
  if (p.length > RLS_PREDICATE_MAX) return { ok: false, error: `predicate exceeds ${RLS_PREDICATE_MAX} characters` };
  if (p.includes(';')) return { ok: false, error: 'predicate may not contain a statement terminator (;)' };
  if (p.includes('--') || p.includes('/*') || p.includes('*/')) return { ok: false, error: 'predicate may not contain SQL comments' };
  if (p.includes('\\')) return { ok: false, error: 'predicate may not contain a backslash' };
  if (RLS_FORBIDDEN.test(p)) return { ok: false, error: 'predicate may not contain DDL/DML/exec keywords' };
  if (!RLS_ALLOWED_CHARS.test(p)) return { ok: false, error: 'predicate contains disallowed characters' };
  let depth = 0;
  for (const ch of p) {
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth < 0) return { ok: false, error: 'unbalanced parentheses' }; }
  }
  if (depth !== 0) return { ok: false, error: 'unbalanced parentheses' };
  if ((p.match(/'/g) || []).length % 2 !== 0) return { ok: false, error: 'unbalanced single quotes' };
  return { ok: true };
}

/** A SQL/Kusto-safe column identifier: letter/underscore start, alphanumerics,
 *  optionally bracket-quoted, ≤128 chars. */
const COLUMN_IDENT_RE = /^\[?[A-Za-z_][A-Za-z0-9_ ]{0,127}\]?$/;

/** Validate a CLS allowed-column list — each a safe identifier; non-empty. */
export function isValidColumnList(cols: string[]): { ok: boolean; error?: string } {
  if (!Array.isArray(cols) || cols.length === 0) return { ok: false, error: 'at least one column is required' };
  for (const c of cols) {
    if (typeof c !== 'string' || !COLUMN_IDENT_RE.test(c.trim())) {
      return { ok: false, error: `invalid column identifier: ${JSON.stringify(c)}` };
    }
  }
  return { ok: true };
}
