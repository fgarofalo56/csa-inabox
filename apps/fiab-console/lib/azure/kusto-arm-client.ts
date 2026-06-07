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

const ARM_SCOPE = 'https://management.azure.com/.default';
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
  return `https://management.azure.com/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.Kusto/clusters/${cfg.clusterName}`;
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
  return `https://management.azure.com/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.Kusto/clusters/${cfg.clusterName}/databases/${encodeURIComponent(database)}/dataConnections`;
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
