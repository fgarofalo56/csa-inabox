/**
 * Server-side reader/writer for tenant-wide + workspace Copilot & Agents config.
 *
 * The Copilot, Help-agent and Data-agent backends call `loadTenantCopilotConfig()`
 * / `loadWorkspaceAgentConfig()` to resolve the admin-/owner-selected Foundry
 * account, model deployments and project endpoint — falling back to the existing
 * env vars when no doc exists. This is the bridge that makes the UI pickers the
 * single source of truth without ripping out env-var support.
 *
 * Reads are cached per-tenant for a short TTL so the hot chat path doesn't hit
 * Cosmos on every turn; writes bust the cache for that tenant/workspace.
 */
import {
  copilotConfigContainer,
  workspaceAgentConfigContainer,
} from './cosmos-client';
import type {
  TenantCopilotConfig,
  TenantCopilotConfigDoc,
  WorkspaceAgentConfig,
  WorkspaceAgentConfigDoc,
} from '../types/copilot-config';

const TTL_MS = 30_000;

interface CacheEntry<T> { value: T | null; at: number }
const _tenantCache = new Map<string, CacheEntry<TenantCopilotConfig>>();
const _wsCache = new Map<string, CacheEntry<WorkspaceAgentConfig>>();

/** Read the tenant-wide config doc (null when none saved). Cached. */
export async function loadTenantCopilotConfig(tenantId: string): Promise<TenantCopilotConfig | null> {
  if (!tenantId) return null;
  const hit = _tenantCache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const c = await copilotConfigContainer();
    const { resource } = await c.item(tenantId, tenantId).read<TenantCopilotConfigDoc>();
    const value = resource ? stripTenantDoc(resource) : null;
    _tenantCache.set(tenantId, { value, at: Date.now() });
    return value;
  } catch (e: any) {
    if (e?.code === 404) {
      _tenantCache.set(tenantId, { value: null, at: Date.now() });
      return null;
    }
    // Don't let a Cosmos blip break the chat path — treat as "no config".
    return null;
  }
}

export async function saveTenantCopilotConfig(
  tenantId: string,
  who: string,
  patch: TenantCopilotConfig,
): Promise<TenantCopilotConfigDoc> {
  const c = await copilotConfigContainer();
  let current: TenantCopilotConfigDoc | null = null;
  try {
    const { resource } = await c.item(tenantId, tenantId).read<TenantCopilotConfigDoc>();
    current = resource ?? null;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  const doc: TenantCopilotConfigDoc = {
    ...(current || { id: tenantId, tenantId }),
    ...patch,
    id: tenantId,
    tenantId,
    updatedAt: new Date().toISOString(),
    updatedBy: who,
  };
  await c.items.upsert(doc);
  _tenantCache.delete(tenantId);
  return doc;
}

function stripTenantDoc(d: TenantCopilotConfigDoc): TenantCopilotConfig {
  const { id: _id, tenantId: _t, updatedAt: _u, updatedBy: _b, ...rest } = d;
  return rest;
}

/** Read a workspace data-agent config doc (null when none saved). Cached. */
export async function loadWorkspaceAgentConfig(workspaceId: string): Promise<WorkspaceAgentConfig | null> {
  if (!workspaceId) return null;
  const hit = _wsCache.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const c = await workspaceAgentConfigContainer();
    const { resource } = await c.item(workspaceId, workspaceId).read<WorkspaceAgentConfigDoc>();
    const value = resource ? stripWsDoc(resource) : null;
    _wsCache.set(workspaceId, { value, at: Date.now() });
    return value;
  } catch (e: any) {
    if (e?.code === 404) {
      _wsCache.set(workspaceId, { value: null, at: Date.now() });
      return null;
    }
    return null;
  }
}

export async function saveWorkspaceAgentConfig(
  workspaceId: string,
  tenantId: string,
  who: string,
  patch: WorkspaceAgentConfig,
): Promise<WorkspaceAgentConfigDoc> {
  const c = await workspaceAgentConfigContainer();
  let current: WorkspaceAgentConfigDoc | null = null;
  try {
    const { resource } = await c.item(workspaceId, workspaceId).read<WorkspaceAgentConfigDoc>();
    current = resource ?? null;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  const doc: WorkspaceAgentConfigDoc = {
    ...(current || { id: workspaceId, workspaceId, tenantId }),
    ...patch,
    id: workspaceId,
    workspaceId,
    tenantId,
    updatedAt: new Date().toISOString(),
    updatedBy: who,
  };
  await c.items.upsert(doc);
  _wsCache.delete(workspaceId);
  return doc;
}

function stripWsDoc(d: WorkspaceAgentConfigDoc): WorkspaceAgentConfig {
  const { id: _id, workspaceId: _w, tenantId: _t, updatedAt: _u, updatedBy: _b, ...rest } = d;
  return rest;
}

/**
 * Resolve the Foundry Agent Service project endpoint/GUID for a workspace's
 * data agents. Resolution order: workspace config → tenant default → env.
 * Returns `undefined` fields where nothing is set so foundry-agent-client can
 * fall back to env and raise the honest not-configured gate when nothing
 * resolves at all.
 *
 * `defaultAgent` is the workspace's preferred published agent (or undefined).
 */
export async function resolveWorkspaceFoundry(
  workspaceId: string,
  tenantId: string,
): Promise<{ projectEndpoint?: string; projectId?: string; defaultAgent?: string }> {
  const [ws, tenant] = await Promise.all([
    loadWorkspaceAgentConfig(workspaceId),
    loadTenantCopilotConfig(tenantId),
  ]);
  return {
    projectEndpoint: ws?.foundryProjectEndpoint || tenant?.foundryProjectEndpoint || undefined,
    projectId: ws?.foundryProjectId || tenant?.foundryProjectId || undefined,
    defaultAgent: ws?.defaultAgent || undefined,
  };
}
