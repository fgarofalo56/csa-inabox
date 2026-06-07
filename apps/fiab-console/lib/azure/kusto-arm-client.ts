/**
 * Azure Data Explorer (Kusto) ARM management-plane client — separate
 * from kusto-client.ts which talks to the query/mgmt plane.
 *
 * This file is dedicated to ARM scale operations against
 * Microsoft.Kusto/clusters/{name}:
 *   - GET cluster (current SKU, capacity, state)
 *   - PATCH cluster SKU (vCore tier change)
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential). The UAMI
 * must hold "Contributor" (or the narrower "Azure Kusto Contributor")
 * at the cluster scope to PATCH the SKU.
 *
 * Scale axis surfaced by ADX:
 *   - Dev(No SLA)_Standard_E2a_v4  (dev/test, single node, no SLA)
 *   - Standard_E2ads_v5            (small prod)
 *   - Standard_E4ads_v5            (medium)
 *   - Standard_E8ads_v5            (large)
 *   - Standard_E16ads_v5           (xlarge)
 *   - Standard_E64ads_v5           (xxlarge)
 * Plus optional capacity (number of instances 2-1000).
 *
 * No mocks. Real ARM REST only.
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

// ARM endpoint is sovereign-cloud aware. Default = Commercial (unchanged
// behavior). GCC / GCC-High / IL5 deployments set AZURE_CLOUD (or
// LOOM_ARM_ENDPOINT) so every ARM call below — GET cluster, PATCH SKU, and
// PATCH optimizedAutoscale — targets the correct ARM host and the token
// audience matches. Mirrors the pattern in adf-client.ts.
function armBase(): string {
  const explicit = process.env.LOOM_ARM_ENDPOINT;
  if (explicit) return explicit.replace(/\/+$/, '');
  switch ((process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase()) {
    case 'azureusgovernment': return 'https://management.usgovcloudapi.net';
    case 'azuredod':          return 'https://management.azure.microsoft.scloud';
    default:                  return 'https://management.azure.com';
  }
}
const ARM_BASE = armBase();
const ARM_SCOPE = `${ARM_BASE}/.default`;
const KUSTO_API = '2023-08-15';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class KustoArmError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Kusto ARM call failed (${status})`);
    this.name = 'KustoArmError';
    this.status = status;
    this.body = body;
  }
}

export interface KustoClusterArmConfig {
  subscriptionId: string;
  resourceGroup: string;
  clusterName: string;
}

export class KustoNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`ADX cluster is not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'KustoNotConfiguredError';
  }
}

export function readKustoArmConfig(): KustoClusterArmConfig {
  const missing: string[] = [];
  const subscriptionId =
    process.env.LOOM_KUSTO_SUB || process.env.LOOM_SUBSCRIPTION_ID || '';
  const resourceGroup =
    process.env.LOOM_KUSTO_RG || process.env.LOOM_DLZ_RG || '';
  const clusterName = process.env.LOOM_KUSTO_CLUSTER_NAME || '';
  if (!subscriptionId) missing.push('LOOM_KUSTO_SUB (or LOOM_SUBSCRIPTION_ID)');
  if (!resourceGroup) missing.push('LOOM_KUSTO_RG (or LOOM_DLZ_RG)');
  if (!clusterName) missing.push('LOOM_KUSTO_CLUSTER_NAME');
  if (missing.length) throw new KustoNotConfiguredError(missing);
  return { subscriptionId, resourceGroup, clusterName };
}

function clusterUrl(cfg: KustoClusterArmConfig): string {
  return `${ARM_BASE}/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.Kusto/clusters/${cfg.clusterName}`;
}

async function callArm(url: string, init?: RequestInit): Promise<Response> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new KustoArmError(401, undefined, 'Failed to acquire ARM token');
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${t.token}`,
      'content-type': 'application/json',
    },
  });
}

export interface OptimizedAutoscale {
  isEnabled: boolean;
  minimum: number;
  maximum: number;
  version: number; // always 1 per the ARM schema
}

export interface KustoClusterArm {
  id: string;
  name: string;
  location: string;
  sku: { name: string; tier: string; capacity?: number };
  state?: string;
  provisioningState?: string;
  optimizedAutoscale?: OptimizedAutoscale;
}

function shape(raw: any): KustoClusterArm {
  return {
    id: raw?.id,
    name: raw?.name,
    location: raw?.location,
    sku: {
      name: raw?.sku?.name || 'unknown',
      tier: raw?.sku?.tier || 'unknown',
      capacity: raw?.sku?.capacity,
    },
    state: raw?.properties?.state,
    provisioningState: raw?.properties?.provisioningState,
    optimizedAutoscale: raw?.properties?.optimizedAutoscale
      ? {
          isEnabled: !!raw.properties.optimizedAutoscale.isEnabled,
          minimum: Number(raw.properties.optimizedAutoscale.minimum),
          maximum: Number(raw.properties.optimizedAutoscale.maximum),
          version: Number(raw.properties.optimizedAutoscale.version ?? 1),
        }
      : undefined,
  };
}

export async function getKustoClusterArm(): Promise<KustoClusterArm> {
  const cfg = readKustoArmConfig();
  const r = await callArm(`${clusterUrl(cfg)}?api-version=${KUSTO_API}`);
  if (!r.ok) {
    throw new KustoArmError(r.status, await r.text(), `getKustoCluster failed ${r.status}`);
  }
  return shape(await r.json());
}

/**
 * PATCH the cluster SKU + optional capacity. Tier is derived from the
 * SKU name (Dev → 'Basic', everything else → 'Standard').
 */
export async function updateKustoClusterSku(
  newSkuName: string,
  capacity?: number,
): Promise<KustoClusterArm> {
  const cfg = readKustoArmConfig();
  const tier = newSkuName.toLowerCase().startsWith('dev(no sla)') ? 'Basic' : 'Standard';
  const body: any = { sku: { name: newSkuName, tier } };
  if (typeof capacity === 'number' && capacity > 0) body.sku.capacity = capacity;
  const r = await callArm(
    `${clusterUrl(cfg)}?api-version=${KUSTO_API}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  if (!r.ok && r.status !== 202) {
    throw new KustoArmError(r.status, await r.text(), `updateKustoClusterSku failed ${r.status}`);
  }
  // ARM returns the full resource on PATCH (or 202 + Location for async).
  if (r.status === 202) {
    return shape({ id: cfg.clusterName, name: cfg.clusterName, sku: body.sku, properties: { provisioningState: 'Updating' } });
  }
  return shape(await r.json());
}

/**
 * PATCH the cluster's optimizedAutoscale property via ARM.
 *   properties.optimizedAutoscale = { isEnabled, minimum, maximum, version }
 * `version` is always 1 (ARM schema requirement).
 *
 * ARM rejects this field with HTTP 400 on Dev(No SLA)/Basic-tier SKUs — the
 * caller surfaces that as an honest SKU gate. Standard-tier clusters apply it
 * (often as a 202 long-running op).
 */
export async function updateKustoClusterAutoscale(
  isEnabled: boolean,
  minimum: number,
  maximum: number,
): Promise<KustoClusterArm> {
  const cfg = readKustoArmConfig();
  const body = {
    properties: {
      optimizedAutoscale: { isEnabled, minimum, maximum, version: 1 },
    },
  };
  const r = await callArm(
    `${clusterUrl(cfg)}?api-version=${KUSTO_API}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  if (!r.ok && r.status !== 202) {
    throw new KustoArmError(r.status, await r.text(), `updateKustoClusterAutoscale failed ${r.status}`);
  }
  if (r.status === 202) {
    // Long-running ARM op — return a provisional shape so the caller can
    // surface provisioningState:'Updating' in the receipt MessageBar.
    return shape({
      id: cfg.clusterName,
      name: cfg.clusterName,
      sku: {},
      properties: {
        provisioningState: 'Updating',
        optimizedAutoscale: { isEnabled, minimum, maximum, version: 1 },
      },
    });
  }
  return shape(await r.json());
}
