#!/usr/bin/env node
/**
 * Reads lib/editors/registry.ts + docs/fiab/wiring-audit.md and emits
 * docs/fiab/fabric-parity-tasks.json — the full per-UI task list driving
 * the fabric-parity-loop workflow. Idempotent — preserves any hand edits
 * in entries that already exist with knownGaps[] populated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const REGISTRY = path.join(REPO, 'apps', 'fiab-console', 'lib', 'editors', 'registry.ts');
const OUT = path.join(REPO, 'docs', 'fiab', 'fabric-parity-tasks.json');

// Extract editor type names from registry.ts
const editors = fs.readFileSync(REGISTRY, 'utf-8')
  .split('\n')
  .map(l => l.match(/^\s*['"]([a-z][a-z0-9-]+)['"]\s*:\s*reg\(/))
  .filter(Boolean).map(m => m[1]);

// Backend mapping — derived from the wiring audit
const BACKEND = {
  'activator': 'Loom Activator engine container + ADX rules', 'lakehouse': 'ADLS Gen2 + paired Synapse Serverless SQL',
  'notebook': 'Synapse Spark Livy + Databricks Jobs', 'data-pipeline': 'ADF', 'dataflow': 'ADF Mapping Data Flow',
  'mirrored-database': 'loom-mirroring-engine container', 'spark-job-definition': 'Synapse Spark batch',
  'environment': 'Cosmos (Loom-native env defs)', 'copy-job': 'ADF copy activity', 'dbt-job': 'Synapse pipeline running dbt',
  'eventhouse': 'Azure Data Explorer', 'kql-database': 'ADX database', 'kql-queryset': 'ADX query script (Cosmos)',
  'kql-dashboard': 'ADX dashboard', 'eventstream': 'Event Hubs → ADX ingestion', 'warehouse': 'Synapse Dedicated SQL Pool',
  'semantic-model': 'Power BI tenant', 'report': 'Power BI embed', 'dashboard': 'Power BI embed',
  'paginated-report': 'Power BI Paginated', 'scorecard': 'Power BI scorecard', 'ml-model': 'Azure ML model registry',
  'ml-experiment': 'Azure ML MLflow', 'graphql-api': 'APIM publish', 'user-data-function': 'Container app fn host (Preview)',
  'variable-library': 'Cosmos (consumers query)', 'ontology': 'Cosmos + Purview', 'graph-model': 'ADX make-graph',
  'plan': 'Cosmos (orchestrator)', 'map': 'Azure Maps + ADX geo-temporal', 'operations-agent': 'Cosmos + Azure AI Agent',
  'data-agent': 'Azure AI Agent (Foundry)', 'synapse-dedicated-sql-pool': 'Synapse Dedicated SQL Pool',
  'synapse-serverless-sql-pool': 'Synapse Serverless SQL', 'synapse-spark-pool': 'Synapse Spark pool',
  'synapse-pipeline': 'Synapse pipeline', 'databricks-notebook': 'Databricks Notebook API',
  'databricks-job': 'Databricks Jobs API', 'databricks-cluster': 'Databricks Clusters API',
  'databricks-sql-warehouse': 'Databricks SQL warehouse', 'adf-pipeline': 'ADF', 'adf-dataset': 'ADF',
  'adf-trigger': 'ADF', 'usql-job': 'ADLA (legacy — D-grade)', 'apim-api': 'APIM REST',
  'apim-product': 'APIM REST', 'apim-policy': 'APIM REST', 'data-product': 'APIM + Loom catalog',
  'ai-foundry-hub': 'Azure ML / Foundry Hub', 'ai-foundry-project': 'Foundry project',
  'prompt-flow': 'Foundry Prompt Flow', 'evaluation': 'Foundry evaluation', 'content-safety': 'AI Content Safety',
  'tracing': 'Foundry tracing', 'ai-search-index': 'AI Search', 'compute': 'AML compute', 'dataset': 'AML dataset',
  'copilot-studio-agent': 'Dataverse + Copilot Studio', 'copilot-studio-knowledge': 'Dataverse',
  'copilot-studio-topic': 'Dataverse', 'copilot-studio-action': 'Dataverse', 'copilot-studio-channel': 'Dataverse',
  'copilot-studio-analytics': 'Dataverse', 'copilot-template-library': 'Dataverse',
  'powerplatform-environment': 'BAP admin API', 'dataverse-table': 'Dataverse Web API',
  'power-app': 'PowerApps API', 'power-page': 'Power Pages / Dataverse mspp_website',
  'power-automate-flow': 'Flow API', 'ai-builder-model': 'AI Builder', 'cross-item-copilot': 'Loom orchestrator + AOAI',
  'azure-sql-server': 'Azure SQL ARM', 'azure-sql-database': 'Azure SQL TDS', 'azure-sql-managed-instance': 'Azure SQL MI',
  'sql-server-2025-vector-index': 'SQL Server 2025 vector', 'geo-map': 'Azure Maps + ADX',
  'geo-dataset': 'Synapse Serverless + ADLS', 'geo-query': 'KQL geo / T-SQL ST',
  'geo-pipeline': 'ADF geo-enrichment', 'cosmos-gremlin-graph': 'Cosmos Gremlin',
  'cypher-graph': 'ADX make-graph (Cypher dialect)', 'gql-graph': 'ISO GQL on ADX',
  'vector-store': 'AI Search vectors / Cosmos vCore', 'data-product-template': 'Loom catalog template',
  'data-product-instance': 'Loom catalog instance',
};

// Verdict from wiring-audit.md
const VERDICT = {
  'notebook': 'D', 'data-pipeline': 'B', 'dataflow': 'B', 'mirrored-database': 'B',
  'warehouse': 'B', 'semantic-model': 'C', 'report': 'C', 'dashboard': 'C',
  'paginated-report': 'C', 'scorecard': 'C', 'eventstream': 'B', 'vector-store': 'B',
  'graphql-api': 'B', 'user-data-function': 'B', 'variable-library': 'B',
  'ontology': 'B', 'plan': 'B', 'operations-agent': 'B', 'usql-job': 'D',
};

// Existing entries in fabric-parity-tasks.json — preserve their richer metadata
let existing = {};
if (fs.existsSync(OUT)) {
  const cur = JSON.parse(fs.readFileSync(OUT, 'utf-8'));
  for (const ui of (cur.uis || [])) existing[ui.name] = ui;
}

let nextPriority = Math.max(...Object.values(existing).map(u => u.priority || 0), 0);

const uis = editors.map(name => {
  if (existing[name]) return existing[name];
  nextPriority++;
  return {
    name,
    priority: nextPriority,
    currentVerdict: VERDICT[name] || 'A',
    loomEditorPath: `apps/fiab-console/lib/editors/registry.ts#${name}`,
    azureBackend: BACKEND[name] || 'TBD — fill from catalog phase',
    knownGaps: ['Catalog phase has not run yet — needs Fabric reference inspection'],
    parityRefDoc: null,
  };
}).sort((a, b) => a.priority - b.priority);

const out = {
  $schema: './fabric-parity-tasks.schema.json',
  description: 'Per-UI task list driving the fabric-parity-loop multi-agent workflow. Auto-generated by tools/gen-parity-tasks.mjs from registry.ts + wiring-audit.md. Hand-edits to existing entries preserved.',
  generatedAt: new Date().toISOString(),
  fabricRefWorkspace: {
    name: 'casino-fabric-poc',
    id: '7899f58d-d19f-4e9d-8370-b88621aad31e',
    tenant: 'limitlessdata.ai',
    capacity: 'F64',
  },
  loomBaseUrl: 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net',
  uis,
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`✓ Wrote ${path.relative(REPO, OUT)} with ${uis.length} UIs (${Object.keys(existing).length} preserved, ${uis.length - Object.keys(existing).length} new)`);
