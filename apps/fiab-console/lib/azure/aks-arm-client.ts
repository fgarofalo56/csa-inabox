/**
 * AKS (Azure Kubernetes Service) agent-pool ARM control — the GCC-High / IL5
 * container platform Loom runs on (Commercial / GCC use Container Apps instead).
 *
 * This client lets the Loom Console read the cluster's node pools and scale a
 * pool's node count on demand — the AKS analogue of the VMSS / Container Apps
 * scale paths. Real ARM REST, no mocks:
 *   GET .../managedClusters/{cluster}/agentPools?api-version=2025-04-01   → pools
 *   GET .../managedClusters/{cluster}/agentPools/{pool}?api-version=...   → one pool
 *   PUT .../managedClusters/{cluster}/agentPools/{pool}  { properties }   → scale
 *
 * Scaling a pool sets `count` and disables the cluster autoscaler on that pool
 * (you cannot pin `count` while `enableAutoScaling` is true — ARM rejects it).
 * The existing pool profile is read first and merged so immutable fields
 * (vmSize, osType, vnetSubnetID …) are preserved on the PUT.
 *
 * Auth: ChainedTokenCredential(UAMI → DefaultAzureCredential) on the ARM scope.
 * Needs "Azure Kubernetes Service Cluster Admin" (or Contributor) on the
 * cluster — granted in container-platform.bicep for the AKS path.
 */
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { armBase, armScope } from './cloud-endpoints';

const ARM = armBase();
const ARM_SCOPE = armScope();
const AKS_API = '2025-04-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class AksError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'AksError';
    this.status = status;
    this.body = body;
  }
}

export class AksNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`AKS cluster is not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'AksNotConfiguredError';
  }
}

export interface AksConfig {
  subscriptionId: string;
  resourceGroup: string;
  clusterName: string;
}

export interface AgentPool {
  name: string;
  count: number;
  provisioningState?: string;
  powerState?: string;
  mode?: string;
  vmSize?: string;
  enableAutoScaling: boolean;
  minCount?: number;
  maxCount?: number;
}

/**
 * Resolve AKS config from env. The bicep wires LOOM_AKS_CLUSTER_NAME +
 * LOOM_AKS_RG (only populated when containerPlatform == 'aks', i.e. GCC-High /
 * IL5). Throws AksNotConfiguredError when absent so the route can return an
 * honest 503 gate (Commercial / GCC always hit this — they run Container Apps).
 */
export function readAksConfig(): AksConfig {
  const missing: string[] = [];
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID || '';
  const resourceGroup = process.env.LOOM_AKS_RG || process.env.LOOM_ADMIN_RG || '';
  const clusterName = process.env.LOOM_AKS_CLUSTER_NAME || '';
  if (!subscriptionId) missing.push('LOOM_SUBSCRIPTION_ID');
  if (!resourceGroup) missing.push('LOOM_AKS_RG (or LOOM_ADMIN_RG)');
  if (!clusterName) missing.push('LOOM_AKS_CLUSTER_NAME');
  if (missing.length) throw new AksNotConfiguredError(missing);
  return { subscriptionId, resourceGroup, clusterName };
}

async function token(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new AksError('Failed to acquire ARM token', 401);
  return t.token;
}

function clusterPath(c: AksConfig): string {
  return `/subscriptions/${c.subscriptionId}/resourceGroups/${c.resourceGroup}/providers/Microsoft.ContainerService/managedClusters/${encodeURIComponent(c.clusterName)}`;
}

async function armFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${ARM}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await token()}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init?.headers || {}),
    },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok && res.status !== 202) {
    const msg = json?.error?.message || json?.message || (typeof json === 'string' ? json : `ARM ${path} failed ${res.status}`);
    throw new AksError(msg, res.status, json);
  }
  return json;
}

function shapePool(raw: any): AgentPool {
  const p = raw?.properties || raw || {};
  return {
    name: raw?.name || p?.name || 'nodepool',
    count: typeof p?.count === 'number' ? p.count : 0,
    provisioningState: p?.provisioningState,
    powerState: p?.powerState?.code,
    mode: p?.mode,
    vmSize: p?.vmSize,
    enableAutoScaling: !!p?.enableAutoScaling,
    minCount: typeof p?.minCount === 'number' ? p.minCount : undefined,
    maxCount: typeof p?.maxCount === 'number' ? p.maxCount : undefined,
  };
}

/** List the cluster's agent (node) pools with their current count + state. */
export async function listAksAgentPools(): Promise<AgentPool[]> {
  const cfg = readAksConfig();
  const list = await armFetch(`${clusterPath(cfg)}/agentPools?api-version=${AKS_API}`);
  return (list?.value || []).map(shapePool);
}

/** Read a single agent pool (raw ARM body — used to preserve immutable fields on PUT). */
async function getAgentPoolRaw(cfg: AksConfig, poolName: string): Promise<any> {
  return armFetch(`${clusterPath(cfg)}/agentPools/${encodeURIComponent(poolName)}?api-version=${AKS_API}`);
}

/**
 * Scale an agent pool to `count` nodes. Reads the existing pool first, merges
 * the new count and disables the autoscaler on that pool (count + autoscale are
 * mutually exclusive in ARM), then PUTs the merged profile back so vmSize /
 * osType / subnet are preserved. ARM returns 200 (sync) or 202 (async LRO) —
 * either way provisioningState transitions Updating → Succeeded.
 */
export async function scaleAksAgentPool(poolName: string, count: number): Promise<AgentPool> {
  if (!Number.isInteger(count) || count < 0 || count > 1000) {
    throw new AksError(`count must be an integer 0-1000 (got ${count})`, 400);
  }
  const cfg = readAksConfig();
  const existing = await getAgentPoolRaw(cfg, poolName);
  const props = { ...(existing?.properties || {}) };
  props.count = count;
  // Pin the count: a manual scale requires the autoscaler off on this pool.
  props.enableAutoScaling = false;
  delete props.minCount;
  delete props.maxCount;
  // provisioningState / powerState are read-only — drop them from the PUT body.
  delete props.provisioningState;
  delete props.powerState;
  const r = await armFetch(
    `${clusterPath(cfg)}/agentPools/${encodeURIComponent(poolName)}?api-version=${AKS_API}`,
    { method: 'PUT', body: JSON.stringify({ properties: props }) },
  );
  // 202 returns no body; reflect an Updating state for the poll loop.
  if (!r) return { name: poolName, count, provisioningState: 'Updating', enableAutoScaling: false };
  return shapePool(r);
}
