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

// ARM endpoint is sovereign-cloud aware — single source of truth, identical
// pattern to adf-client.ts. Default = Commercial (unchanged behavior). GCC /
// GCC-High / IL5 deployments set AZURE_CLOUD=AzureUSGovernment (or
// LOOM_ARM_ENDPOINT) so every Kusto ARM call below — GET cluster, PATCH SKU,
// PATCH optimizedAutoscale, PATCH enableStreamingIngest, follower-attach —
// targets the correct ARM host + token scope instead of management.azure.com.
// Required because follower-attach ships in Gov.
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
  enableStreamingIngest?: boolean;
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
    enableStreamingIngest: raw?.properties?.enableStreamingIngest,
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
 * ARM DELETE Microsoft.Kusto/clusters/{cluster}/databases/{name}.
 * Database deletion is an ARM-plane operation (it deallocates persistent
 * storage), mirroring `createDatabase` in kusto-client.ts.
 *
 * Returns { provisioningState: 'Succeeded' } on 200 (sync delete) or
 * { provisioningState: 'Deleting' } on 202 (async long-running operation).
 * The caller identity (Console UAMI) must hold Contributor on the cluster
 * scope — the same role used to create databases.
 *
 * Grounded in Microsoft Learn (Databases - Delete REST operation):
 *   DELETE .../clusters/{cluster}/databases/{name}?api-version=2023-08-15
 */
export async function deleteKustoDatabase(dbName: string): Promise<{ provisioningState: string }> {
  const cfg = readKustoArmConfig();
  const url = `${clusterUrl(cfg)}/databases/${encodeURIComponent(dbName)}?api-version=${KUSTO_API}`;
  const r = await callArm(url, { method: 'DELETE' });
  // 200 sync delete, 202 async delete, 204 already-gone are all success.
  if (!r.ok && r.status !== 202) {
    throw new KustoArmError(r.status, await r.text(), `deleteKustoDatabase(${dbName}) failed ${r.status}`);
  }
  return { provisioningState: r.status === 202 ? 'Deleting' : 'Succeeded' };
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

// ============================================================
// Follower database attach (database shortcut) — T7.
//
// A follower database is an ATTACHED, read-only replica of a leader cluster's
// database, surfaced live on THIS (follower) cluster via an
// `attachedDatabaseConfigurations` ARM child resource. Grounded in Microsoft
// Learn:
//   https://learn.microsoft.com/azure/data-explorer/follower
//   https://learn.microsoft.com/rest/api/azurerekusto/attached-database-configurations
//
// Constraints (enforced/surfaced by the API route + wizard):
//   - Leader and follower clusters MUST be in the same Azure region.
//   - The caller identity (Loom UAMI) needs Contributor / Azure Kusto
//     Contributor on BOTH clusters; the follower side is already configured,
//     the leader side is an out-of-band grant.
//   - Followers are strictly read-only — ADX rejects .create/.drop/.ingest/
//     .alter/.purge; the query route blocks them before the cluster is hit.
//   - tableLevelSharingProperties is unsupported when databaseName = '*'.
// ============================================================

function attachedConfigUrl(cfg: KustoClusterArmConfig, configName: string): string {
  return `${clusterUrl(cfg)}/attachedDatabaseConfigurations/${encodeURIComponent(configName)}?api-version=${KUSTO_API}`;
}

export interface AttachFollowerConfig {
  configName: string;              // unique per follower cluster
  leaderClusterResourceId: string; // /subscriptions/.../providers/Microsoft.Kusto/clusters/<leader>
  databaseName: string;            // specific leader DB name, or '*' = follow all
  defaultPrincipalsModificationKind: 'Union' | 'Replace' | 'None';
  location?: string;               // defaults to LOOM_KUSTO_LOCATION; must match leader region
}

/**
 * Create-or-replace an attachedDatabaseConfiguration on the Loom follower
 * cluster. PUT is async — ARM may return 200 (sync), 201, or 202; we surface
 * provisioningState immediately and the follower DB appears in `.show
 * databases` within seconds of the ARM operation completing.
 */
export async function attachFollowerDatabase(
  cfg: AttachFollowerConfig,
): Promise<{ provisioningState: string; id: string; configName: string }> {
  const arm = readKustoArmConfig();
  const location = cfg.location || process.env.LOOM_KUSTO_LOCATION || 'eastus2';
  const body = {
    location,
    properties: {
      databaseName: cfg.databaseName,
      clusterResourceId: cfg.leaderClusterResourceId,
      defaultPrincipalsModificationKind: cfg.defaultPrincipalsModificationKind,
    },
  };
  const r = await callArm(attachedConfigUrl(arm, cfg.configName), {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!r.ok && r.status !== 202 && r.status !== 201) {
    throw new KustoArmError(r.status, await r.text(), `attachFollowerDatabase failed ${r.status}`);
  }
  let json: any = null;
  try { json = await r.json(); } catch { /* 202 may have empty body */ }
  return {
    provisioningState: json?.properties?.provisioningState || (r.status === 200 ? 'Succeeded' : 'Creating'),
    id: json?.id || '',
    configName: cfg.configName,
  };
}

export interface AttachedDatabaseConfigurationResult {
  name: string;                    // short name (after cluster/)
  configId: string;                // full ARM id
  leaderClusterResourceId: string;
  databaseName: string;
  provisioningState?: string;
  attachedDatabaseNames?: string[]; // properties.attachedDatabaseNames
}

/** List all attachedDatabaseConfigurations on the Loom follower cluster. */
export async function listAttachedDatabaseConfigurations(): Promise<AttachedDatabaseConfigurationResult[]> {
  const cfg = readKustoArmConfig();
  const url = `${clusterUrl(cfg)}/attachedDatabaseConfigurations?api-version=${KUSTO_API}`;
  const r = await callArm(url);
  if (!r.ok) {
    throw new KustoArmError(r.status, await r.text(), `listAttachedDatabaseConfigurations failed ${r.status}`);
  }
  const json: any = await r.json();
  const arr: any[] = Array.isArray(json?.value) ? json.value : [];
  return arr.map((c) => ({
    name: String(c?.name || '').split('/').pop() || String(c?.name || ''),
    configId: String(c?.id || ''),
    leaderClusterResourceId: String(c?.properties?.clusterResourceId || ''),
    databaseName: String(c?.properties?.databaseName || ''),
    provisioningState: c?.properties?.provisioningState,
    attachedDatabaseNames: Array.isArray(c?.properties?.attachedDatabaseNames)
      ? c.properties.attachedDatabaseNames.map((n: any) => String(n))
      : [],
  }));
}

/** Detach (DELETE) a follower configuration by its short config name. */
export async function detachFollowerDatabase(configName: string): Promise<void> {
  const cfg = readKustoArmConfig();
  const r = await callArm(attachedConfigUrl(cfg, configName), { method: 'DELETE' });
  // ARM returns 200 (deleted), 202 (async delete), or 204 (already gone).
  if (!r.ok && r.status !== 202 && r.status !== 204) {
    throw new KustoArmError(r.status, await r.text(), `detachFollowerDatabase failed ${r.status}`);
  }
}

/**
 * PATCH the cluster-level streaming-ingestion capability flag.
 *
 * ARM body: { "properties": { "enableStreamingIngest": true|false } }
 *
 * Unlike the SKU PATCH (which carries `sku` at the document root), this flag
 * lives under `properties`. Toggling it triggers an async cluster
 * reconfiguration: enabling is fast (seconds–minutes), disabling can take
 * longer. ARM may answer 200 (full resource) or 202 (async). On 202 we return
 * a synthetic shape with provisioningState='Updating' and the desired flag,
 * matching updateKustoClusterSku.
 *
 * The UAMI must hold "Contributor" (or "Azure Kusto Contributor") at the
 * cluster scope. Same auth + sovereign-cloud ARM host as the rest of this file.
 */
export async function updateKustoStreamingIngest(
  enabled: boolean,
): Promise<KustoClusterArm> {
  const cfg = readKustoArmConfig();
  const body = { properties: { enableStreamingIngest: enabled } };
  const r = await callArm(
    `${clusterUrl(cfg)}?api-version=${KUSTO_API}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  if (!r.ok && r.status !== 202) {
    throw new KustoArmError(r.status, await r.text(), `updateKustoStreamingIngest failed ${r.status}`);
  }
  if (r.status === 202) {
    return shape({
      id: cfg.clusterName,
      name: cfg.clusterName,
      sku: {},
      properties: { provisioningState: 'Updating', enableStreamingIngest: enabled },
    });
  }
  return shape(await r.json());
}
