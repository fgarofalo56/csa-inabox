/**
 * Loom Feature Capability Catalog — Fabric-style RBAC model.
 *
 * The catalog is the authoritative source of which Loom capabilities are
 * RBAC-controlled.  Every editor type, every admin page, every workload
 * domain registers here.  The `/admin/permissions` page renders this as
 * a domain → workload → capability tree mirroring Fabric's UX.
 *
 * Stable shape:
 *   { id, domain, workload, name, kind, description }
 *
 * Where `id` is the capability key persisted in the
 * `feature-permissions` Cosmos container: e.g.
 *   "editor.notebook"             — Notebook editor
 *   "admin.tenant-settings"       — Tenant Settings admin page
 *   "workload.fabric"             — All Fabric items
 *   "workspace.<workspaceId>"     — Workspace-scoped (dynamic)
 *
 * The feature-gate middleware walks the parent chain when checking a
 * grant — workload-level grants cover all child capabilities.
 */

export type CapabilityKind = 'editor' | 'admin' | 'workload' | 'workspace' | 'service';

export interface Capability {
  /** Stable key persisted in feature-permissions container. */
  id: string;
  /** Top-level domain bucket — Data / Analytics / AI / Admin / Governance. */
  domain: string;
  /** Sub-grouping within the domain. */
  workload: string;
  /** Human-readable name. */
  name: string;
  /** Short description shown as the capability tooltip. */
  description: string;
  /** What kind of capability — editor item type, admin page, etc. */
  kind: CapabilityKind;
  /** Optional parent capability id — grants on the parent propagate down. */
  parentId?: string;
}

/** Static catalog — adding a new capability here is the ONLY change
 * required for it to show up in /admin/permissions and be enforce-able.
 * Dynamic capabilities (per-workspace) are appended at query time by the
 * BFF route. */
export const CAPABILITY_CATALOG: Capability[] = [
  // ============================================================
  // Domain: Data
  // ============================================================
  { id: 'workload.lakehouse',        domain: 'Data',      workload: 'Lakehouse',         name: 'Lakehouse (Fabric)',   kind: 'workload',  description: 'All Lakehouse-related editors and operations.' },
  { id: 'editor.lakehouse',          domain: 'Data',      workload: 'Lakehouse',         name: 'Lakehouse editor',     kind: 'editor',    description: 'Open and edit Fabric Lakehouses.', parentId: 'workload.lakehouse' },
  { id: 'editor.mirrored-database',  domain: 'Data',      workload: 'Lakehouse',         name: 'Mirrored Database',    kind: 'editor',    description: 'Mirror sources into Fabric.', parentId: 'workload.lakehouse' },

  { id: 'workload.warehouse',        domain: 'Data',      workload: 'Warehouse',         name: 'Warehouse',            kind: 'workload',  description: 'Synapse Dedicated + Fabric Warehouse editors.' },
  { id: 'editor.warehouse',          domain: 'Data',      workload: 'Warehouse',         name: 'Warehouse editor',     kind: 'editor',    description: 'Fabric Warehouse', parentId: 'workload.warehouse' },
  { id: 'editor.synapse-dedicated-sql-pool',  domain: 'Data', workload: 'Warehouse',     name: 'Synapse Dedicated SQL', kind: 'editor',   description: 'Dedicated SQL pool', parentId: 'workload.warehouse' },
  { id: 'editor.synapse-serverless-sql-pool', domain: 'Data', workload: 'Warehouse',     name: 'Synapse Serverless SQL',kind: 'editor',   description: 'Serverless SQL pool', parentId: 'workload.warehouse' },
  { id: 'editor.azure-sql-server',   domain: 'Data',      workload: 'Warehouse',         name: 'Azure SQL Server',     kind: 'editor',    description: 'Azure SQL server', parentId: 'workload.warehouse' },
  { id: 'editor.azure-sql-database', domain: 'Data',      workload: 'Warehouse',         name: 'Azure SQL Database',   kind: 'editor',    description: 'Azure SQL database', parentId: 'workload.warehouse' },
  { id: 'service.sql-security',      domain: 'Data',      workload: 'Warehouse',         name: 'SQL Granular Security', kind: 'service',  description: 'Object/column GRANT, Row-Level Security and Dynamic Data Masking wizards for Synapse Dedicated/Serverless and Azure SQL.', parentId: 'workload.warehouse' },

  { id: 'workload.pipelines',        domain: 'Data',      workload: 'Pipelines',         name: 'Data integration',     kind: 'workload',  description: 'Pipelines, dataflows, ADF, copy jobs.' },
  { id: 'editor.data-pipeline',      domain: 'Data',      workload: 'Pipelines',         name: 'Fabric Data Pipeline', kind: 'editor',    description: 'Fabric pipelines', parentId: 'workload.pipelines' },
  { id: 'editor.dataflow',           domain: 'Data',      workload: 'Pipelines',         name: 'Dataflow Gen2',        kind: 'editor',    description: 'Dataflow Gen2', parentId: 'workload.pipelines' },
  { id: 'editor.adf-pipeline',       domain: 'Data',      workload: 'Pipelines',         name: 'ADF Pipeline',         kind: 'editor',    description: 'Azure Data Factory pipeline', parentId: 'workload.pipelines' },
  { id: 'editor.synapse-pipeline',   domain: 'Data',      workload: 'Pipelines',         name: 'Synapse Pipeline',     kind: 'editor',    description: 'Synapse pipeline', parentId: 'workload.pipelines' },
  { id: 'editor.copy-job',           domain: 'Data',      workload: 'Pipelines',         name: 'Copy Job',             kind: 'editor',    description: 'Copy job', parentId: 'workload.pipelines' },
  { id: 'editor.dbt-job',            domain: 'Data',      workload: 'Pipelines',         name: 'dbt Job',              kind: 'editor',    description: 'dbt Cloud job', parentId: 'workload.pipelines' },

  { id: 'workload.notebooks',        domain: 'Data',      workload: 'Compute',           name: 'Compute',              kind: 'workload',  description: 'Notebooks, Spark jobs, environments.' },
  { id: 'editor.notebook',           domain: 'Data',      workload: 'Compute',           name: 'Notebook (Fabric)',    kind: 'editor',    description: 'Fabric notebook', parentId: 'workload.notebooks' },
  { id: 'editor.spark-job-definition', domain: 'Data',    workload: 'Compute',           name: 'Spark Job Definition', kind: 'editor',    description: 'Spark job', parentId: 'workload.notebooks' },
  { id: 'editor.environment',        domain: 'Data',      workload: 'Compute',           name: 'Spark Environment',    kind: 'editor',    description: 'Spark environment', parentId: 'workload.notebooks' },
  { id: 'editor.databricks-notebook',domain: 'Data',      workload: 'Compute',           name: 'Databricks Notebook',  kind: 'editor',    description: 'Databricks notebook', parentId: 'workload.notebooks' },
  { id: 'editor.databricks-job',     domain: 'Data',      workload: 'Compute',           name: 'Databricks Job',       kind: 'editor',    description: 'Databricks job', parentId: 'workload.notebooks' },
  { id: 'editor.databricks-cluster', domain: 'Data',      workload: 'Compute',           name: 'Databricks Cluster',   kind: 'editor',    description: 'Databricks cluster', parentId: 'workload.notebooks' },
  { id: 'editor.databricks-sql-warehouse', domain: 'Data', workload: 'Compute',          name: 'Databricks SQL WH',    kind: 'editor',    description: 'Databricks SQL warehouse', parentId: 'workload.notebooks' },
  { id: 'editor.synapse-spark-pool', domain: 'Data',      workload: 'Compute',           name: 'Synapse Spark Pool',   kind: 'editor',    description: 'Synapse Spark pool', parentId: 'workload.notebooks' },

  // ============================================================
  // Domain: Realtime
  // ============================================================
  { id: 'workload.realtime',         domain: 'Realtime',  workload: 'Eventhouse',        name: 'Real-time intelligence',kind: 'workload', description: 'KQL DBs, eventstreams, activator.' },
  { id: 'editor.eventhouse',         domain: 'Realtime',  workload: 'Eventhouse',        name: 'Eventhouse',           kind: 'editor',    description: 'KQL cluster', parentId: 'workload.realtime' },
  { id: 'editor.kql-database',       domain: 'Realtime',  workload: 'Eventhouse',        name: 'KQL Database',         kind: 'editor',    description: 'KQL database', parentId: 'workload.realtime' },
  { id: 'editor.kql-queryset',       domain: 'Realtime',  workload: 'Eventhouse',        name: 'KQL Queryset',         kind: 'editor',    description: 'KQL queryset', parentId: 'workload.realtime' },
  { id: 'editor.kql-dashboard',      domain: 'Realtime',  workload: 'Eventhouse',        name: 'KQL Dashboard',        kind: 'editor',    description: 'KQL dashboard', parentId: 'workload.realtime' },
  { id: 'editor.eventstream',        domain: 'Realtime',  workload: 'Eventhouse',        name: 'Eventstream',          kind: 'editor',    description: 'Eventstream', parentId: 'workload.realtime' },
  { id: 'editor.activator',          domain: 'Realtime',  workload: 'Eventhouse',        name: 'Activator (Reflex)',   kind: 'editor',    description: 'Activator rule engine', parentId: 'workload.realtime' },
  { id: 'editor.stream-analytics-job', domain: 'Realtime',workload: 'Eventhouse',        name: 'Stream Analytics Job', kind: 'editor',    description: 'ASA job', parentId: 'workload.realtime' },

  // ============================================================
  // Domain: BI
  // ============================================================
  { id: 'workload.bi',               domain: 'BI',        workload: 'Power BI',          name: 'Business intelligence', kind: 'workload', description: 'Reports, dashboards, semantic models.' },
  { id: 'editor.semantic-model',     domain: 'BI',        workload: 'Power BI',          name: 'Semantic Model',       kind: 'editor',    description: 'Tabular semantic model', parentId: 'workload.bi' },
  { id: 'editor.report',             domain: 'BI',        workload: 'Power BI',          name: 'Report',               kind: 'editor',    description: 'Power BI report', parentId: 'workload.bi' },
  { id: 'editor.dashboard',          domain: 'BI',        workload: 'Power BI',          name: 'Dashboard',            kind: 'editor',    description: 'Power BI dashboard', parentId: 'workload.bi' },
  { id: 'editor.paginated-report',   domain: 'BI',        workload: 'Power BI',          name: 'Paginated Report',     kind: 'editor',    description: 'Paginated report', parentId: 'workload.bi' },
  { id: 'editor.scorecard',          domain: 'BI',        workload: 'Power BI',          name: 'Scorecard',            kind: 'editor',    description: 'Goals / scorecard', parentId: 'workload.bi' },

  // ============================================================
  // Domain: AI
  // ============================================================
  { id: 'workload.ai-foundry',       domain: 'AI',        workload: 'AI Foundry',        name: 'AI Foundry',           kind: 'workload',  description: 'Foundry hub + projects.' },
  { id: 'editor.ai-foundry-hub',     domain: 'AI',        workload: 'AI Foundry',        name: 'Foundry Hub',          kind: 'editor',    description: 'AI Foundry hub', parentId: 'workload.ai-foundry' },
  { id: 'editor.ai-foundry-project', domain: 'AI',        workload: 'AI Foundry',        name: 'Foundry Project',      kind: 'editor',    description: 'AI Foundry project', parentId: 'workload.ai-foundry' },
  { id: 'editor.prompt-flow',        domain: 'AI',        workload: 'AI Foundry',        name: 'Prompt Flow',          kind: 'editor',    description: 'Prompt flow', parentId: 'workload.ai-foundry' },
  { id: 'editor.evaluation',         domain: 'AI',        workload: 'AI Foundry',        name: 'Evaluation',           kind: 'editor',    description: 'Eval suite', parentId: 'workload.ai-foundry' },
  { id: 'editor.content-safety',     domain: 'AI',        workload: 'AI Foundry',        name: 'Content Safety',       kind: 'editor',    description: 'Content safety policy', parentId: 'workload.ai-foundry' },
  { id: 'editor.ai-search-index',    domain: 'AI',        workload: 'AI Foundry',        name: 'AI Search Index',      kind: 'editor',    description: 'AI Search index', parentId: 'workload.ai-foundry' },
  { id: 'editor.compute',            domain: 'AI',        workload: 'AI Foundry',        name: 'Foundry Compute',      kind: 'editor',    description: 'Foundry compute', parentId: 'workload.ai-foundry' },
  { id: 'editor.dataset',            domain: 'AI',        workload: 'AI Foundry',        name: 'Foundry Dataset',      kind: 'editor',    description: 'Foundry dataset', parentId: 'workload.ai-foundry' },
  { id: 'editor.tracing',            domain: 'AI',        workload: 'AI Foundry',        name: 'Foundry Tracing',      kind: 'editor',    description: 'Foundry tracing', parentId: 'workload.ai-foundry' },

  { id: 'workload.ml',               domain: 'AI',        workload: 'Machine Learning',  name: 'Machine Learning',     kind: 'workload',  description: 'ML models & experiments.' },
  { id: 'editor.ml-model',           domain: 'AI',        workload: 'Machine Learning',  name: 'ML Model',             kind: 'editor',    description: 'ML model', parentId: 'workload.ml' },
  { id: 'editor.ml-experiment',      domain: 'AI',        workload: 'Machine Learning',  name: 'ML Experiment',        kind: 'editor',    description: 'ML experiment', parentId: 'workload.ml' },

  { id: 'workload.copilot',          domain: 'AI',        workload: 'Copilot Studio',    name: 'Copilot Studio',       kind: 'workload',  description: 'Power Platform copilot agents.' },
  { id: 'editor.copilot-studio-agent',       domain: 'AI',workload: 'Copilot Studio',    name: 'Copilot Agent',        kind: 'editor',    description: 'Copilot agent', parentId: 'workload.copilot' },
  { id: 'editor.copilot-studio-knowledge',   domain: 'AI',workload: 'Copilot Studio',    name: 'Copilot Knowledge',    kind: 'editor',    description: 'Copilot knowledge', parentId: 'workload.copilot' },
  { id: 'editor.copilot-studio-topic',       domain: 'AI',workload: 'Copilot Studio',    name: 'Copilot Topic',        kind: 'editor',    description: 'Copilot topic', parentId: 'workload.copilot' },
  { id: 'editor.copilot-studio-action',      domain: 'AI',workload: 'Copilot Studio',    name: 'Copilot Action',       kind: 'editor',    description: 'Copilot action', parentId: 'workload.copilot' },
  { id: 'editor.copilot-studio-channel',     domain: 'AI',workload: 'Copilot Studio',    name: 'Copilot Channel',      kind: 'editor',    description: 'Copilot channel', parentId: 'workload.copilot' },
  { id: 'editor.copilot-studio-analytics',   domain: 'AI',workload: 'Copilot Studio',    name: 'Copilot Analytics',    kind: 'editor',    description: 'Copilot analytics', parentId: 'workload.copilot' },
  { id: 'editor.cross-item-copilot', domain: 'AI',        workload: 'Copilot Studio',    name: 'Cross-item Copilot',   kind: 'editor',    description: 'Loom cross-item copilot', parentId: 'workload.copilot' },

  // ============================================================
  // Domain: APIs & Apps
  // ============================================================
  { id: 'workload.apim',             domain: 'APIs',      workload: 'APIM',              name: 'API Management',       kind: 'workload',  description: 'APIM-first surface.' },
  { id: 'editor.apim-api',           domain: 'APIs',      workload: 'APIM',              name: 'APIM API',             kind: 'editor',    description: 'APIM API', parentId: 'workload.apim' },
  { id: 'editor.apim-product',       domain: 'APIs',      workload: 'APIM',              name: 'APIM Product',         kind: 'editor',    description: 'APIM product', parentId: 'workload.apim' },
  { id: 'editor.apim-policy',        domain: 'APIs',      workload: 'APIM',              name: 'APIM Policy',          kind: 'editor',    description: 'APIM policy', parentId: 'workload.apim' },
  { id: 'editor.data-product',       domain: 'APIs',      workload: 'APIM',              name: 'Data Product',         kind: 'editor',    description: 'Data product', parentId: 'workload.apim' },
  { id: 'editor.data-product-template', domain: 'APIs',   workload: 'APIM',              name: 'Data Product Template',kind: 'editor',    description: 'Push-button template', parentId: 'workload.apim' },
  { id: 'editor.data-product-instance', domain: 'APIs',   workload: 'APIM',              name: 'Data Product Instance',kind: 'editor',    description: 'Materialized template', parentId: 'workload.apim' },
  { id: 'editor.graphql-api',        domain: 'APIs',      workload: 'APIM',              name: 'GraphQL API',          kind: 'editor',    description: 'GraphQL API', parentId: 'workload.apim' },
  { id: 'editor.user-data-function', domain: 'APIs',      workload: 'APIM',              name: 'User Data Function',   kind: 'editor',    description: 'UDF', parentId: 'workload.apim' },

  { id: 'workload.power-platform',   domain: 'APIs',      workload: 'Power Platform',    name: 'Power Platform',       kind: 'workload',  description: 'PowerApps, Flow, Dataverse, Pages.' },
  { id: 'editor.powerplatform-environment', domain: 'APIs',workload: 'Power Platform',   name: 'PP Environment',       kind: 'editor',    description: 'Power Platform environment', parentId: 'workload.power-platform' },
  { id: 'editor.dataverse-table',    domain: 'APIs',      workload: 'Power Platform',    name: 'Dataverse Table',      kind: 'editor',    description: 'Dataverse table', parentId: 'workload.power-platform' },
  { id: 'editor.power-app',          domain: 'APIs',      workload: 'Power Platform',    name: 'Power App',            kind: 'editor',    description: 'Power App', parentId: 'workload.power-platform' },
  { id: 'editor.power-automate-flow',domain: 'APIs',      workload: 'Power Platform',    name: 'Power Automate Flow',  kind: 'editor',    description: 'Power Automate flow', parentId: 'workload.power-platform' },
  { id: 'editor.power-page',         domain: 'APIs',      workload: 'Power Platform',    name: 'Power Page',           kind: 'editor',    description: 'Power Page', parentId: 'workload.power-platform' },
  { id: 'editor.ai-builder-model',   domain: 'APIs',      workload: 'Power Platform',    name: 'AI Builder Model',     kind: 'editor',    description: 'AI Builder model', parentId: 'workload.power-platform' },

  // ============================================================
  // Domain: Graph & Geo
  // ============================================================
  { id: 'workload.graph',            domain: 'Graph',     workload: 'Graph',             name: 'Graph & vector',       kind: 'workload',  description: 'Graph + vector knowledge stores.' },
  { id: 'editor.cosmos-gremlin-graph',domain: 'Graph',    workload: 'Graph',             name: 'Cosmos Gremlin',       kind: 'editor',    description: 'Cosmos Gremlin graph', parentId: 'workload.graph' },
  { id: 'editor.cypher-graph',       domain: 'Graph',     workload: 'Graph',             name: 'Cypher Graph',         kind: 'editor',    description: 'Cypher graph', parentId: 'workload.graph' },
  { id: 'editor.gql-graph',          domain: 'Graph',     workload: 'Graph',             name: 'GQL Graph',            kind: 'editor',    description: 'GQL graph', parentId: 'workload.graph' },
  { id: 'editor.vector-store',       domain: 'Graph',     workload: 'Graph',             name: 'Vector Store',         kind: 'editor',    description: 'Vector store', parentId: 'workload.graph' },
  { id: 'editor.ontology',           domain: 'Graph',     workload: 'Graph',             name: 'Ontology',             kind: 'editor',    description: 'Ontology', parentId: 'workload.graph' },
  { id: 'editor.graph-model',        domain: 'Graph',     workload: 'Graph',             name: 'Graph Model',          kind: 'editor',    description: 'Graph model', parentId: 'workload.graph' },

  { id: 'workload.geo',              domain: 'Graph',     workload: 'Geo',               name: 'Geoanalytics',         kind: 'workload',  description: 'Geo maps + spatial queries.' },
  { id: 'editor.geo-map',            domain: 'Graph',     workload: 'Geo',               name: 'Geo Map',              kind: 'editor',    description: 'Geo map', parentId: 'workload.geo' },
  { id: 'editor.geo-dataset',        domain: 'Graph',     workload: 'Geo',               name: 'Geo Dataset',          kind: 'editor',    description: 'Geo dataset', parentId: 'workload.geo' },
  { id: 'editor.geo-query',          domain: 'Graph',     workload: 'Geo',               name: 'Geo Query',            kind: 'editor',    description: 'Geo query', parentId: 'workload.geo' },
  { id: 'editor.geo-pipeline',       domain: 'Graph',     workload: 'Geo',               name: 'Geo Pipeline',         kind: 'editor',    description: 'Geo pipeline', parentId: 'workload.geo' },

  // ============================================================
  // Domain: Operations & Agents
  // ============================================================
  { id: 'workload.operations',       domain: 'Ops',       workload: 'Operations',        name: 'Operations',           kind: 'workload',  description: 'Plans, maps, operations & data agents.' },
  { id: 'editor.plan',               domain: 'Ops',       workload: 'Operations',        name: 'Plan',                 kind: 'editor',    description: 'Operations plan', parentId: 'workload.operations' },
  { id: 'editor.map',                domain: 'Ops',       workload: 'Operations',        name: 'Map',                  kind: 'editor',    description: 'Operations map', parentId: 'workload.operations' },
  { id: 'editor.operations-agent',   domain: 'Ops',       workload: 'Operations',        name: 'Operations Agent',     kind: 'editor',    description: 'Ops agent', parentId: 'workload.operations' },
  { id: 'editor.data-agent',         domain: 'Ops',       workload: 'Operations',        name: 'Data Agent',           kind: 'editor',    description: 'Data agent', parentId: 'workload.operations' },
  { id: 'editor.variable-library',   domain: 'Ops',       workload: 'Operations',        name: 'Variable Library',     kind: 'editor',    description: 'Variable library', parentId: 'workload.operations' },

  // ============================================================
  // Domain: Admin
  // ============================================================
  { id: 'workload.admin',            domain: 'Admin',     workload: 'Tenant Admin',      name: 'Tenant administration',kind: 'workload',  description: 'Whole-tenant admin surface (settings, users, audit).' },
  { id: 'admin.tenant-settings',     domain: 'Admin',     workload: 'Tenant Admin',      name: 'Tenant Settings',      kind: 'admin',     description: '/admin/tenant-settings', parentId: 'workload.admin' },
  { id: 'admin.users',               domain: 'Admin',     workload: 'Tenant Admin',      name: 'Users',                kind: 'admin',     description: '/admin/users', parentId: 'workload.admin' },
  { id: 'admin.workspaces',          domain: 'Admin',     workload: 'Tenant Admin',      name: 'Workspaces (admin)',   kind: 'admin',     description: '/admin/workspaces', parentId: 'workload.admin' },
  { id: 'admin.domains',             domain: 'Admin',     workload: 'Tenant Admin',      name: 'Business Domains',     kind: 'admin',     description: '/admin/domains', parentId: 'workload.admin' },
  { id: 'admin.capacity',            domain: 'Admin',     workload: 'Tenant Admin',      name: 'Capacity / Scaling',   kind: 'admin',     description: '/admin/capacity', parentId: 'workload.admin' },
  { id: 'admin.usage',               domain: 'Admin',     workload: 'Tenant Admin',      name: 'Usage Metrics',        kind: 'admin',     description: '/admin/usage', parentId: 'workload.admin' },
  { id: 'admin.audit-logs',          domain: 'Admin',     workload: 'Tenant Admin',      name: 'Audit Logs',           kind: 'admin',     description: '/admin/audit-logs', parentId: 'workload.admin' },
  { id: 'admin.security',            domain: 'Admin',     workload: 'Tenant Admin',      name: 'Security & Governance',kind: 'admin',     description: '/admin/security', parentId: 'workload.admin' },
  { id: 'admin.updates',             domain: 'Admin',     workload: 'Tenant Admin',      name: 'Updates / Releases',   kind: 'admin',     description: '/admin/updates', parentId: 'workload.admin' },
  { id: 'admin.permissions',         domain: 'Admin',     workload: 'Tenant Admin',      name: 'Feature Permissions',  kind: 'admin',     description: '/admin/permissions — grant capabilities to users/groups.', parentId: 'workload.admin' },
  { id: 'item.share',                domain: 'Admin',     workload: 'Tenant Admin',      name: 'Item sharing & permissions', kind: 'admin', description: 'Grant and revoke item-level permissions (F6) — the Share dialog and /items/[type]/[id]/permissions page. Item owners can always manage their own items; this capability delegates sharing to non-owners.', parentId: 'workload.admin' },
  { id: 'admin.deploy-dlz',          domain: 'Admin',     workload: 'Tenant Admin',      name: 'Deploy Landing Zone',  kind: 'admin',     description: 'Setup wizard — deploy an additional Data Landing Zone (server-side GitHub Actions dispatch / az deployment). Admin-only by default; an existing admin can delegate it by granting this capability at /admin/permissions.', parentId: 'workload.admin' },
  { id: 'admin.deploy-mcp',          domain: 'Admin',     workload: 'Tenant Admin',      name: 'Deploy MCP Server',    kind: 'admin',     description: 'External MCP Tools — deploy a catalog MCP server as an internal Azure Container App (per-field Key Vault secrets, auto-registered for Copilot). Admin-only by default; an existing admin can delegate it by granting this capability at /admin/permissions.', parentId: 'workload.admin' },
];

/** Lookup by id. */
export function getCapability(id: string): Capability | undefined {
  return CAPABILITY_CATALOG.find((c) => c.id === id);
}

/** Walk parent chain — returns [self, parent, grandparent, ...]. */
export function ancestorIds(id: string): string[] {
  const out: string[] = [];
  let cur: Capability | undefined = getCapability(id);
  let safety = 0;
  while (cur && safety++ < 10) {
    out.push(cur.id);
    cur = cur.parentId ? getCapability(cur.parentId) : undefined;
  }
  return out;
}

/** Resolve the canonical capability id for an editor item type, e.g.
 * "notebook" → "editor.notebook".  Falls through to the raw value if no
 * match (so dynamic / custom types still work end-to-end). */
export function capabilityIdForItemType(itemType: string): string {
  const id = `editor.${itemType}`;
  return getCapability(id)?.id || id;
}

/** Group the catalog into domain → workload → capability[] for the
 * /admin/permissions tree UI. */
export function groupedCatalog(): Array<{
  domain: string;
  workloads: Array<{ name: string; capabilities: Capability[] }>;
}> {
  const byDomain = new Map<string, Map<string, Capability[]>>();
  for (const c of CAPABILITY_CATALOG) {
    if (!byDomain.has(c.domain)) byDomain.set(c.domain, new Map());
    const byWorkload = byDomain.get(c.domain)!;
    if (!byWorkload.has(c.workload)) byWorkload.set(c.workload, []);
    byWorkload.get(c.workload)!.push(c);
  }
  return Array.from(byDomain.entries()).map(([domain, wl]) => ({
    domain,
    workloads: Array.from(wl.entries()).map(([name, capabilities]) => ({ name, capabilities })),
  }));
}
