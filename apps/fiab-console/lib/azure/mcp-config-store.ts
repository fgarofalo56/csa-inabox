/**
 * Server-side reader/writer for tenant-wide MCP server connections.
 *
 * The Copilot orchestrator calls `listMcpServers()` at orchestrate time to fetch
 * all enabled MCP servers for this tenant, then calls `buildMcpShim()` to register
 * their tools as Loom tools.
 *
 * Reads are cached per-tenant for a short TTL; writes bust the cache.
 */

import { mcpServersContainer } from './cosmos-client';
import { defaultOnRemoteMcps, msRemoteMcp, type RemoteBuiltinMcpEntry } from '../mcp/catalog';
import type { McpServerConfig, McpServerConfigDoc } from '../types/mcp-config';

const TTL_MS = 30_000;

interface CacheEntry<T> { value: T | null; at: number }
const _cache = new Map<string, CacheEntry<McpServerConfigDoc[]>>();

/**
 * Project a generalized remote built-in MCP descriptor (lib/mcp/catalog.ts) onto
 * the persisted `McpServerConfig` shape, so a synthetic (un-persisted) default-on
 * server flows through `buildMcpShim` exactly like a registered row.
 *
 * `catalogId` is set to the descriptor id so `mcpToolPrefixSlug` (mcp-shim.ts)
 * derives the stable `mcp_<slug>_<tool>` prefix from it (e.g. 'ms-learn' →
 * `mcp_mslearn_*`) — the same single-source-of-truth naming the Power BI row uses.
 * Auth maps straight across: 'none' (Microsoft Learn — no Authorization header),
 * 'entra-obo' (per-user delegated token, keyed by `oboResourceKey` = the descriptor
 * id), or 'key-vault' (a stored PAT secret NAME, never a literal — GitHub).
 */
function remoteBuiltinToConfig(e: RemoteBuiltinMcpEntry): McpServerConfig {
  const cfg: McpServerConfig = {
    name: e.name,
    endpoint: e.endpoint,
    authMethod: e.auth, // 'none' | 'entra-obo' | 'key-vault' — all valid McpServerConfig authMethods
    enabled: true,
    source: 'remote-builtin',
    catalogId: e.id,
    description: e.desc,
  };
  if (e.auth === 'entra-obo') {
    cfg.oboResource = e.oboResource || undefined; // '' (per-org, e.g. Dataverse) → derived from endpoint at OBO time
    cfg.oboScopes = e.oboScopes;
    cfg.oboResourceKey = e.id; // per-resource per-user token lookup key (no secret)
  } else if (e.auth === 'key-vault' && e.secretRefEnv) {
    // Key Vault secret NAME (never the value) lives in the env var the descriptor names.
    const secretName = process.env[e.secretRefEnv]?.trim();
    if (secretName) cfg.authValue = secretName;
  }
  return cfg;
}

/**
 * Apply the remote built-in MCP policy to a tenant's persisted server list:
 *
 *  1. **Drop opted-out remote-builtin rows.** A `source: 'remote-builtin'` row
 *     whose descriptor `configured()` is now false (its enable-env toggle was
 *     cleared, the shared OBO client / endpoint went away, or a PAT secret name
 *     was removed) must NEVER be advertised — otherwise `buildMcpShim` would try
 *     to reach an opted-out Microsoft server. Rows with no matching descriptor
 *     (manually-registered remote endpoints we don't model) are kept as-is.
 *  2. **Fold in the default-on synthetic rows.** The single source of the
 *     "Microsoft Learn is live day-one with zero config" behavior
 *     (no-fabric-dependency: Learn is the SOLE default-on server — public,
 *     no-auth, no Fabric/Power BI dependency). `defaultOnRemoteMcps()` already
 *     filters on `defaultOn && configured()`, so Learn drops out automatically
 *     when `LOOM_MS_LEARN_MCP_ENABLED=false`. We only append a synthetic row when
 *     the same descriptor id isn't already persisted (admin-registered) — no
 *     duplicate. Consumed by `buildMcpShim` (tool discovery) + the admin panel.
 */
function decorateMcpServers(persisted: McpServerConfig[]): McpServerConfig[] {
  const kept = persisted.filter((srv) => {
    if (srv.source !== 'remote-builtin' || !srv.catalogId) return true;
    const d = msRemoteMcp(srv.catalogId);
    return d ? d.configured() : true;
  });
  const present = new Set(
    kept.filter((s) => s.source === 'remote-builtin' && s.catalogId).map((s) => s.catalogId),
  );
  const synthetic = defaultOnRemoteMcps()
    .filter((e) => !present.has(e.id))
    .map(remoteBuiltinToConfig);
  return synthetic.length ? [...kept, ...synthetic] : kept;
}

/**
 * List all enabled MCP servers for a tenant. Cached.
 *
 * The persisted Cosmos rows are decorated via `decorateMcpServers()` on every
 * call (including cache hits and the Cosmos-error fallback) so the env-driven
 * remote built-in policy — drop opted-out Microsoft servers, inject the default-on
 * Microsoft Learn row — is always evaluated live, never frozen into the cache.
 */
export async function listMcpServers(tenantId: string): Promise<McpServerConfig[]> {
  if (!tenantId) return [];
  const hit = _cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return decorateMcpServers((hit.value || []).map((doc) => stripDoc(doc)));
  }
  try {
    const c = await mcpServersContainer();
    const q = {
      query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.enabled = true ORDER BY c.name',
      parameters: [{ name: '@t', value: tenantId }],
    };
    const { resources } = await c.items.query<McpServerConfigDoc>(q).fetchAll();
    const value = resources || [];
    _cache.set(tenantId, { value, at: Date.now() });
    return decorateMcpServers(value.map((doc) => stripDoc(doc)));
  } catch (e: any) {
    _cache.set(tenantId, { value: null, at: Date.now() });
    // Cosmos unreachable: still advertise the default-on Microsoft Learn row so its
    // tools are live day-one even before any persisted MCP config exists.
    return decorateMcpServers([]);
  }
}

/**
 * Get a single MCP server config by ID.
 */
export async function getMcpServer(tenantId: string, serverId: string): Promise<McpServerConfigDoc | null> {
  try {
    const c = await mcpServersContainer();
    const { resource } = await c.item(serverId, serverId).read<McpServerConfigDoc>();
    // Verify tenantId matches
    if (resource && resource.tenantId === tenantId) return resource;
    return null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/**
 * Create or update an MCP server config.
 */
export async function saveMcpServer(
  tenantId: string,
  serverId: string | undefined,
  who: string,
  config: McpServerConfig,
): Promise<McpServerConfigDoc> {
  const c = await mcpServersContainer();
  const id = serverId || `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  let existing: McpServerConfigDoc | null = null;
  try {
    const { resource } = await c.item(id, id).read<McpServerConfigDoc>();
    existing = resource ?? null;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  const doc: McpServerConfigDoc = {
    ...config,
    id,
    serverId: id,
    tenantId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    updatedBy: who,
    lastTestResult: existing?.lastTestResult,
  };
  await c.items.upsert(doc);
  _cache.delete(tenantId);
  return doc;
}

/**
 * Delete an MCP server config by ID.
 */
export async function deleteMcpServer(tenantId: string, serverId: string): Promise<void> {
  try {
    const c = await mcpServersContainer();
    const doc = await getMcpServer(tenantId, serverId);
    if (doc) {
      await c.item(serverId, serverId).delete();
      _cache.delete(tenantId);
    }
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}

/**
 * Update the last test result for an MCP server.
 */
export async function updateMcpServerTestResult(
  tenantId: string,
  serverId: string,
  result: { toolCount: number } | { error: string },
): Promise<void> {
  const doc = await getMcpServer(tenantId, serverId);
  if (!doc) return;
  const now = new Date().toISOString();
  if ('error' in result) {
    doc.lastTestResult = { at: now, toolCount: 0, error: result.error };
  } else {
    doc.lastTestResult = { at: now, ...result };
  }
  const c = await mcpServersContainer();
  await c.item(serverId, serverId).replace(doc);
  _cache.delete(tenantId);
}

function stripDoc(d: McpServerConfigDoc): McpServerConfig {
  const { id: _i, serverId: _s, tenantId: _t, createdAt: _c, updatedAt: _u, updatedBy: _b, lastTestResult: _l, ...rest } = d;
  return rest;
}
