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

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

const ARM_SCOPE = 'https://management.azure.com/.default';
const SEARCH_API = '2024-03-01-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
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
  return `https://management.azure.com/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.Search/searchServices/${cfg.serviceName}`;
}

async function callArm(url: string, init?: RequestInit): Promise<Response> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new SearchArmError(401, undefined, 'Failed to acquire ARM token');
  return fetch(url, {
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
