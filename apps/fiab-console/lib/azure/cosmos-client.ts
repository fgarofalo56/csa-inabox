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
let _ensured = false;

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

function endpoint(): string {
  const v = process.env.LOOM_COSMOS_ENDPOINT;
  if (!v) throw new Error('LOOM_COSMOS_ENDPOINT not set');
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
  return new ChainedTokenCredential(...chain);
}

function client(): CosmosClient {
  if (_client) return _client;
  _client = new CosmosClient({ endpoint: endpoint(), aadCredentials: credential() });
  return _client;
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
  _ensured = true;
}

export async function copilotConfigContainer(): Promise<Container> { await ensure(); return _copilotConfig!; }
export async function workspaceAgentConfigContainer(): Promise<Container> { await ensure(); return _workspaceAgentConfig!; }
export async function mcpServersContainer(): Promise<Container> { await ensure(); return _mcpServers!; }
export async function threadEdgesContainer(): Promise<Container> { await ensure(); return _threadEdges!; }
export async function connectionsContainer(): Promise<Container> { await ensure(); return _connections!; }
export async function maintenanceJobsContainer(): Promise<Container> { await ensure(); return _maintenanceJobs!; }
export async function dataproductJobsContainer(): Promise<Container> { await ensure(); return _dataproductJobs!; }
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

// Wave 4 — Data Marketplace / Governance accessors.
export async function dataProductsContainer(): Promise<Container> { await ensure(); return _dataProducts!; }
export async function dataProductJobsContainer(): Promise<Container> { await ensure(); return _dataProductJobs!; }
export async function accessRequestsContainer(): Promise<Container> { await ensure(); return _accessRequests!; }
export async function attributeGroupsContainer(): Promise<Container> { await ensure(); return _attributeGroups!; }
export async function okrsContainer(): Promise<Container> { await ensure(); return _okrs!; }


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
  'maintenance-jobs', 'dataproduct-import-jobs',
  'label-propagation',
  'posture-aggregates', 'recommended-actions',
  'posture-aggregates-admin', 'recommended-actions-admin',
  'onelake-security-roles',
  'item-permissions', 'workspace-roles', 'governance-domains', 'label-assignments',
  'dataproducts', 'dataproduct-jobs', 'access-requests',
  'attribute-groups', 'okrs',
  'access-request-workflow',
  'saved-queries',
  'loom-pipelines', 'pipeline-stage-rules', 'pipeline-history',
  'scorecard-config',
];

/** List all Loom containers with their current throughput shape. */
export async function listContainerThroughput(): Promise<ContainerThroughputInfo[]> {
  await ensure();
  const out: ContainerThroughputInfo[] = [];
  for (const id of KNOWN_CONTAINER_IDS) {
    try {
      const c = _db!.container(id);
      const def = await c.read();
      const partitionKey = (def?.resource?.partitionKey?.paths || [])[0];
      let info: ContainerThroughputInfo = { id, partitionKey, mode: 'unknown' };
      try {
        const off = await c.readOffer();
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
        // Serverless accounts return 404 on readOffer.
        info.mode = 'serverless';
      }
      out.push(info);
    } catch {
      // skip containers that don't exist in this account
    }
  }
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
