/**
 * Authoritative Fabric item-type catalog, sourced from
 * docs/fiab/fabric-feature-inventory.md (which was assembled via
 * Microsoft Learn MCP — item-definition-overview,
 * item-management-overview, and per-workload product overviews).
 *
 * Used by:
 *  - the `+ New item` dialog (categorized grid)
 *  - the per-item-type editor routes at /items/[type]/[id]
 *  - the workspace inventory rollup
 *
 * Keep in sync with the inventory doc; any drift means the doc is
 * stale (re-fetch via microsoft_docs_search) or this file is.
 */

export type WorkloadCategory =
  | 'Data Engineering'
  | 'Data Factory'
  | 'Data Warehouse'
  | 'Databases'
  | 'Real-Time Intelligence'
  | 'Data Science'
  | 'Fabric IQ'
  | 'Power BI'
  | 'APIs and functions'
  | 'Synapse Analytics'
  | 'Azure Databricks'
  | 'Azure Data Factory'
  | 'Azure Data Lake Analytics'
  | 'Azure AI Foundry'
  | 'Azure SQL Database'
  | 'Azure Geoanalytics'
  | 'Azure Graph + Vector'
  | 'CSA Data Products'
  | 'Copilot Studio'
  | 'Power Platform'
  | 'AI & Agents';

export interface FabricItemType {
  /** Route slug — used at /items/[slug]/[id] */
  slug: string;
  /** Display name shown in dialog + editor */
  displayName: string;
  /** REST API type name (matches Fabric REST `type` field) */
  restType: string;
  /** Short one-line summary for the New item dialog card */
  description: string;
  /** Workload category for grouping */
  category: WorkloadCategory;
  /** True when this is a preview-only item type */
  preview?: boolean;
  /** True when no Fabric REST API exists (Scorecard, Dataflow Gen1) */
  noRestApi?: boolean;
}

export const FABRIC_ITEM_TYPES: readonly FabricItemType[] = [
  // Data Engineering
  { slug: 'lakehouse', displayName: 'Lakehouse', restType: 'Lakehouse', category: 'Data Engineering',
    description: 'A unified store for files, folders, and Delta tables in OneLake.' },
  { slug: 'notebook', displayName: 'Notebook', restType: 'Notebook', category: 'Data Engineering',
    description: 'Interactive Spark / Python authoring with cells and outputs.' },
  { slug: 'spark-job-definition', displayName: 'Spark job definition', restType: 'SparkJobDefinition', category: 'Data Engineering',
    description: 'Run a compiled Spark application (JAR / .py) against your lakehouse.' },
  { slug: 'environment', displayName: 'Environment', restType: 'Environment', category: 'Data Engineering',
    description: 'Reusable Spark settings and library bundle for notebooks and jobs.' },

  // Data Factory
  { slug: 'data-pipeline', displayName: 'Data pipeline', restType: 'DataPipeline', category: 'Data Factory',
    description: 'Orchestrate Copy, Lookup, ForEach, Notebook, Stored procedure, Web, and more.' },
  { slug: 'dataflow', displayName: 'Dataflow Gen2', restType: 'Dataflow', category: 'Data Factory',
    description: 'Low-code Power Query data prep with visual + M code authoring.' },
  { slug: 'copy-job', displayName: 'Copy job', restType: 'CopyJob', category: 'Data Factory',
    description: 'Wizard-driven bulk ingestion from any supported connector.' },
  { slug: 'mirrored-database', displayName: 'Mirrored database', restType: 'MirroredDatabase', category: 'Data Factory',
    description: 'Near-real-time replica of Snowflake / SQL DB / Postgres / Cosmos / MSSQL into OneLake.' },
  { slug: 'mirrored-databricks', displayName: 'Mirrored Databricks catalog', restType: 'MirroredAzureDatabricksCatalog', category: 'Data Factory',
    description: 'Mount a Databricks Unity Catalog as a read-only mirror in OneLake.' },
  { slug: 'mounted-adf', displayName: 'Mounted Data Factory', restType: 'MountedDataFactory', category: 'Data Factory',
    description: 'Reference an existing Azure Data Factory and run its pipelines from Fabric.' },
  { slug: 'dbt-job', displayName: 'dbt job', restType: 'DataBuildToolJob', category: 'Data Factory',
    description: 'Run dbt Core projects against your warehouse with schedule + run history.' },
  { slug: 'airflow-job', displayName: 'Apache Airflow job', restType: 'ApacheAirflowJob', category: 'Data Factory', preview: true,
    description: 'Managed Airflow DAGs synced from a Git repo (preview).' },

  // Data Warehouse
  { slug: 'warehouse', displayName: 'Warehouse', restType: 'Warehouse', category: 'Data Warehouse',
    description: 'Lakehouse-native T-SQL warehouse with separated compute and storage.' },

  // Databases
  { slug: 'sql-database', displayName: 'SQL database', restType: 'SQLDatabase', category: 'Databases',
    description: 'Azure SQL Database surface inside Fabric with auto-mirroring to OneLake.' },

  // Real-Time Intelligence
  { slug: 'eventhouse', displayName: 'Eventhouse', restType: 'Eventhouse', category: 'Real-Time Intelligence',
    description: 'Compute + storage container for one or more KQL databases.' },
  { slug: 'kql-database', displayName: 'KQL database', restType: 'KQLDatabase', category: 'Real-Time Intelligence',
    description: 'Kusto database for high-volume, low-latency analytics with OneLake availability.' },
  { slug: 'kql-queryset', displayName: 'KQL queryset', restType: 'KQLQueryset', category: 'Real-Time Intelligence',
    description: 'Persisted set of KQL queries with charts and saved views.' },
  { slug: 'kql-dashboard', displayName: 'Real-Time dashboard', restType: 'KQLDashboard', category: 'Real-Time Intelligence',
    description: 'Tile grid powered by KQL queries with parameters and auto-refresh.' },
  { slug: 'eventstream', displayName: 'Eventstream', restType: 'Eventstream', category: 'Real-Time Intelligence',
    description: 'Visual canvas to ingest, transform, and route real-time event streams.' },
  { slug: 'event-schema-set', displayName: 'Event schema set', restType: 'EventSchemaSet', category: 'Real-Time Intelligence',
    description: 'Schema registry for event streams powering DeltaFlow CDC.' },
  { slug: 'activator', displayName: 'Activator', restType: 'Reflex', category: 'Real-Time Intelligence',
    description: 'Detect conditions and trigger actions (Teams, email, pipeline, notebook, Power Automate).' },

  // Data Science
  { slug: 'ml-model', displayName: 'ML model', restType: 'MLModel', category: 'Data Science',
    description: 'MLflow-backed registered model with versions and PREDICT endpoint.' },
  { slug: 'ml-experiment', displayName: 'ML experiment', restType: 'MLExperiment', category: 'Data Science',
    description: 'Track runs, parameters, metrics, and artifacts for a model family.' },

  // Fabric IQ (preview)
  { slug: 'ontology', displayName: 'Ontology', restType: 'Ontology', category: 'Fabric IQ', preview: true,
    description: 'Define business entities, relationships, and condition-action rules.' },
  { slug: 'graph-model', displayName: 'Graph model', restType: 'GraphModel', category: 'Fabric IQ', preview: true,
    description: 'Native graph storage + GQL queries for connected data.' },
  { slug: 'plan', displayName: 'Plan', restType: 'Plan', category: 'Fabric IQ', preview: true,
    description: 'Collaborative planning sheets with writeback and approvals.' },
  { slug: 'map', displayName: 'Map', restType: 'Map', category: 'Fabric IQ', preview: true,
    description: 'Geospatial visualization layered over Lakehouse, KQL, and Ontology data.' },
  { slug: 'data-agent', displayName: 'Data agent', restType: 'DataAgent', category: 'Fabric IQ',
    description: 'Conversational Q&A grounded in your data sources and semantic model.' },
  { slug: 'operations-agent', displayName: 'Operations agent', restType: 'OperationsAgent', category: 'Fabric IQ', preview: true,
    description: 'Monitor real-time data and recommend actions via Activator + Power Automate.' },

  // Power BI
  { slug: 'semantic-model', displayName: 'Semantic model', restType: 'SemanticModel', category: 'Power BI',
    description: 'Tables, relationships, measures, and roles backing Power BI reports.' },
  { slug: 'report', displayName: 'Report', restType: 'Report', category: 'Power BI',
    description: 'Interactive Power BI report with pages, visuals, and filters.' },
  { slug: 'dashboard', displayName: 'Dashboard', restType: 'Dashboard', category: 'Power BI',
    description: 'Pinned-visual dashboard surfacing tiles from multiple reports.' },
  { slug: 'paginated-report', displayName: 'Paginated report', restType: 'PaginatedReport', category: 'Power BI',
    description: 'Pixel-perfect RDL report for printable, parameterized output.' },
  { slug: 'scorecard', displayName: 'Scorecard', restType: 'Scorecard', category: 'Power BI', noRestApi: true,
    description: 'KPI tree with targets and status (no REST API today; metadata only).' },

  // APIs and functions
  { slug: 'graphql-api', displayName: 'API for GraphQL', restType: 'GraphQLApi', category: 'APIs and functions',
    description: 'Single GraphQL endpoint over Warehouse / Lakehouse / SQL DB / mirrored DBs.' },
  { slug: 'user-data-function', displayName: 'User data function', restType: 'UserDataFunction', category: 'APIs and functions',
    description: 'Python functions with bindings to Fabric items and external connections.' },
  { slug: 'variable-library', displayName: 'Variable library', restType: 'VariableLibrary', category: 'APIs and functions',
    description: 'Centralized variables with value sets per environment (dev / test / prod).' },

  // --- Azure-native services, surfaced 1:1 in Loom (no studio jumps) ---
  // Synapse Analytics
  { slug: 'synapse-dedicated-sql-pool',  displayName: 'Synapse dedicated SQL pool',  restType: 'SynapseDedicatedSqlPool',  category: 'Synapse Analytics',
    description: 'Provisioned, MPP T-SQL warehouse. Query editor, monitoring, scaling — native in Loom.' },
  { slug: 'synapse-serverless-sql-pool', displayName: 'Synapse serverless SQL pool', restType: 'SynapseServerlessSqlPool', category: 'Synapse Analytics',
    description: 'Pay-per-query T-SQL over ADLS. OPENROWSET, external tables, ad-hoc analytics.' },
  { slug: 'synapse-spark-pool',          displayName: 'Synapse Spark pool',          restType: 'SynapseSparkPool',          category: 'Synapse Analytics',
    description: 'Apache Spark notebooks + job definitions on Synapse-managed clusters.' },
  { slug: 'synapse-pipeline',            displayName: 'Synapse pipeline',            restType: 'SynapsePipeline',           category: 'Synapse Analytics',
    description: 'Synapse Integrate canvas — pipelines, dataflows, triggers native to Synapse.' },
  // Azure Databricks
  { slug: 'databricks-notebook',         displayName: 'Databricks notebook',         restType: 'DatabricksNotebook',        category: 'Azure Databricks',
    description: 'Databricks notebook cells (PySpark / SQL / R / Scala) with cluster attach.' },
  { slug: 'databricks-job',              displayName: 'Databricks job',              restType: 'DatabricksJob',             category: 'Azure Databricks',
    description: 'Multi-task Databricks job — notebooks, JARs, Python wheels, dbt, SQL.' },
  { slug: 'databricks-cluster',          displayName: 'Databricks cluster',          restType: 'DatabricksCluster',         category: 'Azure Databricks',
    description: 'All-purpose or job cluster — node types, autoscale, init scripts, libraries.' },
  { slug: 'databricks-sql-warehouse',    displayName: 'Databricks SQL warehouse',    restType: 'DatabricksSqlWarehouse',    category: 'Azure Databricks',
    description: 'Serverless / classic SQL warehouse with Unity Catalog and Photon.' },
  // Azure Data Factory (separate from Fabric Data Factory)
  { slug: 'adf-pipeline',                displayName: 'ADF pipeline',                restType: 'AdfPipeline',               category: 'Azure Data Factory',
    description: 'Classic ADF pipeline — 90+ activities, IR-aware, on-prem via Self-hosted IR.' },
  { slug: 'adf-dataset',                 displayName: 'ADF dataset',                 restType: 'AdfDataset',                category: 'Azure Data Factory',
    description: 'Typed dataset over linked services — JSON, Parquet, Delimited, SQL, REST, etc.' },
  { slug: 'adf-trigger',                 displayName: 'ADF trigger',                 restType: 'AdfTrigger',                category: 'Azure Data Factory',
    description: 'Schedule, tumbling window, storage event, or custom event trigger.' },
  // Azure Data Lake Analytics
  { slug: 'usql-job',                    displayName: 'U-SQL job',                   restType: 'UsqlJob',                   category: 'Azure Data Lake Analytics',
    description: 'U-SQL script over ADLS Gen1/Gen2 with C# UDFs. Legacy ADLA workloads, native in Loom.' },

  // --- API-first surfacing: APIM is the runtime glue for every Loom-managed function, ML endpoint, and data product ---
  { slug: 'apim-api',                    displayName: 'APIM API',                    restType: 'ApimApi',                   category: 'APIs and functions',
    description: 'A versioned API on Azure API Management. Auto-imports OpenAPI / GraphQL / WSDL; ties to Loom items as backends.' },
  { slug: 'apim-product',                displayName: 'APIM product',                restType: 'ApimProduct',               category: 'APIs and functions',
    description: 'Bundles APIs into a subscribable offering: rate limits, quotas, terms, publisher portal landing.' },
  { slug: 'apim-policy',                 displayName: 'APIM policy',                 restType: 'ApimPolicy',                category: 'APIs and functions',
    description: 'Inbound / backend / outbound / on-error XML policy: JWT validation, rate-limit, cache, transform, mock.' },
  { slug: 'data-product',                displayName: 'Data product',                restType: 'DataProduct',               category: 'APIs and functions',
    description: 'Data-mesh-aligned package: dataset + semantic contract + APIM API + access policy + owner. Listed in the marketplace.' },

  // --- Azure AI Foundry hub (Microsoft.MachineLearningServices/workspaces kind=Hub) ---
  { slug: 'ai-foundry-hub',              displayName: 'AI Foundry hub',              restType: 'AiFoundryHub',              category: 'Azure AI Foundry',
    description: 'Azure AI Foundry hub workspace — connections, models, online endpoints, computes, datastores, and jobs. Native in Loom.' },

  // v2.5 — Azure AI Foundry sub-editors (project + project-scoped surfaces)
  { slug: 'ai-foundry-project',          displayName: 'AI Foundry project',          restType: 'AiFoundryProject',          category: 'Azure AI Foundry',
    description: 'Child workspace under the Foundry hub. Inherits connections/models/datastores; scopes prompt flows, evaluations, and data assets.' },
  { slug: 'prompt-flow',                 displayName: 'Prompt flow',                 restType: 'PromptFlow',                category: 'Azure AI Foundry',
    description: 'LangChain-style flow graph of LLM + tool nodes. Author the YAML/JSON definition, run with inputs, view run history.' },
  { slug: 'evaluation',                  displayName: 'Foundry evaluation',          restType: 'FoundryEvaluation',         category: 'Azure AI Foundry',
    description: 'Run quality / safety / accuracy evaluators against a dataset + model deployment. Surfaces metric tables and pass/fail signals.' },
  { slug: 'content-safety',              displayName: 'Content Safety',              restType: 'ContentSafety',             category: 'Azure AI Foundry',
    description: 'Azure AI Content Safety: text + image moderation across hate/violence/sexual/self-harm with severity thresholds.' },
  { slug: 'tracing',                     displayName: 'Foundry tracing',             restType: 'FoundryTracing',            category: 'Azure AI Foundry',
    description: 'Operation traces (App Insights) for prompt flow runs, evaluator runs, and endpoint calls. Filter by operation + window.' },
  { slug: 'ai-search-index',             displayName: 'AI Search index',             restType: 'AiSearchIndex',             category: 'Azure AI Foundry',
    description: 'Azure AI Search index — fields, scoring profiles, vector + hybrid query. Backs RAG grounding for Foundry agents.' },
  { slug: 'compute',                     displayName: 'Foundry compute',             restType: 'FoundryCompute',            category: 'Azure AI Foundry',
    description: 'AML compute instances + clusters. Create, start, stop, scale, delete. Used by prompt flows, evaluations, training jobs.' },
  { slug: 'dataset',                     displayName: 'Foundry dataset',             restType: 'FoundryDataset',            category: 'Azure AI Foundry',
    description: 'AML data asset — URI file, URI folder, or MLTable. Versioned, used by prompt flows + evaluations + training runs.' },

  // --- v3 — Copilot Studio (Power Platform / Dataverse-backed agents) ---
  { slug: 'copilot-studio-agent',        displayName: 'Copilot Studio agent',        restType: 'CopilotStudioAgent',        category: 'Copilot Studio',
    description: 'Conversational agent stored in Power Platform Dataverse. Instructions, knowledge, topics, actions, channels — native in Loom.' },
  { slug: 'copilot-studio-knowledge',    displayName: 'Copilot knowledge source',    restType: 'CopilotKnowledgeSource',    category: 'Copilot Studio',
    description: 'Grounding source for an agent — URL, file, SharePoint site, or Dataverse table.' },
  { slug: 'copilot-studio-topic',        displayName: 'Copilot topic',               restType: 'CopilotTopic',              category: 'Copilot Studio',
    description: 'Trigger-phrase-driven dialog flow authored in Copilot Studio YAML.' },
  { slug: 'copilot-studio-action',       displayName: 'Copilot action',              restType: 'CopilotAction',             category: 'Copilot Studio',
    description: 'Power Automate flow, custom connector, or prebuilt action bound to a Copilot Studio agent.' },
  { slug: 'copilot-studio-channel',      displayName: 'Copilot channel',             restType: 'CopilotChannel',            category: 'Copilot Studio',
    description: 'Publish an agent to Teams, Web chat, Direct Line, Slack, or a custom channel.' },
  { slug: 'copilot-studio-analytics',    displayName: 'Copilot analytics',           restType: 'CopilotAnalytics',          category: 'Copilot Studio',
    description: 'Sessions, resolution rate, escalation rate, and CSAT for a Copilot Studio agent (last 30 days by default).' },
  { slug: 'copilot-template-library',    displayName: 'Copilot template library',    restType: 'CopilotTemplateLibrary',    category: 'Copilot Studio',
    description: 'CSA-curated agent templates: data steward, contract analyzer, RFP responder, etc.' },

  // --- v3 — Power Platform (Environments, Dataverse, Power Apps, Power Automate, Power Pages, AI Builder) ---
  { slug: 'powerplatform-environment',   displayName: 'Power Platform environment',  restType: 'PowerPlatformEnvironment',  category: 'Power Platform',
    description: 'Power Platform environment surfaced via the BAP admin API — SKU, region, Dataverse domain, security group, DLP summary.' },
  { slug: 'dataverse-table',             displayName: 'Dataverse table',             restType: 'DataverseTable',            category: 'Power Platform',
    description: 'Dataverse EntityDefinition — schema, attributes, primary keys, custom vs system. Sourced from Dataverse Web API v9.2.' },
  { slug: 'power-app',                   displayName: 'Power App',                   restType: 'PowerApp',                  category: 'Power Platform',
    description: 'Canvas or model-driven Power App in an environment — owner, last modified, play link. Sourced from the PowerApps admin API.' },
  { slug: 'power-automate-flow',         displayName: 'Power Automate flow',         restType: 'PowerAutomateFlow',         category: 'Power Platform',
    description: 'Cloud flow in Power Automate — state, trigger, run history, manual run. Sourced from the Flow admin API.' },
  { slug: 'power-page',                  displayName: 'Power Pages site',            restType: 'PowerPagesSite',            category: 'Power Platform',
    description: 'Power Pages website (mspp_website / adx_website) — domain, status, type. Sourced from Dataverse Web API.' },
  { slug: 'ai-builder-model',            displayName: 'AI Builder model',            restType: 'AiBuilderModel',            category: 'Power Platform',
    description: 'AI Builder model (msdyn_aimodel) — prediction / extraction / classification / form-processing. State + status from Dataverse.' },

  // --- v3 — Azure SQL family (Microsoft.Sql/servers + databases + MI + SQL Server 2025 features) ---
  { slug: 'azure-sql-server',            displayName: 'Azure SQL server',            restType: 'AzureSqlServer',            category: 'Azure SQL Database',
    description: 'Microsoft.Sql/servers — server-level admin, firewall, AAD admin, list of databases.' },
  { slug: 'azure-sql-database',          displayName: 'Azure SQL database',          restType: 'AzureSqlDatabase',          category: 'Azure SQL Database',
    description: 'Per-database T-SQL editor (TDS + AAD), Fabric mirroring config, geo-replication, vector index.' },
  { slug: 'azure-sql-managed-instance',  displayName: 'SQL Managed Instance',        restType: 'AzureSqlManagedInstance',   category: 'Azure SQL Database',
    description: 'Microsoft.Sql/managedInstances — listing + state. Editor execution deferred to v3.x (TDS via PE).' },
  { slug: 'sql-server-2025-vector-index',displayName: 'SQL Server 2025 vector index',restType: 'SqlServer2025VectorIndex',  category: 'Azure SQL Database',
    description: 'SQL Server 2025 native vector index — CREATE VECTOR INDEX, JSON_AGG, regex, similarity search.' },

  // --- v3 — Geoanalytics platform (Azure Maps + lakehouse geometry + spatial T-SQL/KQL + H3/S2) ---
  { slug: 'geo-map',                     displayName: 'Geo map',                     restType: 'GeoMap',                    category: 'Azure Geoanalytics',
    description: 'Azure Maps account + style + tile layer config. OSM fallback when no Maps account is deployed.' },
  { slug: 'geo-dataset',                 displayName: 'Geo dataset',                 restType: 'GeoDataset',                category: 'Azure Geoanalytics',
    description: 'GeoJSON / Parquet+geometry dataset in ADLS Gen2. Geometry-column inspector + sample preview.' },
  { slug: 'geo-query',                   displayName: 'Geo query',                   restType: 'GeoQuery',                  category: 'Azure Geoanalytics',
    description: 'Spatial query against Synapse Serverless / Kusto — H3, S2, ST_DISTANCE, ST_WITHIN.' },
  { slug: 'geo-pipeline',                displayName: 'Geo pipeline',                restType: 'GeoPipeline',               category: 'Azure Geoanalytics',
    description: 'ADF/Synapse pipeline specialized for geo enrichment (H3 index, reverse geocode, buffer).' },

  // --- v3 — Graph + knowledge stores (Cosmos Gremlin, ADX graph, Cypher, GQL, vector stores) ---
  { slug: 'cosmos-gremlin-graph',        displayName: 'Cosmos Gremlin graph',        restType: 'CosmosGremlinGraph',        category: 'Azure Graph + Vector',
    description: 'Cosmos DB for Apache Gremlin — graph traversal queries over property graphs.' },
  { slug: 'cypher-graph',                displayName: 'Cypher graph',                restType: 'CypherGraph',               category: 'Azure Graph + Vector',
    description: 'openCypher dialect over Cosmos / Neptune-compatible / ADX graph plugin.' },
  { slug: 'gql-graph',                   displayName: 'GQL graph',                   restType: 'GqlGraph',                  category: 'Azure Graph + Vector',
    description: 'ISO GQL standard graph query language against the graph backend of record.' },
  { slug: 'vector-store',                displayName: 'Vector store',                restType: 'VectorStore',               category: 'Azure Graph + Vector',
    description: 'Vector index — Cosmos vCore, AI Search, or PostgreSQL pgvector. Similarity search + RAG grounding.' },

  // --- v3 — Push-button data-products library (CSA-curated templates + instances) ---
  { slug: 'data-product-template',       displayName: 'Data product template',       restType: 'DataProductTemplate',       category: 'CSA Data Products',
    description: 'CSA-curated push-button template: medallion lakehouse, IoT analytics, federated mesh, RAG agent, geospatial.' },
  { slug: 'data-product-instance',       displayName: 'Data product instance',       restType: 'DataProductInstance',       category: 'CSA Data Products',
    description: 'Instantiated data product in a workspace — composed of underlying items (pipelines, lakehouses, indexes).' },

  // --- v3 — Cross-item Copilot orchestrator (AOAI via Foundry hub) ---
  { slug: 'cross-item-copilot',          displayName: 'Cross-item Copilot',          restType: 'CrossItemCopilot',          category: 'AI & Agents',
    description: 'Natural-language orchestrator across every wired Loom service: Synapse, Lakehouse, Databricks, APIM, ADX, ADF, Power BI, Fabric, Foundry. 25+ tools.' },
];

export const WORKLOAD_CATEGORIES: readonly WorkloadCategory[] = [
  'Data Engineering',
  'Data Factory',
  'Data Warehouse',
  'Databases',
  'Real-Time Intelligence',
  'Data Science',
  'Fabric IQ',
  'Power BI',
  'APIs and functions',
  'Synapse Analytics',
  'Azure Databricks',
  'Azure Data Factory',
  'Azure Data Lake Analytics',
  'Azure AI Foundry',
  'Azure SQL Database',
  'Azure Geoanalytics',
  'Azure Graph + Vector',
  'CSA Data Products',
  'Copilot Studio',
  'Power Platform',
];

export function itemsByCategory(category: WorkloadCategory): FabricItemType[] {
  return FABRIC_ITEM_TYPES.filter((i) => i.category === category);
}

export function findItemType(slug: string): FabricItemType | undefined {
  return FABRIC_ITEM_TYPES.find((i) => i.slug === slug);
}
