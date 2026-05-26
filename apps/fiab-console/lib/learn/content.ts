/**
 * Learn-popup content registry. Keys are FabricItemType ids (matches the
 * `type` URL param in /items/[type]/[id]). Only entries with real, hand-
 * authored content live here — per the no-vaporware rule we never fall
 * back to auto-generated placeholder text. Items without a learn entry
 * surface an honest "not yet authored" MessageBar in the Learn drawer.
 *
 * Contributions: add a new entry below. The Learn drawer auto-shows on
 * first visit to an item of that type; users can dismiss permanently
 * per-type via the "Don't show again" checkbox (persisted to user-prefs).
 */

export interface LearnEntry {
  title: string;
  summary?: string;
  steps?: string[];
  tip?: string;
  docsUrl?: string;
}

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
    summary: 'Simple data movement: source → sink, no transformations. Optimized for bulk loads with built-in retry + fault tolerance.',
    docsUrl: 'https://learn.microsoft.com/fabric/data-factory/what-is-copy-job',
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
};

export function getLearn(itemType: string): LearnEntry | null {
  return REGISTRY[itemType] ?? null;
}
