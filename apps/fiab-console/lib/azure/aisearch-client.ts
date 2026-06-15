/**
 * Azure AI Search ARM management-plane client.
 *
 * Targets Microsoft.Search/searchServices/{name} for SKU + replica +
 * partition scaling. Data-plane (index CRUD, document query) is owned
 * by lib/azure/loom-search.ts; this file ONLY does ARM scale ops.
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential). The UAMI
 * must hold "Search Service Contributor" at the search service scope
 * to PATCH SKU / replica / partition counts. Note: changing tier (e.g.
 * S1 → S2) requires that the new tier permits the current replica/
 * partition counts; Azure validates this server-side and returns 400
 * with a precise reason — we surface that verbatim.
 *
 * No mocks. Real ARM REST only.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';

const ARM_SCOPE = armScope();
const SEARCH_API = '2024-03-01-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class SearchArmError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `AI Search ARM call failed (${status})`);
    this.name = 'SearchArmError';
    this.status = status;
    this.body = body;
  }
}

export interface SearchServiceConfig {
  subscriptionId: string;
  resourceGroup: string;
  serviceName: string;
}

export class SearchNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`AI Search is not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'SearchNotConfiguredError';
  }
}

export function readSearchConfig(): SearchServiceConfig {
  const missing: string[] = [];
  const subscriptionId = process.env.LOOM_AI_SEARCH_SUB || process.env.LOOM_SUBSCRIPTION_ID || '';
  const resourceGroup = process.env.LOOM_AI_SEARCH_RG || process.env.LOOM_ADMIN_RG || '';
  const serviceName = process.env.LOOM_AI_SEARCH_SERVICE || '';
  if (!subscriptionId) missing.push('LOOM_AI_SEARCH_SUB (or LOOM_SUBSCRIPTION_ID)');
  if (!resourceGroup) missing.push('LOOM_AI_SEARCH_RG (or LOOM_ADMIN_RG)');
  if (!serviceName) missing.push('LOOM_AI_SEARCH_SERVICE');
  if (missing.length) throw new SearchNotConfiguredError(missing);
  return { subscriptionId, resourceGroup, serviceName };
}

function serviceUrl(cfg: SearchServiceConfig): string {
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.Search/searchServices/${cfg.serviceName}`;
}

async function callArm(url: string, init?: RequestInit): Promise<Response> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new SearchArmError(401, undefined, 'Failed to acquire ARM token');
  return fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${t.token}`,
      'content-type': 'application/json',
    },
  });
}

export interface SearchServiceArm {
  id: string;
  name: string;
  location: string;
  sku: { name: string };
  replicaCount: number;
  partitionCount: number;
  status?: string;
  provisioningState?: string;
}

function shape(raw: any): SearchServiceArm {
  return {
    id: raw?.id,
    name: raw?.name,
    location: raw?.location,
    sku: { name: raw?.sku?.name || 'unknown' },
    replicaCount: raw?.properties?.replicaCount ?? 1,
    partitionCount: raw?.properties?.partitionCount ?? 1,
    status: raw?.properties?.status,
    provisioningState: raw?.properties?.provisioningState,
  };
}

export async function getSearchService(): Promise<SearchServiceArm> {
  const cfg = readSearchConfig();
  const r = await callArm(`${serviceUrl(cfg)}?api-version=${SEARCH_API}`);
  if (!r.ok) {
    throw new SearchArmError(r.status, await r.text(), `getSearchService failed ${r.status}`);
  }
  return shape(await r.json());
}

/**
 * Update SKU + replica + partition counts. SKU is immutable on free /
 * basic; PATCH will 400 with a precise reason in those cases.
 *
 * Valid SKUs: free, basic, standard (S1), standard2 (S2), standard3 (S3),
 * storage_optimized_l1, storage_optimized_l2.
 * Replicas: 1-12 (S1-S3), partitions: 1, 2, 3, 4, 6, 12.
 */
export async function updateSearchService(opts: {
  sku?: string;
  replicaCount?: number;
  partitionCount?: number;
}): Promise<SearchServiceArm> {
  const cfg = readSearchConfig();
  const body: any = {};
  if (opts.sku) body.sku = { name: opts.sku };
  if (opts.replicaCount || opts.partitionCount) {
    body.properties = {};
    if (opts.replicaCount) body.properties.replicaCount = opts.replicaCount;
    if (opts.partitionCount) body.properties.partitionCount = opts.partitionCount;
  }
  const r = await callArm(
    `${serviceUrl(cfg)}?api-version=${SEARCH_API}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  if (!r.ok && r.status !== 202) {
    throw new SearchArmError(r.status, await r.text(), `updateSearchService failed ${r.status}`);
  }
  if (r.status === 202) {
    return shape({
      id: cfg.serviceName, name: cfg.serviceName,
      location: 'unknown',
      sku: { name: opts.sku || 'unknown' },
      properties: { replicaCount: opts.replicaCount, partitionCount: opts.partitionCount, provisioningState: 'Updating' },
    });
  }
  return shape(await r.json());
}

// ---------------------------------------------------------------------------
// Debug sessions  (Microsoft.Search/searchServices/{name}/debugSessions)
//
// A debug session is an ARM child resource that captures a single-document
// enrichment trace so an indexer + skillset pipeline can be inspected. Session
// state is persisted to a blob container (ms-az-cognitive-search-debugsession)
// on a storage account — the search service's system-assigned managed identity
// needs Storage Blob Data Contributor on that account (granted in ai-search.bicep).
//
// The portal renders a proprietary visual skill graph over the stored state;
// Loom manages the session lifecycle (create / list / delete) + last execution
// status (data-plane GET /indexers/{name}/status) and deep-links to the portal
// to view the trace graph. Grounded in Microsoft Learn:
//   https://learn.microsoft.com/azure/search/cognitive-search-debug-session
//   https://learn.microsoft.com/azure/search/cognitive-search-how-to-debug-skillset
// ---------------------------------------------------------------------------

export interface DebugSession {
  name: string;
  indexerName?: string;
  status?: string;
  provisioningState?: string;
  lastExecutionTime?: string;
}

function shapeDebugSession(raw: any): DebugSession {
  const p = raw?.properties || {};
  return {
    name: raw?.name,
    indexerName: p.indexerName,
    status: p.status,
    provisioningState: p.provisioningState,
    lastExecutionTime: p.lastExecutionTime,
  };
}

/** GET …/debugSessions — list debug sessions on the search service. */
export async function listDebugSessions(cfg?: SearchServiceConfig): Promise<DebugSession[]> {
  const c = cfg || readSearchConfig();
  const r = await callArm(`${serviceUrl(c)}/debugSessions?api-version=${SEARCH_API}`);
  if (r.status === 404) return [];
  if (!r.ok) throw new SearchArmError(r.status, await r.text(), `listDebugSessions failed ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return (j?.value || []).map(shapeDebugSession);
}

/**
 * PUT …/debugSessions/{name} — create-or-update a debug session.
 * `indexerName` selects the indexer pipeline to trace; `storageConnectionString`
 * is the account that holds the session state container. In a PE-locked
 * deployment the session also needs `"executionEnvironment":"private"` on the
 * indexer and a shared private link from the search service to storage.
 */
export async function createDebugSession(
  opts: { sessionName: string; indexerName: string; storageConnectionString: string },
  cfg?: SearchServiceConfig,
): Promise<DebugSession> {
  const c = cfg || readSearchConfig();
  if (!opts?.sessionName) throw new SearchArmError(400, opts, 'createDebugSession requires sessionName');
  if (!opts?.indexerName) throw new SearchArmError(400, opts, 'createDebugSession requires indexerName');
  if (!opts?.storageConnectionString) throw new SearchArmError(400, opts, 'createDebugSession requires storageConnectionString');
  const body = {
    properties: {
      indexerName: opts.indexerName,
      storageAccountConnectionString: opts.storageConnectionString,
    },
  };
  const r = await callArm(
    `${serviceUrl(c)}/debugSessions/${encodeURIComponent(opts.sessionName)}?api-version=${SEARCH_API}`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
  if (!r.ok && r.status !== 201 && r.status !== 202) {
    throw new SearchArmError(r.status, await r.text(), `createDebugSession failed ${r.status}`);
  }
  const j = await r.json().catch(() => ({ name: opts.sessionName, properties: { indexerName: opts.indexerName, provisioningState: 'Creating' } }));
  return shapeDebugSession(j);
}

/** DELETE …/debugSessions/{name}. */
export async function deleteDebugSession(sessionName: string, cfg?: SearchServiceConfig): Promise<void> {
  const c = cfg || readSearchConfig();
  const r = await callArm(
    `${serviceUrl(c)}/debugSessions/${encodeURIComponent(sessionName)}?api-version=${SEARCH_API}`,
    { method: 'DELETE' },
  );
  if (r.status === 404 || r.status === 204 || r.ok) return;
  throw new SearchArmError(r.status, await r.text(), `deleteDebugSession failed ${r.status}`);
}

/** A portal deep-link to the debug-sessions blade for the configured service. */
export function debugSessionsPortalUrl(cfg?: SearchServiceConfig): string {
  const c = cfg || readSearchConfig();
  return `https://portal.azure.com/#resource/subscriptions/${c.subscriptionId}/resourceGroups/${c.resourceGroup}/providers/Microsoft.Search/searchServices/${c.serviceName}/debugSessions`;
}
