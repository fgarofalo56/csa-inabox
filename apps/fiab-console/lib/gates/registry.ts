/**
 * CSA Loom gate registry (G2) — the complete, typed manifest of every
 * day-one configuration gate in the console.
 *
 * DERIVED, not duplicated: the backbone is `lib/admin/self-audit.ts:ENV_CHECKS`
 * (the single declarative source of every runtime LOOM_ var — title, category,
 * severity, required/anyOf keys, remediation, provisionedBy bicep module, RBAC
 * role). This module ENRICHES each spec with the gate-specific metadata the
 * registry surfaces need:
 *   - `surfaces`   — where the gate fires (pages / editors / API routes),
 *   - `fixit`      — how the inline "Fix it" wizard resolves it (env-picker /
 *                    resource-picker with a REAL ARM options-loader / role-grant
 *                    / wizard),
 *   - `legacyCodes`— the bespoke `*_not_configured` error codes routes return
 *                    today, mapped to their canonical gate id,
 *   - `canAutoResolve` — true when a push-button deploy fills the values with
 *                    zero operator input (spec.derived / spec.optionalDefault).
 *
 * A unit test (lib/gates/__tests__/registry.test.ts) asserts GATE_META covers
 * EVERY ENV_CHECKS id and carries no orphans — the two can never drift.
 *
 * Resolution goes through the ONE shared write path (lib/admin/env-apply.ts →
 * the same ACA-revision / AKS-rolling-update + Cosmos + audit machinery as
 * PUT /api/admin/env-config). No second write path (no-vaporware.md).
 */
// IMPORTANT: import from the PURE declarative layer (env-checks), NOT
// self-audit — this module is consumed by client components (HonestGate,
// /admin/gates) and self-audit's probe section lazy-imports the Azure clients
// + copilot orchestrator, which reach next/headers and must never enter a
// client bundle.
import {
  ENV_CHECKS,
  VALUE_HINT,
  evalEnv,
  type AuditCategory,
  type AuditSeverity,
  type CheckResult,
  type EnvSpec,
} from '@/lib/admin/env-checks';

export type FixitKind = 'env-picker' | 'resource-picker' | 'role-grant' | 'wizard';

/**
 * A REAL ARM options-loader for one env var of a gate: the resolve dialog
 * enumerates live resources in the deployment's subscription(s) so the
 * operator PICKS from what actually exists instead of typing.
 */
export interface GateOptionsLoader {
  /**
   * ARM resource type enumerated at subscription scope, e.g.
   * 'Microsoft.Synapse/workspaces'. Executed by GET /api/admin/gates/[id]/options
   * as `GET /subscriptions/{sub}/resources?$filter=resourceType eq '<type>'`.
   */
  armType: string;
  /**
   * Which field of the ARM resource becomes the env value:
   *   'name' | 'id' — from the list response directly;
   *   'properties.<path>' — requires a per-resource GET (the options route
   *   fetches each resource with `armApiVersion`, bounded).
   */
  valueFrom: 'name' | 'id' | `properties.${string}`;
  /** api-version for the per-resource GET when valueFrom needs properties. */
  armApiVersion?: string;
  /** Restrict to resources whose `kind` matches (e.g. OpenAI/AIServices). */
  kindFilter?: string[];
  /**
   * Special multi-step loader: 'aoai-deployments' lists model deployments
   * across the subscription's OpenAI/AIServices accounts (accounts list →
   * per-account deployments list). Overrides armType enumeration.
   */
  special?: 'aoai-deployments';
}

export interface GateRequiredSetting {
  /** The env var this setting writes (whitelisted via EDITABLE_ENV). */
  envVar: string;
  /** What the value is / does (from VALUE_HINT + the spec). */
  description: string;
  /** Placeholder / example value. */
  valueHint: string;
  /** Members of the same anyOf group (setting ANY one satisfies the gate). */
  aliasOf?: string[];
  /** True when part of a `required` group (vs an anyOf alternative). */
  required: boolean;
  /** Live ARM discovery for the Fix-it picker (absent → free-text input). */
  loader?: GateOptionsLoader;
}

export interface GateFixit {
  kind: FixitKind;
  /**
   * For 'role-grant' / 'wizard': the one-time operator action that cannot be
   * a pure env write (RBAC grant, tenant consent). The dialog shows the
   * pre-filled fixScript/portalSteps from the self-audit check for these.
   */
  grantNote?: string;
}

export interface GateSurface {
  /** Route or page where the gate fires, e.g. '/copilot', '/api/items/eventstream/*'. */
  path: string;
  /** Human label, e.g. 'Copilot pane', 'Eventstream editor'. */
  label: string;
}

export interface GateDef {
  /** Stable gate id == the ENV_CHECKS spec id (e.g. 'svc-aoai'). */
  id: string;
  title: string;
  category: AuditCategory;
  severity: AuditSeverity;
  /** Where this gate fires in the product. */
  surfaces: GateSurface[];
  /** Every env var / alias group that satisfies the gate. */
  requiredSettings: GateRequiredSetting[];
  /** The exact RBAC role / tenant action needed once values are set. */
  role?: string;
  /** The bicep module that wires these values on a push-button deploy. */
  provisionedBy?: string;
  /** Exact operator remediation (from the self-audit spec). */
  remediation: string;
  docs?: string;
  /**
   * True when a push-button deploy AUTO-fills the values (spec.derived) or the
   * unset state is the fully-functional intended default (spec.optionalDefault)
   * — i.e. ZERO day-one operator input is needed.
   */
  canAutoResolve: boolean;
  autoResolveNote?: string;
  fixit: GateFixit;
  /** Bespoke error codes routes return today for this gate (Phase-1 inventory). */
  legacyCodes: string[];
}

/** Live status for a gate — evaluated from the REAL env-presence check (the
 * per-client *ConfigGate() helpers gate on exactly these vars). */
export interface GateStatus {
  id: string;
  /** 'configured' — every required value present (or auto-resolved default);
   *  'blocked'    — missing values; the surfaces honest-gate. */
  status: 'configured' | 'blocked';
  /** The underlying audit result (detail, portalSteps, fixScript). */
  check: CheckResult;
  /** Missing env vars (preferred member of each unsatisfied group). */
  missing: string[];
}

// ── per-gate enrichment (surfaces / fixit / legacy codes) ────────────────────
// Every ENV_CHECKS id MUST have an entry here (enforced by the registry test).

interface GateMeta {
  surfaces: GateSurface[];
  fixit: GateFixit;
  legacyCodes?: string[];
  /** Loaders keyed by env var (merged into requiredSettings). */
  loaders?: Record<string, GateOptionsLoader>;
  autoResolveNote?: string;
}

const L = {
  synapse: { armType: 'Microsoft.Synapse/workspaces', valueFrom: 'name' } as GateOptionsLoader,
  adxUri: { armType: 'Microsoft.Kusto/clusters', valueFrom: 'properties.uri', armApiVersion: '2023-08-15' } as GateOptionsLoader,
  eventhubs: { armType: 'Microsoft.EventHub/namespaces', valueFrom: 'name' } as GateOptionsLoader,
  storage: { armType: 'Microsoft.Storage/storageAccounts', valueFrom: 'name' } as GateOptionsLoader,
  aisearch: { armType: 'Microsoft.Search/searchServices', valueFrom: 'name' } as GateOptionsLoader,
  aoaiEndpoint: {
    armType: 'Microsoft.CognitiveServices/accounts', valueFrom: 'properties.endpoint',
    armApiVersion: '2023-05-01', kindFilter: ['OpenAI', 'AIServices'],
  } as GateOptionsLoader,
  aoaiDeployment: { armType: 'Microsoft.CognitiveServices/accounts', valueFrom: 'name', special: 'aoai-deployments' } as GateOptionsLoader,
  databricks: { armType: 'Microsoft.Databricks/workspaces', valueFrom: 'properties.workspaceUrl', armApiVersion: '2024-05-01' } as GateOptionsLoader,
  adf: { armType: 'Microsoft.DataFactory/factories', valueFrom: 'name' } as GateOptionsLoader,
  purview: { armType: 'Microsoft.Purview/accounts', valueFrom: 'name' } as GateOptionsLoader,
  cosmos: { armType: 'Microsoft.DocumentDB/databaseAccounts', valueFrom: 'properties.documentEndpoint', armApiVersion: '2024-05-15' } as GateOptionsLoader,
  law: { armType: 'Microsoft.OperationalInsights/workspaces', valueFrom: 'id' } as GateOptionsLoader,
  lawCustomerId: { armType: 'Microsoft.OperationalInsights/workspaces', valueFrom: 'properties.customerId', armApiVersion: '2023-09-01' } as GateOptionsLoader,
  maps: { armType: 'Microsoft.Maps/accounts', valueFrom: 'properties.uniqueId', armApiVersion: '2023-06-01' } as GateOptionsLoader,
  acaEnv: { armType: 'Microsoft.App/managedEnvironments', valueFrom: 'id' } as GateOptionsLoader,
  acaEnvDomain: { armType: 'Microsoft.App/managedEnvironments', valueFrom: 'properties.defaultDomain', armApiVersion: '2024-03-01' } as GateOptionsLoader,
  grafana: { armType: 'Microsoft.Dashboard/grafana', valueFrom: 'properties.endpoint', armApiVersion: '2023-09-01' } as GateOptionsLoader,
  sqlServer: { armType: 'Microsoft.Sql/servers', valueFrom: 'properties.fullyQualifiedDomainName', armApiVersion: '2023-08-01-preview' } as GateOptionsLoader,
  aas: { armType: 'Microsoft.AnalysisServices/servers', valueFrom: 'properties.serverFullName', armApiVersion: '2017-08-01' } as GateOptionsLoader,
  aml: { armType: 'Microsoft.MachineLearningServices/workspaces', valueFrom: 'name' } as GateOptionsLoader,
  apim: { armType: 'Microsoft.ApiManagement/service', valueFrom: 'name' } as GateOptionsLoader,
  keyvault: { armType: 'Microsoft.KeyVault/vaults', valueFrom: 'properties.vaultUri', armApiVersion: '2023-07-01' } as GateOptionsLoader,
  servicebus: { armType: 'Microsoft.ServiceBus/namespaces', valueFrom: 'name' } as GateOptionsLoader,
  adt: { armType: 'Microsoft.DigitalTwins/digitalTwinsInstances', valueFrom: 'properties.hostName', armApiVersion: '2023-01-31' } as GateOptionsLoader,
  batch: { armType: 'Microsoft.Batch/batchAccounts', valueFrom: 'name' } as GateOptionsLoader,
  pgFqdn: { armType: 'Microsoft.DBforPostgreSQL/flexibleServers', valueFrom: 'properties.fullyQualifiedDomainName', armApiVersion: '2023-12-01-preview' } as GateOptionsLoader,
  cosmosAccountName: { armType: 'Microsoft.DocumentDB/databaseAccounts', valueFrom: 'name' } as GateOptionsLoader,
  appConfig: { armType: 'Microsoft.AppConfiguration/configurationStores', valueFrom: 'properties.endpoint', armApiVersion: '2023-03-01' } as GateOptionsLoader,
};

export const GATE_META: Record<string, GateMeta> = {
  // ── identity / data-plane (deploy-critical; the deploy wires them) ──
  'session-secret': {
    surfaces: [{ path: '/auth/sign-in', label: 'Sign-in (session minting)' }],
    fixit: { kind: 'env-picker' },
  },
  'entra-app': {
    surfaces: [{ path: '/auth/sign-in', label: 'Sign-in (MSAL confidential client)' }],
    fixit: {
      kind: 'wizard',
      grantNote: 'Provisioned automatically by the push-button deploy (loomMsalAppRegEnabled) — re-run csa-loom-post-deploy-bootstrap.yml "Provision MSAL app registration" rather than hand-typing a client secret.',
    },
    legacyCodes: ['auth_error=not_configured'],
  },
  uami: {
    surfaces: [{ path: '*', label: 'Every Azure data-plane call (Console identity)' }],
    fixit: { kind: 'env-picker' },
  },
  'cosmos-config': {
    surfaces: [{ path: '*', label: 'The Loom store (workspaces, items, grants, config)' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_COSMOS_ENDPOINT: L.cosmos },
  },
  subscription: {
    surfaces: [
      { path: '/admin/capacity', label: 'ARM discovery + capacity' },
      { path: '/admin/scaling', label: 'Scale by SKU' },
      { path: '/api/azure/*', label: 'Azure navigators' },
    ],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['LOOM_SUBSCRIPTION_ID not configured', 'LOOM_SUBSCRIPTION_ID not set'],
  },
  'domain-routing': {
    surfaces: [{ path: '/admin/domains', label: 'Domain-scoped item-create routing' }],
    fixit: { kind: 'role-grant', grantNote: 'Multi-sub only: set each domain\'s subscriptionIds in Admin → Domains and grant the Console UAMI Contributor on each domain DLZ RG.' },
  },
  'bootstrap-admin': {
    surfaces: [{ path: '/admin/*', label: 'Admin portal (first-admin bootstrap)' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['admin_only'],
  },
  // ── azure services ──
  'svc-synapse': {
    surfaces: [
      { path: '/items/warehouse', label: 'Warehouse editor' },
      { path: '/items/notebook', label: 'Notebooks (Synapse Spark)' },
      { path: '/items/data-pipeline', label: 'Pipelines' },
      { path: '/api/items/warehouse/*', label: 'Warehouse BFF routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_SYNAPSE_WORKSPACE: L.synapse },
    legacyCodes: ['synapse_not_configured', 'not_configured:LOOM_SYNAPSE_WORKSPACE'],
  },
  'svc-adx': {
    surfaces: [
      { path: '/items/kql-database', label: 'KQL database editor' },
      { path: '/items/eventhouse', label: 'Eventhouse editor' },
      { path: '/items/kql-dashboard', label: 'Real-Time dashboards' },
      { path: '/items/graph', label: 'Graph (ADX Kusto graph)' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_KUSTO_CLUSTER_URI: L.adxUri },
    legacyCodes: ['kusto_not_configured', 'adx_not_configured'],
  },
  'svc-eventhubs': {
    surfaces: [
      { path: '/items/eventstream', label: 'Eventstream editor' },
      { path: '/api/items/eventstream/*', label: 'Eventstream BFF routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_EVENTHUB_NAMESPACE: L.eventhubs },
    legacyCodes: ['eventhubs_not_configured'],
  },
  'svc-adls': {
    surfaces: [
      { path: '/items/lakehouse', label: 'Lakehouse editor' },
      { path: '/onelake', label: 'OneLake catalog' },
      { path: '/api/onelake/*', label: 'OneLake storage routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_ADLS_ACCOUNT: L.storage },
    legacyCodes: ['adls_not_configured'],
  },
  'svc-aisearch': {
    surfaces: [
      { path: '/items/ai-search-index', label: 'AI Search index editor' },
      { path: '/api/search/*', label: 'RAG index routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AI_SEARCH_SERVICE: L.aisearch },
    legacyCodes: ['ai_search_not_configured', 'search_not_configured'],
  },
  'svc-aoai': {
    surfaces: [
      { path: '/copilot', label: 'Copilot console' },
      { path: '/learn', label: 'Learning Hub help agent' },
      { path: '/api/copilot/*', label: 'Copilot orchestrate/complete routes' },
      { path: '/items/report', label: 'Report Copilot' },
      { path: '/items/notebook', label: 'Notebook assist' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AOAI_ENDPOINT: L.aoaiEndpoint, LOOM_AOAI_DEPLOYMENT: L.aoaiDeployment },
    legacyCodes: ['no_aoai', 'aoai_not_configured'],
  },
  'svc-ai-enrich': {
    surfaces: [
      { path: '/items/data-pipeline', label: 'AI enrichment pipeline activities' },
      { path: '/api/enrich/*', label: 'AI enrich preview routes' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Falls back to the shared multi-service Azure AI Services (Foundry) account — fully functional with zero per-service endpoints set.',
  },
  'svc-monitor-alerts': {
    surfaces: [
      { path: '/items/activator', label: 'Activator (alert rules)' },
      { path: '/monitor', label: 'Monitor hub — Alerts' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_LOG_ANALYTICS_RESOURCE_ID: L.law },
    legacyCodes: ['monitor_not_configured'],
  },
  'svc-adf': {
    surfaces: [
      { path: '/items/mirrored-database', label: 'Mirrored database (ADF CDC)' },
      { path: '/api/adf/*', label: 'ADF CDC routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_ADF_FACTORY: L.adf },
    legacyCodes: ['adf_not_configured', 'not_configured:LOOM_ADF_FACTORY'],
  },
  'svc-posture-refresh': {
    surfaces: [{ path: '/governance', label: 'Govern tab (posture pre-warm)' }],
    fixit: { kind: 'env-picker' },
  },
  'graph-users': {
    surfaces: [{ path: '/admin/users', label: 'Users & licenses (Graph enrichment)' }],
    fixit: { kind: 'role-grant', grantNote: 'Grant the Console UAMI Microsoft Graph Directory.Read.All (application) — a tenant-admin Graph consent, not an env write.' },
  },
  'graph-group-sync': {
    surfaces: [
      { path: '/admin/access-reviews', label: 'Access reviews — group-targeted packages' },
      { path: '/admin/access-packages', label: 'Access packages — Entra group targets' },
      { path: '/api/access-governance/group-sync', label: 'Group-sync reconcile' },
    ],
    fixit: { kind: 'role-grant', grantNote: 'Set LOOM_GRAPH_GROUP_SYNC_ENABLED=true and grant the Console UAMI Microsoft Graph Group.Read.All + GroupMember.Read.All (application, admin-consented). Read-only on Entra — Loom never mutates tenant groups.' },
    legacyCodes: ['graph_group_sync_not_configured'],
    autoResolveNote: 'Opt-in: unset → group-targeted packages are still requestable directly; only the automatic membership→grant reconcile is gated. Everything else in access-governance is day-one-ON.',
  },
  purview: {
    surfaces: [
      { path: '/governance/catalog', label: 'Unified catalog (Purview mirror)' },
      { path: '/governance/scans', label: 'Scans & sources' },
      { path: '/admin/security', label: 'Security & governance' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_PURVIEW_ACCOUNT: L.purview },
    legacyCodes: ['purview_not_configured'],
  },
  'usage-embed': {
    surfaces: [{ path: '/admin/usage', label: 'Usage analytics — embedded report' }],
    fixit: { kind: 'wizard' },
    loaders: { LOOM_GRAFANA_ENDPOINT: L.grafana },
  },
  'govern-embed': {
    surfaces: [{ path: '/governance', label: 'Governance analytics — embedded report' }],
    fixit: { kind: 'wizard' },
  },
  'org-visuals': {
    surfaces: [{ path: '/admin/org-visuals', label: 'Organizational visuals' }, { path: '/admin/embed-codes', label: 'Embed codes' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Auto-derived by bicep from the DLZ storage account on a push-button deploy.',
  },
  'audit-la-workspace': {
    surfaces: [{ path: '/admin/audit-logs', label: 'Audit logs — Log Analytics source' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_LOG_ANALYTICS_WORKSPACE_ID: L.lawCustomerId },
    autoResolveNote: 'Auto-derived from the monitoring module (LAW customerId) on a push-button deploy.',
  },
  // ── builders / catalog-governance / ai-copilot ──
  'svc-mcp-deploy': {
    surfaces: [{ path: '/admin/mcp-servers', label: 'MCP Servers — deploy catalog server' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_ACA_ENV_ID: L.acaEnv, LOOM_ACA_ENV_DOMAIN: L.acaEnvDomain },
  },
  'svc-warp-engine': {
    surfaces: [{ path: '/experience/warp', label: 'Warp transforms — Run' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_SYNAPSE_WORKSPACE: L.synapse, LOOM_DATABRICKS_HOSTNAME: L.databricks },
  },
  'svc-deploy-planner': {
    surfaces: [{ path: '/admin/deploy-planner', label: 'Deployment planner' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_COSMOS_ENDPOINT: L.cosmos },
  },
  'svc-org-visuals': {
    surfaces: [{ path: '/admin/org-visuals', label: 'Custom-visual uploads' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-learning-hub': {
    surfaces: [{ path: '/learn', label: 'Learning Hub — help agent' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AOAI_ENDPOINT: L.aoaiEndpoint },
  },
  'svc-mcp-catalog': {
    surfaces: [{ path: '/admin/mcp-servers', label: 'MCP Servers — built-in server' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-databricks': {
    surfaces: [
      { path: '/items/notebook', label: 'Notebooks (Databricks backend)' },
      { path: '/items/sql-warehouse', label: 'Databricks SQL' },
      { path: '/admin/domains', label: 'Unity Catalog mirror' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_DATABRICKS_HOSTNAME: L.databricks },
    legacyCodes: ['databricks_not_configured', 'not_configured:LOOM_DATABRICKS_HOSTNAME'],
  },
  'svc-swa-publish': {
    surfaces: [
      { path: '/items/workshop-app', label: 'Workshop app — Publish' },
      { path: '/items/slate-app', label: 'Slate app — Publish' },
    ],
    fixit: { kind: 'env-picker' },
  },
  'svc-activator-adx-scope': {
    surfaces: [{ path: '/items/activator', label: 'Activator — ADX continuous evaluation' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-pe-subnet': {
    surfaces: [{ path: '/admin/network', label: 'Network — managed private endpoints' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Auto-derived from the network module (snet-private-endpoints) on a push-button deploy.',
  },
  'svc-plan-writeback': {
    surfaces: [{ path: '/items/plan', label: 'Plan — SQL writeback mirror' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_PLAN_BACKING_SQL_SERVER: L.sqlServer },
    autoResolveNote: 'Planning cells always persist Loom-native (Cosmos); the SQL mirror is an optional add-on.',
  },
  'svc-dab-runtime': {
    surfaces: [
      { path: '/items/data-api-builder', label: 'Data API builder — live testers' },
      { path: '/items/ontology-sdk', label: 'Ontology SDK — Try it' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Auto-wired on a push-button deploy (dabRuntimeEnabled, default on).',
  },
  'svc-udf-function': {
    surfaces: [{ path: '/items/user-data-function', label: 'User data functions — Invoke' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-onelake-acl': {
    surfaces: [{ path: '/items/lakehouse', label: 'OneLake security — ACL enforcement' }],
    fixit: { kind: 'role-grant', grantNote: 'Also requires Storage Blob Data Owner (Console UAMI) on the DLZ storage account.' },
  },
  'svc-audit-siem-stream': {
    surfaces: [{ path: '/admin/audit-logs', label: 'SIEM audit stream (Sentinel mirror)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'The built-in Cosmos audit trail records every event regardless — the DCR only adds an external SIEM mirror.',
  },
  'svc-azure-maps': {
    surfaces: [
      { path: '/items/report', label: 'Report Map visual' },
      { path: '/items/graph', label: 'Geo map canvases' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AZURE_MAPS_CLIENT_ID: L.maps },
    legacyCodes: ['maps_not_configured'],
  },
  // ── Hyperscale band (optional substrates; unset = fully-functional default) ──
  'svc-loom-onelake': {
    surfaces: [{ path: '/onelake', label: 'OneLake namespace service (scale-out)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → the per-item library path (adls-client / lakehouse-shortcuts) serves everything with no loss of function.',
  },
  'svc-loom-directlake': {
    surfaces: [{ path: '/items/semantic-model', label: 'Direct Lake columnar cache (scale-out)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → the AAS fast-path or Synapse-Serverless cold path serves DAX-class queries unchanged.',
  },
  'svc-loom-capacity-broker': {
    surfaces: [{ path: '/admin/usage-chargeback', label: 'LCU admission control (scale-out)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → job submission proceeds unthrottled (the broker constrains, it never blocks the platform).',
  },
  'perf-spark-warm-pool-store': {
    surfaces: [{ path: '/items/notebook', label: 'Warm Spark pool — cross-replica leases' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → the warm pool runs per-replica (still fully functional, just not shared).',
  },
  // ── wave-3 (G2): the promoted bespoke gates ──
  'svc-aas': {
    surfaces: [
      { path: '/items/semantic-model', label: 'Semantic model — AAS fast path' },
      { path: '/items/report', label: 'Report DAX (AAS)' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AAS_SERVER: L.aas },
    autoResolveNote: 'The Loom-native tabular layer (LOOM_SEMANTIC_BACKEND=loom-native, always emitted) is the default engine and satisfies this gate — semantic models / reports work with zero config. Azure Analysis Services is an OPT-IN fast path (Commercial/GCC only; unavailable in GCC-High / IL5). Fix-it only applies where AAS exists.',
    legacyCodes: ['aas_not_configured', 'AAS_NOT_IN_GOV', 'xmla_not_configured'],
  },
  'svc-aml': {
    surfaces: [
      { path: '/items/automl', label: 'AutoML editor' },
      { path: '/items/ml-model', label: 'ML model train/deploy' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AML_WORKSPACE: L.aml },
    legacyCodes: ['aml_not_configured', 'automl_not_configured'],
  },
  'svc-apim': {
    surfaces: [
      { path: '/admin/api-management', label: 'API Management admin' },
      { path: '/marketplace', label: 'API marketplace / publish-as-API' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_APIM_NAME: L.apim },
    legacyCodes: ['apim_not_configured'],
  },
  'svc-mip': {
    surfaces: [
      { path: '/admin/sensitivity-labels', label: 'Sensitivity labels (MIP)' },
      { path: '/admin/batch-labeling', label: 'Batch labeling' },
    ],
    fixit: { kind: 'role-grant', grantNote: 'Also grant the Console UAMI Graph InformationProtectionPolicy.Read.All (application).' },
    legacyCodes: ['mip_not_configured', 'mip_admin_not_configured'],
  },
  'svc-dlp': {
    surfaces: [{ path: '/admin/security', label: 'DLP policies' }],
    fixit: { kind: 'role-grant', grantNote: 'Also grant the Purview DLP Graph application roles to the Console UAMI.' },
    legacyCodes: ['dlp_not_configured', 'dlp_admin_not_configured', 'dlp_simulate_not_available'],
  },
  'svc-purview-uc': {
    surfaces: [{ path: '/governance/catalog', label: 'Unified catalog (Purview UC)' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_PURVIEW_UC_ENDPOINT: L.purview },
  },
  'svc-aoai-embeddings': {
    surfaces: [
      { path: '/items/ai-search-index', label: 'Index my data (embeddings)' },
      { path: '/api/ai-search/index-my-data/*', label: 'Vector index routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AOAI_EMBED_DEPLOYMENT: L.aoaiDeployment },
    legacyCodes: ['embedding_not_configured'],
  },
  'svc-databricks-sql': {
    surfaces: [
      { path: '/governance/data-quality', label: 'DQ monitor' },
      { path: '/governance/mdm', label: 'MDM match-merge' },
    ],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['warehouse_not_configured', 'dq_monitor_not_configured', 'mdm_not_configured'],
  },
  'svc-synapse-spark-pool': {
    surfaces: [
      { path: '/items/ml-model', label: 'ML model predict' },
      { path: '/scheduler', label: 'Scheduled job run adapters' },
    ],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['synapse_spark_pool_not_configured', 'spark_not_configured', 'run_adapters_not_configured'],
  },
  'svc-cosmos-control': {
    surfaces: [
      { path: '/admin/scaling', label: 'Cosmos account scaling' },
      { path: '/items/*', label: 'Item version restore' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_COSMOS_ACCOUNT: L.cosmosAccountName },
    legacyCodes: ['cosmos_not_configured'],
  },
  'svc-cosmos-vcore': {
    surfaces: [{ path: '/items/ai-search-index', label: 'Mongo vCore vector search' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['cosmos_vcore_not_configured'],
  },
  'svc-keyvault': {
    surfaces: [
      { path: '/items/lakehouse-shortcut', label: 'Shortcut credentials' },
      { path: '/admin/security', label: 'CMK pane' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_KEY_VAULT_URI: L.keyvault, LOOM_SHORTCUT_KEYVAULT: L.keyvault },
    legacyCodes: ['kv_not_configured', 'key_vault_not_configured', 'shortcut_keyvault_not_configured', 'cert_vault_not_configured', 'cmk_not_configured'],
  },
  'svc-eventgrid-topics': {
    surfaces: [{ path: '/items/event-grid-topic', label: 'Event Grid topic editor' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['eventgrid_not_configured'],
  },
  'svc-webhooks-eventgrid': {
    surfaces: [{ path: '/admin/webhooks', label: 'Event subscriptions (EG transport)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Webhooks deliver via HMAC-signed direct HTTPS by default — Event Grid is an optional alternative transport.',
  },
  'svc-servicebus': {
    surfaces: [{ path: '/items/service-bus-namespace', label: 'Service Bus namespace editor' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_SERVICEBUS_NAMESPACE: L.servicebus },
    legacyCodes: ['servicebus_not_configured'],
  },
  'svc-iothub': {
    surfaces: [{ path: '/items/iot-hub', label: 'IoT Hub editor' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['iothub_not_configured'],
  },
  'svc-digital-twins': {
    surfaces: [{ path: '/items/digital-twin', label: 'Digital twin queries' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_ADT_ENDPOINT: L.adt },
    legacyCodes: ['adt_not_configured'],
  },
  'svc-airflow': {
    surfaces: [{ path: '/items/airflow-job', label: 'Airflow job editor' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-batch': {
    surfaces: [{ path: '/items/batch-pool', label: 'Batch pool editor' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_BATCH_ACCOUNT: L.batch },
    legacyCodes: ['batch_not_configured'],
  },
  'svc-copyjob-control': {
    surfaces: [{ path: '/items/copy-job', label: 'Copy job watermarks' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_COPYJOB_CONTROL_SQL_SERVER: L.sqlServer },
    legacyCodes: ['copyjob_control_not_configured'],
  },
  'svc-postgres-flex': {
    surfaces: [{ path: '/items/postgres-flexible-server', label: 'Postgres Flexible Server editor' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['postgres_flex_not_configured'],
  },
  'svc-pgvector': {
    surfaces: [{ path: '/items/ai-search-index', label: 'pgvector backend' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_PGVECTOR_HOST: L.pgFqdn },
    legacyCodes: ['pgvector_not_configured'],
  },
  'svc-weave-ontology': {
    surfaces: [{ path: '/weave', label: 'Weave ontology store' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_WEAVE_PG_FQDN: L.pgFqdn },
    legacyCodes: ['weave_ontology_not_configured'],
  },
  'svc-dbt': {
    surfaces: [{ path: '/items/dbt-project', label: 'dbt runner' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['dbt_not_configured'],
  },
  'svc-approval-logicapp': {
    surfaces: [{ path: '/items/data-pipeline', label: 'Pipeline approval activity' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['approval_not_configured'],
  },
  'svc-shir': {
    surfaces: [{ path: '/admin/scaling', label: 'SHIR scale-to-0 controls' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['shir_not_configured', 'purview_shir_not_configured'],
  },
  'svc-rti-export': {
    surfaces: [{ path: '/items/eventhouse', label: 'Eventhouse continuous export' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_RTI_EXPORT_ADLS: L.storage },
    legacyCodes: ['rti_export_not_configured'],
  },
  'svc-sample-data': {
    surfaces: [{ path: '/learn', label: 'Sample data seeds / practice pipelines' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_SAMPLE_ADLS: L.storage },
    legacyCodes: ['sample_adls_not_configured'],
  },
  'svc-csv-imports': {
    surfaces: [{ path: '/marketplace', label: 'Data product CSV import' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['csv_imports_not_configured'],
  },
  'svc-eh-schema-registry': {
    surfaces: [{ path: '/items/event-schema-set', label: 'Event schema set editor' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['schema_registry_not_configured'],
  },
  'svc-workspace-identity': {
    surfaces: [{ path: '/workspaces', label: 'Workspace identity creation' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['workspace_identity_not_configured'],
  },
  'svc-dataverse': {
    surfaces: [{ path: '/items/power-app', label: 'Power Platform / Dataverse tables' }],
    fixit: { kind: 'wizard', grantNote: 'Requires the operator-run Power Platform SP grant (scripts/csa-loom/grant-powerplatform-sp.sh) — the S2S app must be added as an application user in the environment.' },
    legacyCodes: ['dataverse_not_configured', 'powerplatform_not_configured'],
  },
  'svc-feedback-forwarding': {
    surfaces: [{ path: '/admin/feedback-forwarding', label: 'Feedback forwarding' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-m365-link': {
    surfaces: [{ path: '/workspaces', label: 'Workspace ↔ M365 group link' }],
    fixit: { kind: 'role-grant', grantNote: 'Also grant the Console UAMI Graph Group.ReadWrite.All (application).' },
  },
  'svc-sharepoint-shortcuts': {
    surfaces: [{ path: '/items/lakehouse-shortcut', label: 'OneDrive / SharePoint shortcuts' }],
    fixit: { kind: 'role-grant', grantNote: 'Also grant the Console UAMI Graph Files.Read.All (application).' },
    legacyCodes: ['graph_drive_not_configured'],
  },
  'svc-iq-mcp': {
    surfaces: [{ path: '/admin/mcp-servers', label: 'IQ MCP bridge' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-param-sources': {
    surfaces: [{ path: '/items/data-pipeline', label: 'Parameter sources / trigger wizard' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_PARAM_KEYVAULT: L.keyvault, LOOM_PARAM_APPCONFIG: L.appConfig },
  },
  'svc-data-wrangler': {
    surfaces: [{ path: '/items/notebook', label: 'Data Wrangler panel' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-medallion-layers': {
    surfaces: [
      { path: '/onelake', label: 'OneLake paths (silver/gold)' },
      { path: '/items/semantic-model', label: 'Direct Lake (gold layer)' },
    ],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['gold_url_not_configured', 'mirror_not_configured'],
  },
  'svc-lakebase': {
    surfaces: [{ path: '/items/lakebase-postgres', label: 'Lakebase Postgres editor' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_DATABRICKS_HOSTNAME: L.databricks },
    legacyCodes: ['lakebase_not_configured'],
  },
  // ── health-coverage convergence (#2093) — the audit-added backend specs ──
  'svc-powerplatform': {
    surfaces: [{ path: '/items/power-app', label: 'Power Platform control plane (power-* items)' }],
    fixit: { kind: 'role-grant', grantNote: 'A Power Platform admin must register the Console UAMI as a management app (New-PowerAppManagementApp; scripts/csa-loom/grant-powerplatform-sp.ps1) — a one-time tenant action, not an env write.' },
  },
  'svc-stream-analytics': {
    surfaces: [{ path: '/items/eventstream', label: 'Eventstream processing (ASA jobs)' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-azure-sql': {
    surfaces: [
      { path: '/items/sql-database', label: 'SQL database items' },
      { path: '/items/mirrored-database', label: 'Mirroring source ops' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AZURE_SQL_DEFAULT_SERVER: L.sqlServer },
    legacyCodes: ['sql_default_server_not_configured'],
  },
  'svc-postgres': {
    surfaces: [{ path: '/items/lakebase-postgres', label: 'Lakebase / pgvector Postgres host' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_POSTGRES_HOST: L.pgFqdn },
  },
  'svc-eventgrid': {
    surfaces: [{ path: '/admin/webhooks', label: 'Business-event topics' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-redis-result-cache': {
    surfaces: [{ path: '/items/kql-database', label: 'Query result cache (scale-out)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → the built-in per-replica in-memory result cache serves everything with zero loss of function.',
  },
};

// ── registry composition ─────────────────────────────────────────────────────

function settingsFor(spec: EnvSpec, meta: GateMeta | undefined): GateRequiredSetting[] {
  const out: GateRequiredSetting[] = [];
  const seen = new Set<string>();
  const add = (key: string, required: boolean, aliasOf?: string[]) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      envVar: key,
      description: spec.title,
      valueHint: VALUE_HINT[key] || '',
      aliasOf: aliasOf && aliasOf.length > 1 ? aliasOf : undefined,
      required,
      loader: meta?.loaders?.[key],
    });
  };
  for (const k of spec.required || []) add(k, true);
  for (const group of spec.anyOf || []) for (const k of group) add(k, false, group);
  return out;
}

/** The complete gate registry — one entry per ENV_CHECKS spec, enriched. */
export const GATES: GateDef[] = ENV_CHECKS.map((spec) => {
  const meta = GATE_META[spec.id];
  return {
    id: spec.id,
    title: spec.title,
    category: spec.category,
    severity: spec.severity,
    surfaces: meta?.surfaces || [],
    requiredSettings: settingsFor(spec, meta),
    role: spec.role,
    provisionedBy: spec.provisionedBy,
    remediation: spec.remediation,
    docs: spec.docs,
    canAutoResolve: !!(spec.derived || spec.optionalDefault),
    autoResolveNote: meta?.autoResolveNote,
    fixit: meta?.fixit || { kind: 'env-picker' },
    legacyCodes: meta?.legacyCodes || [],
  };
});

const GATES_BY_ID = new Map(GATES.map((g) => [g.id, g]));

export function getGate(id: string): GateDef | undefined {
  return GATES_BY_ID.get(id);
}

/** Map a bespoke legacy error code (e.g. 'adls_not_configured') to its gate. */
export function gateForLegacyCode(code: string): GateDef | undefined {
  return GATES.find((g) => g.legacyCodes.includes(code));
}

/**
 * Evaluate the LIVE status of one gate — the same env-presence evaluation the
 * self-audit runs (evalEnv), reduced to configured/blocked for the registry UI.
 * Real check: the per-client *ConfigGate() helpers gate on exactly these vars.
 */
export function gateStatus(id: string): GateStatus | undefined {
  const spec = ENV_CHECKS.find((s) => s.id === id);
  if (!spec) return undefined;
  const check = evalEnv(spec);
  const missing = check.status === 'pass'
    ? []
    : (check.detail.match(/Missing: (.+)\.$/)?.[1]?.split(', ') || []).map((m) =>
        m.includes(' | ') ? m.split(' | ')[0].trim() : m.trim());
  return {
    id,
    status: check.status === 'pass' ? 'configured' : 'blocked',
    check,
    missing,
  };
}

/** Evaluate every gate (one cheap in-process pass — no network). */
export function allGateStatuses(): GateStatus[] {
  return GATES.map((g) => gateStatus(g.id)!).filter(Boolean);
}
