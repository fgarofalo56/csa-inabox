/**
 * Item-type → VS Code codicon id map — PURE (no `vscode` import) so it is unit
 * testable. `explorer.ts` wraps the returned id in `new vscode.ThemeIcon(id)`.
 *
 * Grounded in the same 98-entry taxonomy the CLI + SDK ship
 * (`apps/loom-cli/src/item-types.ts`). Every returned id is a real codicon so
 * the tree never renders a broken glyph.
 */

/** Explicit per-type overrides (highest priority). */
const EXACT: Record<string, string> = {
  lakehouse: 'database',
  warehouse: 'server',
  'sql-database': 'database',
  'sql-databases': 'database',
  'azure-sql-database': 'database',
  'azure-sql-managed-instance': 'database',
  'azure-sql-server': 'server',
  'postgres-flexible-server': 'database',
  'cosmos-db': 'database',
  datamart: 'database',
  dataset: 'table',
  'adf-dataset': 'table',
  notebook: 'notebook',
  'synapse-notebook': 'notebook',
  report: 'graph',
  'paginated-report': 'graph-line',
  dashboard: 'dashboard',
  'kql-dashboard': 'dashboard',
  scorecard: 'dashboard',
  'semantic-model': 'symbol-structure',
  'data-pipeline': 'run-all',
  'adf-pipeline': 'run-all',
  'synapse-pipeline': 'run-all',
  'geo-pipeline': 'run-all',
  'copy-job': 'copy',
  eventstream: 'broadcast',
  eventhouse: 'database',
  'event-schema-set': 'json',
  'kql-database': 'database',
  'kql-queryset': 'search',
  activator: 'zap',
  'stream-analytics-job': 'pulse',
  'spark-job-definition': 'flame',
  'spark-environment': 'server-environment',
  environment: 'server-environment',
  'release-environment': 'server-environment',
  'ml-model': 'beaker',
  'ml-experiment': 'beaker',
  automl: 'beaker',
  evaluation: 'checklist',
  'prompt-flow': 'symbol-event',
  'ai-foundry-project': 'rocket',
  'ai-search-index': 'search',
  'vector-store': 'symbol-array',
  'sql-server-2025-vector-index': 'symbol-array',
  'content-safety': 'shield',
  'data-agent': 'robot',
  'operations-agent': 'robot',
  'copilot-studio-agent': 'robot',
  'gql-graph': 'graph',
  'cypher-graph': 'graph',
  'graph-model': 'graph',
  'cosmos-gremlin-graph': 'graph',
  'graphql-api': 'symbol-interface',
  ontology: 'symbol-class',
  'ontology-sdk': 'library',
  map: 'map',
  'geo-map': 'map',
  'geo-dataset': 'map',
  'geo-query': 'map',
  'logic-app': 'circuit-board',
  'power-automate-flow': 'circuit-board',
  'power-app': 'browser',
  'power-page': 'browser',
  'apim-api': 'plug',
  'apim-product': 'package',
  'apim-policy': 'law',
  'user-data-function': 'symbol-method',
  'variable-library': 'symbol-variable',
  'health-check': 'pulse',
  plan: 'checklist',
  tracing: 'list-tree',
  'mirrored-database': 'mirror',
  'mirrored-databricks': 'mirror',
  'materialized-lake-view': 'preview',
  'data-product': 'package',
  'data-product-template': 'package',
  'data-product-instance': 'package',
  dataflow: 'git-merge',
  'dbt-job': 'git-merge',
  'airflow-job': 'run-all',
};

/** Substring heuristics (checked in order) after exact lookup misses. */
const HEURISTICS: Array<[RegExp, string]> = [
  [/notebook/, 'notebook'],
  [/pipeline|flow/, 'run-all'],
  [/graph|gremlin/, 'graph'],
  [/database|sql|cosmos|warehouse|lakehouse|datamart/, 'database'],
  [/report|dashboard|scorecard/, 'graph'],
  [/agent|copilot|bot/, 'robot'],
  [/model|experiment|automl|evaluation/, 'beaker'],
  [/geo|map/, 'map'],
  [/event|stream/, 'broadcast'],
  [/kql|search|query/, 'search'],
  [/spark/, 'flame'],
  [/environment/, 'server-environment'],
  [/app$|-app/, 'browser'],
  [/api/, 'plug'],
  [/function/, 'symbol-method'],
  [/synapse|adf|mounted/, 'run-all'],
];

/** Default when nothing matches — a real, generic codicon (never broken). */
export const DEFAULT_ITEM_ICON = 'symbol-misc';

/** Return the codicon id for an item type. Deterministic + total. */
export function iconIdForItemType(itemType: string): string {
  if (!itemType) return DEFAULT_ITEM_ICON;
  const t = itemType.toLowerCase();
  if (EXACT[t]) return EXACT[t];
  for (const [re, icon] of HEURISTICS) {
    if (re.test(t)) return icon;
  }
  return DEFAULT_ITEM_ICON;
}
