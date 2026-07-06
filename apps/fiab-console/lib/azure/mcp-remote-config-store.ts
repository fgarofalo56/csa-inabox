/**
 * Server-side reader/writer for per-tenant INLINE config overrides of the remote
 * built-in MCP family (lib/mcp/catalog.ts REMOTE_BUILTIN_MCP_CATALOG).
 *
 * WHY THIS EXISTS
 * ---------------
 * A remote built-in descriptor's `configured()` gate reads ONLY process.env, so a
 * server is otherwise only enable-able by wiring a deployment env var + redeploy.
 * This store lets a tenant admin enable + configure each opt-in server INLINE from
 * /admin/mcp-servers — the enable toggle, the endpoint (for the not-yet-GA
 * servers), and the GitHub Key Vault secret NAME — persisted to Cosmos and merged
 * with the env by `effectiveRemoteState()` (catalog.ts). The merge is env-first +
 * additive: a deployment env force-on always wins; overrides only add capability
 * when the env left a server off (see the catalog block comment).
 *
 * STORAGE
 * -------
 * One doc per tenant in the existing `mcp-servers` Cosmos container (PK /tenantId,
 * so no new container / bicep change). The doc carries `type:'remote-builtin-config'`
 * and NO `enabled` / `source` field, so it never collides with the server-list
 * query (`WHERE enabled=true`) or the remote-builtin registered-row query
 * (`WHERE source='remote-builtin'`). Reads use a tenant-scoped query (never a
 * point-read keyed by the wrong PK); writes use upsert (PK derived from the doc).
 *
 * SECRETS: only NON-secret values live here — the enable flag, the endpoint, and
 * the Key Vault secret NAME (never a PAT / token value), mirroring the invariant
 * the McpServerConfig doc already holds.
 */

import { mcpServersContainer } from './cosmos-client';
import {
  msRemoteMcp,
  effectiveRemoteState,
  type RemoteBuiltinOverride,
  type EffectiveRemoteState,
} from '../mcp/catalog';

/** Fixed doc id (unique per /tenantId partition). */
const DOC_ID = 'remote-builtin-config';
const DOC_TYPE = 'remote-builtin-config';
const TTL_MS = 30_000;

/** Persisted per-tenant overrides doc (Cosmos). */
interface RemoteBuiltinConfigDoc {
  id: string;
  tenantId: string;
  type: typeof DOC_TYPE;
  /** catalogId → override. Absent keys ⇒ pure env behaviour for that server. */
  overrides: Record<string, RemoteBuiltinOverride>;
  updatedAt: string;
  updatedBy: string;
}

interface CacheEntry {
  value: Record<string, RemoteBuiltinOverride>;
  at: number;
}
const _cache = new Map<string, CacheEntry>();

/** Drop empty members so a cleared override reverts a server to pure-env behaviour. */
function cleanOverride(o: RemoteBuiltinOverride): RemoteBuiltinOverride | undefined {
  const out: RemoteBuiltinOverride = {};
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
  const ep = o.endpoint?.trim();
  if (ep) out.endpoint = ep;
  const sn = o.secretName?.trim();
  if (sn) out.secretName = sn;
  return Object.keys(out).length ? out : undefined;
}

/**
 * All remote built-in overrides for a tenant (catalogId → override). Cached for a
 * short TTL. Returns {} on any Cosmos error so callers fall back to pure-env
 * behaviour — this store must NEVER break tool discovery or login.
 */
export async function getRemoteBuiltinOverrides(
  tenantId: string,
): Promise<Record<string, RemoteBuiltinOverride>> {
  if (!tenantId) return {};
  const hit = _cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const c = await mcpServersContainer();
    const { resources } = await c.items
      .query<RemoteBuiltinConfigDoc>({
        query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.type = @ty',
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@ty', value: DOC_TYPE },
        ],
      })
      .fetchAll();
    const value = (resources?.[0]?.overrides as Record<string, RemoteBuiltinOverride>) || {};
    _cache.set(tenantId, { value, at: Date.now() });
    return value;
  } catch {
    _cache.set(tenantId, { value: {}, at: Date.now() });
    return {};
  }
}

/** One server's override (undefined ⇒ pure-env). */
export async function getRemoteBuiltinOverride(
  tenantId: string,
  catalogId: string,
): Promise<RemoteBuiltinOverride | undefined> {
  const all = await getRemoteBuiltinOverrides(tenantId);
  return all[catalogId];
}

/**
 * Merge a patch into one server's override and persist. Passing an override that
 * cleans to empty REMOVES it (server reverts to pure-env). Throws for an unknown
 * catalogId so the caller can 400. Returns the saved override (or undefined when
 * removed).
 */
export async function setRemoteBuiltinOverride(
  tenantId: string,
  who: string,
  catalogId: string,
  patch: RemoteBuiltinOverride,
): Promise<RemoteBuiltinOverride | undefined> {
  if (!msRemoteMcp(catalogId)) {
    throw new Error(`unknown remote MCP server: ${catalogId}`);
  }
  const c = await mcpServersContainer();
  const now = new Date().toISOString();
  // Read the current doc (tenant-scoped query — PK-safe).
  const { resources } = await c.items
    .query<RemoteBuiltinConfigDoc>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.type = @ty',
      parameters: [
        { name: '@t', value: tenantId },
        { name: '@ty', value: DOC_TYPE },
      ],
    })
    .fetchAll();
  const doc: RemoteBuiltinConfigDoc = resources?.[0] ?? {
    id: DOC_ID,
    tenantId,
    type: DOC_TYPE,
    overrides: {},
    updatedAt: now,
    updatedBy: who,
  };
  const merged = cleanOverride({ ...(doc.overrides[catalogId] ?? {}), ...patch });
  if (merged) doc.overrides[catalogId] = merged;
  else delete doc.overrides[catalogId];
  doc.updatedAt = now;
  doc.updatedBy = who;
  await c.items.upsert(doc);
  _cache.delete(tenantId);
  return merged;
}

/**
 * The effective state of one server for a tenant (env + persisted override).
 * Convenience wrapper used by the ms-remote route.
 */
export async function effectiveRemoteStateForTenant(
  tenantId: string,
  catalogId: string,
): Promise<EffectiveRemoteState | undefined> {
  const entry = msRemoteMcp(catalogId);
  if (!entry) return undefined;
  const ov = await getRemoteBuiltinOverride(tenantId, catalogId);
  return effectiveRemoteState(entry, ov);
}

/** Bust the per-tenant cache (call after any external mutation). */
export function invalidateRemoteBuiltinOverrides(tenantId: string): void {
  _cache.delete(tenantId);
}
