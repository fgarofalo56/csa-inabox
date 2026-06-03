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
import type { McpServerConfig, McpServerConfigDoc } from '../types/mcp-config';

const TTL_MS = 30_000;

interface CacheEntry<T> { value: T | null; at: number }
const _cache = new Map<string, CacheEntry<McpServerConfigDoc[]>>();

/**
 * List all enabled MCP servers for a tenant. Cached.
 */
export async function listMcpServers(tenantId: string): Promise<McpServerConfig[]> {
  if (!tenantId) return [];
  const hit = _cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return (hit.value || []).map((doc) => stripDoc(doc));
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
    return value.map((doc) => stripDoc(doc));
  } catch (e: any) {
    _cache.set(tenantId, { value: null, at: Date.now() });
    return [];
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
