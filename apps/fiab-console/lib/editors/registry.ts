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
  // Phase 2
  'lakehouse':            reg(() => import('./lakehouse-editor'),         'LakehouseEditor'),
  'notebook':             reg(() => import('./notebook-editor'),          'NotebookEditor'),
  'data-pipeline':        reg(() => import('./data-pipeline-editor'),     'DataPipelineEditor'),
  'dataflow':             reg(() => import('./dataflow-gen2-editor'),     'DataflowGen2Editor'),
  'mirrored-database':    reg(() => import('./mirrored-database-editor'), 'MirroredDatabaseEditor'),
  'spark-job-definition': reg(() => import('./phase2-misc-editors'),      'SparkJobDefinitionEditor'),
  'environment':          reg(() => import('./phase2-misc-editors'),      'EnvironmentEditor'),
  'copy-job':             reg(() => import('./phase2-misc-editors'),      'CopyJobEditor'),
  'dbt-job':              reg(() => import('./phase2-misc-editors'),      'DbtJobEditor'),

  // Phase 3
  'eventhouse':           reg(() => import('./phase3-editors'),           'EventhouseEditor'),
  'kql-database':         reg(() => import('./phase3-editors'),           'KqlDatabaseEditor'),
  'kql-queryset':         reg(() => import('./phase3-editors'),           'KqlQuerysetEditor'),
  'kql-dashboard':        reg(() => import('./phase3-editors'),           'KqlDashboardEditor'),
  'eventstream':          reg(() => import('./phase3-editors'),           'EventstreamEditor'),
  'activator':            reg(() => import('./phase3-editors'),           'ActivatorEditor'),
  'warehouse':            reg(() => import('./phase3-editors'),           'WarehouseEditor'),
  'semantic-model':       reg(() => import('./phase3-editors'),           'SemanticModelEditor'),
  'report':               reg(() => import('./phase3-editors'),           'ReportEditor'),
  'dashboard':            reg(() => import('./phase3-editors'),           'DashboardEditor'),
  'paginated-report':     reg(() => import('./phase3-editors'),           'PaginatedReportEditor'),
  'scorecard':            reg(() => import('./phase3-editors'),           'ScorecardEditor'),

  // Phase 4
  'ml-model':             reg(() => import('./phase4-editors'),           'MlModelEditor'),
  'ml-experiment':        reg(() => import('./phase4-editors'),           'MlExperimentEditor'),
  'graphql-api':          reg(() => import('./phase4-editors'),           'GraphqlApiEditor'),
  'user-data-function':   reg(() => import('./phase4-editors'),           'UserDataFunctionEditor'),
  'variable-library':     reg(() => import('./phase4-editors'),           'VariableLibraryEditor'),
  'ontology':             reg(() => import('./phase4-editors'),           'OntologyEditor'),
  'graph-model':          reg(() => import('./phase4-editors'),           'GraphModelEditor'),
  'plan':                 reg(() => import('./phase4-editors'),           'PlanEditor'),
  'map':                  reg(() => import('./phase4-editors'),           'MapEditor'),
  'operations-agent':     reg(() => import('./phase4-editors'),           'OperationsAgentEditor'),
  'data-agent':           reg(() => import('./phase4-editors'),           'DataAgentEditor'),

  // v1.5 — Native Azure-service editors (Synapse, Databricks, ADF, U-SQL)
  // v2.0 — Synapse Dedicated + Serverless are real-REST wired (TDS over PE + AAD MI)
  // v2.1 — Synapse Spark pool + Pipeline + Warehouse alias real-REST wired (ARM + dev endpoint)
  'synapse-dedicated-sql-pool':  reg(() => import('./synapse-sql-editors'),    'SynapseDedicatedSqlPoolEditor'),
  'synapse-serverless-sql-pool': reg(() => import('./synapse-sql-editors'),    'SynapseServerlessSqlPoolEditor'),
  'synapse-spark-pool':          reg(() => import('./azure-services-editors'), 'SynapseSparkPoolEditor'),
  'synapse-pipeline':            reg(() => import('./azure-services-editors'), 'SynapsePipelineEditor'),
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
  'data-product':                reg(() => import('./apim-editors'),           'DataProductEditor'),

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
  'azure-sql-database':          reg(() => import('./azure-sql-editors'),      'AzureSqlDatabaseEditor'),
  'azure-sql-managed-instance':  reg(() => import('./azure-sql-editors'),      'SqlManagedInstanceEditor'),
  'sql-server-2025-vector-index':reg(() => import('./azure-sql-editors'),      'SqlServer2025VectorIndexEditor'),
  // Fabric SQL database (Microsoft.Fabric SQLDatabase REST type). At the
  // engine level this is an Azure SQL DB with Fabric-layer mirroring on
  // top — reuse the Azure SQL editor surface so users get T-SQL Monaco +
  // server/DB pickers + Run + mirroring toggle.
  'sql-database':                reg(() => import('./azure-sql-editors'),      'AzureSqlDatabaseEditor'),

  // v3 — Geoanalytics (Azure Maps + lakehouse geometry + H3/S2 + spatial T-SQL/KQL)
  'geo-map':                     reg(() => import('./geo-editors'),            'GeoMapEditor'),
  'geo-dataset':                 reg(() => import('./geo-editors'),            'GeoDatasetEditor'),
  'geo-query':                   reg(() => import('./geo-editors'),            'GeoQueryEditor'),
  'geo-pipeline':                reg(() => import('./geo-editors'),            'GeoPipelineEditor'),

  // v3 — Graph + Vector knowledge stores (Cosmos Gremlin, Cypher, GQL, vector store)
  'cosmos-gremlin-graph':        reg(() => import('./graph-editors'),          'CosmosGremlinGraphEditor'),
  'cypher-graph':                reg(() => import('./graph-editors'),          'CypherGraphEditor'),
  'gql-graph':                   reg(() => import('./graph-editors'),          'GqlGraphEditor'),
  'vector-store':                reg(() => import('./graph-editors'),          'VectorStoreEditor'),

  // v3 — Push-button data-products library (CSA-curated templates + instances)
  'data-product-template':       reg(() => import('./data-product-editors'),   'DataProductTemplateEditor'),
  'data-product-instance':       reg(() => import('./data-product-editors'),   'DataProductInstanceEditor'),
};

export function getEditor(slug: string): EditorComponent | null {
  return EDITOR_REGISTRY[slug] ?? null;
}
