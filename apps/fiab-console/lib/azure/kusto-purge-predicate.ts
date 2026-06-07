/**
 * Guided GDPR purge predicate builder — pure, dependency-free.
 *
 * Kept separate from kusto-client.ts (which pulls in @azure/identity + Cosmos)
 * so the structured-predicate → KQL `where` translation can be unit-tested in
 * isolation and reused without loading Azure SDKs.
 *
 * Grounded in Microsoft Learn (Data purge — predicate restrictions):
 *   https://learn.microsoft.com/kusto/concepts/data-purge?view=azure-data-explorer
 * Only scalar `where` comparisons are permitted — no pipes, no system functions
 * (ingestion_time(), extent_id()), no cross-table references. We never accept a
 * freeform predicate string; callers supply {column, op, value} parts only.
 */

export class PurgePredicateError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PurgePredicateError';
    this.status = status;
  }
}

/** The scalar comparison operators the guided predicate builder allows. */
export const PURGE_ALLOWED_OPS = ['==', '!=', '>', '<', '>=', '<=', 'contains', 'startswith'] as const;
export type PurgeOp = (typeof PURGE_ALLOWED_OPS)[number];

export interface PurgePredicatePart {
  column: string;
  op: PurgeOp;
  value: string;
}

/**
 * Build a KQL `where` clause from structured predicate parts. The op is
 * validated against PURGE_ALLOWED_OPS, columns are bracket-quoted (with `"`
 * escaped), string values are double-quoted, and numeric values are emitted
 * bare. All parts are joined with `and`.
 */
export function buildPurgeWhere(parts: PurgePredicatePart[]): string {
  if (!parts.length) throw new PurgePredicateError('At least one predicate condition is required');
  const clauses = parts.map(({ column, op, value }) => {
    if (!column.trim()) throw new PurgePredicateError('Each predicate must have a column');
    if (!(PURGE_ALLOWED_OPS as readonly string[]).includes(op)) {
      throw new PurgePredicateError(`Unsupported operator: ${op}`);
    }
    const col = `["${column.replace(/"/g, '\\"')}"]`;
    // contains / startswith take a string-literal RHS.
    if (op === 'contains' || op === 'startswith') {
      return `${col} ${op} "${value.replace(/"/g, '\\"')}"`;
    }
    // Numeric literals emitted bare; everything else quoted.
    const isNum = /^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value);
    const rhs = isNum ? value : `"${value.replace(/"/g, '\\"')}"`;
    return `${col} ${op} ${rhs}`;
  });
  return `where ${clauses.join(' and ')}`;
}
