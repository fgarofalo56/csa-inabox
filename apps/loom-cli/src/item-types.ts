/**
 * Loom item-type taxonomy.
 *
 * This list is the SAME set the Console exposes as per-type routes under
 * `apps/fiab-console/app/api/items/<type>/` and that the catalog offers in the
 * "New item" experience. The CLI validates `--type` against it so a typo fails
 * fast locally instead of creating a mistyped item server-side.
 *
 * Every type here is Azure-native by default (no Microsoft Fabric tenant
 * required) — see .claude/rules/no-fabric-dependency.md. Keep in sync when new
 * item-type routes are added.
 */
export const ITEM_TYPES: readonly string[] = [
  'activator',
  'adf-dataset',
  'adf-pipeline',
  'adf-trigger',
  'ai-builder-model',
  'ai-foundry-project',
  'ai-search-index',
  'aip-logic',
  'airflow-job',
  'apim-api',
  'apim-policy',
  'apim-product',
  'automl',
  'azure-sql-database',
  'azure-sql-managed-instance',
  'azure-sql-server',
  'content-safety',
  'copilot-studio-action',
  'copilot-studio-agent',
  'copilot-studio-analytics',
  'copilot-studio-channel',
  'copilot-studio-knowledge',
  'copilot-studio-topic',
  'copilot-template-library',
  'copy-job',
  'cosmos-db',
  'cosmos-gremlin-graph',
  'cypher-graph',
  'dashboard',
  'data-agent',
  'data-pipeline',
  'data-product',
  'data-product-instance',
  'data-product-template',
  'dataflow',
  'datamart',
  'dataset',
  'dataverse-table',
  'dbt-job',
  'environment',
  'evaluation',
  'event-schema-set',
  'eventhouse',
  'eventstream',
  'geo-dataset',
  'geo-map',
  'geo-pipeline',
  'geo-query',
  'gql-graph',
  'graph-model',
  'graphql-api',
  'health-check',
  'kql-dashboard',
  'kql-database',
  'kql-queryset',
  'lakehouse',
  'logic-app',
  'map',
  'materialized-lake-view',
  'mirrored-database',
  'mirrored-databricks',
  'ml-experiment',
  'ml-model',
  'mounted-adf',
  'notebook',
  'ontology',
  'ontology-sdk',
  'operations-agent',
  'paginated-report',
  'plan',
  'postgres-flexible-server',
  'power-app',
  'power-automate-flow',
  'power-page',
  'prompt-flow',
  'rayfin-app',
  'release-environment',
  'report',
  'scorecard',
  'semantic-model',
  'slate-app',
  'spark-environment',
  'spark-job-definition',
  'sql-database',
  'sql-databases',
  'sql-server-2025-vector-index',
  'stream-analytics-job',
  'synapse-dedicated-sql-pool',
  'synapse-notebook',
  'synapse-pipeline',
  'synapse-serverless-sql-pool',
  'synapse-spark-pool',
  'tracing',
  'user-data-function',
  'variable-library',
  'vector-store',
  'warehouse',
  'workshop-app',
];

const ITEM_TYPE_SET = new Set(ITEM_TYPES);

export function isKnownItemType(t: string): boolean {
  return ITEM_TYPE_SET.has(t);
}

/** Suggest the closest known item types for a typo (cheap Levenshtein). */
export function suggestItemTypes(input: string, limit = 5): string[] {
  const lev = (a: string, b: string): number => {
    const m = a.length;
    const n = b.length;
    const d = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = 0; i <= m; i++) d[i][0] = i;
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      }
    }
    return d[m][n];
  };
  return [...ITEM_TYPES]
    .map((t) => ({ t, d: lev(input, t) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.t);
}
