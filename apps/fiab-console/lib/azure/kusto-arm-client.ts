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
import { armBase, armScope } from './arm-endpoint';

// Sovereign-cloud aware ARM host + scope. Previously hardcoded to Commercial
// (`management.azure.com`), which broke ARM token acquisition + REST on
// GCC-High / IL5 / IL6. Now resolved from AZURE_CLOUD / LOOM_ARM_ENDPOINT via
// the shared arm-endpoint helper so every call below targets the right host.
const ARM_BASE = armBase();
const ARM_SCOPE = armScope();
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

export interface KustoClusterArm {
  id: string;
  name: string;
  location: string;
  sku: { name: string; tier: string; capacity?: number };
  state?: string;
  provisioningState?: string;
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

// ---------------------------------------------------------------------------
// Data connections (Microsoft.Kusto/clusters/{c}/databases/{d}/dataConnections)
//
// ADX streams events from Azure Event Hubs OR Azure IoT Hub into a target
// table via a managed "data connection". This is the Azure-native parity for
// a Fabric Eventhouse data connection — no Fabric tenant required. The ADX
// cluster's system-assigned managed identity must be able to read the source's
// shared-access keys (Event Hubs Data Receiver for an Event Hub; IoT Hub
// Contributor / Microsoft.Devices/IotHubs/IotHubKeys/read for an IoT Hub).
// ---------------------------------------------------------------------------

/** Build the data-connection ARM URL for a named connection on a database. */
function dataConnectionUrl(cfg: KustoClusterArmConfig, database: string, connName: string): string {
  return `${clusterUrl(cfg)}/databases/${encodeURIComponent(database)}/dataConnections/${encodeURIComponent(connName)}?api-version=${KUSTO_API}`;
}

/** Build the list-all data-connections ARM URL for a database. */
function dataConnectionsListUrl(cfg: KustoClusterArmConfig, database: string): string {
  return `${clusterUrl(cfg)}/databases/${encodeURIComponent(database)}/dataConnections?api-version=${KUSTO_API}`;
}

export interface DataConnectionSpec {
  /** EventHub | IotHub — the ARM `kind` discriminator. */
  kind: 'EventHub' | 'IotHub';
  // Event Hub source
  eventHubResourceId?: string;
  // IoT Hub source
  iotHubResourceId?: string;
  sharedAccessPolicyName?: string;
  // Shared
  consumerGroup?: string;
  tableName?: string;
  /** ADX data format. IoT Hub does NOT support RAW. Defaults: IoT=MULTIJSON, EH=JSON. */
  dataFormat?: string;
  mappingRuleName?: string;
  compression?: string;
}

/**
 * Resolve the cluster's Azure region for the data-connection PUT body.
 * Honors LOOM_KUSTO_LOCATION when set; otherwise reads it live from the
 * cluster resource so the value is correct in any region/cloud (no hardcoded
 * 'eastus2'). ARM requires `location` on the child data-connection resource.
 */
async function resolveClusterLocation(cfg: KustoClusterArmConfig): Promise<string> {
  const fromEnv = process.env.LOOM_KUSTO_LOCATION;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const c = await getKustoClusterArm();
  if (c.location && c.location.trim()) return c.location.trim();
  throw new KustoArmError(400, undefined, 'Could not resolve ADX cluster location; set LOOM_KUSTO_LOCATION.');
}

/** Shape an ARM data-connection resource into a stable, key-free summary. */
export interface DataConnectionSummary {
  id?: string;
  name?: string;
  kind?: string;
  tableName?: string;
  consumerGroup?: string;
  dataFormat?: string;
  provisioningState?: string;
  source?: string; // eventHubResourceId or iotHubResourceId
}

function shapeDataConnection(raw: any): DataConnectionSummary {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    kind: raw?.kind,
    tableName: p?.tableName,
    consumerGroup: p?.consumerGroup,
    dataFormat: p?.dataFormat,
    provisioningState: p?.provisioningState,
    source: p?.iotHubResourceId || p?.eventHubResourceId,
  };
}

/** List every data connection on the resolved database. Real ARM REST. */
export async function listDataConnections(database: string): Promise<DataConnectionSummary[]> {
  const cfg = readKustoArmConfig();
  const r = await callArm(dataConnectionsListUrl(cfg, database));
  if (!r.ok) {
    throw new KustoArmError(r.status, await r.text(), `listDataConnections failed ${r.status}`);
  }
  const body = await r.json();
  const value: any[] = Array.isArray(body?.value) ? body.value : [];
  return value.map(shapeDataConnection);
}

/**
 * PUT (create-or-update) an EventHub or IotHub data connection on a database.
 * Returns the shaped resource (incl. provisioningState). ARM validates that
 * the ADX cluster MI can read the source's keys — a 403 here means the MI
 * needs the source-side role grant (surfaced as an honest gate by the caller).
 */
export async function createDataConnection(
  database: string,
  connName: string,
  spec: DataConnectionSpec,
): Promise<DataConnectionSummary> {
  const cfg = readKustoArmConfig();
  const location = await resolveClusterLocation(cfg);

  let properties: Record<string, unknown>;
  if (spec.kind === 'IotHub') {
    if (!spec.iotHubResourceId) throw new KustoArmError(400, undefined, 'iotHubResourceId required');
    if (!spec.sharedAccessPolicyName) throw new KustoArmError(400, undefined, 'sharedAccessPolicyName required');
    properties = {
      iotHubResourceId: spec.iotHubResourceId,
      sharedAccessPolicyName: spec.sharedAccessPolicyName,
      consumerGroup: spec.consumerGroup || '$Default',
      tableName: spec.tableName,
      // IoT Hub D2C messages are JSON envelopes; MULTIJSON is the ADX default.
      dataFormat: spec.dataFormat || 'MULTIJSON',
      databaseRouting: 'Single',
    };
  } else {
    if (!spec.eventHubResourceId) throw new KustoArmError(400, undefined, 'eventHubResourceId required');
    properties = {
      eventHubResourceId: spec.eventHubResourceId,
      consumerGroup: spec.consumerGroup || '$Default',
      tableName: spec.tableName,
      dataFormat: spec.dataFormat || 'JSON',
      compression: spec.compression || 'None',
      databaseRouting: 'Single',
    };
  }
  if (spec.mappingRuleName) properties.mappingRuleName = spec.mappingRuleName;

  const body = { location, kind: spec.kind, properties };
  const r = await callArm(
    dataConnectionUrl(cfg, database, connName),
    { method: 'PUT', body: JSON.stringify(body) },
  );
  if (!r.ok && r.status !== 202) {
    throw new KustoArmError(r.status, await r.text(), `createDataConnection failed ${r.status}`);
  }
  if (r.status === 202) {
    return { name: connName, kind: spec.kind, provisioningState: 'Creating', tableName: spec.tableName };
  }
  return shapeDataConnection(await r.json());
}

/** DELETE a data connection by name. Idempotent (404 → resolved). */
export async function deleteDataConnection(database: string, connName: string): Promise<void> {
  const cfg = readKustoArmConfig();
  const r = await callArm(
    dataConnectionUrl(cfg, database, connName),
    { method: 'DELETE' },
  );
  if (!r.ok && r.status !== 202 && r.status !== 204 && r.status !== 404) {
    throw new KustoArmError(r.status, await r.text(), `deleteDataConnection failed ${r.status}`);
  }
}
