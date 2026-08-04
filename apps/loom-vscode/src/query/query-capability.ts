/**
 * Query-capability router — PURE (no `vscode`) so it is unit testable. Maps a
 * Loom item type to the bounded read surface it exposes, grounded in the REAL
 * per-item routes that exist in the Console today (and are the same ones the
 * SDK `query` resource + M2 `loom-query` MCP server call):
 *
 *   • SQL     → POST /api/items/{type}/{id}/query   body { sql, database? }
 *   • KQL     → POST /api/items/{type}/{id}/query   body { kql, db?, page? }
 *   • preview → GET  /api/items/{type}/{id}/preview?top=
 *
 * The sets are conservative on purpose (no-vaporware): a type is listed ONLY
 * when its route is verified in-tree. An item outside every set is honestly
 * gated by the command ("open it in the Console") — never routed at a URL that
 * would 404.
 */

/** SQL-capable item types (their `…/query` route reads `body.sql`). */
export const SQL_TYPES: ReadonlySet<string> = new Set([
  'synapse-serverless-sql-pool',
  'synapse-dedicated-sql-pool',
  'sql-analytics-endpoint',
  'lakehouse',
  'warehouse',
  'azure-sql-database',
  'databricks-sql-warehouse',
  'postgres-flexible-server',
  'lakebase-postgres',
]);

/** KQL-capable item types (their `…/query` route reads `body.kql`, ADX-backed). */
export const KQL_TYPES: ReadonlySet<string> = new Set(['kql-database']);

/** Item types with a tabular `…/preview` route (sampled rows → the grid). */
export const PREVIEW_TYPES: ReadonlySet<string> = new Set([
  'dataset',
  'materialized-lake-view',
  'synthetic-data',
]);

export type QueryEngine = 'sql' | 'kql';

/** What a given item type can do on the data surface. */
export interface QueryCapabilities {
  /** The engine an ad-hoc query editor would use, or undefined if none. */
  engine?: QueryEngine;
  /** Whether a bounded row-sample preview route exists for this type. */
  previewable: boolean;
}

/** Resolve the read capabilities for an item type. Total + deterministic. */
export function queryCapabilities(itemType: string): QueryCapabilities {
  const t = (itemType || '').toLowerCase();
  const engine: QueryEngine | undefined = SQL_TYPES.has(t) ? 'sql' : KQL_TYPES.has(t) ? 'kql' : undefined;
  return { engine, previewable: PREVIEW_TYPES.has(t) };
}

/** True when the item exposes ANY bounded read surface (query or preview). */
export function isDataReadable(itemType: string): boolean {
  const c = queryCapabilities(itemType);
  return !!c.engine || c.previewable;
}
