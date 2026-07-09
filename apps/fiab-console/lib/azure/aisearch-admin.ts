/**
 * Azure AI Search SERVICE-ADMINISTRATION client (AIF-17).
 *
 * A NEW sibling to `aisearch-client.ts` (which owns scale + debug sessions) so
 * the existing module is not restructured. This module covers the in-editor
 * "Service" tab: API keys, identity, networking (public access + PE), semantic-
 * ranker tier, service statistics, and Azure Monitor QPS/latency/throttling
 * metrics — all real ARM / management REST + the data-plane servicestats call.
 *
 * Auth: ChainedTokenCredential(ACA MSI → UAMI → DefaultAzureCredential); the
 * UAMI needs "Search Service Contributor" on the service to list/regenerate
 * keys and PATCH networking/semantic, and "Monitoring Reader" (or Reader) for
 * Monitor metrics. Config comes from `readSearchConfig()` (LOOM_AI_SEARCH_SUB /
 * _RG / _SERVICE) — the same honest gate as debug sessions.
 *
 * Grounded in Microsoft Learn:
 *   - API keys: https://learn.microsoft.com/azure/search/search-security-api-keys
 *   - Networking (publicNetworkAccess, IP rules, PE): https://learn.microsoft.com/azure/search/service-configure-firewall
 *   - Monitor metrics (SearchQueriesPerSecond / SearchLatency / ThrottledSearchQueriesPercentage):
 *     https://learn.microsoft.com/azure/search/monitor-azure-cognitive-search
 *
 * No mocks. Real ARM + Monitor REST only.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';
import { readSearchConfig, type SearchServiceConfig, SearchNotConfiguredError } from './aisearch-client';
import { getServiceStats } from './search-index-client';
import { fetchMetrics } from './monitor-client';

const ARM_SCOPE = armScope();
const ADMIN_API = '2024-03-01-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class SearchAdminError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `AI Search admin call failed (${status})`);
    this.name = 'SearchAdminError';
    this.status = status;
    this.body = body;
  }
}

export { SearchNotConfiguredError };

function serviceUrl(cfg: SearchServiceConfig): string {
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.Search/searchServices/${cfg.serviceName}`;
}

async function callArm(url: string, init?: RequestInit): Promise<Response> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new SearchAdminError(401, undefined, 'Failed to acquire ARM token');
  return fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${t.token}`,
      'content-type': 'application/json',
    },
  });
}

async function armJson(url: string, init?: RequestInit, ctx = 'ARM call'): Promise<any> {
  const r = await callArm(url, init);
  const text = await r.text();
  let body: any = text;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json') && text.trim()) { try { body = JSON.parse(text); } catch { /* keep text */ } }
  if (!r.ok && r.status !== 202) {
    const detail = body?.error?.message || (typeof body === 'string' ? body : JSON.stringify(body));
    throw new SearchAdminError(r.status, body, `${ctx} failed (${r.status}): ${String(detail).slice(0, 240)}`);
  }
  return r.status === 204 ? null : body;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export interface AdminKeys { primaryKey: string; secondaryKey: string; }
export interface QueryKey { name: string; key: string; }

/** POST …/listAdminKeys — the two admin (read-write) keys. */
export async function listAdminKeys(cfg?: SearchServiceConfig): Promise<AdminKeys> {
  const c = cfg || readSearchConfig();
  const j = await armJson(`${serviceUrl(c)}/listAdminKeys?api-version=${ADMIN_API}`, { method: 'POST' }, 'listAdminKeys');
  return { primaryKey: j?.primaryKey || '', secondaryKey: j?.secondaryKey || '' };
}

/** POST …/regenerateAdminKey/{primary|secondary} — rotate one admin key. */
export async function regenerateAdminKey(keyKind: 'primary' | 'secondary', cfg?: SearchServiceConfig): Promise<AdminKeys> {
  const c = cfg || readSearchConfig();
  if (keyKind !== 'primary' && keyKind !== 'secondary') throw new SearchAdminError(400, keyKind, "keyKind must be 'primary' or 'secondary'");
  const j = await armJson(`${serviceUrl(c)}/regenerateAdminKey/${keyKind}?api-version=${ADMIN_API}`, { method: 'POST' }, 'regenerateAdminKey');
  return { primaryKey: j?.primaryKey || '', secondaryKey: j?.secondaryKey || '' };
}

/** GET …/listQueryKeys — the read-only query keys. */
export async function listQueryKeys(cfg?: SearchServiceConfig): Promise<QueryKey[]> {
  const c = cfg || readSearchConfig();
  const j = await armJson(`${serviceUrl(c)}/listQueryKeys?api-version=${ADMIN_API}`, undefined, 'listQueryKeys');
  return (j?.value || []).map((k: any) => ({ name: k?.name || '', key: k?.key || '' }));
}

/** POST …/createQueryKey/{name} — mint a new named query key. */
export async function createQueryKey(name: string, cfg?: SearchServiceConfig): Promise<QueryKey> {
  const c = cfg || readSearchConfig();
  const nm = (name || '').trim();
  if (!nm) throw new SearchAdminError(400, name, 'query key name is required');
  const j = await armJson(`${serviceUrl(c)}/createQueryKey/${encodeURIComponent(nm)}?api-version=${ADMIN_API}`, { method: 'POST' }, 'createQueryKey');
  return { name: j?.name || nm, key: j?.key || '' };
}

/** DELETE …/deleteQueryKey/{key} — revoke a query key by its value. */
export async function deleteQueryKey(key: string, cfg?: SearchServiceConfig): Promise<void> {
  const c = cfg || readSearchConfig();
  if (!key) throw new SearchAdminError(400, key, 'query key value is required');
  await armJson(`${serviceUrl(c)}/deleteQueryKey/${encodeURIComponent(key)}?api-version=${ADMIN_API}`, { method: 'DELETE' }, 'deleteQueryKey');
}

// ---------------------------------------------------------------------------
// Service properties: identity, networking, semantic tier
// ---------------------------------------------------------------------------

export interface ServiceProperties {
  id: string;
  name: string;
  location: string;
  sku: string;
  replicaCount: number;
  partitionCount: number;
  provisioningState?: string;
  status?: string;
  // identity
  identityType?: string;
  principalId?: string;
  userAssignedIdentities?: string[];
  // networking
  publicNetworkAccess: 'enabled' | 'disabled';
  ipRules: string[];
  bypass?: string;
  privateEndpointCount: number;
  privateEndpoints: Array<{ name: string; status?: string }>;
  // auth
  authMode: 'apiKeyOnly' | 'aadOrApiKey' | 'aadOnly';
  aadFailureMode?: string;
  // semantic
  semanticSearch: 'disabled' | 'free' | 'standard';
  cmkEnforcement?: string;
}

/** Normalize a raw ARM search-service resource into editor-friendly properties. Exported for unit tests. */
export function shapeProps(raw: any): ServiceProperties {
  const p = raw?.properties || {};
  const identity = raw?.identity || {};
  const peConns = Array.isArray(p.privateEndpointConnections) ? p.privateEndpointConnections : [];
  const disableLocalAuth = !!p.disableLocalAuth;
  const authOptions = p.authOptions;
  let authMode: ServiceProperties['authMode'] = 'apiKeyOnly';
  if (disableLocalAuth) authMode = 'aadOnly';
  else if (authOptions?.aadOrApiKey) authMode = 'aadOrApiKey';
  return {
    id: raw?.id || '',
    name: raw?.name || '',
    location: raw?.location || '',
    sku: raw?.sku?.name || 'unknown',
    replicaCount: p.replicaCount ?? 1,
    partitionCount: p.partitionCount ?? 1,
    provisioningState: p.provisioningState,
    status: p.status,
    identityType: identity.type,
    principalId: identity.principalId,
    userAssignedIdentities: identity.userAssignedIdentities ? Object.keys(identity.userAssignedIdentities) : [],
    publicNetworkAccess: p.publicNetworkAccess === 'disabled' ? 'disabled' : 'enabled',
    ipRules: Array.isArray(p.networkRuleSet?.ipRules) ? p.networkRuleSet.ipRules.map((r: any) => r?.value).filter(Boolean) : [],
    bypass: p.networkRuleSet?.bypass,
    privateEndpointCount: peConns.length,
    privateEndpoints: peConns.map((c: any) => ({
      name: c?.name || c?.properties?.privateEndpoint?.id?.split('/').pop() || 'pe',
      status: c?.properties?.privateLinkServiceConnectionState?.status,
    })),
    authMode,
    aadFailureMode: authOptions?.aadOrApiKey?.aadAuthFailureMode,
    semanticSearch: p.semanticSearch === 'free' ? 'free' : p.semanticSearch === 'disabled' ? 'disabled' : 'standard',
    cmkEnforcement: p.encryptionWithCmk?.enforcement,
  };
}

/** GET the full service resource → normalized properties (identity/networking/semantic). */
export async function getServiceProperties(cfg?: SearchServiceConfig): Promise<ServiceProperties> {
  const c = cfg || readSearchConfig();
  const j = await armJson(`${serviceUrl(c)}?api-version=${ADMIN_API}`, undefined, 'getServiceProperties');
  return shapeProps(j);
}

/** PATCH properties.publicNetworkAccess ('enabled'|'disabled'). */
export async function setPublicNetworkAccess(enabled: boolean, cfg?: SearchServiceConfig): Promise<ServiceProperties> {
  const c = cfg || readSearchConfig();
  const body = { properties: { publicNetworkAccess: enabled ? 'enabled' : 'disabled' } };
  const j = await armJson(`${serviceUrl(c)}?api-version=${ADMIN_API}`, { method: 'PATCH', body: JSON.stringify(body) }, 'setPublicNetworkAccess');
  return shapeProps(j);
}

/** PATCH properties.semanticSearch tier ('disabled'|'free'|'standard'). */
export async function setSemanticTier(tier: 'disabled' | 'free' | 'standard', cfg?: SearchServiceConfig): Promise<ServiceProperties> {
  const c = cfg || readSearchConfig();
  if (!['disabled', 'free', 'standard'].includes(tier)) throw new SearchAdminError(400, tier, "tier must be 'disabled', 'free' or 'standard'");
  const body = { properties: { semanticSearch: tier } };
  const j = await armJson(`${serviceUrl(c)}?api-version=${ADMIN_API}`, { method: 'PATCH', body: JSON.stringify(body) }, 'setSemanticTier');
  return shapeProps(j);
}

// ---------------------------------------------------------------------------
// Replica / partition scaling (ARM PATCH properties.replicaCount/partitionCount)
//
// The SKU TIER is immutable once a Search service exists (basic→standard etc.
// requires a new service + re-index) — only replicas and partitions scale in
// place, so this in-editor Scale control deliberately adjusts ONLY those two.
// Replicas govern query throughput + HA; partitions govern index storage +
// indexing throughput. Azure validates the requested counts against the SKU
// server-side and returns a precise 400 we surface verbatim.
// https://learn.microsoft.com/azure/search/search-capacity-planning
// ---------------------------------------------------------------------------

export const REPLICA_MIN = 1;
export const REPLICA_MAX = 12;
/** Partition counts Azure AI Search accepts (billable search units = replicas × partitions). */
export const ALLOWED_PARTITIONS = [1, 2, 3, 4, 6, 12] as const;
export type PartitionCount = (typeof ALLOWED_PARTITIONS)[number];

export interface ScaleRequest { replicaCount?: number; partitionCount?: number; }

/**
 * Validate a replica/partition scale request against Azure's accepted ranges.
 * Pure — no I/O — so it is unit-tested and reused by the route + client. Does
 * NOT know the SKU's own ceilings (basic caps at 3×3); Azure enforces those and
 * returns a precise 400 that {@link scaleService} surfaces.
 */
export function validateScale(req: ScaleRequest): { ok: boolean; error?: string } {
  const { replicaCount, partitionCount } = req;
  if (replicaCount == null && partitionCount == null) {
    return { ok: false, error: 'Specify a new replica or partition count.' };
  }
  if (replicaCount != null) {
    if (!Number.isInteger(replicaCount) || replicaCount < REPLICA_MIN || replicaCount > REPLICA_MAX) {
      return { ok: false, error: `replicaCount must be an integer between ${REPLICA_MIN} and ${REPLICA_MAX}.` };
    }
  }
  if (partitionCount != null) {
    if (!(ALLOWED_PARTITIONS as readonly number[]).includes(partitionCount)) {
      return { ok: false, error: `partitionCount must be one of ${ALLOWED_PARTITIONS.join(', ')}.` };
    }
  }
  return { ok: true };
}

/**
 * PATCH replica/partition counts, then re-GET the normalized service props so
 * the editor reflects the new (often `provisioning`) state. The PATCH is
 * long-running: Azure accepts it (200/202) and rebalances asynchronously —
 * `provisioningState` reads `provisioning` until it completes.
 */
export async function scaleService(req: ScaleRequest, cfg?: SearchServiceConfig): Promise<ServiceProperties> {
  const v = validateScale(req);
  if (!v.ok) throw new SearchAdminError(400, req, v.error);
  const c = cfg || readSearchConfig();
  const properties: Record<string, number> = {};
  if (req.replicaCount != null) properties.replicaCount = req.replicaCount;
  if (req.partitionCount != null) properties.partitionCount = req.partitionCount;
  await armJson(`${serviceUrl(c)}?api-version=${ADMIN_API}`, { method: 'PATCH', body: JSON.stringify({ properties }) }, 'scaleService');
  return getServiceProperties(c);
}

// ---------------------------------------------------------------------------
// Monitor metrics + service statistics
// ---------------------------------------------------------------------------

export interface ServiceMetric { name: string; unit: string; points: Array<{ timeStamp: string; value: number | null }>; }

/**
 * QPS / latency / throttling time-series from Azure Monitor for the search
 * service. `timespan` is an ISO duration window ending now (default PT6H).
 */
export async function queryServiceMetrics(opts: { timespan?: string; interval?: string } = {}, cfg?: SearchServiceConfig): Promise<ServiceMetric[]> {
  const c = cfg || readSearchConfig();
  const resourceId = serviceUrl(c);
  const results = await fetchMetrics({
    resourceId,
    metricNames: ['SearchQueriesPerSecond', 'SearchLatency', 'ThrottledSearchQueriesPercentage'],
    aggregation: 'Average',
    timespan: opts.timespan || 'PT6H',
    interval: opts.interval || 'PT15M',
  });
  return results.map((r) => ({ name: r.name, unit: r.unit, points: r.points }));
}

/** Data-plane GET /servicestats — object counters + quotas. */
export async function getServiceStatistics(): Promise<any> {
  return getServiceStats();
}
