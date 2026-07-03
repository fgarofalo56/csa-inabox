/**
 * Cosmos singleton for the Loom Console BFF.
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) via ManagedIdentityCredential,
 * chained with DefaultAzureCredential so local dev works against the
 * same account via `az login`. The UAMI must hold the Cosmos DB
 * Built-in Data Contributor role at account scope.
 *
 * Containers are created on first access (idempotent) so a fresh
 * environment doesn't require an ARM/Bicep pre-step beyond the
 * account+database.
 */

import { CosmosClient, type Container, type Database } from '@azure/cosmos';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

let _client: CosmosClient | null = null;
let _db: Database | null = null;
let _workspaces: Container | null = null;
let _items: Container | null = null;
let _copilotSessions: Container | null = null;
// Per-message Copilot feedback (thumbs up/down) — append-only audit log, one
// row per rating, partitioned by /sessionId so every per-session feedback read
// hits a single physical partition. NO defaultTtl: feedback is a permanent
// audit record (unlike copilot-sessions, which auto-expire after 28 days).
let _copilotFeedback: Container | null = null;
let _appsCatalog: Container | null = null;
let _workloadsCatalog: Container | null = null;
let _userPrefs: Container | null = null;
let _tabsState: Container | null = null;
let _notifications: Container | null = null;
let _auditLog: Container | null = null;
let _comments: Container | null = null;
let _shares: Container | null = null;
let _folders: Container | null = null;
let _downloads: Container | null = null;
let _searchHistory: Container | null = null;
let _wsPermissions: Container | null = null;
let _wsGit: Container | null = null;
let _tenantThemes: Container | null = null;
let _tenantSettings: Container | null = null;
let _marketplaceListings: Container | null = null;
let _featurePermissions: Container | null = null;
let _lakehouseShortcuts: Container | null = null;
let _lakehouseSchemas: Container | null = null;
let _networkingConfig: Container | null = null;
let _copilotConfig: Container | null = null;
let _workspaceAgentConfig: Container | null = null;
let _mcpServers: Container | null = null;
let _threadEdges: Container | null = null;
let _connections: Container | null = null;
let _maintenanceJobs: Container | null = null;
let _dataproductJobs: Container | null = null;
let _appInstallJobs: Container | null = null;
let _labelPropagation: Container | null = null;
let _postureAggregates: Container | null = null;
let _recommendedActions: Container | null = null;
// Govern → Admin view (F2) — tenant-scoped posture aggregates, distinct from the
// owner-scoped (F3) containers above. Partitioned by /tenantId.
let _postureAggregatesAdmin: Container | null = null;
let _recommendedActionsAdmin: Container | null = null;
let _onelakeSecurityRoles: Container | null = null;
// Wave 4 — Data Marketplace / Governance containers.
let _dataProducts: Container | null = null;
let _dataProductJobs: Container | null = null;
let _accessRequests: Container | null = null;
let _attributeGroups: Container | null = null;
let _okrs: Container | null = null;
let _scorecardGoals: Container | null = null;
let _scorecardCheckins: Container | null = null;
let _governanceDomains: Container | null = null;
let _itemPermissions: Container | null = null;
let _wsRoles: Container | null = null;
let _labelAssignments: Container | null = null;
// F16 — Access-request approval workflow (manager → privacy → approver →
// access-provider). Distinct from the Wave-4 marketplace `access-requests`
// container above: this one is partitioned by /tenantId and drives the
// multi-tier approval inbox + final real-RBAC grant.
let _accessRequestWorkflow: Container | null = null;
// Saved SQL queries — per-item "My Queries" (private) + "Shared Queries" rows
// for the SQL-database editor. Partitioned by /itemId so every per-item fetch
// (and bulk delete) hits a single physical partition. Created lazily; no
// ARM/Bicep pre-step beyond the account+database (the Console UAMI already holds
// Cosmos DB Built-in Data Contributor at account scope).
let _savedQueries: Container | null = null;
// Foundation admin containers (shared cloud-endpoints resolver task) — only
// the two with NO main-side equivalent are declared here. `embed-codes`,
// `org-visuals`, `task-flows`, and `azure-connections` are all declared
// further down by parallel feature branches and reused as-is.
//   loom-workspaces    — admin Workspace Catalog (one row per Loom-managed
//                        workspace), PK /tenantId so the admin workspace-picker
//                        hits a single physical partition. Distinct from the
//                        BFF `workspaces` config container.
//   workspace-folders  — Loom-native folder hierarchy (OneLake folder parity),
//                        PK /workspaceId so the Explorer tree hits one partition.
let _loomWorkspaces: Container | null = null;
let _workspaceFolders: Container | null = null;
let _pbiDashboardOverlays: Container | null = null;
// Paginated-report (RDL) definitions — the Loom-native authoring document for
// the paginated-report editor (data sources, datasets, tablixes, parameters).
// One row per report (id = reportId, PK /workspaceId) so every per-report load
// hits a single physical partition. Azure-native parity with a Power BI
// Paginated Report .rdl — NO Fabric/Power BI workspace required to author or
// export (export delegates to the paginated-report-renderer Azure Function).
// Created lazily so a fresh environment needs no extra ARM/Bicep step beyond
// the account+database.
let _paginatedReportDefinitions: Container | null = null;
// Loom-native deployment pipelines — Azure-native parity for Fabric Deployment
// pipelines (no-fabric-dependency.md). `loom-pipelines` holds one doc per
// pipeline (PK /tenantId so the per-tenant list hits a single physical
// partition); `pipeline-stage-rules` holds per-stage parameter/data-source
// override rules (PK /pipelineId); `pipeline-history` holds one receipt per
// deploy run (PK /pipelineId). Created lazily so a fresh environment needs no
// extra ARM/Bicep step beyond the account+database.
let _loomPipelines: Container | null = null;
let _pipelineStageRules: Container | null = null;
let _pipelineHistory: Container | null = null;
// Scorecard rollup + status-rule config — one row per scorecard (id =
// scorecardId), PK /scorecardId so every per-scorecard read is a single-
// partition point-read. Stores the rollupMethod / statusRules / otherwiseStatus
// overlay applied to live Fabric goals (loom: items carry their config inline
// in state.content). Created lazily so a fresh environment needs no extra
// ARM/Bicep step beyond the account+database (the Console UAMI already holds
// Cosmos DB Built-in Data Contributor at account scope).
let _scorecardConfig: Container | null = null;
let _reportSubscriptions: Container | null = null;
let _reportDeliveryLog: Container | null = null;
// F16 Azure Connections — per-workspace ADLS Gen2 + Log Analytics bindings.
// Partitioned by /workspaceId so every per-workspace connection list hits a
// single physical partition. Distinct from the tenant-scoped 'connections'
// container (generic data-source connections with Key Vault secrets).
let _azureConnections: Container | null = null;
// Task flows (F11) — visual step-sequence canvases per workspace. One row per
// task flow, partitioned by /workspaceId so the workspace's flow list + every
// per-flow save hits a single physical partition. Steps carry @xyflow/react
// canvas positions and optional refs to real WorkspaceItem ids; edges are the
// directed links between steps. Loom-native (no Fabric dependency). Created
// lazily so a fresh environment needs no extra ARM/Bicep step beyond the
// account+database.
let _taskFlows: Container | null = null;
// Spark / compute configuration (F13) — one doc per Loom workspace holding the
// operator-desired Databricks Spark settings (Pool / Runtime / Environment /
// Jobs). The Cosmos doc is the source of truth; the live Databricks cluster/pool
// is the projection applied on cluster create/edit. Partitioned by /workspaceId
// so every Spark-settings read is a single-partition point read. Created lazily
// (createIfNotExists) so a fresh environment needs no extra ARM/Bicep step
// beyond the account+database. Azure-native default — no Fabric dependency.
let _workspaceSparkConfig: Container | null = null;
// F22 — embed codes (signed embed URLs), PK /tenantId.
let _embedCodes: Container | null = null;
// F23 — org-visuals metadata (tenant-wide custom visuals), PK /tenantId.
let _orgVisuals: Container | null = null;
// CoE template library — per-tenant clones of the default CoE Power BI report
// templates ("Use this template"). One row per cloned template, PK /tenantId.
let _coeTemplates: Container | null = null;
// Admin runtime env/config management — one doc per tenant (id = tenantId, PK
// /tenantId) holding the operator-desired deployment env-var values set from
// /admin/env-config. The Cosmos doc is the DURABLE source of desired state
// (survives container restarts); the live values are projected onto the
// loom-console container app as a new ACA revision via updateContainerAppEnv.
// Secret-typed keys are NEVER stored here in plaintext — only { set:true } —
// since the value lives in an ACA secret. Created lazily so a fresh
// environment needs no extra ARM/Bicep step beyond the account+database.
let _envConfig: Container | null = null;
// Catalog → Metastores: persistent Databricks workspace registrations. One row
// per registered workspace (id = workspaceUrl, PK /tenantId so the per-tenant
// federation list hits a single physical partition). Records the UC metastore
// attach state + Purview source/scan state so a registration survives a Console
// reload WITHOUT a bicep flip of LOOM_DATABRICKS_HOSTNAMES. Created lazily so a
// fresh environment needs no extra ARM/Bicep step beyond the account+database.
let _metastoreRegistrations: Container | null = null;
// Tenant topology (audit-t157). One doc per tenant (id='tenant-topology') with
// the deployed hub's coordinates (VNet/LAW/DNS/ADX/Cosmos + Console UAMI ids),
// written by the tenant deploy's post-bootstrap. Read by the Setup Wizard "Add
// landing zone" flow + the orchestrator dlz-attach path so hub coordinates are
// never free-typed. PK /tenantId. Created lazily (createIfNotExists) here AND
// ARM-provisioned in cosmos.bicep's loomContainers — the createIfNotExists is
// the idempotent fallback for hotfix deploys that predate the bicep change.
let _tenantTopology: Container | null = null;
// Durable rate-limiter store (rel-T16). Fixed-window counter + payload-dedupe
// docs, PK /key. defaultTtl=-1 so each doc's own `ttl` (window seconds / dedupe
// hours) is honored and expired windows/markers self-evict — the container never
// grows unbounded. Created lazily so a fresh environment needs no extra ARM/Bicep
// step beyond the account+database.
let _rateLimits: Container | null = null;
let _ensured = false;

/**
 * Persisted Spark / compute configuration for one Loom workspace (F13).
 * Mirrors the Fabric "Spark settings" object (Pool / Environment / Jobs) but
 * backed by Databricks instance pools + cluster spec. The doc is authoritative;
 * runtime/jobs settings are merged into the ClusterSpec when a cluster is
 * created/edited from this workspace's template.
 */
export interface WorkspaceSparkConfig {
  id: string;                 // == workspaceId
  workspaceId: string;        // partition key
  tenantId?: string;
  pool: {
    mode: 'starter' | 'custom';
    instance_pool_id?: string;
    instance_pool_name?: string;
    node_type_id?: string;
    min_idle_instances?: number;
    max_capacity?: number;
    idle_instance_autotermination_minutes?: number;
    availability?: 'ON_DEMAND_AZURE' | 'SPOT_AZURE';
  };
  runtime: {
    spark_version?: string;          // e.g. '15.4.x-scala2.12'
    node_type_id?: string;
    driver_node_type_id?: string;
    autoscale?: { min_workers: number; max_workers: number };
    num_workers?: number;
  };
  environment: {
    pypi?: string[];
    maven?: string[];
    sessionLevelPackages?: boolean;
  };
  jobs: {
    session_timeout_minutes: number;
    optimistic_admission: boolean;
    reserve_cores: number;
    dynamic_executors?: boolean;
    min_executors?: number;
    max_executors?: number;
  };
  updatedAt: string;
  updatedBy?: string;
}

/**
 * Bulk-import job record for the Data product "Import from CSV" flyout (F2/F18).
 * One row per import run, partitioned by tenant so the Monitor tab polls a
 * single physical partition. `rowErrors` captures the per-row failures that did
 * NOT abort the valid rows — surfaced verbatim in the Monitor error log.
 */
export interface DataProductImportJob {
  id: string;            // jobId (UUID)
  tenantId: string;      // partition key — caller's oid
  status: 'running' | 'done' | 'partial' | 'failed';
  totalRows: number;
  successCount: number;
  failCount: number;
  rowErrors: Array<{ row: number; name: string; error: string }>;
  createdAt: string;
  updatedAt: string;
  workspaceId: string;
  /** ADLS staging path (file name in the csv-imports container). '' when staging was gated. */
  blobPath: string;
  /** True when the raw CSV was staged to ADLS; false when the storage gate fired (inline-only). */
  staged: boolean;
  createdBy?: string;
}

/**
 * Async app-install job record (harness task-019 — true async install).
 *
 * A long app install (creating 10-12 Cosmos items, then provisioning each into
 * a REAL Azure backend — ADX cluster create, Synapse dedicated-pool resume,
 * Databricks job run, ADF/Synapse pipeline createRun+poll, Logic App run) can
 * exceed the edge gateway's ~30s window. Rather than block the HTTP response on
 * the whole provision (which 504s), POST /api/apps/[id]/install now writes a
 * `running` job here, returns 202 { jobId }, and finishes the install in a
 * floating promise that survives the response (the Container App Node process
 * stays alive). The dialog polls GET /api/apps/install-jobs/[jobId] every 5s for
 * live phase + percentComplete + the final ProvisionReport.
 *
 * One row per install run, partitioned by tenant so every poll is a
 * single-partition point-read. Created lazily (createIfNotExists) + ARM-
 * provisioned in cosmos.bicep so a fresh environment needs no extra step.
 *
 * `percentComplete` mirrors the Fabric/ARM long-running-operation contract
 * (Fabric LRO `percentComplete`, ARM async `status`), so the UI shows real
 * forward progress across phases instead of a spinner that may 504.
 */
export interface AppInstallJob {
  id: string;            // jobId (UUID)
  tenantId: string;      // partition key — caller's oid
  appId: string;
  appName?: string;
  workspaceId: string;
  status: 'running' | 'done' | 'partial' | 'failed';
  /** Coarse phase for the progress label. */
  phase: 'creating-items' | 'provisioning' | 'seeding' | 'finalizing' | 'done';
  /** Whether live-service provisioning was requested (the wizard's Deploy switch). */
  deploy: boolean;
  mode: 'shared' | 'dedicated';
  totalItems: number;
  createdItems: number;
  /** 0-100 — forward progress across create + provision + finalize. */
  percentComplete: number;
  /** Per-item create results (created | existed | failed). */
  installed: Array<{ itemType: string; id?: string; displayName: string; status: string; error?: string }>;
  /** Final provisioning report (set once the provision phase completes). Typed
   *  structurally so this low-level module stays decoupled from the engine. */
  provision?: unknown;
  /** Sample-data seed outcome (Supercharge medallion apps) — lands the Bronze
   *  SOURCE parquet + creates the lh_* Spark databases. Best-effort. */
  seed?: { status: 'succeeded' | 'failed' | 'gated'; error?: string; gate?: string; at: string };
  /** Catastrophic worker error (the install loop itself threw) — distinct from
   *  per-item provision failures captured inside `provision`. */
  error?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

/**
 * Report subscription — a scheduled, recurring export+email delivery of a
 * Power BI report (Azure-native parity with Fabric/Power BI "Subscribe to
 * report" + "Subscriptions"). One row per subscription, partitioned by the
 * reportId so the editor's per-report subscription list hits a single physical
 * partition. The fiab-report-subscriptions timer Function reads `enabled=true`
 * rows, renders the report via the real Power BI ExportTo REST job, and emails
 * the file via the report-subscription Logic App. No Microsoft Fabric
 * dependency — Power BI REST is the Azure-native rendering backend.
 */
export interface ReportSubscription {
  id: string;                       // 'sub:<uuid>' — partition companion
  reportId: string;                 // PK — the Power BI report id (groupId-scoped)
  workspaceId: string;              // the Power BI workspace (groupId) the report lives in
  itemId?: string;                  // owning Loom item id (when launched from an item editor)
  format: 'PDF' | 'PPTX' | 'PNG';   // export format
  cron: string;                     // NCRONTAB (6-field: sec min hour day month day-of-week)
  recipients: string[];             // email addresses the export is delivered to
  subject?: string;                 // email subject override (defaults to the report name)
  enabled: boolean;                 // false pauses delivery without deleting the row
  createdBy: string;                // creator oid — scopes ownership
  createdByName?: string;           // creator display name/upn for the audit trail
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;               // last delivery attempt (set by the timer Function)
  lastStatus?: 'succeeded' | 'failed';
  lastError?: string;               // last failure message (cleared on success)
}

/**
 * Report delivery log — one append-only row per delivery attempt for a
 * subscription, partitioned by subscriptionId so the editor's per-subscription
 * "Delivery history" view hits a single physical partition. Written by the
 * timer Function after each export+email. This is the "delivery log" half of
 * the acceptance receipt.
 */
export interface ReportDeliveryLog {
  id: string;                       // 'del:<uuid>'
  subscriptionId: string;           // PK — the parent subscription id
  reportId: string;
  workspaceId: string;
  format: 'PDF' | 'PPTX' | 'PNG';
  recipients: string[];
  deliveredAt: string;
  status: 'succeeded' | 'failed';
  fileSizeBytes?: number;           // size of the exported file (succeeded only)
  blobPath?: string;                // ADLS path the export was archived to (succeeded only)
  error?: string;                   // failure detail (failed only)
}

/**
 * Persistent Databricks workspace registration for the Unified Catalog →
 * Metastores surface. One row per registered workspace (id = workspaceUrl),
 * partitioned by /tenantId. The Cosmos doc is what makes a registration survive
 * a Console reload WITHOUT a bicep flip of LOOM_DATABRICKS_HOSTNAMES — the BFF
 * unions these workspaceUrls with the env hostnames so federation picks them up.
 */
export interface MetastoreRegistration {
  id: string;                       // == workspaceUrl (host, no scheme)
  tenantId: string;                 // partition key — registrant oid
  workspaceUrl: string;             // adb-….azuredatabricks.net (host, no scheme)
  workspaceName?: string;           // friendly ARM name when registered from the picker
  workspaceArmId?: string;          // ARM resource id (when known)
  workspaceNumericId?: string;      // Databricks numeric workspace id (for UC attach)
  metastoreId?: string;             // attached UC metastore id (when attached)
  defaultCatalog?: string;          // default catalog name set on attach (e.g. 'main')
  ucAttached: boolean;              // true once assignMetastore() succeeded
  purviewSourceName?: string;       // Purview Data Map data-source name (when registered)
  purviewScanName?: string;         // Purview scan name (when defined)
  lastScanRunId?: string;           // last triggered scan run id
  purviewRegistered: boolean;       // true once the Purview source was registered
  purviewScanned: boolean;          // true once a scan run was triggered
  registeredAt: string;             // ISO timestamp
  registeredBy?: string;            // registrant oid / upn
  updatedAt?: string;
}

/** Thrown when LOOM_COSMOS_ENDPOINT is not set or the client cannot connect. */
export class CosmosNotConfiguredError extends Error {
  readonly code = 'cosmos_not_configured';
  readonly missing: string[];
  constructor(missing: string[] = ['LOOM_COSMOS_ENDPOINT']) {
    super(`Cosmos DB is not configured in this deployment. Missing: ${missing.join(', ')}`);
    this.name = 'CosmosNotConfiguredError';
    this.missing = missing;
  }
}

function endpoint(): string {
  const v = process.env.LOOM_COSMOS_ENDPOINT;
  if (!v) throw new CosmosNotConfiguredError(['LOOM_COSMOS_ENDPOINT']);
  return v;
}

function databaseId(): string {
  return process.env.LOOM_COSMOS_DATABASE || 'loom';
}

function credential() {
  const clientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const chain: any[] = [];
  if (clientId) chain.push(new ManagedIdentityCredential({ clientId }));
  chain.push(new DefaultAzureCredential());
  return new ChainedTokenCredential(new AcaManagedIdentityCredential(), ...chain);
}

function client(): CosmosClient {
  if (_client) return _client;
  _client = new CosmosClient({ endpoint: endpoint(), aadCredentials: credential() });
  return _client;
}

/**
 * Cheap reachability probe for the deep-health route (/api/health/deep).
 *
 * Does a single `getDatabaseAccount()` — a lightweight metadata read that
 * exercises connectivity + the Console UAMI's AAD auth WITHOUT the heavier
 * `ensure()` (which createIfNotExists's ~60 containers). Bounded by `budgetMs`
 * via an AbortController so a Cosmos blip can't stall the health route. Throws
 * CosmosNotConfiguredError when LOOM_COSMOS_ENDPOINT is unset (the honest
 * "not configured in this deployment" signal) and rethrows on unreachable/auth
 * failure — the caller records it as a degraded check, never a thrown 500.
 */
export async function probeCosmosReachable(budgetMs = 2000): Promise<void> {
  const c = client(); // throws CosmosNotConfiguredError when the endpoint is unset
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(250, budgetMs));
  try {
    await c.getDatabaseAccount({ abortSignal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ensure() {
  if (_ensured) return;
  const c = client();
  const { database } = await c.databases.createIfNotExists({ id: databaseId() });
  _db = database;
  const { container: ws } = await database.containers.createIfNotExists({
    id: 'workspaces',
    partitionKey: { paths: ['/tenantId'] },
  });
  _workspaces = ws;
  const { container: it } = await database.containers.createIfNotExists({
    id: 'items',
    partitionKey: { paths: ['/workspaceId'] },
  });
  _items = it;
  const { container: cs } = await database.containers.createIfNotExists({
    id: 'copilot-sessions',
    partitionKey: { paths: ['/sessionId'] },
    defaultTtl: 2419200, // 28 days = 28 * 24 * 3600 — chat sessions auto-expire
  });
  _copilotSessions = cs;
  // Idempotent TTL upgrade. createIfNotExists ignores `defaultTtl` for a
  // PRE-EXISTING container, so environments whose copilot-sessions container
  // was created before TTL was added would never expire. Read the current
  // container def and, if TTL isn't 28 days, replace() it once. Best-effort:
  // a failure here (e.g. transient throttle) never blocks the BFF.
  try {
    const csDef = await cs.read();
    if (csDef.resource && (csDef.resource as any).defaultTtl !== 2419200) {
      await cs.replace({ ...(csDef.resource as any), defaultTtl: 2419200 });
    }
  } catch {
    /* TTL upgrade is best-effort */
  }
  // Per-message Copilot feedback (thumbs up/down). PK /sessionId. NO defaultTtl
  // — feedback is a permanent audit record, unlike the sessions above.
  const { container: cf } = await database.containers.createIfNotExists({
    id: 'copilot-feedback',
    partitionKey: { paths: ['/sessionId'] },
  });
  _copilotFeedback = cf;

  // Chunk 0 — UI foundation containers
  const mk = async (id: string, pk: string) =>
    (await database.containers.createIfNotExists({ id, partitionKey: { paths: [pk] } })).container;
  _appsCatalog = await mk('apps-catalog', '/tenantId');
  _workloadsCatalog = await mk('workloads-catalog', '/tenantId');
  _userPrefs = await mk('user-prefs', '/userId');
  _tabsState = await mk('tabs-state', '/userId');
  _notifications = await mk('notifications', '/userId');
  _auditLog = await mk('audit-log', '/itemId');
  _comments = await mk('comments', '/itemId');
  _shares = await mk('shares', '/itemId');
  _folders = await mk('folders', '/workspaceId');
  _downloads = await mk('downloads', '/userId');
  _searchHistory = await mk('search-history', '/userId');
  _wsPermissions = await mk('workspace-permissions', '/workspaceId');
  _wsGit = await mk('workspace-git', '/workspaceId');
  _tenantThemes = await mk('tenant-themes', '/tenantId');
  _tenantSettings = await mk('tenant-settings', '/tenantId');
  _marketplaceListings = await mk('marketplace-listings', '/tenantId');
  // Phase 2 — Fabric-style RBAC: grant rows partitioned by tenant so
  // every per-request lookup hits a single physical partition.
  _featurePermissions = await mk('feature-permissions', '/tenantId');
  // Lakehouse "Shortcuts" registry — Azure-native OneLake-shortcut parity.
  // Partitioned by the lakehouse (container/item id) so every Explorer lookup
  // hits a single physical partition. Created lazily so a fresh environment
  // needs no extra ARM/Bicep step beyond the account+database.
  _lakehouseShortcuts = await mk('lakehouse-shortcuts', '/lakehouseId');
  // Lakehouse multi-schema registry (F9) — one row per schema per lakehouse.
  // Azure-native parity with Fabric's schema-enabled lakehouse. Partitioned by
  // the lakehouse id so every Tables-tree lookup hits a single physical
  // partition. 'dbo' is synthetic (never stored) and always present.
  _lakehouseSchemas = await mk('lakehouse-schemas', '/lakehouseId');
  // Advanced networking (F15) — per-workspace allowlist (trusted instances) +
  // outbound private-endpoint rule registry. One doc per workspace
  // (id = workspaceId), PK /workspaceId so every networking-pane read hits a
  // single physical partition. The NSG rules + private endpoints themselves
  // live in Azure (ARM); this container only records the Loom-side metadata so
  // the pane can list/remove them. Created lazily — no extra ARM/Bicep step.
  _networkingConfig = await mk('networking-config', '/workspaceId');
  // Copilot & Agents config — tenant-wide default Foundry account + model
  // deployments (PK /tenantId, one doc per tenant) set in admin tenant-settings,
  // and per-workspace data-agent config (PK /workspaceId) set by workspace
  // owners/contributors. Created lazily so a fresh environment needs no extra
  // ARM/Bicep step beyond the account+database.
  _copilotConfig = await mk('copilot-config', '/tenantId');
  _workspaceAgentConfig = await mk('workspace-agent-config', '/workspaceId');
  // "Connect MCP tools" — external MCP tool-server connections per tenant.
  _mcpServers = await mk('mcp-servers', '/tenantId');
  // Loom Thread edge graph — one row per "Weave" integration (from → to),
  // partitioned by tenant so the lineage view hits a single physical partition.
  _threadEdges = await mk('thread-edges', '/tenantId');
  // Loom Connections — reusable data-source connection metadata (secrets live in
  // Key Vault; only the secretRef is stored here). PK /tenantId.
  _connections = await mk('connections', '/tenantId');
  // Delta maintenance jobs — one row per OPTIMIZE / VACUUM / ZORDER BY job
  // submitted to a Synapse Spark Livy session, partitioned by tenant so the
  // Monitor "Maintenance" view hits a single physical partition.
  _maintenanceJobs = await mk('maintenance-jobs', '/tenantId');
  // Bulk-import jobs for the Data product "Import from CSV" flyout (F2/F18) —
  // one row per import run, partitioned by tenant so the Monitor tab polls a
  // single physical partition. Created lazily so a fresh environment needs no
  // extra ARM/Bicep step beyond the account+database. Named distinctly from the
  // marketplace 'dataproduct-jobs' container below (different partition key).
  _dataproductJobs = await mk('dataproduct-import-jobs', '/tenantId');
  // Async app-install jobs (task-019) — one row per install run, PK /tenantId so
  // the install dialog's 5s poll hits a single physical partition. Created lazily
  // (createIfNotExists) here AND ARM-provisioned in cosmos.bicep's loomContainers.
  _appInstallJobs = await mk('app-install-jobs', '/tenantId');
  // Sensitivity-label downstream propagation state (F15). One row per item
  // (id = 'prop:<itemId>'), written by the label-propagation timer Function
  // and read live-overlaid by the lineage view. PK /tenantId so the governance
  // lineage read hits a single physical partition.
  _labelPropagation = await mk('label-propagation', '/tenantId');
  // Governance posture aggregates — F3 data-owner Govern view. One doc per
  // data owner (id = owner OID, PK /ownerId), recomputed by the posture-refresh
  // Azure Function on tab-open AND live in the BFF as a fallback. Partitioned by
  // ownerId so every owner-scoped read is a single-partition point-read —
  // cross-owner leakage is structurally impossible. Created lazily so a fresh
  // environment needs no extra ARM/Bicep step beyond the account+database.
  _postureAggregates = await mk('posture-aggregates', '/ownerId');
  // Recommended governance actions — owner-scoped action cards (items missing a
  // sensitivity label / description / endorsement). One doc per owner, PK
  // /ownerId. Same single-partition isolation guarantee as posture-aggregates.
  _recommendedActions = await mk('recommended-actions', '/ownerId');
  // OneLake Security roles (F7) — one doc per data-access role per item,
  // partitioned by /itemId so the Security tab's per-item GET hits a single
  // physical partition. Azure-native parity with Fabric's OneLake data-access
  // roles; real enforcement is ADLS Gen2 ACLs (see onelake-security-client.ts).
  _onelakeSecurityRoles = await mk('onelake-security-roles', '/itemId');
  // Data Marketplace / Governance containers (Wave 4). Partitioned by tenantId
  // (product catalog, attribute groups, OKRs, governance domains) or
  // dataProductId (jobs, access requests) so every per-product or per-tenant
  // lookup hits a single physical partition. Created lazily (createIfNotExists)
  // so a fresh environment needs no extra ARM/Bicep step beyond the
  // account + database — exactly like every other Loom container above.
  _dataProducts      = await mk('dataproducts',        '/tenantId');
  _dataProductJobs   = await mk('dataproduct-jobs',    '/dataProductId');
  _accessRequests    = await mk('access-requests',     '/dataProductId');
  _attributeGroups   = await mk('attribute-groups',    '/tenantId');
  // Data-product OKRs (F10 "Linked resources") — Loom-native objectives &
  // key-results store, one row per OKR, partitioned by the parent data-product
  // item id so the editor's OKR list hits a single physical partition. The F10
  // linked-resources route is the live consumer (PK /dataProductId).
  _okrs              = await mk('okrs',                '/dataProductId');
  // Scorecard extended goal metadata (F — Scorecard goals + connected metrics)
  // — status / owner / dueDate / connected-DAX-metric binding / sub-goals that
  // the Fabric Scorecards REST surface doesn't expose as first-class fields.
  // One row per (scorecard, goal), PK /scorecardId so the editor's per-scorecard
  // goal-merge load hits a single physical partition. Azure-native: the goal's
  // live value is pulled from a Power BI / AAS semantic model via executeQueries
  // (see aas-client.ts) — no real Fabric scorecard required. Created lazily so a
  // fresh environment needs no extra ARM/Bicep step beyond the account+database.
  _scorecardGoals    = await mk('scorecard-goals',     '/scorecardId');
  // Scorecard check-in history — one append-only row per manual/automated
  // check-in (value + status + note + date). PK /goalId so every per-goal
  // history query is a single-partition read. Records check-ins even for
  // bundle-template scorecards that aren't yet live in Fabric.
  _scorecardCheckins = await mk('scorecard-checkins',  '/goalId');
  // Item-level permissions & sharing (F6) — one row per (item, principal),
  // partitioned by the item id so every per-item permission lookup hits a
  // single physical partition. The Azure-native default mirrors each grant to
  // ADLS POSIX ACLs + ARM Storage data-plane RBAC; Cosmos is the source of
  // truth for the "Manage permissions" list. Created lazily so a fresh
  // environment needs no extra ARM/Bicep step beyond the account+database.
  _itemPermissions = await mk('item-permissions', '/itemId');
  // Workspace roles (F5 — Manage Access) — Azure-native workspace RBAC mirror.
  // One row per principal (user / group / SP) per workspace, partitioned by the
  // workspace so the Manage Access pane hits a single physical partition. Keyed
  // by principalId (NOT UPN) so groups — which have no UPN — are first-class.
  // Distinct from the legacy UPN-keyed `workspace-permissions` container, which
  // is left untouched for the data-agent config authz path.
  _wsRoles = await mk('workspace-roles', '/workspaceId');
  // Governance Domains (F4) — one doc per domain, partitioned by tenant so
  // every Governance "Domains" list lookup hits a single physical partition.
  // Created lazily; no pre-step beyond the Cosmos account + database. The
  // Purview classic-collection mirror is best-effort on top of this store.
  // Shared by both the Wave-4 marketplace catalog and the governance dashboard.
  _governanceDomains = await mk('governance-domains', '/tenantId');
  // Sensitivity-label assignments — one row per manual label application to a
  // Loom item (F12 sensitivity-label flyout). Mirrors what's written into
  // item.state.sensitivityLabel, but as an append-only, tenant-partitioned
  // audit tier so the governance dashboard can query "every label change in
  // the tenant" without scanning every item's state field. PK /tenantId.
  // createIfNotExists keeps a fresh environment from needing an extra
  // ARM/Bicep step beyond the account+database.
  _labelAssignments = await mk('label-assignments', '/tenantId');
  // Govern → Admin view (F2) — tenant-scoped posture, distinct containers from
  // the owner-scoped (F3) posture-aggregates / recommended-actions above so the
  // two features never collide on partition key. The posture-refresh Azure
  // Function pre-computes `posture:${tenantId}` here; the BFF reads it on the
  // fast path (/api/governance/govern/posture). Partitioned by /tenantId.
  _postureAggregatesAdmin = await mk('posture-aggregates-admin', '/tenantId');
  _recommendedActionsAdmin = await mk('recommended-actions-admin', '/tenantId');
  // Access-request approval workflow (F16) — one row per data-asset access
  // request, advanced through the manager → privacy → approver → access-provider
  // tiers. Partitioned by tenant (s.claims.oid) so every per-tier inbox query
  // hits a single physical partition. Final approval provisions a real Azure
  // RBAC grant via enforceAccessGrant (access-policy-client) — no Fabric
  // dependency. Distinct from the marketplace 'access-requests' container
  // (PK /dataProductId) above. Created lazily so a fresh environment needs no
  // extra ARM step.
  _accessRequestWorkflow = await mk('access-request-workflow', '/tenantId');
  // Saved SQL queries (My Queries / Shared Queries) — one row per saved query
  // per SQL-database item. PK /itemId so the editor's per-item list and the
  // bulk-delete both hit a single physical partition. Private rows are scoped
  // by ownerId; shared rows are visible to workspace Admin/Member/Contributor
  // (RBAC enforced in the route). Created lazily so a fresh environment needs
  // no extra ARM/Bicep step beyond the account+database.
  _savedQueries = await mk('saved-queries', '/itemId');
  // Foundation admin containers (shared cloud-endpoints resolver task). ARM-
  // provisioned in landing-zone/cosmos.bicep for the `loom` database; these
  // createIfNotExists calls are the idempotent fallback for hotfix deploys that
  // skip bicep. Partition keys MUST match cosmos.bicep exactly.
  _loomWorkspaces    = await mk('loom-workspaces',    '/tenantId');
  _workspaceFolders  = await mk('workspace-folders',  '/workspaceId');
  // Loom-native overlay for Power BI / AAS dashboards: pinned-DAX tiles, Q&A
  // (Copilot→DAX) tiles, streaming (ADX/KQL) tiles, and the grid layout. Stored
  // separately from the Power BI REST tile list so the PBI ACL never gates the
  // Loom layout, and so the Azure-native streaming tiles persist with NO Power
  // BI / Fabric workspace bound. Partitioned by /itemId → one physical
  // partition per dashboard. Created lazily; no extra ARM/Bicep step.
  _pbiDashboardOverlays = await mk('pbi-dashboard-overlays', '/itemId');
  // Paginated-report (RDL) definitions — Loom-native authoring doc per report.
  // PK /workspaceId so the editor's per-report GET/PUT and the renderer's read
  // hit a single physical partition. Azure-native; no Fabric/Power BI needed.
  _paginatedReportDefinitions = await mk('paginated-report-definitions', '/workspaceId');
  // Loom-native deployment pipelines (Azure-native parity for Fabric Deployment
  // pipelines). Three containers: the pipeline catalog (PK /tenantId), the
  // per-stage deployment rules (PK /pipelineId), and the deploy-receipt history
  // (PK /pipelineId). Created lazily so a fresh environment needs no extra
  // ARM/Bicep step beyond the account+database.
  _loomPipelines = await mk('loom-pipelines', '/tenantId');
  _pipelineStageRules = await mk('pipeline-stage-rules', '/pipelineId');
  _pipelineHistory = await mk('pipeline-history', '/pipelineId');
  // Scorecard rollup + status-rule config — one row per scorecard (PK
  // /scorecardId). Overlays rollupMethod / statusRules / otherwiseStatus onto
  // live Fabric goals; loom: bundle scorecards carry config inline in
  // state.content. Single-partition point-read per scorecard.
  _scorecardConfig = await mk('scorecard-config', '/scorecardId');
  // Report subscriptions (scheduled export + email delivery) — one row per
  // subscription, PK /reportId so the editor's per-report subscription list and
  // the timer Function's per-report reads hit a single physical partition. The
  // delivery log is append-only, PK /subscriptionId. Both created lazily so a
  // fresh environment needs no extra ARM/Bicep step beyond the account+database.
  // Azure-native parity with Fabric/Power BI report subscriptions — rendering is
  // the real Power BI ExportTo REST job; delivery is the report-subscription
  // Logic App. No Microsoft Fabric dependency.
  _reportSubscriptions = await mk('report-subscriptions', '/reportId');
  _reportDeliveryLog = await mk('report-delivery-log', '/subscriptionId');
  // F16 Azure Connections — per-workspace ADLS Gen2 (dataflow staging) +
  // Log Analytics (query-log export) bindings. PK /workspaceId so every
  // per-workspace connection list hits a single physical partition. Created
  // lazily so a fresh environment needs no extra ARM/Bicep step beyond the
  // account+database.
  _azureConnections = await mk('azure-connections', '/workspaceId');
  // Task flows (F11) — visual step-sequence canvases. One row per task flow,
  // PK /workspaceId so the workspace's flow list + every save hits a single
  // physical partition. Created lazily; no ARM/Bicep pre-step beyond the
  // account+database (the Console UAMI already holds Cosmos DB Built-in Data
  // Contributor at account scope).
  _taskFlows = await mk('task-flows', '/workspaceId');
  // Spark / compute configuration (F13) — one doc per workspace holding the
  // Databricks Spark settings (Pool / Runtime / Environment / Jobs). PK
  // /workspaceId so the Spark-settings pane hits a single physical partition.
  // Created lazily so a fresh environment needs no extra ARM/Bicep step beyond
  // the account+database. Azure-native default — no Fabric dependency.
  _workspaceSparkConfig = await mk('workspace-spark-config', '/workspaceId');
  // F22 — embed codes: tenant-scoped signed embed URLs (PK /tenantId). Each row
  // is one Azure-native "embed code" (a user-delegation SAS to an org-visuals
  // blob). F23 — org-visuals: tenant-wide custom-visual bundle metadata (PK
  // /tenantId); the bundle bytes live in the org-visuals Blob container, the
  // enabled toggle + version live here. Created lazily so a fresh environment
  // needs no extra ARM/Bicep step beyond the account+database.
  _embedCodes = await mk('embed-codes', '/tenantId');
  _orgVisuals = await mk('org-visuals', '/tenantId');
  // CoE template library — per-tenant clones of the default CoE Power BI report
  // templates. Created lazily (no extra ARM/Bicep step beyond account+database;
  // the Console UAMI already holds Cosmos DB Built-in Data Contributor).
  _coeTemplates = await mk('coe-templates', '/tenantId');
  // Admin runtime env/config — one doc per tenant holding desired env-var
  // values (non-secret) + secret-set flags, PK /tenantId.
  _envConfig = await mk('env-config', '/tenantId');
  // Catalog → Metastores: persistent Databricks workspace registrations. One row
  // per registered workspace (id = workspaceUrl), PK /tenantId so the federation
  // list hits a single physical partition. Survives Console reloads without a
  // bicep flip of LOOM_DATABRICKS_HOSTNAMES.
  _metastoreRegistrations = await mk('metastore-registrations', '/tenantId');
  // Tenant topology — hub coordinates for the dlz-attach flow (audit-t157).
  _tenantTopology = await mk('tenant-topology', '/tenantId');
  // Durable rate-limiter store (rel-T16) — PK /key, TTL-enabled so per-doc `ttl`
  // (fixed-window seconds / dedupe hours) auto-evicts. Distinct createIfNotExists
  // (not `mk`) because it must set defaultTtl.
  const { container: rl } = await database.containers.createIfNotExists({
    id: 'rate-limits',
    partitionKey: { paths: ['/key'] },
    defaultTtl: -1, // TTL enabled; each doc carries its own `ttl` (no default expiry)
  });
  _rateLimits = rl;
  _ensured = true;
}

export async function copilotConfigContainer(): Promise<Container> { await ensure(); return _copilotConfig!; }
export async function workspaceAgentConfigContainer(): Promise<Container> { await ensure(); return _workspaceAgentConfig!; }
export async function mcpServersContainer(): Promise<Container> { await ensure(); return _mcpServers!; }
export async function threadEdgesContainer(): Promise<Container> { await ensure(); return _threadEdges!; }
export async function connectionsContainer(): Promise<Container> { await ensure(); return _connections!; }
export async function maintenanceJobsContainer(): Promise<Container> { await ensure(); return _maintenanceJobs!; }
export async function dataproductJobsContainer(): Promise<Container> { await ensure(); return _dataproductJobs!; }
export async function appInstallJobsContainer(): Promise<Container> { await ensure(); return _appInstallJobs!; }
export async function labelPropagationContainer(): Promise<Container> { await ensure(); return _labelPropagation!; }
export async function postureAggregatesContainer(): Promise<Container> { await ensure(); return _postureAggregates!; }
export async function recommendedActionsContainer(): Promise<Container> { await ensure(); return _recommendedActions!; }
export async function postureAggregatesAdminContainer(): Promise<Container> { await ensure(); return _postureAggregatesAdmin!; }
export async function recommendedActionsAdminContainer(): Promise<Container> { await ensure(); return _recommendedActionsAdmin!; }
export async function onelakeSecurityRolesContainer(): Promise<Container> { await ensure(); return _onelakeSecurityRoles!; }
export async function itemPermissionsContainer(): Promise<Container> { await ensure(); return _itemPermissions!; }
export async function workspaceRolesContainer(): Promise<Container> { await ensure(); return _wsRoles!; }
export async function governanceDomainsContainer(): Promise<Container> { await ensure(); return _governanceDomains!; }
export async function labelAssignmentsContainer(): Promise<Container> { await ensure(); return _labelAssignments!; }
// F16 — access-request approval workflow container (PK /tenantId). Distinct
// from the marketplace accessRequestsContainer() below (PK /dataProductId).
export async function accessRequestWorkflowContainer(): Promise<Container> { await ensure(); return _accessRequestWorkflow!; }
/** Saved SQL queries (My Queries / Shared Queries) — PK /itemId. */
export async function savedQueriesContainer(): Promise<Container> { await ensure(); return _savedQueries!; }
export async function pbiDashboardOverlaysContainer(): Promise<Container> { await ensure(); return _pbiDashboardOverlays!; }
/** Paginated-report (RDL) authoring definitions — PK /workspaceId. */
export async function paginatedReportDefinitionsContainer(): Promise<Container> { await ensure(); return _paginatedReportDefinitions!; }
/** Loom-native deployment-pipeline catalog — PK /tenantId. */
export async function loomPipelinesContainer(): Promise<Container> { await ensure(); return _loomPipelines!; }
/** Per-stage deployment rules (parameter / data-source overrides) — PK /pipelineId. */
export async function pipelineStageRulesContainer(): Promise<Container> { await ensure(); return _pipelineStageRules!; }
/** Deploy-receipt history (diff + deployed item ids per run) — PK /pipelineId. */
export async function pipelineHistoryContainer(): Promise<Container> { await ensure(); return _pipelineHistory!; }
/** Scorecard rollup + status-rule config — PK /scorecardId. */
export async function scorecardConfigContainer(): Promise<Container> { await ensure(); return _scorecardConfig!; }
/** Report subscriptions (scheduled export + email delivery) — PK /reportId. */
export async function reportSubscriptionsContainer(): Promise<Container> { await ensure(); return _reportSubscriptions!; }
/** Report delivery log (append-only delivery history) — PK /subscriptionId. */
export async function reportDeliveryLogContainer(): Promise<Container> { await ensure(); return _reportDeliveryLog!; }
/** F16 Azure Connections — per-workspace ADLS Gen2 + Log Analytics bindings (PK /workspaceId). */
export async function azureConnectionsContainer(): Promise<Container> { await ensure(); return _azureConnections!; }
/** Task flows (F11) — visual step-sequence canvases, PK /workspaceId. */
export async function taskFlowsContainer(): Promise<Container> { await ensure(); return _taskFlows!; }
/** Spark / compute configuration (F13) — PK /workspaceId. */
export async function workspaceSparkConfigContainer(): Promise<Container> { await ensure(); return _workspaceSparkConfig!; }
/** F22 — embed codes (signed embed URLs) — PK /tenantId. */
export async function embedCodesContainer(): Promise<Container> { await ensure(); return _embedCodes!; }
/** F23 — org-visuals metadata (tenant-wide custom visuals) — PK /tenantId. */
export async function orgVisualsContainer(): Promise<Container> { await ensure(); return _orgVisuals!; }
/** CoE template library — per-tenant clones of default CoE report templates, PK /tenantId. */
export async function coeTemplatesContainer(): Promise<Container> { await ensure(); return _coeTemplates!; }
/** Admin runtime env/config — desired deployment env-var state, PK /tenantId. */
export async function envConfigContainer(): Promise<Container> { await ensure(); return _envConfig!; }
/** Catalog → Metastores: persistent Databricks workspace registrations, PK /tenantId. */
export async function metastoreRegistrationsContainer(): Promise<Container> { await ensure(); return _metastoreRegistrations!; }
/** Tenant topology (audit-t157) — hub coordinates doc (id='tenant-topology', PK /tenantId). */
export async function tenantTopologyContainer(): Promise<Container> { await ensure(); return _tenantTopology!; }
/** Durable rate-limiter store (rel-T16) — fixed-window counters + dedupe markers, PK /key, TTL-enabled. */
export async function rateLimitsContainer(): Promise<Container> { await ensure(); return _rateLimits!; }

// Foundation admin containers (shared cloud-endpoints resolver task).
/** Admin Workspace Catalog — one row per Loom-managed workspace, PK /tenantId. */
export async function loomWorkspacesContainer(): Promise<Container>  { await ensure(); return _loomWorkspaces!; }
/** Workspace-native folder hierarchy (OneLake folder parity), PK /workspaceId. */
export async function workspaceFoldersContainer(): Promise<Container> { await ensure(); return _workspaceFolders!; }
// (embedCodesContainer + orgVisualsContainer + taskFlowsContainer +
//  azureConnectionsContainer accessors live further down — they were declared
//  by parallel feature branches and are reused as-is.)

// Wave 4 — Data Marketplace / Governance accessors.
export async function dataProductsContainer(): Promise<Container> { await ensure(); return _dataProducts!; }
export async function dataProductJobsContainer(): Promise<Container> { await ensure(); return _dataProductJobs!; }
export async function accessRequestsContainer(): Promise<Container> { await ensure(); return _accessRequests!; }
export async function attributeGroupsContainer(): Promise<Container> { await ensure(); return _attributeGroups!; }
export async function okrsContainer(): Promise<Container> { await ensure(); return _okrs!; }
/** Status of a scorecard goal — mirrors Fabric/Power BI scorecard status bands. */
export type ScorecardGoalStatus =
  | 'notStarted' | 'onTrack' | 'atRisk' | 'behindGoal' | 'aheadOfGoal' | 'completed';

/** Binding from a scorecard goal to a live DAX measure in a PBI/AAS model. */
export interface ScorecardConnectedMetric {
  workspaceId: string;
  datasetId: string;
  daxExpression: string;
  /** ISO timestamp of the last successful live pull. */
  lastRefreshed?: string;
  /** Last value pulled from the model. */
  lastValue?: number;
}

/** Extended per-goal metadata that the Fabric Scorecards REST surface lacks. */
export interface ScorecardGoalRecord {
  id: string;            // `${scorecardId}:${goalId}`
  scorecardId: string;   // partition key
  goalId: string;        // Fabric goal GUID or bundle OKR id
  status?: ScorecardGoalStatus;
  owner?: string;        // display name or email
  dueDate?: string;      // ISO date
  connectedMetric?: ScorecardConnectedMetric;
  subGoalIds?: string[];
  updatedAt: string;
  updatedBy: string;     // session OID
}

/** A single scorecard goal check-in (manual or metric-driven). */
export interface ScorecardCheckIn {
  id: string;            // UUID
  goalId: string;        // partition key
  scorecardId: string;
  value: number;
  status?: ScorecardGoalStatus;
  note?: string;
  checkInDate?: string;  // ISO date the value is for (defaults to today)
  source?: 'manual' | 'metric';
  recordedAt: string;    // ISO timestamp, server-side
  recordedBy: string;    // session OID
}

export async function scorecardGoalsContainer(): Promise<Container> { await ensure(); return _scorecardGoals!; }
export async function scorecardCheckinsContainer(): Promise<Container> { await ensure(); return _scorecardCheckins!; }


export async function featurePermissionsContainer(): Promise<Container> { await ensure(); return _featurePermissions!; }
export async function lakehouseShortcutsContainer(): Promise<Container> { await ensure(); return _lakehouseShortcuts!; }
export async function lakehouseSchemasContainer(): Promise<Container> { await ensure(); return _lakehouseSchemas!; }
export async function networkingConfigContainer(): Promise<Container> { await ensure(); return _networkingConfig!; }

export async function marketplaceListingsContainer(): Promise<Container> {
  await ensure();
  return _marketplaceListings!;
}

export async function workspacesContainer(): Promise<Container> {
  await ensure();
  return _workspaces!;
}

export async function itemsContainer(): Promise<Container> {
  await ensure();
  return _items!;
}

export async function copilotSessionsContainer(): Promise<Container> {
  await ensure();
  return _copilotSessions!;
}

/** Per-message Copilot feedback (thumbs up/down) — PK /sessionId, no TTL. */
export async function copilotFeedbackContainer(): Promise<Container> {
  await ensure();
  return _copilotFeedback!;
}

export async function appsCatalogContainer(): Promise<Container> { await ensure(); return _appsCatalog!; }
export async function workloadsCatalogContainer(): Promise<Container> { await ensure(); return _workloadsCatalog!; }
export async function userPrefsContainer(): Promise<Container> { await ensure(); return _userPrefs!; }
export async function tabsStateContainer(): Promise<Container> { await ensure(); return _tabsState!; }
export async function notificationsContainer(): Promise<Container> { await ensure(); return _notifications!; }
export async function auditLogContainer(): Promise<Container> { await ensure(); return _auditLog!; }
export async function commentsContainer(): Promise<Container> { await ensure(); return _comments!; }
export async function sharesContainer(): Promise<Container> { await ensure(); return _shares!; }
export async function foldersContainer(): Promise<Container> { await ensure(); return _folders!; }
export async function downloadsContainer(): Promise<Container> { await ensure(); return _downloads!; }
export async function searchHistoryContainer(): Promise<Container> { await ensure(); return _searchHistory!; }
export async function workspacePermissionsContainer(): Promise<Container> { await ensure(); return _wsPermissions!; }
export async function workspaceGitContainer(): Promise<Container> { await ensure(); return _wsGit!; }
export async function tenantThemesContainer(): Promise<Container> { await ensure(); return _tenantThemes!; }
export async function tenantSettingsContainer(): Promise<Container> { await ensure(); return _tenantSettings!; }

// ============================================================
// Throughput administration — RU/s scale-by-SKU
// ============================================================

export interface ContainerThroughputInfo {
  id: string;
  partitionKey?: string;
  mode: 'manual' | 'autoscale' | 'serverless' | 'unknown';
  ru?: number;          // manual RU/s
  maxRu?: number;       // autoscale max RU/s
  minRu?: number;       // ARM-reported minimum (cannot go below)
}

const KNOWN_CONTAINER_IDS = [
  'workspaces', 'items', 'copilot-sessions', 'copilot-feedback',
  'apps-catalog', 'workloads-catalog', 'user-prefs',
  'tabs-state', 'notifications', 'audit-log', 'comments',
  'shares', 'folders', 'downloads', 'search-history',
  'workspace-permissions', 'workspace-git',
  'tenant-themes', 'tenant-settings', 'marketplace-listings',
  'feature-permissions', 'lakehouse-shortcuts', 'lakehouse-schemas', 'thread-edges', 'connections',
  'maintenance-jobs', 'dataproduct-import-jobs', 'app-install-jobs',
  'label-propagation',
  'posture-aggregates', 'recommended-actions',
  'posture-aggregates-admin', 'recommended-actions-admin',
  'onelake-security-roles',
  'item-permissions', 'workspace-roles', 'governance-domains', 'label-assignments',
  'dataproducts', 'dataproduct-jobs', 'access-requests',
  'attribute-groups', 'okrs',
  'scorecard-goals', 'scorecard-checkins',
  'access-request-workflow',
  'saved-queries',
  // Foundation admin containers (shared cloud-endpoints resolver task).
  'loom-workspaces', 'workspace-folders',
  'pbi-dashboard-overlays',
  'loom-pipelines', 'pipeline-stage-rules', 'pipeline-history',
  'scorecard-config',
  'azure-connections',
  'task-flows',
  'workspace-spark-config',
  'embed-codes', 'org-visuals',
  'coe-templates',
  'env-config',
  'metastore-registrations',
  'rate-limits',
];

/** List all Loom containers with their current throughput shape.
 *
 * BOUNDED: previously this looped over all ~60 KNOWN_CONTAINER_IDS serially,
 * issuing TWO Cosmos round-trips each (read + readOffer) = ~120 sequential
 * calls. On a cold console or an RBAC-throttled account that blew past the
 * route deadline ("Timed out"). Now each container is probed with bounded
 * concurrency and a per-call abort timeout, so a slow/hanging container can't
 * stall the whole list and the route returns promptly. Tunables:
 *   LOOM_COSMOS_SCALING_CONCURRENCY (default 12)
 *   LOOM_COSMOS_SCALING_PROBE_MS    (default 4000, per-container deadline)
 */
export async function listContainerThroughput(): Promise<ContainerThroughputInfo[]> {
  await ensure();
  const concurrency = Math.max(1, Number(process.env.LOOM_COSMOS_SCALING_CONCURRENCY) || 12);
  const probeMs = Math.max(500, Number(process.env.LOOM_COSMOS_SCALING_PROBE_MS) || 4000);
  // Overall wall-clock budget: once exceeded, workers stop pulling new ids and
  // we return what we have so the BFF route never hangs past its own ceiling.
  const totalMs = Math.max(2000, Number(process.env.LOOM_COSMOS_SCALING_TOTAL_MS) || 15000);
  const deadline = Date.now() + totalMs;

  const probe = async (id: string): Promise<ContainerThroughputInfo | null> => {
    // One AbortController per container so a per-call timeout actually cancels
    // the in-flight Cosmos request rather than leaking a dangling promise.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), probeMs);
    try {
      const c = _db!.container(id);
      const def = await c.read({ abortSignal: ac.signal });
      const partitionKey = (def?.resource?.partitionKey?.paths || [])[0];
      let info: ContainerThroughputInfo = { id, partitionKey, mode: 'unknown' };
      try {
        const off = await c.readOffer({ abortSignal: ac.signal });
        if (off?.resource) {
          const r: any = off.resource;
          const autoMax = r?.content?.offerAutopilotSettings?.maxThroughput;
          if (autoMax) {
            info = { ...info, mode: 'autoscale', maxRu: autoMax, minRu: r?.content?.offerMinimumThroughputParameters?.maxThroughputEverProvisioned };
          } else if (r?.content?.offerThroughput) {
            info = { ...info, mode: 'manual', ru: r.content.offerThroughput };
          }
        } else {
          info.mode = 'serverless';
        }
      } catch {
        // Serverless accounts (and database-shared-throughput containers)
        // return 404/no-offer on readOffer.
        info.mode = 'serverless';
      }
      return info;
    } catch {
      // Container doesn't exist in this account, or the read timed out/aborted.
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // Bounded-concurrency pool over the known container ids (parallel, not serial).
  const out: ContainerThroughputInfo[] = [];
  let next = 0;
  const worker = async () => {
    while (next < KNOWN_CONTAINER_IDS.length && Date.now() < deadline) {
      const i = next++;
      const info = await probe(KNOWN_CONTAINER_IDS[i]);
      if (info) out.push(info);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, KNOWN_CONTAINER_IDS.length) }, worker));
  // Stable order (parallelism scrambles completion order).
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Update RU/s for one Loom container. Pass either { ru: <manual> } or
 * { maxRu: <autoscale-max> }. Throws on serverless accounts (those have
 * no throughput dial).
 */
export async function updateContainerThroughput(
  containerId: string,
  opts: { ru?: number; maxRu?: number },
): Promise<ContainerThroughputInfo> {
  if (!KNOWN_CONTAINER_IDS.includes(containerId)) {
    throw new Error(`updateContainerThroughput: unknown container ${containerId}`);
  }
  if (!opts.ru && !opts.maxRu) {
    throw new Error('updateContainerThroughput: pass ru (manual) or maxRu (autoscale)');
  }
  await ensure();
  const c = _db!.container(containerId);
  let off;
  try {
    off = await c.readOffer();
  } catch (e: any) {
    throw new Error(`Cannot read offer for ${containerId} — likely a serverless account (${e?.message || e})`);
  }
  if (!off?.resource) throw new Error(`No throughput offer on ${containerId} (serverless?)`);
  const r: any = off.resource;
  if (opts.maxRu) {
    // Switch to / update autoscale
    r.content = r.content || {};
    r.content.offerAutopilotSettings = { maxThroughput: opts.maxRu };
    delete r.content.offerThroughput;
  } else if (opts.ru) {
    r.content = r.content || {};
    r.content.offerThroughput = opts.ru;
    delete r.content.offerAutopilotSettings;
  }
  await c.database.client.offer(r.id!).replace(r);
  const updated = await c.readOffer();
  const ur: any = updated?.resource;
  const autoMax = ur?.content?.offerAutopilotSettings?.maxThroughput;
  return {
    id: containerId,
    mode: autoMax ? 'autoscale' : 'manual',
    ru: ur?.content?.offerThroughput,
    maxRu: autoMax,
  };
}
