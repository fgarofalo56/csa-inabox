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
let _copilotConfig: Container | null = null;
let _workspaceAgentConfig: Container | null = null;
let _mcpServers: Container | null = null;
let _threadEdges: Container | null = null;
let _connections: Container | null = null;
let _maintenanceJobs: Container | null = null;
let _accessRequests: Container | null = null;
let _ensured = false;

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
  });
  _copilotSessions = cs;

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
  // Data-product access requests (F15) — one row per consumer "Request access"
  // submission, bound to a permitted purpose from the owner's Access policy.
  // Partitioned by the data product id so the approver inbox (T14) lookup
  // (WHERE c.dataProductId = @id AND c.status = 'pending') hits a single
  // physical partition. Created lazily so a fresh environment needs no extra
  // ARM/Bicep step beyond the account+database.
  _accessRequests = await mk('access-requests', '/dataProductId');
  _ensured = true;
}

export async function copilotConfigContainer(): Promise<Container> { await ensure(); return _copilotConfig!; }
export async function workspaceAgentConfigContainer(): Promise<Container> { await ensure(); return _workspaceAgentConfig!; }
export async function mcpServersContainer(): Promise<Container> { await ensure(); return _mcpServers!; }
export async function threadEdgesContainer(): Promise<Container> { await ensure(); return _threadEdges!; }
export async function connectionsContainer(): Promise<Container> { await ensure(); return _connections!; }
export async function maintenanceJobsContainer(): Promise<Container> { await ensure(); return _maintenanceJobs!; }
export async function accessRequestsContainer(): Promise<Container> { await ensure(); return _accessRequests!; }

export async function featurePermissionsContainer(): Promise<Container> { await ensure(); return _featurePermissions!; }
export async function lakehouseShortcutsContainer(): Promise<Container> { await ensure(); return _lakehouseShortcuts!; }
export async function lakehouseSchemasContainer(): Promise<Container> { await ensure(); return _lakehouseSchemas!; }

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
  'workspaces', 'items', 'copilot-sessions',
  'apps-catalog', 'workloads-catalog', 'user-prefs',
  'tabs-state', 'notifications', 'audit-log', 'comments',
  'shares', 'folders', 'downloads', 'search-history',
  'workspace-permissions', 'workspace-git',
  'tenant-themes', 'tenant-settings', 'marketplace-listings',
  'feature-permissions', 'lakehouse-shortcuts', 'lakehouse-schemas', 'thread-edges', 'connections',
  'maintenance-jobs', 'access-requests',
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
