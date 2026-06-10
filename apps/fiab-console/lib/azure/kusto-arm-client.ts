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
import { armBase, armScope } from './cloud-endpoints';

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
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.Kusto/clusters/${cfg.clusterName}`;
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

// ============================================================
// Cluster lifecycle — stop / start / delete (ARM REST).
//
// Grounded in Microsoft Learn (Clusters - Stop / Start / Delete REST ops):
//   POST   .../clusters/{name}/stop  — async (202), releases compute, data survives
//   POST   .../clusters/{name}/start — async (202), ~10-min warm-up
//   DELETE .../clusters/{name}       — async (202); 14-day soft-delete window
// All return 202 (long-running op) on the live service; we surface a provisional
// provisioningState the caller renders in an async-receipt MessageBar.
//
// Auth: the Console UAMI's "Azure Kusto Contributor" grant
// (833127c3-3d62-4978-9c27-c0a5e418f64f, granted in adx-cluster.bicep) includes
// Microsoft.Kusto/clusters/stop/action + start/action + delete; no extra role
// needed. Same sovereign-cloud ARM host via armBase() as the rest of this file.
// No mocks. Real ARM REST only.
// ============================================================

export async function stopKustoCluster(): Promise<{ provisioningState: string }> {
  const cfg = readKustoArmConfig();
  const r = await callArm(`${clusterUrl(cfg)}/stop?api-version=${KUSTO_API}`, { method: 'POST' });
  if (!r.ok && r.status !== 202 && r.status !== 204) {
    throw new KustoArmError(r.status, await r.text(), `stopKustoCluster failed ${r.status}`);
  }
  return { provisioningState: r.status === 202 ? 'Stopping' : 'Stopped' };
}

export async function startKustoCluster(): Promise<{ provisioningState: string }> {
  const cfg = readKustoArmConfig();
  const r = await callArm(`${clusterUrl(cfg)}/start?api-version=${KUSTO_API}`, { method: 'POST' });
  if (!r.ok && r.status !== 202 && r.status !== 204) {
    throw new KustoArmError(r.status, await r.text(), `startKustoCluster failed ${r.status}`);
  }
  return { provisioningState: r.status === 202 ? 'Starting' : 'Running' };
}

/**
 * DELETE the entire ADX cluster. Async (202). Azure keeps the cluster in a
 * 14-day soft-delete window unless the resource carries the tag
 * `opt-out-of-soft-delete=true`. The caller (cluster-editor "Danger zone")
 * gates this behind a type-the-name confirmation.
 */
export async function deleteKustoCluster(): Promise<{ provisioningState: string }> {
  const cfg = readKustoArmConfig();
  const r = await callArm(`${clusterUrl(cfg)}?api-version=${KUSTO_API}`, { method: 'DELETE' });
  // 200 (sync), 202 (async), 204 (already gone) are all success.
  if (!r.ok && r.status !== 202 && r.status !== 204) {
    throw new KustoArmError(r.status, await r.text(), `deleteKustoCluster failed ${r.status}`);
  }
  return { provisioningState: r.status === 202 ? 'Deleting' : 'Deleted' };
}

// ============================================================
// Data connections (EventHub kind) — ARM REST
//   Microsoft.Kusto/clusters/{name}/databases/{db}/dataConnections[/{name}]
//   api-version = KUSTO_API (2023-08-15)
//
// These back the KQL-database "Event Hub data connection" wizard. ADX
// authenticates to Event Hubs using the cluster's system-assigned MI
// (managedIdentityResourceId = the cluster ARM id). That MI MUST hold
// "Azure Event Hubs Data Receiver" on the namespace — granted by
// eventhubs.bicep (adxClusterPrincipalId). The portal auto-grants it; the
// ARM REST API does NOT, so the pre-grant is part of this feature's bicep.
//
// eventHubResourceId and managedIdentityResourceId are plain ARM resource
// paths (no hostnames) so this code path is cloud-agnostic — no Event Hubs
// data-plane suffix is needed here. (The data-plane *send* path used by the
// validation test resolves the suffix via eventhubs-data-client's
// LOOM_EVENTHUB_DATA_SUFFIX.)
//
// No mocks. Real ARM REST only.
// ============================================================

export type DataConnectionDataFormat =
  | 'JSON' | 'MULTIJSON' | 'CSV' | 'TSV' | 'SCSV' | 'SOHSV' | 'PSV'
  | 'TXT' | 'RAW' | 'SINGLEJSON' | 'AVRO' | 'APACHEAVRO' | 'PARQUET'
  | 'ORC' | 'W3CLOGFILE' | 'TSVE';
export type DataConnectionCompression = 'None' | 'GZip';

export interface DataConnectionArm {
  id: string;
  name: string;
  location: string;
  kind: 'EventHub' | 'EventGrid' | 'IotHub' | 'CosmosDb';
  properties: {
    eventHubResourceId?: string;
    consumerGroup?: string;
    tableName?: string;
    mappingRuleName?: string;
    dataFormat?: DataConnectionDataFormat;
    compression?: DataConnectionCompression;
    managedIdentityResourceId?: string;
    provisioningState?: string;
    databaseRouting?: 'Single' | 'Multi';
  };
}

export interface CreateEventHubDataConnectionSpec {
  /** ARM resource ID of the event hub entity:
   *  /subscriptions/{s}/resourceGroups/{rg}/providers/Microsoft.EventHub/namespaces/{ns}/eventhubs/{hub} */
  eventHubResourceId: string;
  /** Consumer group — MUST be dedicated (one per ADX data connection, per Azure docs). */
  consumerGroup: string;
  /** Optional target table. Omit for per-event (dynamic) routing. */
  tableName?: string;
  /** Optional ingestion mapping name. */
  mappingRuleName?: string;
  /** Optional data format. Defaults to JSON. */
  dataFormat?: DataConnectionDataFormat;
  /** Optional payload compression. Defaults to None. */
  compression?: DataConnectionCompression;
  /** ARM resource ID of the cluster (its system-assigned MI authenticates to Event Hubs). */
  managedIdentityResourceId: string;
  /** Cluster region — required in the PUT body. */
  location: string;
}

function dataConnectionsBaseUrl(cfg: KustoClusterArmConfig, database: string): string {
  // Sovereign-cloud aware host via clusterUrl(ARM_BASE) — never hardcode
  // management.azure.com (would break GCC/GCC-High/IL5/IL6).
  return `${clusterUrl(cfg)}/databases/${encodeURIComponent(database)}/dataConnections`;
}

function shapeDataConnection(raw: any): DataConnectionArm {
  const p = raw?.properties || {};
  return {
    id: raw?.id || raw?.name,
    name: raw?.name,
    location: raw?.location,
    kind: raw?.kind || 'EventHub',
    properties: {
      eventHubResourceId: p.eventHubResourceId,
      consumerGroup: p.consumerGroup,
      tableName: p.tableName,
      mappingRuleName: p.mappingRuleName,
      dataFormat: p.dataFormat,
      compression: p.compression,
      managedIdentityResourceId: p.managedIdentityResourceId,
      provisioningState: p.provisioningState,
      databaseRouting: p.databaseRouting,
    },
  };
}

export async function listDataConnections(database: string): Promise<DataConnectionArm[]> {
  const cfg = readKustoArmConfig();
  const r = await callArm(`${dataConnectionsBaseUrl(cfg, database)}?api-version=${KUSTO_API}`);
  if (!r.ok) throw new KustoArmError(r.status, await r.text(), `listDataConnections failed ${r.status}`);
  const body: any = await r.json();
  return Array.isArray(body?.value) ? body.value.map(shapeDataConnection) : [];
}

export async function createOrUpdateDataConnection(
  database: string,
  name: string,
  spec: CreateEventHubDataConnectionSpec,
): Promise<DataConnectionArm> {
  const cfg = readKustoArmConfig();
  const payload = {
    kind: 'EventHub',
    location: spec.location,
    properties: {
      eventHubResourceId: spec.eventHubResourceId,
      consumerGroup: spec.consumerGroup,
      managedIdentityResourceId: spec.managedIdentityResourceId,
      ...(spec.tableName ? { tableName: spec.tableName } : {}),
      ...(spec.mappingRuleName ? { mappingRuleName: spec.mappingRuleName } : {}),
      dataFormat: spec.dataFormat ?? 'JSON',
      compression: spec.compression ?? 'None',
      databaseRouting: 'Single',
    },
  };
  const r = await callArm(
    `${dataConnectionsBaseUrl(cfg, database)}/${encodeURIComponent(name)}?api-version=${KUSTO_API}`,
    { method: 'PUT', body: JSON.stringify(payload) },
  );
  // ARM returns 200 (update) / 201 (create), or 202 + Location for async ops.
  if (!r.ok && r.status !== 202) {
    throw new KustoArmError(r.status, await r.text(), `createDataConnection failed ${r.status}`);
  }
  if (r.status === 202) {
    return shapeDataConnection({
      id: name, name, location: spec.location, kind: 'EventHub',
      properties: { ...payload.properties, provisioningState: 'Creating' },
    });
  }
  return shapeDataConnection(await r.json());
}

// ---------------------------------------------------------------------------
// IoT Hub data connection (PR #837) — Azure-native parity for a Fabric
// Eventhouse IoT Hub "Get data" connection. ADX streams device-to-cloud
// messages from an Azure IoT Hub into a target table. Unlike Event Hubs (which
// uses the cluster's system-assigned MI), an IoT Hub data connection
// authenticates with the hub's shared-access policy (key-based) — ARM reads the
// keys on the caller's behalf, so the ADX cluster MI needs IoT Hub Contributor
// (Microsoft.Devices/IotHubs/IotHubKeys/read) at the IoT Hub scope. No Fabric
// tenant required; works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
// ---------------------------------------------------------------------------

export interface CreateIotHubDataConnectionSpec {
  /** ARM resource ID: /subscriptions/{s}/resourceGroups/{rg}/providers/Microsoft.Devices/IotHubs/{name} */
  iotHubResourceId: string;
  /** Shared-access policy name (e.g. iothubowner, service) — ADX reads its keys via ARM. */
  sharedAccessPolicyName: string;
  /** Consumer group — defaults to $Default. */
  consumerGroup?: string;
  /** Optional target table. Omit for per-event (dynamic) routing. */
  tableName?: string;
  /** Optional ingestion mapping name. */
  mappingRuleName?: string;
  /** Optional data format. IoT Hub does NOT support RAW; defaults to MULTIJSON. */
  dataFormat?: DataConnectionDataFormat;
}

/**
 * Resolve the cluster's Azure region for the data-connection PUT body. Honors
 * LOOM_KUSTO_LOCATION; otherwise reads it live from the cluster resource so the
 * value is correct in any region/cloud (no hardcoded 'eastus2'). ARM requires
 * `location` on the child data-connection resource.
 */
async function resolveClusterLocation(): Promise<string> {
  const fromEnv = process.env.LOOM_KUSTO_LOCATION;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const c = await getKustoClusterArm();
  if (c.location && c.location.trim()) return c.location.trim();
  throw new KustoArmError(400, undefined, 'Could not resolve ADX cluster location; set LOOM_KUSTO_LOCATION.');
}

export async function createIotHubDataConnection(
  database: string,
  name: string,
  spec: CreateIotHubDataConnectionSpec,
): Promise<DataConnectionArm> {
  const cfg = readKustoArmConfig();
  const location = await resolveClusterLocation();
  const payload = {
    kind: 'IotHub',
    location,
    properties: {
      iotHubResourceId: spec.iotHubResourceId,
      sharedAccessPolicyName: spec.sharedAccessPolicyName,
      consumerGroup: spec.consumerGroup || '$Default',
      ...(spec.tableName ? { tableName: spec.tableName } : {}),
      ...(spec.mappingRuleName ? { mappingRuleName: spec.mappingRuleName } : {}),
      // IoT Hub D2C messages are JSON envelopes; MULTIJSON is the ADX default.
      dataFormat: spec.dataFormat ?? 'MULTIJSON',
      databaseRouting: 'Single',
    },
  };
  const r = await callArm(
    `${dataConnectionsBaseUrl(cfg, database)}/${encodeURIComponent(name)}?api-version=${KUSTO_API}`,
    { method: 'PUT', body: JSON.stringify(payload) },
  );
  if (!r.ok && r.status !== 202) {
    throw new KustoArmError(r.status, await r.text(), `createIotHubDataConnection failed ${r.status}`);
  }
  if (r.status === 202) {
    return shapeDataConnection({
      id: name, name, location, kind: 'IotHub',
      properties: { ...payload.properties, provisioningState: 'Creating' },
    });
  }
  return shapeDataConnection(await r.json());
}

export async function deleteDataConnection(database: string, name: string): Promise<void> {
  const cfg = readKustoArmConfig();
  const r = await callArm(
    `${dataConnectionsBaseUrl(cfg, database)}/${encodeURIComponent(name)}?api-version=${KUSTO_API}`,
    { method: 'DELETE' },
  );
  // 200/204 (sync delete) or 202 (async) or 404 (already gone) are all OK.
  if (!r.ok && r.status !== 204 && r.status !== 202 && r.status !== 404) {
    throw new KustoArmError(r.status, await r.text(), `deleteDataConnection failed ${r.status}`);
  }
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

