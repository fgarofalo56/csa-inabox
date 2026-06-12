'use client';

/**
 * Editor registry — maps an item-type slug to a rich editor component.
 * Slugs not in the map fall back to the generic shell in the
 * /items/[type]/[id] route. Phases 2-4 wire all the major editors
 * here; the rest stay on the generic chrome until a focused editor
 * is shipped.
 */

import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

export interface EditorProps { item: FabricItemType; id: string; }

type EditorComponent = ComponentType<EditorProps>;

const reg = (loader: () => Promise<{ [k: string]: EditorComponent }>, name: string): EditorComponent =>
  dynamic(() => loader().then((m) => ({ default: m[name] })), { ssr: false });

export const EDITOR_REGISTRY: Record<string, EditorComponent> = {
  // Fabric Apps (Build 2026 preview)
  'rayfin-app':           reg(() => import('./rayfin-app-editor'),        'RayfinAppEditor'),
  // Data Marketplace — consumer discovery (F14/F18) over the loom-data-products AI Search index
  'data-marketplace':     reg(() => import('./data-marketplace'),        'DataMarketplaceEditor'),
  // Phase 2
  'lakehouse':            reg(() => import('./lakehouse-editor'),         'LakehouseEditor'),
  'materialized-lake-view': reg(() => import('./materialized-lake-view-editor'), 'MaterializedLakeViewEditor'),
  'notebook':             reg(() => import('./notebook-editor'),          'NotebookEditor'),
  'data-pipeline':        reg(() => import('./data-pipeline-editor'),     'DataPipelineEditor'),
  'dataflow':             reg(() => import('./dataflow-gen2-editor'),     'DataflowGen2Editor'),
  'mirrored-database':    reg(() => import('./mirrored-database-editor'), 'MirroredDatabaseEditor'),
  'mirrored-databricks':  reg(() => import('./mirrored-databricks-editor'), 'MirroredDatabricksEditor'),
  'mounted-adf':          reg(() => import('./mounted-adf-editor'),       'MountedAdfEditor'),
  'event-schema-set':     reg(() => import('./event-schema-set-editor'),  'EventSchemaSetEditor'),
  'airflow-job':          reg(() => import('./airflow-job-editor'),       'AirflowJobEditor'),
  'spark-job-definition': reg(() => import('./spark-job-definition-editor'), 'SparkJobDefinitionEditor'),
  'environment':          reg(() => import('./phase2-misc-editors'),      'EnvironmentEditor'),
  'spark-environment':    reg(() => import('./spark-environment-editor'), 'SparkEnvironmentEditor'),
  'copy-job':             reg(() => import('./copy-job-editor'),          'CopyJobEditor'),
  'dbt-job':              reg(() => import('./phase2-misc-editors'),      'DbtJobEditor'),

  // Phase 3
  'eventhouse':           reg(() => import('./phase3-editors'),           'EventhouseEditor'),
  // Workspace-monitoring DB — read-only ADX usage/perf store; reuses the
  // Eventhouse cluster/database surface (lists databases incl. the monitor DB).
  'workspace-monitor':    reg(() => import('./phase3-editors'),           'EventhouseEditor'),
  'kql-database':         reg(() => import('./phase3-editors'),           'KqlDatabaseEditor'),
  'kql-queryset':         reg(() => import('./phase3-editors'),           'KqlQuerysetEditor'),
  'kql-dashboard':        reg(() => import('./phase3-editors'),           'KqlDashboardEditor'),
  'eventstream':          reg(() => import('./phase3-editors'),           'EventstreamEditor'),
  'activator':            reg(() => import('./phase3-editors'),           'ActivatorEditor'),
  'warehouse':            reg(() => import('./phase3-editors'),           'WarehouseEditor'),
  // Datamart (DEPRECATED) — migration-only surface (Synapse Serverless + AAS). No create path.
  'datamart':             reg(() => import('./phase3-editors'),           'DatamartEditor'),
  'semantic-model':       reg(() => import('./phase3-editors'),           'SemanticModelEditor'),
  'report':               reg(() => import('./phase3-editors'),           'ReportEditor'),
  'dashboard':            reg(() => import('./phase3-editors'),           'DashboardEditor'),
  'paginated-report':     reg(() => import('./phase3-editors'),           'PaginatedReportEditor'),
  'scorecard':            reg(() => import('./phase3-editors'),           'ScorecardEditor'),

  // Phase 4
  'ml-model':             reg(() => import('./phase4-editors'),           'MlModelEditor'),
  'ml-experiment':        reg(() => import('./ml-experiment-editor'),     'MlExperimentEditor'),
  'automl':               reg(() => import('./automl-editor'),            'AutoMlEditor'),
  'graphql-api':          reg(() => import('./phase4-editors'),           'GraphqlApiEditor'),
  'user-data-function':   reg(() => import('./phase4-editors'),           'UserDataFunctionEditor'),
  'variable-library':     reg(() => import('./phase4-editors'),           'VariableLibraryEditor'),
  'ontology':             reg(() => import('./phase4-editors'),           'OntologyEditor'),
  'graph-model':          reg(() => import('./phase4-editors'),           'GraphModelEditor'),
  'plan':                 reg(() => import('./phase4-editors'),           'PlanEditor'),
  'map':                  reg(() => import('./phase4-editors'),           'MapEditor'),
  'operations-agent':     reg(() => import('./phase4-editors'),           'OperationsAgentEditor'),
  'data-agent':           reg(() => import('./phase4-editors'),           'DataAgentEditor'),

  // v3.5 — Data Science experience home (workload landing page)
  'data-science-home':    reg(() => import('./data-science-home-editor'), 'DataScienceHomeEditor'),

  // v1.5 — Native Azure-service editors (Synapse, Databricks, ADF, U-SQL)
  // v2.0 — Synapse Dedicated + Serverless are real-REST wired (TDS over PE + AAD MI)
  // v2.1 — Synapse Spark pool + Pipeline + Warehouse alias real-REST wired (ARM + dev endpoint)
  'synapse-dedicated-sql-pool':  reg(() => import('./synapse-sql-editors'),    'SynapseDedicatedSqlPoolEditor'),
  'synapse-serverless-sql-pool': reg(() => import('./synapse-serverless-sql-editor'), 'SynapseServerlessSqlEditor'),
  'synapse-spark-pool':          reg(() => import('./azure-services-editors'), 'SynapseSparkPoolEditor'),
  'synapse-pipeline':            reg(() => import('./azure-services-editors'), 'SynapsePipelineEditor'),
  'synapse-notebook':            reg(() => import('./synapse-notebook-editor'), 'SynapseNotebookEditor'),
  'databricks-notebook':         reg(() => import('./databricks-editors'),     'DatabricksNotebookEditor'),
  'databricks-job':              reg(() => import('./databricks-editors'),     'DatabricksJobEditor'),
  'databricks-cluster':          reg(() => import('./databricks-editors'),     'DatabricksClusterEditor'),
  'databricks-sql-warehouse':    reg(() => import('./databricks-editors'),     'DatabricksSqlWarehouseEditor'),
  'adf-pipeline':                reg(() => import('./azure-services-editors'), 'AdfPipelineEditor'),
  'adf-dataset':                 reg(() => import('./azure-services-editors'), 'AdfDatasetEditor'),
  'adf-trigger':                 reg(() => import('./azure-services-editors'), 'AdfTriggerEditor'),
  'stream-analytics-job':        reg(() => import('./stream-analytics-editor'), 'StreamAnalyticsJobEditor'),

  // v1.9 — APIM-first surface (API-first methodology, data product marketplace)
  'apim-api':                    reg(() => import('./apim-editors'),           'ApimApiEditor'),
  'apim-product':                reg(() => import('./apim-editors'),           'ApimProductEditor'),
  'apim-policy':                 reg(() => import('./apim-editors'),           'ApimPolicyEditor'),
  // data-product → read-first owner details page (F3). The full working owner
  // editor (DataProductEditor) is reached from there via ?view=edit.
  'data-product':                reg(() => import('./data-product-detail'),    'DataProductDetailEditor'),

  // v2.x — Azure AI Foundry hub (Microsoft.MachineLearningServices/workspaces kind=Hub)
  'ai-foundry-hub':              reg(() => import('./foundry-hub-editor'),     'FoundryHubEditor'),

  // v2.5 — AI Foundry sub-editors (projects + project-scoped surfaces)
  'ai-foundry-project':          reg(() => import('./foundry-sub-editors'),    'ProjectEditor'),
  'prompt-flow':                 reg(() => import('./foundry-sub-editors'),    'PromptFlowEditor'),
  'evaluation':                  reg(() => import('./foundry-sub-editors'),    'EvaluationEditor'),
  'content-safety':              reg(() => import('./foundry-sub-editors'),    'ContentSafetyEditor'),
  'tracing':                     reg(() => import('./foundry-sub-editors'),    'TracingEditor'),
  'ai-search-index':             reg(() => import('./foundry-sub-editors'),    'AiSearchIndexEditor'),
  'compute':                     reg(() => import('./foundry-sub-editors'),    'ComputeEditor'),
  'dataset':                     reg(() => import('./foundry-sub-editors'),    'DatasetEditor'),

  // v3 — Copilot Studio (Power Platform / Dataverse-backed agents)
  'copilot-studio-agent':        reg(() => import('./copilot-studio-editors'), 'CopilotStudioAgentEditor'),
  'copilot-studio-knowledge':    reg(() => import('./copilot-studio-editors'), 'CopilotKnowledgeEditor'),
  'copilot-studio-topic':        reg(() => import('./copilot-studio-editors'), 'CopilotTopicEditor'),
  'copilot-studio-action':       reg(() => import('./copilot-studio-editors'), 'CopilotActionEditor'),
  'copilot-studio-channel':      reg(() => import('./copilot-studio-editors'), 'CopilotChannelEditor'),
  'copilot-studio-analytics':    reg(() => import('./copilot-studio-editors'), 'CopilotAnalyticsEditor'),
  'copilot-template-library':    reg(() => import('./copilot-studio-editors'), 'CopilotTemplateLibraryEditor'),

  // v3 — Power Platform (real BAP / PowerApps / Flow / Dataverse REST)
  'powerplatform-environment':   reg(() => import('./powerplatform-editors'),  'PowerPlatformEnvironmentEditor'),
  'dataverse-table':             reg(() => import('./powerplatform-editors'),  'DataverseTableEditor'),
  'power-app':                   reg(() => import('./powerplatform-editors'),  'PowerAppEditor'),
  'power-automate-flow':         reg(() => import('./powerplatform-editors'),  'PowerAutomateFlowEditor'),
  'power-page':                  reg(() => import('./powerplatform-editors'),  'PowerPageEditor'),
  'ai-builder-model':            reg(() => import('./powerplatform-editors'),  'AiBuilderModelEditor'),

  // v3 — Cross-item Copilot orchestrator (32 tools across all wired services)
  'cross-item-copilot':          reg(() => import('./cross-item-copilot-editor').then((m) => ({ CrossItemCopilotEditor: m.CrossItemCopilotEditor })), 'CrossItemCopilotEditor'),

  // v3 — Azure SQL family (Microsoft.Sql/servers + databases + MI + SQL 2025 vector index)
  'azure-sql-server':            reg(() => import('./azure-sql-editors'),      'AzureSqlServerEditor'),
  // The unified "SQL database" surface is backed by REAL Azure database
  // services (Azure SQL DB / SQL MI / PostgreSQL Flexible Server) — tenant
  // inventory + connect + provision + query + schema + OneLake/Purview
  // catalog. Replaces the old Fabric-SQL framing entirely.
  'azure-sql-database':          reg(() => import('./unified-sql-database-editor'), 'UnifiedSqlDatabaseEditor'),
  'azure-sql-managed-instance':  reg(() => import('./azure-sql-editors'),      'SqlManagedInstanceEditor'),
  'sql-server-2025-vector-index':reg(() => import('./azure-sql-editors'),      'SqlServer2025VectorIndexEditor'),
  // The generic "SQL database" catalog slug now maps to the same unified
  // Azure-database surface (NOT Fabric SQL "no workspace attached"). Whole
  // point of CSA Loom: Fabric isn't available, so SQL = Azure SQL/PG/MI.
  'postgres-flexible-server':    reg(() => import('./unified-sql-database-editor'), 'UnifiedSqlDatabaseEditor'),
  'sql-database':                reg(() => import('./unified-sql-database-editor'), 'UnifiedSqlDatabaseEditor'),

  // v3 — Geoanalytics (Azure Maps + lakehouse geometry + H3/S2 + spatial T-SQL/KQL)
  'geo-map':                     reg(() => import('./geo-editors'),            'GeoMapEditor'),
  'geo-dataset':                 reg(() => import('./geo-editors'),            'GeoDatasetEditor'),
  'geo-query':                   reg(() => import('./geo-editors'),            'GeoQueryEditor'),
  'geo-pipeline':                reg(() => import('./geo-editors'),            'GeoPipelineEditor'),

  // v3 — Azure Cosmos DB account navigator (SQL/NoSQL API — parity wave 7).
  // Real ARM control plane (Microsoft.DocumentDB/databaseAccounts) for the
  // env-pinned LOOM_COSMOS_ACCOUNT, distinct from Loom's own internal store.
  'azure-cosmos-account':        reg(() => import('./cosmos-account-editor'),   'CosmosAccountEditor'),

  // v3 — Graph + Vector knowledge stores (Cosmos Gremlin, Cypher, GQL, vector store)
  'cosmos-gremlin-graph':        reg(() => import('./graph-editors'),          'CosmosGremlinGraphEditor'),
  'cypher-graph':                reg(() => import('./graph-editors'),          'CypherGraphEditor'),
  'gql-graph':                   reg(() => import('./graph-editors'),          'GqlGraphEditor'),
  'vector-store':                reg(() => import('./graph-editors'),          'VectorStoreEditor'),

  // audit-t53 — Tapestry: investigative link-analysis + geospatial + timeline
  // workspace over ADX make-graph/graph-match + Azure Maps (Gotham-equivalent).
  // Azure-native default — no Fabric required.
  'tapestry':                    reg(() => import('./tapestry-editor'),        'TapestryEditor'),

  // v3 — Push-button data-products library (CSA-curated templates + instances)
  'data-product-template':       reg(() => import('./data-product-editors'),   'DataProductTemplateEditor'),
  'data-product-instance':       reg(() => import('./data-product-editors'),   'DataProductInstanceEditor'),

  // v3 — Azure Logic Apps (Consumption) — WDL workflow designer + code view.
  // Opens fully built-out from the bundle's state.content.definition (or the
  // live Microsoft.Logic/workflows resource when bound); Run trigger fires a
  // real manual run via /api/items/logic-app/[id]/run or an honest infra gate.
  'logic-app':                   reg(() => import('./logic-app-editor'),       'LogicAppEditor'),

  // v3 — Microsoft Data API builder (DAB) — WYSIWYG dab-config.json builder
  // (real REST/GraphQL entity authoring, per-role permissions, relationships,
  // runtime/host; emits real dab-config.json + publishes via APIM).
  'data-api-builder':            reg(() => import('./data-api-builder-editor'), 'DataApiBuilderEditor'),

  // audit-T29 / deep T50-T57 — Palantir-class migration surfaces. Doc-only
  // mappings in docs/migrations/palantir-foundry/ are superseded by these built
  // Azure-native editors (Workshop/Slate/OSDK/Apollo/Checks/AIP-Logic). All
  // default Azure-native — no Fabric / Power BI workspace required.
  'workshop-app':                reg(() => import('./palantir-editors'),       'WorkshopAppEditor'),
  'slate-app':                   reg(() => import('./palantir-editors'),       'SlateAppEditor'),
  'ontology-sdk':                reg(() => import('./palantir-editors'),       'OntologySdkEditor'),
  'release-environment':         reg(() => import('./palantir-editors'),       'ReleaseEnvironmentEditor'),
  'health-check':                reg(() => import('./palantir-editors'),       'HealthCheckEditor'),
  'aip-logic':                   reg(() => import('./palantir-editors'),       'AipLogicEditor'),
};

export function getEditor(slug: string): EditorComponent | null {
  return EDITOR_REGISTRY[slug] ?? null;
}
