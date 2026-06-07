/**
 * Pure KQL control-command builder for materialized views.
 *
 * Kept in its own module (no `@azure/*` imports) so it is unit-testable in a
 * plain node environment without pulling in the Kusto REST / identity stack.
 * `kusto-client.ts` imports `buildCreateMaterializedViewCommand` from here.
 */

/** Bracket-quote a Kusto entity name: `Raw Events` → `["Raw Events"]`. */
export function bracketName(name: string): string {
  return `["${name.replace(/"/g, '\\"')}"]`;
}

/**
 * Build the `.create [async] materialized-view [with (backfill=true)] …`
 * control command.
 *
 * When `opts.backfill` is true the view is created over the source table's
 * existing data. Per ADX/Eventhouse rules a backfilling create MUST be `async`
 * (the mgmt endpoint returns an operation row rather than blocking until the
 * backfill finishes — track it with `.show operations`).
 */
export function buildCreateMaterializedViewCommand(
  name: string, sourceTable: string, query: string, opts?: { backfill?: boolean },
): string {
  const asyncKw = opts?.backfill ? 'async ' : '';
  const withClause = opts?.backfill ? 'with (backfill=true) ' : '';
  return `.create ${asyncKw}materialized-view ${withClause}${name} on table ${bracketName(sourceTable.trim())} { ${query.trim()} }`;
}
