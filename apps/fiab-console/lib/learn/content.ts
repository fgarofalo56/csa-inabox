/**
 * Learn-popup content registry. Keys are FabricItemType ids (matches the
 * `type` URL param in /items/[type]/[id]).
 *
 * SOURCE OF TRUTH: the authoritative per-item Learn content now lives on
 * each catalog entry's `learnContent` field in
 * `lib/catalog/fabric-item-types.ts` (overview + titled getting-started
 * steps + docsUrl). `getLearn()` reads that first so every one of the 90
 * catalog item types renders real guidance (A+ docs criterion).
 *
 * This REGISTRY remains for one reason: the legacy entries below carry a
 * `tip` callout that the catalog shape doesn't model. When both exist, the
 * catalog `learnContent` supplies title/summary/steps/docsUrl and the
 * registry entry contributes its `tip`. Per the no-vaporware rule we never
 * fall back to auto-generated placeholder text — an item with neither
 * source surfaces an honest "not yet authored" MessageBar.
 *
 * The Learn drawer auto-shows on first visit to an item of that type; users
 * can dismiss permanently per-type via the "Don't show again" checkbox
 * (persisted to user-prefs).
 */

import { findItemType, FABRIC_ITEM_TYPES, type WorkloadCategory } from '@/lib/catalog/fabric-item-types';
import { getBundle } from '@/lib/apps/content-bundles';
import { CATALOG_META } from '@/lib/apps/content-bundles/catalog-meta';

export interface LearnEntry {
  title: string;
  summary?: string;
  /** Plain step strings (legacy) OR titled steps (from catalog learnContent). */
  steps?: Array<string | { title: string; body: string }>;
  tip?: string;
  /**
   * PRIMARY link. Resolved CSA Loom docs URL for this topic when a Loom doc
   * exists (`loomDocUrl(loomDocPath)`), else falls back to `msLearnUrl`.
   * Computed by `getLearn()` — do not set directly in the registry.
   */
  docsUrl?: string;
  /**
   * Relative path of the published CSA Loom doc for this topic, WITHOUT the
   * `LOOM_DOCS_BASE` prefix and without a trailing slash, e.g.
   * `fiab/tutorials/editor-lakehouse`. Undefined when no Loom doc exists yet
   * (the entry then surfaces the MS-Learn link + a "Loom guide coming" tag).
   */
  loomDocPath?: string;
  /** SECONDARY link — the Microsoft Learn / service docs URL (was `docsUrl`). */
  msLearnUrl?: string;
  /** True when a real CSA Loom doc page exists for this topic. */
  hasLoomDoc?: boolean;
}

/**
 * ── Dual-link strategy ──────────────────────────────────────────────────────
 * Each Learn topic now carries TWO links:
 *   • PRIMARY  → the project's own CSA Loom doc (MkDocs pages site), built
 *                from LOOM_DOCS_BASE + the per-topic relative path.
 *   • SECONDARY → the upstream Microsoft Learn / service docs page.
 *
 * LOOM_DOCS_BASE defaults to the published GitHub Pages site and can be
 * overridden per-deployment via NEXT_PUBLIC_LOOM_DOCS_BASE (e.g. an internal
 * mirror). Never trailing-slashed by callers — the builders normalise it.
 */
export const LOOM_DOCS_BASE: string = (
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_LOOM_DOCS_BASE) ||
  'https://fgarofalo56.github.io/csa-inabox'
).replace(/\/+$/, '');

/** Build an absolute CSA Loom doc URL from a relative path (MkDocs dir-urls). */
export function loomDocUrl(relPath: string): string {
  const clean = relPath.replace(/^\/+/, '').replace(/\/+$/, '');
  // MkDocs uses directory URLs by default → page ends in a trailing slash.
  return `${LOOM_DOCS_BASE}/${clean}/`;
}

/** Build the published tutorial thumbnail URL for an editor slug, or undefined. */
export function loomThumbUrl(slug: string): string | undefined {
  if (!EDITOR_DOC_SLUGS.has(slug)) return undefined;
  return `${LOOM_DOCS_BASE}/fiab/tutorials/img/editor-${slug}-1.png`;
}

/**
 * The 85 item-type slugs that have a real per-editor Loom doc at
 * `docs/fiab/tutorials/editor-<slug>.md` (served at
 * `<base>/fiab/tutorials/editor-<slug>/`). Kept in sync with the mkdocs.yml
 * "Editor Tutorials (per-item)" nav block. A slug NOT in this set has no Loom
 * doc yet → the Learn entry shows the MS-Learn link + a "Loom guide coming"
 * tag and is reported in the build-out backlog.
 */
export const EDITOR_DOC_SLUGS: ReadonlySet<string> = new Set([
  'activator', 'adf-dataset', 'adf-pipeline', 'adf-trigger', 'ai-builder-model',
  'ai-foundry-hub', 'ai-foundry-project', 'ai-search-index', 'apim-api', 'apim-policy',
  'apim-product', 'azure-sql-database', 'azure-sql-managed-instance', 'azure-sql-server',
  'compute', 'content-safety', 'copilot-studio-action', 'copilot-studio-agent',
  'copilot-studio-analytics', 'copilot-studio-channel', 'copilot-studio-knowledge',
  'copilot-studio-topic', 'copilot-template-library', 'copy-job', 'cosmos-gremlin-graph',
  'cross-item-copilot', 'cypher-graph', 'dashboard', 'data-agent', 'data-pipeline',
  'data-product', 'data-product-instance', 'data-product-template', 'databricks-cluster',
  'databricks-job', 'databricks-notebook', 'databricks-sql-warehouse', 'dataflow',
  'dataset', 'dataverse-table', 'dbt-job', 'environment', 'evaluation', 'eventhouse',
  'eventstream', 'geo-dataset', 'geo-map', 'geo-pipeline', 'geo-query', 'gql-graph',
  'graph-model', 'graphql-api', 'kql-dashboard', 'kql-database', 'kql-queryset',
  'lakehouse', 'map', 'mirrored-database', 'ml-experiment', 'ml-model', 'notebook',
  'ontology', 'operations-agent', 'paginated-report', 'plan', 'power-app',
  'power-automate-flow', 'power-page', 'powerplatform-environment', 'prompt-flow',
  'report', 'scorecard', 'semantic-model', 'spark-job-definition',
  'sql-server-2025-vector-index', 'synapse-dedicated-sql-pool', 'synapse-pipeline',
  'synapse-serverless-sql-pool', 'synapse-spark-pool', 'tracing', 'user-data-function',
  'usql-job', 'variable-library', 'vector-store', 'warehouse',
]);

const REGISTRY: Record<string, LearnEntry> = {
  'synapse-serverless-sql-pool': {
    title: 'Synapse Serverless SQL Pool',
    summary: 'A pay-per-query T-SQL endpoint that reads Parquet, Delta, and CSV directly from ADLS Gen2 without provisioning compute.',
    steps: [
      'Browse to Run query and paste a SELECT. The first ~1 TB scanned each month is free in many regions; charges apply after that.',
      'Reference files using OPENROWSET(BULK \'https://<storage>.dfs.core.windows.net/container/folder/*.parquet\', FORMAT=\'PARQUET\').',
      'For Delta tables, use OPENROWSET with FORMAT=\'DELTA\' — Synapse Serverless reads the Delta log directly.',
      'Save reusable views in lakehouse-shared-views to share definitions with teammates.',
    ],
    tip: 'Serverless cost is metered by bytes processed — minimise scans by filtering on partitioned columns (year/month/day) and selecting only the columns you need.',
    docsUrl: 'https://learn.microsoft.com/azure/synapse-analytics/sql/on-demand-workspace-overview',
  },
  'synapse-dedicated-sql-pool': {
    title: 'Synapse Dedicated SQL Pool',
    summary: 'A provisioned MPP T-SQL data warehouse (formerly SQL DW). Auto-pauses on a schedule and resumes on demand to control cost.',
    steps: [
      'Resume the pool from the editor; the first query blocks until the pool reaches Online (≈ 60–90s).',
      'The pool has a built-in auto-pause Logic App that suspends it after the idle window configured in admin.',
      'Use Run query to issue T-SQL; Recent runs shows execution history and DMV stats.',
      'For high concurrency loads, increase the SLO temporarily — billing scales with the SLO/DWU level.',
    ],
    tip: 'Pause the pool when not actively running ELT — paused pools incur storage cost only.',
    docsUrl: 'https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-overview-what-is',
  },
  'kql-database': {
    title: 'KQL database (Azure Data Explorer / Eventhouse)',
    summary: 'A real-time analytics store optimised for time-series, telemetry, and logs. Query via Kusto Query Language (KQL).',
    steps: [
      'Ingest from Eventstream, Event Hubs, or direct REST POST.',
      'Open a KQL queryset to run interactive queries; pin charts to a KQL dashboard.',
      'Wire an Activator rule on a KQL query to fire on threshold breach (e.g. failure rate > 5%).',
    ],
    docsUrl: 'https://learn.microsoft.com/azure/data-explorer/data-explorer-overview',
  },
  'eventstream': {
    title: 'Eventstream',
    summary: 'Code-free streaming pipeline. Source connectors (Event Hubs, IoT Hub, Kafka, Azure SQL CDC) → optional transforms → destinations (KQL DB, Lakehouse, Activator).',
    steps: [
      'Add a source (Event Hub or IoT Hub for telemetry; Kafka for cross-cloud).',
      'Add a destination — typically a KQL database for real-time queries plus a Lakehouse for long-term retention.',
      'Optional: drop in transforms (filter, derived columns, manage fields) before the destination.',
    ],
    docsUrl: 'https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/overview',
  },
  'activator': {
    title: 'Activator (Reflex)',
    summary: 'No-code event-driven automation. Watches a stream or KQL query and fires Teams/Email/Power Automate actions on conditions.',
    steps: [
      'Pick a source: a KQL queryset, semantic model measure, or Eventstream.',
      'Define the trigger: when a value crosses a threshold or a pattern occurs.',
      'Pick the action: Teams notification, email, or Power Automate flow.',
    ],
    docsUrl: 'https://learn.microsoft.com/fabric/data-activator/activator-introduction',
  },
  'lakehouse': {
    title: 'Lakehouse',
    summary: 'OneLake-backed lakehouse with bronze/silver/gold containers. Read/write via Spark, Synapse Serverless, or Fabric SQL endpoint.',
    steps: [
      'Use the Files tree to browse raw uploads; use the Tables tree for Delta-managed tables.',
      'Load files into Tables via the "Load to Tables" action — auto-infers schema and writes Delta.',
      'Query tables via the SQL analytics endpoint or via Spark notebooks.',
    ],
    tip: 'Medallion convention: land raw into bronze, conform/clean into silver, aggregate/serve from gold.',
    docsUrl: 'https://learn.microsoft.com/fabric/data-engineering/lakehouse-overview',
  },
  'semantic-model': {
    title: 'Semantic model',
    summary: 'Tabular dataset (formerly "Power BI dataset") with measures, hierarchies, and row-level security. Powers reports, dashboards, and scorecards.',
    steps: [
      'Connect to a Lakehouse, SQL endpoint, or import data directly.',
      'Author DAX measures for KPIs (e.g. Revenue, Cost, Margin %).',
      'Configure RLS roles so each consumer sees only their slice.',
    ],
    docsUrl: 'https://learn.microsoft.com/power-bi/transform-model/datasets/dataset-modes-understand',
  },
  'mirrored-database': {
    title: 'Mirrored database',
    summary: 'Near-real-time replica of an external source (Azure SQL, Snowflake, Cosmos, Databricks) into OneLake. Queries hit the mirror, never the source.',
    steps: [
      'Pick a source connector (Azure SQL, Snowflake, Cosmos, Databricks).',
      'Provide a connection + select tables; mirroring starts and Fabric maintains the replica.',
      'Query the mirror via the SQL analytics endpoint — joins across mirrors and lakehouses are first-class.',
    ],
    docsUrl: 'https://learn.microsoft.com/fabric/database/mirrored-database/overview',
  },
  'ai-foundry-hub': {
    title: 'AI Foundry hub',
    summary: 'Workspace for end-to-end AI app development. Houses prompt flows, evaluations, deployments, fine-tuned models, and shared compute.',
    steps: [
      'Connect models (Azure OpenAI, Foundry catalog, or your own endpoint).',
      'Build a prompt flow that chains retrieval + LLM + post-processing.',
      'Run evaluations on a curated test set before promoting a deployment.',
    ],
    docsUrl: 'https://learn.microsoft.com/azure/ai-studio/concepts/architecture',
  },
  'ai-search-index': {
    title: 'AI Search index',
    summary: 'Vector + keyword hybrid search index for RAG. Source documents are chunked, embedded, and stored with metadata for filtering.',
    steps: [
      'Define the index schema (content, vector, metadata fields).',
      'Run an indexer against your data source (Blob, ADLS, Cosmos, SQL).',
      'Query with hybrid search (vector + BM25 + semantic ranker) from the prompt flow.',
    ],
    docsUrl: 'https://learn.microsoft.com/azure/search/search-what-is-azure-search',
  },
  'copilot-studio-agent': {
    title: 'Copilot Studio agent',
    summary: 'Low-code conversational agent with topics, knowledge sources, actions, and channel deployment (Teams, web, Slack).',
    steps: [
      'Add knowledge sources (SharePoint, websites, files) so the agent can answer factual questions.',
      'Author topics for high-intent flows that need deterministic logic.',
      'Wire actions (Power Automate flows, custom connectors) for write operations.',
      'Publish to Teams, embed in a web page, or expose via the Direct Line API.',
    ],
    docsUrl: 'https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-what-is-copilot-studio',
  },
  'notebook': {
    title: 'Notebook',
    summary: 'Interactive Spark notebook for data engineering + science. PySpark, Scala, SparkSQL, and R cells against the lakehouse.',
    steps: [
      'Attach the notebook to a Spark pool (Synapse) or a Databricks cluster.',
      'Read from a Lakehouse via `spark.read.format("delta").load("Files/...")` or its mounted SQL endpoint.',
      'Write results back with `df.write.mode("overwrite").format("delta").save("Tables/...")`.',
      'Schedule via a Synapse / ADF pipeline trigger for recurring runs.',
    ],
    tip: 'Use `%%sql` magic for ad-hoc SQL inside a PySpark notebook — saves switching languages.',
    docsUrl: 'https://learn.microsoft.com/fabric/data-engineering/lakehouse-notebook-explore',
  },
  'warehouse': {
    title: 'Warehouse',
    summary: 'Fully-managed T-SQL data warehouse. Storage on OneLake (Parquet), compute auto-scales, no infrastructure to manage.',
    steps: [
      'Run CREATE TABLE / INSERT statements like any T-SQL warehouse.',
      'Cross-database query against any lakehouse SQL endpoint or mirrored database in the same workspace.',
      'Connect Power BI in DirectLake mode for sub-second semantic-model refresh.',
    ],
    docsUrl: 'https://learn.microsoft.com/fabric/data-warehouse/data-warehousing',
  },
  'data-pipeline': {
    title: 'Data pipeline',
    summary: 'Visual ETL/ELT orchestration. Drag activities, wire dependencies, schedule. Common run history with notebooks + dataflows.',
    steps: [
      'Add a Copy Data activity for source→sink ingestion (300+ connectors).',
      'Add a Notebook activity to call PySpark transformations.',
      'Configure a trigger (schedule, tumbling window, event-based) to automate runs.',
    ],
    docsUrl: 'https://learn.microsoft.com/fabric/data-factory/data-factory-overview',
  },
  'dataflow': {
    title: 'Dataflow Gen2',
    summary: 'Power Query-based ETL with M expressions. Read from 300+ connectors, transform with the Power Query Editor, write to a lakehouse, warehouse, or SQL DB.',
    docsUrl: 'https://learn.microsoft.com/fabric/data-factory/dataflows-gen2-overview',
  },
  'copy-job': {
    title: 'Copy job',
    summary: 'Guided data movement: source → sink. Full, incremental (watermark), or CDC (native SQL Server change tracking — inserts, updates, deletes) copy modes, with built-in retry + fault tolerance.',
    docsUrl: 'https://learn.microsoft.com/fabric/data-factory/cdc-copy-job',
  },
  'spark-job-definition': {
    title: 'Spark job definition',
    summary: 'Submit a JAR, Python, or R Spark job. Like a notebook but headless — for production batch workloads.',
    docsUrl: 'https://learn.microsoft.com/fabric/data-engineering/spark-job-definition',
  },
  'environment': {
    title: 'Environment',
    summary: 'Shared Spark runtime config: Python/R packages, Spark properties, runtime version. Attach to notebooks and Spark job definitions.',
    docsUrl: 'https://learn.microsoft.com/fabric/data-engineering/environment-manage-customization',
  },
  'dataset': {
    title: 'Dataset',
    summary: 'Registered data asset for AI Foundry: tabular, image, text, or URI folder. Versioned + lineage-tracked, used as ML training input.',
    docsUrl: 'https://learn.microsoft.com/azure/machine-learning/concept-data',
  },
  'ml-model': {
    title: 'ML model',
    summary: 'Registered model artifact (MLflow format) deployable to managed online endpoints or batch.',
    docsUrl: 'https://learn.microsoft.com/azure/machine-learning/concept-mlflow-models',
  },
  'ml-experiment': {
    title: 'ML experiment',
    summary: 'MLflow experiment tracking runs + metrics + params. Compare hyperparameter sweeps, promote the winning run to a registered model.',
    docsUrl: 'https://learn.microsoft.com/azure/machine-learning/concept-mlflow',
  },
  'prompt-flow': {
    title: 'Prompt flow',
    summary: 'Visual DAG for LLM apps: chain retrieval + prompts + post-processing. Eval-driven iteration with reproducible runs.',
    docsUrl: 'https://learn.microsoft.com/azure/ai-studio/how-to/prompt-flow',
  },
  'evaluation': {
    title: 'Evaluation',
    summary: 'Score a prompt flow against a test set with built-in metrics (groundedness, relevance, fluency) plus custom evaluators.',
    docsUrl: 'https://learn.microsoft.com/azure/ai-studio/how-to/evaluate-generative-ai-app',
  },
  'compute': {
    title: 'Compute',
    summary: 'AI Foundry compute target. Pick instance / cluster / serverless. Auto-shutdown reduces idle cost.',
    docsUrl: 'https://learn.microsoft.com/azure/machine-learning/concept-compute-target',
  },
  'report': {
    title: 'Report',
    summary: 'Interactive Power BI report. Visuals bind to a semantic model; consumers slice + drill in browser or Power BI mobile.',
    docsUrl: 'https://learn.microsoft.com/power-bi/create-reports/',
  },
  'dashboard': {
    title: 'Dashboard',
    summary: 'Curated tiles pinned from reports. Single canvas to monitor KPIs at a glance.',
    docsUrl: 'https://learn.microsoft.com/power-bi/create-reports/service-dashboards',
  },
  'paginated-report': {
    title: 'Paginated report',
    summary: 'Pixel-perfect printable / PDF report (formerly SSRS). For invoices, financial statements, regulatory filings.',
    docsUrl: 'https://learn.microsoft.com/power-bi/paginated-reports/paginated-reports-report-builder-power-bi',
  },
  'scorecard': {
    title: 'Scorecard',
    summary: 'Goals + KPIs aligned to an OKR-style hierarchy. Track progress against targets with check-in cadence.',
    docsUrl: 'https://learn.microsoft.com/power-bi/consumer/metrics/metrics-get-started',
  },
  'eventhouse': {
    title: 'Eventhouse',
    summary: 'Container for multiple KQL databases that share compute. Optimised for real-time analytics on streaming data.',
    docsUrl: 'https://learn.microsoft.com/fabric/real-time-intelligence/eventhouse',
  },
  'kql-queryset': {
    title: 'KQL queryset',
    summary: 'Saved set of KQL queries — like a Power BI report but for raw streaming data. Pin charts to a KQL dashboard.',
    docsUrl: 'https://learn.microsoft.com/fabric/real-time-intelligence/kusto-query-set',
  },
  'kql-dashboard': {
    title: 'KQL dashboard',
    summary: 'Real-time dashboard backed by KQL queries. Auto-refresh, parameters, drilldowns, time-pickers.',
    docsUrl: 'https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-real-time-create',
  },
  'apim-api': {
    title: 'APIM API',
    summary: 'Frontend API exposed through Azure API Management. Operations, request/response policies, products, subscriptions.',
    steps: [
      'Define operations (GET/POST/etc.) and their URL templates.',
      'Optionally import an OpenAPI spec to bootstrap operations.',
      'Attach to one or more products to control subscription + visibility.',
      'Add policies (auth, throttling, transformation) at API or operation scope.',
    ],
    docsUrl: 'https://learn.microsoft.com/azure/api-management/api-management-key-concepts',
  },
  'apim-product': {
    title: 'APIM product',
    summary: 'Grouping of one or more APIs that consumers subscribe to as a unit. Sets visibility, approval requirement, subscription quotas.',
    docsUrl: 'https://learn.microsoft.com/azure/api-management/api-management-howto-add-products',
  },
  'apim-policy': {
    title: 'APIM policy',
    summary: 'XML-based policies applied at global, product, API, or operation scope. Auth, throttling, caching, transformation, JWT validation.',
    docsUrl: 'https://learn.microsoft.com/azure/api-management/api-management-howto-policies',
  },
  'azure-sql-database': {
    title: 'Azure SQL Database',
    summary: 'Fully-managed PaaS SQL Server. Backups, HA, point-in-time restore handled for you. Single DB or elastic pool.',
    tip: 'For the dirt-cheap default, pick the General Purpose serverless tier with auto-pause — billed in vCore-seconds.',
    docsUrl: 'https://learn.microsoft.com/azure/azure-sql/database/sql-database-paas-overview',
  },
  'azure-sql-server': {
    title: 'Azure SQL Server',
    summary: 'Logical container for one or more Azure SQL Databases. Manages firewall, AAD admin, server-level audit, server-scoped Entra principals.',
    docsUrl: 'https://learn.microsoft.com/azure/azure-sql/database/logical-servers',
  },
  'azure-sql-managed-instance': {
    title: 'Azure SQL Managed Instance',
    summary: 'Near-100% SQL Server compat (Agent, cross-DB queries, CLR, linked servers). For lift-and-shift of on-prem SQL workloads.',
    docsUrl: 'https://learn.microsoft.com/azure/azure-sql/managed-instance/sql-managed-instance-paas-overview',
  },
  'sql-server-2025-vector-index': {
    title: 'SQL Server 2025 vector index',
    summary: 'Native VECTOR data type + index in SQL Server 2025 + Azure SQL DB. RAG without a separate vector store.',
    docsUrl: 'https://learn.microsoft.com/sql/relational-databases/vectors/vectors-sql-server',
  },
  'databricks-cluster': {
    title: 'Databricks cluster',
    summary: 'Spark compute cluster. Sized by node type + worker count + autoscale; auto-terminate to control cost.',
    docsUrl: 'https://learn.microsoft.com/azure/databricks/compute/',
  },
  'databricks-job': {
    title: 'Databricks job',
    summary: 'Scheduled / triggered Databricks workflow. Tasks (notebooks, JARs, Python scripts, dbt) with dependencies + retry policies.',
    docsUrl: 'https://learn.microsoft.com/azure/databricks/jobs/',
  },
  'databricks-notebook': {
    title: 'Databricks notebook',
    summary: 'Same notebook concept as Spark — but with Unity Catalog governance, Delta Live Tables, and Photon vectorized execution.',
    docsUrl: 'https://learn.microsoft.com/azure/databricks/notebooks/',
  },
  'databricks-sql-warehouse': {
    title: 'Databricks SQL warehouse',
    summary: 'SQL endpoint over Delta Lake. Photon-accelerated. BI tools (Power BI, Tableau, Excel) connect via JDBC / ODBC.',
    docsUrl: 'https://learn.microsoft.com/azure/databricks/sql/admin/sql-endpoints',
  },
  'adf-pipeline': {
    title: 'ADF pipeline',
    summary: 'Azure Data Factory pipeline. Sit alongside Synapse / Fabric pipelines; reuse linked services + integration runtimes.',
    docsUrl: 'https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities',
  },
  'adf-dataset': {
    title: 'ADF dataset',
    summary: 'Pointer to data structure (table / file). Used by Copy Data + Mapping Data Flow activities for source / sink shape.',
    docsUrl: 'https://learn.microsoft.com/azure/data-factory/concepts-datasets-linked-services',
  },
  'adf-trigger': {
    title: 'ADF trigger',
    summary: 'Schedule, tumbling window, or event trigger that invokes a pipeline. Wire one or more pipelines per trigger.',
    docsUrl: 'https://learn.microsoft.com/azure/data-factory/concepts-pipeline-execution-triggers',
  },
  'mirrored-databricks': {
    title: 'Mirrored Databricks catalog',
    summary: 'Read-only OneLake mirror of a Unity Catalog. Query Delta tables from Fabric without re-ingesting.',
    docsUrl: 'https://learn.microsoft.com/fabric/database/mirrored-database/azure-databricks-tutorial',
  },
  'data-product': {
    title: 'Data product',
    summary: 'Productized data asset with owner, SLA, semantic contract, lineage, endorsement. Surfaces in the OneLake catalog + API marketplace.',
    docsUrl: 'https://learn.microsoft.com/purview/concept-data-products',
  },
  'data-product-template': {
    title: 'Data product template',
    summary: 'Reusable bundle: items (lakehouse + warehouse + semantic model + reports) + governance defaults. Instantiate per-domain.',
  },
  'data-product-instance': {
    title: 'Data product instance',
    summary: 'A live materialization of a data-product-template. Owns its own copy of the bundled items + bindings.',
  },
  'graphql-api': {
    title: 'GraphQL API',
    summary: 'Code-first GraphQL endpoint over a SQL DB or Cosmos. Auto-generated CRUD + custom resolvers.',
    docsUrl: 'https://learn.microsoft.com/fabric/data-engineering/api-graphql-overview',
  },
  'user-data-function': {
    title: 'User data function',
    summary: 'Server-side compute (Python / C#) callable from notebooks, pipelines, Power BI. Serverless billing.',
    docsUrl: 'https://learn.microsoft.com/fabric/data-engineering/user-data-functions/user-data-functions-overview',
  },
  'vector-store': {
    title: 'Vector store',
    summary: 'Backend-agnostic vector store: AI Search, Cosmos vector, pgvector, or SQL Server 2025 VECTOR. Pick one based on existing data gravity.',
  },
  'cosmos-gremlin-graph': {
    title: 'Cosmos Gremlin graph',
    summary: 'Multi-model Cosmos DB container exposing the Gremlin graph API. Vertices + edges with property-graph semantics.',
    docsUrl: 'https://learn.microsoft.com/azure/cosmos-db/gremlin/introduction',
  },
  'cypher-graph': {
    title: 'Cypher graph',
    summary: 'Cypher dialect translated to ADX `make-graph` operators. Lets Neo4j-trained engineers query the lakehouse without rewriting.',
    steps: [
      'Run admin → Load sample data (kind=graph) once. That creates `SampleSocialGraph(Source, Target, EdgeType, Weight, Since)` in the default Kusto DB.',
      'Pattern: edges | make-graph Source --> Target with_node_id=NodeId | graph-match (a)-[e]->(b)-[e2]->(c) where a.NodeId == "alice" project a=a.NodeId, b=b.NodeId, c=c.NodeId.',
      'Cypher `(a)-[*1..3]->(b)` ≈ KQL `graph-match (a)-[e*1..3]->(b)`. Cypher `WHERE` ≈ KQL `where` inside graph-match.',
      'For shortest-path use `graph-shortest-paths`; for cycle detection wrap in `graph-to-table edges`.',
    ],
    tip: 'KQL graph operators are server-side — no Spark, no Gremlin, no Cosmos. Latency is millisecond-scale up to ~10M edges.',
    docsUrl: 'https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-operators',
  },
  'gql-graph': {
    title: 'GQL graph',
    summary: 'ISO/IEC 39075:2024 standard graph query language. Vendor-neutral pattern matching; translated to the engine backing the workload.',
  },
  'content-safety': {
    title: 'Content Safety',
    summary: 'Azure AI Content Safety: text + image moderation, prompt-shield, groundedness check. Wire in front of any LLM call.',
    docsUrl: 'https://learn.microsoft.com/azure/ai-services/content-safety/overview',
  },
  'power-app': {
    title: 'Power App',
    summary: 'Low-code app over Dataverse or any data source via connectors. Canvas (free-form) or model-driven (CRUD over entities).',
    docsUrl: 'https://learn.microsoft.com/power-apps/powerapps-overview',
  },
  'power-automate-flow': {
    title: 'Power Automate flow',
    summary: 'Workflow trigger → conditions → actions. Cloud flows (event-driven), scheduled, instant, or desktop (RPA).',
    docsUrl: 'https://learn.microsoft.com/power-automate/getting-started',
  },
  'dataverse-table': {
    title: 'Dataverse table',
    summary: 'Schematized table in Microsoft Dataverse. Built-in audit, role-based security, change tracking, business rules.',
    docsUrl: 'https://learn.microsoft.com/power-apps/maker/data-platform/data-platform-intro',
  },
  'ai-builder-model': {
    title: 'AI Builder model',
    summary: 'Pre-built or custom AI model (form processing, object detection, text classification, prediction) usable from Power Apps + Automate.',
    docsUrl: 'https://learn.microsoft.com/ai-builder/overview',
  },
  'copilot-studio-knowledge': {
    title: 'Copilot Studio knowledge',
    summary: 'Data source the agent grounds answers against: SharePoint, website, uploaded files, Dataverse, custom connector.',
    docsUrl: 'https://learn.microsoft.com/microsoft-copilot-studio/nlu-generative-answers',
  },
  'copilot-studio-topic': {
    title: 'Copilot Studio topic',
    summary: 'Deterministic conversation flow for a high-intent path (e.g. "I want to reset my password"). Trigger phrases + nodes.',
    docsUrl: 'https://learn.microsoft.com/microsoft-copilot-studio/authoring-create-edit-topics',
  },
  'copilot-studio-action': {
    title: 'Copilot Studio action',
    summary: 'Write operation the agent can perform — Power Automate flow, custom connector, or REST endpoint.',
    docsUrl: 'https://learn.microsoft.com/microsoft-copilot-studio/authoring-actions',
  },
  'copilot-studio-channel': {
    title: 'Copilot Studio channel',
    summary: 'Surface where users interact with the agent: Teams, web embed, Slack, custom Direct Line, mobile.',
    docsUrl: 'https://learn.microsoft.com/microsoft-copilot-studio/publication-fundamentals-publish-channels',
  },
  'copilot-studio-analytics': {
    title: 'Copilot Studio analytics',
    summary: 'Conversation insights: session count, deflection rate, top topics, customer-satisfaction trends.',
    docsUrl: 'https://learn.microsoft.com/microsoft-copilot-studio/analytics-overview',
  },
  'copilot-template-library': {
    title: 'Copilot template library',
    summary: 'CSA-curated agent templates: HR helpdesk, IT support, FinOps assistant, healthcare intake. Clone + customize.',
  },
  'ai-foundry-project': {
    title: 'AI Foundry project',
    summary: 'Scoped Foundry workspace for a single app: prompt flows, evaluations, deployments, model catalog access.',
    docsUrl: 'https://learn.microsoft.com/azure/ai-studio/concepts/architecture',
  },
  'airflow-job': {
    title: 'Apache Airflow job',
    summary: 'DAG-based pipeline orchestration. Use when you need Airflow operators (Spark / dbt / Snowflake / etc.) beyond what ADF/Synapse pipelines cover.',
    docsUrl: 'https://learn.microsoft.com/azure/data-factory/airflow-overview',
  },
  'dbt-job': {
    title: 'dbt job',
    summary: 'Run a dbt project (models + tests + docs) against a warehouse/lakehouse. Compiles SQL, materializes models, surfaces test failures.',
    docsUrl: 'https://docs.getdbt.com/docs/introduction',
  },
  'data-agent': {
    title: 'Data agent',
    summary: 'Conversational Q&A grounded in your warehouse, lakehouse, and semantic models. Built on Foundry prompt-flow + AI Search hybrid retrieval.',
  },
  'cross-item-copilot': {
    title: 'Cross-item Copilot',
    summary: 'Orchestrator that drives Loom items via natural language. Calls the same BFF actions the UI calls; full audit log of every move.',
  },
  'event-schema-set': {
    title: 'Event schema set',
    summary: 'Centralized event schemas (Avro / JSON Schema / Protobuf) shared across Eventstream sources + KQL ingestion + downstream consumers.',
  },
  'geo-dataset': {
    title: 'Geoanalytics dataset',
    summary: 'Geo-typed parquet dataset (point/polygon/h3-cell). Queried via ST_* spatial functions in Synapse Serverless or Databricks.',
  },
  'geo-map': {
    title: 'Geo map',
    summary: 'Azure Maps + geoanalytics layer composition for visual analytics. Heatmaps, choropleths, point clusters over your geo-dataset.',
  },
  'geo-pipeline': {
    title: 'Geo pipeline',
    summary: 'Pre-built ETL: lat/long → H3 cell → spatial join → aggregate. Outputs a queryable geo-dataset.',
  },
  'geo-query': {
    title: 'Geo query',
    summary: 'Saved spatial query (ST_Within, ST_Distance, ST_Contains, H3 ring). Pinnable to geo-map layers.',
  },
  'graph-model': {
    title: 'Graph model',
    summary: 'Schema definition for a property graph: node labels, edge types, allowed properties, indexes. Feeds Cosmos Gremlin, Cypher-over-ADX, or GQL backends.',
  },
  'map': {
    title: 'Map',
    summary: 'Static or interactive map artifact bound to a geo-dataset. Embeddable in reports and dashboards.',
  },
  'mounted-adf': {
    title: 'Mounted Data Factory',
    summary: 'Read-only attachment of an existing Azure Data Factory. Run history + monitoring surface inside Loom without migrating pipelines.',
    docsUrl: 'https://learn.microsoft.com/fabric/data-factory/use-existing-adf-in-fabric',
  },
  'ontology': {
    title: 'Ontology',
    summary: 'RDF / OWL ontology that types entities + relationships. Feeds the graph backend semantic layer.',
  },
  'operations-agent': {
    title: 'Operations agent',
    summary: 'Always-on agent that monitors Loom items + workspaces, flags drift, opens incidents in audit-log, and proposes remediations via Cross-item Copilot.',
  },
  'plan': {
    title: 'Plan',
    summary: 'Declarative state for a set of items + their dependencies. Like Terraform for Loom items — diffable, reviewable, applyable.',
  },
  'power-page': {
    title: 'Power Page',
    summary: 'Low-code public-facing website over Dataverse data. Built-in auth, role-based pages, web forms wired to Power Automate.',
    docsUrl: 'https://learn.microsoft.com/power-pages/introduction',
  },
  'powerplatform-environment': {
    title: 'Power Platform environment',
    summary: 'Isolated Power Platform container (Dataverse instance + apps + flows + agents). Each prod/dev/UAT gets its own environment.',
    docsUrl: 'https://learn.microsoft.com/power-platform/admin/environments-overview',
  },
  'sql-database': {
    title: 'SQL database',
    summary: 'Generic SQL database item. Defaults to Azure SQL Database; can target Azure SQL MI or SQL Server 2025 depending on workload requirements.',
  },
  'synapse-pipeline': {
    title: 'Synapse pipeline',
    summary: 'ADF-shaped pipeline that runs inside a Synapse workspace. Reuses Synapse-attached linked services + integration runtimes.',
    docsUrl: 'https://learn.microsoft.com/azure/synapse-analytics/data-integration/concepts-data-factory-differences',
  },
  'synapse-spark-pool': {
    title: 'Synapse Spark pool',
    summary: 'Apache Spark compute pool. Auto-scale + auto-pause; size by node family. Attach notebooks + Spark job definitions.',
    docsUrl: 'https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-pool-configurations',
  },
  'tracing': {
    title: 'Tracing',
    summary: 'Application Insights / OpenTelemetry trace surface for Loom-orchestrated runs. Drill from a failed pipeline into the actual span.',
  },
  'usql-job': {
    title: 'U-SQL job',
    summary: 'Legacy Azure Data Lake Analytics U-SQL job (compatibility surface). Recommend migrating to Spark or Databricks for new workloads.',
  },
  'variable-library': {
    title: 'Variable library',
    summary: 'Centralized name → value store for pipelines, notebooks, and SQL parameter substitution. Workspace- or domain-scoped.',
  },
};

export function getLearn(itemType: string): LearnEntry | null {
  const legacy = REGISTRY[itemType] ?? null;
  const item = findItemType(itemType);
  const catalog = item?.learnContent ?? null;

  if (!legacy && !catalog) return null;

  // The registry/catalog `docsUrl` is always a Microsoft Learn / service docs
  // link today → that becomes the SECONDARY link. The PRIMARY link is the
  // per-editor CSA Loom doc when one exists for this slug.
  const msLearnUrl = catalog?.docsUrl ?? legacy?.docsUrl;
  const hasLoomDoc = EDITOR_DOC_SLUGS.has(itemType);
  const loomDocPath = hasLoomDoc ? `fiab/tutorials/editor-${itemType}` : undefined;
  // PRIMARY: Loom doc if it exists, else fall back to MS Learn (never a dead link).
  const docsUrl = loomDocPath ? loomDocUrl(loomDocPath) : msLearnUrl;

  const base: LearnEntry = catalog
    ? {
        title: item?.displayName ?? legacy?.title ?? itemType,
        summary: catalog.overview,
        steps: catalog.steps.map((s) => ({ title: s.title, body: s.body })),
        tip: legacy?.tip,
      }
    : { ...legacy! };

  return { ...base, docsUrl, loomDocPath, msLearnUrl, hasLoomDoc };
}

/* ── Learn-library catalog (powers the /learn portal) ──────────────────────── */

/** A section the Learn portal groups topics under. */
export type LearnSection =
  | 'Tutorials'
  | 'Use cases'
  | 'Editor guides'
  | 'Service guides'
  | 'Reference';

/**
 * Real-world use cases from the CSA-in-a-Box docs — surfaced in the Learning Hub
 * so users can browse/search every scenario and open the full walkthrough. Built
 * on CSA Loom (Azure-native), never Fabric.
 *
 * • `docPath` is the per-use-case relative MkDocs path → each card deep-links to
 *   its OWN authored walkthrough doc (step-by-step content + architecture
 *   visuals), NOT the shared index. Every path resolves to a file that exists on
 *   disk under docs/ (no fabricated deep links, no dead links).
 * • `appId` (when set) is the matching one-click content-bundle app — an
 *   installable real example with sample data. The Learn use-case card surfaces
 *   an "Install live example" button that opens the shared InstallAppDialog and
 *   runs the real install → provision → seed flow, and/or a second "Install app"
 *   link to /apps/<appId>. Every appId here is registered in BOTH the
 *   content-bundle REGISTRY and CATALOG_META, so the app is discoverable +
 *   installable (no vaporware deep link to a non-existent app).
 *
 * Spans both doc sites: commercial scenarios (docs/use-cases/), sovereign/Gov
 * scenarios (docs/fiab/use-cases/), solution accelerators (docs/learn/08-solutions/),
 * and industry blueprints (docs/industries/).
 */
const USE_CASES: ReadonlyArray<{
  id: string; title: string; summary: string; category: string; visualType: string;
  /** Per-use-case relative MkDocs doc path → the card's own walkthrough deep link. */
  docPath: string;
  /** Matching one-click content-bundle app id (installable example), when one exists. */
  appId?: string;
}> = [
  // ── Commercial + federal-agency scenarios (docs/use-cases/) ───────────────
  { id: 'doj-antitrust', title: 'DOJ Antitrust Analytics', summary: 'Antitrust compliance + investigation analytics — step-by-step domain build on Loom.', category: 'Government', visualType: 'warehouse', docPath: 'use-cases/doj-antitrust-deep-dive' },
  { id: 'gov-data-analytics', title: 'Government Data Analytics', summary: 'General government analytics platform on Azure-native Loom services.', category: 'Government', visualType: 'lakehouse', docPath: 'use-cases/government-data-analytics' },
  { id: 'dot-transportation', title: 'DOT Transportation Analytics', summary: 'Department of Transportation data analytics end to end.', category: 'Government', visualType: 'kql-database', docPath: 'use-cases/dot-transportation-analytics' },
  { id: 'faa-aviation', title: 'FAA Aviation Analytics', summary: 'Federal Aviation Administration analytics on Loom.', category: 'Government', visualType: 'eventstream', docPath: 'use-cases/faa-aviation-analytics' },
  { id: 'epa-environmental', title: 'EPA Environmental Analytics', summary: 'Environmental Protection Agency data analytics.', category: 'Government', visualType: 'lakehouse', docPath: 'use-cases/epa-environmental-analytics' },
  { id: 'noaa-climate', title: 'NOAA Climate & Ocean Analytics', summary: 'Climate + oceanographic data analysis at scale.', category: 'Government', visualType: 'notebook', docPath: 'use-cases/noaa-climate-analytics' },
  { id: 'nasa-earth', title: 'NASA Earth Science Analytics', summary: 'Earth-science data pipelines + analysis.', category: 'Government', visualType: 'notebook', docPath: 'use-cases/nasa-earth-science-analytics' },
  { id: 'interior-resources', title: 'Interior Natural Resources', summary: 'Natural-resources management analytics.', category: 'Government', visualType: 'warehouse', docPath: 'use-cases/interior-natural-resources-analytics' },
  { id: 'usda-agriculture', title: 'USDA Agricultural Analytics', summary: 'Department of Agriculture data solutions.', category: 'Government', visualType: 'lakehouse', docPath: 'use-cases/usda-agriculture-analytics' },
  { id: 'usps-postal', title: 'USPS Postal Operations', summary: 'Postal-service operational analytics.', category: 'Government', visualType: 'kql-dashboard', docPath: 'use-cases/usps-postal-analytics' },
  { id: 'commerce-economic', title: 'Commerce Economic Analytics', summary: 'Economic data + trade analytics.', category: 'Government', visualType: 'semantic-model', docPath: 'use-cases/commerce-economic-analytics' },
  { id: 'ihs-tribal-health', title: 'IHS & Tribal Health Analytics', summary: 'Indian Health Service + tribal healthcare data.', category: 'Healthcare', visualType: 'lakehouse', docPath: 'use-cases/tribal-health-analytics', appId: 'app-healthcare-popmgt' },
  { id: 'rti-anomaly', title: 'Real-Time Anomaly Detection', summary: 'Fraud + anomaly detection on streaming data (Event Hubs → ADX → Activator).', category: 'Real-Time', visualType: 'activator', docPath: 'use-cases/realtime-intelligence-anomaly-detection', appId: 'app-iot-realtime' },
  { id: 'casino-gaming', title: 'Casino & Gaming Analytics', summary: 'Player-grain facts, real-time win/loss, high-roller Activator alerts.', category: 'Industry', visualType: 'warehouse', docPath: 'use-cases/casino-gaming-analytics', appId: 'app-casino-analytics' },
  { id: 'fed-cyber', title: 'Federal Cybersecurity & Threat Analytics', summary: 'Threat detection + security analytics on Loom.', category: 'Cybersecurity', visualType: 'kql-database', docPath: 'use-cases/cybersecurity-threat-analytics' },
  { id: 'unified-analytics', title: 'Unified Analytics', summary: 'Consolidated analytics — the Fabric experience on Azure-native Loom.', category: 'Platform', visualType: 'lakehouse', docPath: 'use-cases/fabric-unified-analytics' },
  { id: 'data-virtualization', title: 'Data Virtualization', summary: 'Cross-cloud data access without copies.', category: 'Multi-Cloud', visualType: 'data-product', docPath: 'use-cases/multi-cloud-data-virtualization' },
  { id: 'api-first-ai', title: 'API-First Multi-Model AI Ecosystem', summary: 'AI + data through an API-gateway architecture (APIM).', category: 'API-First', visualType: 'apim-api', docPath: 'use-cases/api-first-multi-model-ai-ecosystem' },
  { id: 'dataverse-integration', title: 'Dataverse API Integration', summary: 'Microsoft Dataverse connectivity + analytics.', category: 'API-First', visualType: 'dataverse-table', docPath: 'use-cases/dataverse-api-integration' },
  { id: 'eam-apim', title: 'Enterprise Asset Management via APIM', summary: 'Asset management exposed + governed through API Management.', category: 'API-First', visualType: 'apim-product', docPath: 'use-cases/enterprise-asset-management-apim' },
  { id: 'cross-platform', title: 'Cross-Platform Integration', summary: 'Integration across multiple platforms + clouds.', category: 'Multi-Cloud', visualType: 'data-pipeline', docPath: 'use-cases/cross-platform-integration-fabric' },
  { id: 'antitrust-analytics', title: 'Antitrust Market Analytics', summary: 'Market-concentration + merger-review analytics workflow on Loom.', category: 'Government', visualType: 'warehouse', docPath: 'use-cases/antitrust-analytics' },
  { id: 'ai-document-ediscovery', title: 'AI Document Analytics & eDiscovery', summary: 'LLM-assisted document review, classification, and eDiscovery on Azure-native AI Search + Foundry.', category: 'Legal & eDiscovery', visualType: 'ai-search-index', docPath: 'use-cases/ai-document-analytics-ediscovery' },

  // ── Sovereign / Gov-cloud scenarios (docs/fiab/use-cases/) ────────────────
  { id: 'federal-data-mesh', title: 'Federal Data Mesh', summary: 'Domain-oriented, governed data mesh across federal agencies on Loom.', category: 'Government — Sovereign', visualType: 'data-product', docPath: 'fiab/use-cases/federal-data-mesh', appId: 'app-federal-data-mesh' },
  { id: 'multi-agency-onboarding', title: 'Multi-Agency Onboarding', summary: 'Onboard multiple agencies into a shared, isolated Loom platform.', category: 'Government — Sovereign', visualType: 'powerplatform-environment', docPath: 'fiab/use-cases/multi-agency-onboarding', appId: 'app-multi-agency-onboarding' },
  { id: 'direct-lake-replacement', title: 'Direct Lake Replacement', summary: 'Replace Fabric Direct Lake with the Azure-native warm-cache semantic layer.', category: 'Government — Sovereign', visualType: 'semantic-model', docPath: 'fiab/use-cases/direct-lake-replacement', appId: 'app-direct-lake-replacement' },
  { id: 'sovereign-ai-agents', title: 'Sovereign AI Agents', summary: 'Air-gapped, sovereign AI Foundry agents grounded in agency data.', category: 'Government — Sovereign', visualType: 'ai-foundry-project', docPath: 'fiab/use-cases/sovereign-ai-agents', appId: 'app-sovereign-ai-agents' },
  { id: 'hybrid-topology', title: 'Hybrid Topology', summary: 'Hybrid on-prem + Gov-cloud Loom topology for regulated workloads.', category: 'Government — Sovereign', visualType: 'plan', docPath: 'fiab/use-cases/hybrid-topology', appId: 'app-hybrid-topology' },

  // ── Solution accelerators (docs/learn/08-solutions/) ──────────────────────
  { id: 'sol-azure-realtime', title: 'Azure Real-Time Analytics Accelerator', summary: 'End-to-end streaming analytics accelerator — Event Hubs → ADX → dashboards.', category: 'Solution accelerators', visualType: 'eventstream', docPath: 'learn/08-solutions/azure-realtime-analytics', appId: 'app-azure-realtime-analytics' },
  { id: 'sol-change-feed', title: 'Change Feed Processor', summary: 'Cosmos DB change-feed → near-real-time downstream processing pattern.', category: 'Solution accelerators', visualType: 'mirrored-database', docPath: 'learn/08-solutions/change-feed-processor', appId: 'app-change-feed-processor' },
  { id: 'sol-data-governance', title: 'Data Governance & Lineage', summary: 'Catalog, classify, and trace column-level lineage across the platform.', category: 'Solution accelerators', visualType: 'data-product', docPath: 'learn/08-solutions/data-governance/lineage', appId: 'app-data-governance' },
  { id: 'sol-logic-apps', title: 'Logic Apps Integration', summary: 'Event-driven orchestration + integration with Azure Logic Apps.', category: 'Solution accelerators', visualType: 'data-pipeline', docPath: 'learn/08-solutions/logic-apps-integration', appId: 'app-logic-apps-integration' },
  { id: 'sol-ml-pipeline', title: 'ML Pipeline Accelerator', summary: 'Train, register, and operationalize models with an MLflow-backed pipeline.', category: 'Solution accelerators', visualType: 'ml-experiment', docPath: 'learn/08-solutions/ml-pipeline', appId: 'app-ml-pipeline' },
  { id: 'sol-realtime-dashboards', title: 'Real-Time Dashboards', summary: 'Live operational dashboards over ADX with KQL-driven tiles.', category: 'Solution accelerators', visualType: 'kql-dashboard', docPath: 'learn/08-solutions/real-time-dashboards', appId: 'app-real-time-dashboards' },

  // ── Industry blueprints (docs/industries/) ────────────────────────────────
  { id: 'ind-financial-services', title: 'Financial Services Blueprint', summary: 'Risk, fraud, and regulatory analytics blueprint for financial services.', category: 'Industry', visualType: 'warehouse', docPath: 'industries/financial-services' },
  { id: 'ind-manufacturing', title: 'Manufacturing Blueprint', summary: 'IoT + OEE + predictive-maintenance analytics for manufacturing.', category: 'Industry', visualType: 'eventstream', docPath: 'industries/manufacturing' },
  { id: 'ind-retail-cpg', title: 'Retail & CPG Blueprint', summary: 'Demand forecasting, personalization, and supply-chain analytics.', category: 'Industry', visualType: 'lakehouse', docPath: 'industries/retail-cpg' },
  { id: 'ind-energy-utilities', title: 'Energy & Utilities Blueprint', summary: 'Grid telemetry, smart-meter, and outage analytics.', category: 'Industry', visualType: 'kql-database', docPath: 'industries/energy-utilities' },
  { id: 'ind-telco', title: 'Telecommunications Blueprint', summary: 'Network performance, churn, and usage analytics for telco.', category: 'Industry', visualType: 'eventstream', docPath: 'industries/telco' },
  { id: 'ind-life-sciences', title: 'Life Sciences & Genomics Blueprint', summary: 'Genomics, clinical-trial, and research analytics for life sciences.', category: 'Industry', visualType: 'notebook', docPath: 'industries/life-sciences' },
];

export interface LearnTopic {
  /** Item-type slug (for editor guides) or a synthetic id (tutorials/services). */
  id: string;
  title: string;
  summary?: string;
  section: LearnSection;
  /** WorkloadCategory for editor guides; a friendly group label otherwise. */
  category: string;
  /** Item-type slug used to resolve icon + color via itemVisual(). */
  visualType: string;
  /** PRIMARY link — CSA Loom doc when it exists, else the MS-Learn link. */
  primaryUrl: string;
  /** Label for the primary link ("Loom guide" or "MS Learn"). */
  primaryLabel: string;
  /** SECONDARY link — MS Learn / service docs (omitted when none / same as primary). */
  msLearnUrl?: string;
  /** True when a real CSA Loom doc backs the primary link. */
  hasLoomDoc: boolean;
  /**
   * INTERNAL app-install link — relative Next route /apps/<appId> for the
   * matching one-click content-bundle app (NOT run through loomDocUrl; it is a
   * same-origin route, never a docs URL). Only set when the appId is registered
   * in both the bundle REGISTRY and CATALOG_META (installable + discoverable).
   */
  appHref?: string;
  /** Label for the app-install link (e.g. "Install app"). */
  appLabel?: string;
  /** Published thumbnail URL (editor guides only); undefined → use icon art. */
  thumbUrl?: string;
  preview?: boolean;
  /**
   * When set, this topic maps to an installable content-bundle app. The Learn
   * use-case card surfaces an "Install live example" button that opens the
   * shared InstallAppDialog and drives the real install → provision → seed flow
   * via POST /api/apps/{appId}/install. Comes straight from the typed USE_CASES
   * table — never freeform.
   */
  appId?: string;
}

/** The 8 numbered, end-to-end walkthroughs under docs/fiab/tutorials/. */
const NUMBERED_TUTORIALS: ReadonlyArray<{
  id: string; title: string; summary: string; visualType: string;
}> = [
  { id: '01-first-workspace', title: 'Your first workspace',
    summary: 'Provision a workspace, set roles, and orient yourself in the Loom console.',
    visualType: 'powerplatform-environment' },
  { id: '02-first-lakehouse', title: 'First Lakehouse + Delta tables',
    summary: 'Land raw files, load them to managed Delta tables, and query via the SQL endpoint.',
    visualType: 'lakehouse' },
  { id: '03-direct-lake-parity', title: 'Direct Lake parity',
    summary: 'Wire a semantic model in Direct Lake mode with the warm-cache materializer.',
    visualType: 'semantic-model' },
  { id: '04-activator-rules', title: 'Activator rules over an IoT stream',
    summary: 'Fire Teams / email actions when a streaming threshold is breached.',
    visualType: 'activator' },
  { id: '05-data-agent', title: 'Data Agent over a Lakehouse',
    summary: 'Stand up a conversational Q&A agent grounded in your lakehouse + semantic models.',
    visualType: 'data-agent' },
  { id: '06-mirroring-cosmos', title: 'Mirror Cosmos DB to a Lakehouse',
    summary: 'Near-real-time replicate a Cosmos container into OneLake and query the mirror.',
    visualType: 'mirrored-database' },
  { id: '07-marketplace-data-product', title: 'Publish a marketplace data product',
    summary: 'Bundle items into a governed, endorsed data product and publish it to the catalog.',
    visualType: 'data-product' },
  { id: '08-forward-migrate-to-fabric', title: 'Forward-migrate a Lakehouse to Fabric',
    summary: 'Lift a Loom lakehouse into Microsoft Fabric without re-engineering pipelines.',
    visualType: 'lakehouse' },
];

/** Loom-engine service guides under docs/fiab/services/. */
const SERVICE_GUIDES: ReadonlyArray<{
  id: string; title: string; summary: string; visualType: string;
}> = [
  { id: 'activator-engine', title: 'Activator engine',
    summary: 'How Loom evaluates Activator rules and dispatches actions without Fabric Reflex.',
    visualType: 'activator' },
  { id: 'mirroring-engine', title: 'Mirroring engine',
    summary: 'The change-feed replicator that keeps OneLake mirrors in sync with their source.',
    visualType: 'mirrored-database' },
  { id: 'direct-lake-shim', title: 'Direct-Lake shim',
    summary: 'The warm-cache materializer that gives Power BI sub-second Direct Lake reads.',
    visualType: 'semantic-model' },
];

/** Reference topics — concept docs that aren't tied to one editor. */
const REFERENCE_TOPICS: ReadonlyArray<{
  id: string; title: string; summary: string; visualType: string; path: string;
}> = [
  { id: 'what-is-csa-loom', title: 'What is CSA Loom?',
    summary: 'The one-page orientation: what Loom is, how it maps to Fabric + Azure, and why.',
    visualType: 'data-product', path: 'fiab/what-is-csa-loom' },
  { id: 'architecture', title: 'Reference architecture',
    summary: 'End-to-end architecture of the Loom platform and its Azure backing services.',
    visualType: 'plan', path: 'fiab/architecture' },
  { id: 'portal-architecture', title: 'Portal architecture',
    summary: 'Where admins and users go — the console surfaces and how they fit together.',
    visualType: 'powerplatform-environment', path: 'fiab/portal-architecture' },
  { id: 'parity-matrix', title: 'Parity matrix',
    summary: 'Feature-by-feature parity scorecard against Microsoft Fabric and Azure.',
    visualType: 'scorecard', path: 'fiab/parity-matrix' },
];

/**
 * Build the full Learn-library catalog: every editor guide (one per catalog
 * item type that has Learn content) plus the numbered tutorials, Loom service
 * guides, and reference topics. Every entry resolves to a real, non-dead link.
 */
export function getLearnCatalog(): LearnTopic[] {
  const topics: LearnTopic[] = [];

  // Numbered tutorials (always have a Loom doc).
  for (const t of NUMBERED_TUTORIALS) {
    const path = `fiab/tutorials/${t.id}`;
    topics.push({
      id: `tutorial:${t.id}`, title: t.title, summary: t.summary,
      section: 'Tutorials', category: 'End-to-end tutorials', visualType: t.visualType,
      primaryUrl: loomDocUrl(path), primaryLabel: 'Loom guide', hasLoomDoc: true,
    });
  }

  // Real-world use cases (CSA-in-a-Box scenarios, built on Loom). Each card
  // deep-links to its OWN authored walkthrough doc; when a matching content
  // bundle is registered (in both the REGISTRY and CATALOG_META) the card also
  // offers a one-click "Install app" link to the internal /apps/<id> route.
  for (const u of USE_CASES) {
    const appInstallable = !!u.appId && !!getBundle(u.appId) && !!CATALOG_META[u.appId];
    topics.push({
      id: `usecase:${u.id}`, title: u.title, summary: u.summary,
      section: 'Use cases', category: u.category, visualType: u.visualType,
      primaryUrl: loomDocUrl(u.docPath), primaryLabel: 'Walkthrough', hasLoomDoc: true,
      ...(appInstallable ? { appId: u.appId, appHref: `/apps/${u.appId}`, appLabel: 'Install app' } : {}),
    });
  }

  // Editor guides — one per catalog item type that has Learn content.
  for (const it of FABRIC_ITEM_TYPES) {
    const learn = getLearn(it.slug);
    if (!learn) continue;
    topics.push({
      id: `editor:${it.slug}`,
      title: learn.title,
      summary: learn.summary,
      section: 'Editor guides',
      category: it.category,
      visualType: it.slug,
      primaryUrl: learn.docsUrl ?? loomDocUrl('fiab/index'),
      primaryLabel: learn.hasLoomDoc ? 'Loom guide' : 'MS Learn',
      msLearnUrl: learn.hasLoomDoc ? learn.msLearnUrl : undefined,
      hasLoomDoc: !!learn.hasLoomDoc,
      thumbUrl: loomThumbUrl(it.slug),
      preview: it.preview,
    });
  }

  // Loom service guides.
  for (const s of SERVICE_GUIDES) {
    const path = `fiab/services/${s.id}`;
    topics.push({
      id: `service:${s.id}`, title: s.title, summary: s.summary,
      section: 'Service guides', category: 'Loom engines', visualType: s.visualType,
      primaryUrl: loomDocUrl(path), primaryLabel: 'Loom guide', hasLoomDoc: true,
    });
  }

  // Reference topics.
  for (const r of REFERENCE_TOPICS) {
    topics.push({
      id: `ref:${r.id}`, title: r.title, summary: r.summary,
      section: 'Reference', category: 'Concepts', visualType: r.visualType,
      primaryUrl: loomDocUrl(r.path), primaryLabel: 'Loom guide', hasLoomDoc: true,
    });
  }

  return topics;
}

/** Item-type slugs that have a Learn entry but NO Loom doc yet (build-out backlog). */
export function loomDocBacklog(): string[] {
  return FABRIC_ITEM_TYPES
    .filter((it) => getLearn(it.slug) && !EDITOR_DOC_SLUGS.has(it.slug))
    .map((it) => it.slug);
}
