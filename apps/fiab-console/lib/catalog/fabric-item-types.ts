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
  | 'APIs and functions';

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
];

export function itemsByCategory(category: WorkloadCategory): FabricItemType[] {
  return FABRIC_ITEM_TYPES.filter((i) => i.category === category);
}

export function findItemType(slug: string): FabricItemType | undefined {
  return FABRIC_ITEM_TYPES.find((i) => i.slug === slug);
}
