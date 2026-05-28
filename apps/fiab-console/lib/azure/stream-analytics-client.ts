/**
 * Azure Stream Analytics (ASA) ARM REST client.
 *
 * Talks to the ASA management plane (Microsoft.StreamAnalytics/streamingjobs).
 * Streaming jobs, transformations (query), inputs, outputs, and start/stop
 * are all child resources of the streamingjob ARM resource.
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential). The UAMI must
 * hold "Stream Analytics Contributor" on the configured RG (or sub) so the
 * BFF can list jobs, GET, PUT transformations, and POST start/stop.
 *
 * Honest gating: every helper reads env vars on demand. If LOOM_ASA_RG is
 * unset, the helpers throw AsaNotConfiguredError and the route surfaces a
 * 501 MessageBar that names the bicep module + env vars the operator
 * needs. No mock arrays, no "return []" lies.
 *
 * No mocks. Real REST against management.azure.com only.
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

const ARM_SCOPE = 'https://management.azure.com/.default';
const API = '2020-03-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export interface AsaConfig {
  subscriptionId: string;
  resourceGroup: string;
}

export class AsaNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`Stream Analytics is not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'AsaNotConfiguredError';
  }
}

export function readAsaConfig(): AsaConfig {
  const missing: string[] = [];
  const subscriptionId =
    process.env.LOOM_ASA_SUB ||
    process.env.LOOM_SUBSCRIPTION_ID ||
    '';
  const resourceGroup =
    process.env.LOOM_ASA_RG ||
    process.env.LOOM_DLZ_RG ||
    '';
  if (!subscriptionId) missing.push('LOOM_ASA_SUB (or LOOM_SUBSCRIPTION_ID)');
  if (!resourceGroup) missing.push('LOOM_ASA_RG (or LOOM_DLZ_RG)');
  if (missing.length) throw new AsaNotConfiguredError(missing);
  return { subscriptionId, resourceGroup };
}

function rgBase(cfg: AsaConfig): string {
  return `https://management.azure.com/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.StreamAnalytics/streamingjobs`;
}

async function call(url: string, init?: RequestInit): Promise<Response> {
  const tok = await credential.getToken(ARM_SCOPE);
  if (!tok?.token) throw new Error('Failed to acquire ARM token');
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${tok.token}`,
      'content-type': 'application/json',
    },
  });
}

async function jsonOrThrow<T>(r: Response, label: string): Promise<T> {
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${label} failed ${r.status}: ${body.slice(0, 600)}`);
  }
  return (await r.json()) as T;
}

export interface AsaJobSummary {
  name: string;
  id: string;
  location: string;
  state?: string;
  jobState?: string;
  sku?: string;
  streamingUnits?: number;
  lastOutputEventTime?: string;
}

export interface AsaInput { name: string; type: string; serialization?: string; }
export interface AsaOutput { name: string; type: string; }
export interface AsaJobDetail extends AsaJobSummary {
  inputs?: AsaInput[];
  outputs?: AsaOutput[];
  query?: string;
}

function mapJob(j: any): AsaJobSummary {
  return {
    name: j.name,
    id: j.id,
    location: j.location,
    state: j.properties?.jobState,
    jobState: j.properties?.jobState,
    sku: j.properties?.sku?.name,
    streamingUnits: j.properties?.transformation?.properties?.streamingUnits,
    lastOutputEventTime: j.properties?.lastOutputEventTime,
  };
}

export async function listJobs(): Promise<AsaJobSummary[]> {
  const cfg = readAsaConfig();
  const r = await call(`${rgBase(cfg)}?api-version=${API}`);
  const body = await jsonOrThrow<{ value?: any[] }>(r, 'ASA list');
  return (body.value || []).map(mapJob);
}

export async function getJob(name: string): Promise<AsaJobDetail> {
  const cfg = readAsaConfig();
  const url = `${rgBase(cfg)}/${encodeURIComponent(name)}?api-version=${API}&$expand=inputs,outputs,transformation,functions`;
  const r = await call(url);
  const body = await jsonOrThrow<any>(r, 'ASA get');
  const base = mapJob(body);
  const inputs: AsaInput[] = (body.properties?.inputs || []).map((i: any) => ({
    name: i.name,
    type: i.properties?.type || 'Stream',
    serialization: i.properties?.serialization?.type,
  }));
  const outputs: AsaOutput[] = (body.properties?.outputs || []).map((o: any) => ({
    name: o.name,
    type: o.properties?.datasource?.type || 'Unknown',
  }));
  return {
    ...base,
    inputs,
    outputs,
    query: body.properties?.transformation?.properties?.query,
  };
}

export async function saveTransformation(name: string, query: string): Promise<void> {
  const cfg = readAsaConfig();
  const getRes = await call(`${rgBase(cfg)}/${encodeURIComponent(name)}?api-version=${API}&$expand=transformation`);
  const cur = await jsonOrThrow<any>(getRes, 'ASA get-for-transform');
  const xName = cur.properties?.transformation?.name || 'Transformation';
  const su = cur.properties?.transformation?.properties?.streamingUnits ?? 3;
  const url = `${rgBase(cfg)}/${encodeURIComponent(name)}/transformations/${encodeURIComponent(xName)}?api-version=${API}`;
  const body = { properties: { streamingUnits: su, query } };
  const r = await call(url, { method: 'PUT', body: JSON.stringify(body) });
  if (!r.ok && r.status !== 201) {
    const text = await r.text().catch(() => '');
    throw new Error(`ASA save-transformation failed ${r.status}: ${text.slice(0, 600)}`);
  }
}

export async function startJob(name: string): Promise<void> {
  const cfg = readAsaConfig();
  const url = `${rgBase(cfg)}/${encodeURIComponent(name)}/start?api-version=${API}`;
  const r = await call(url, {
    method: 'POST',
    body: JSON.stringify({ outputStartMode: 'JobStartTime' }),
  });
  if (!r.ok && r.status !== 202) {
    const text = await r.text().catch(() => '');
    throw new Error(`ASA start failed ${r.status}: ${text.slice(0, 600)}`);
  }
}

export async function stopJob(name: string): Promise<void> {
  const cfg = readAsaConfig();
  const url = `${rgBase(cfg)}/${encodeURIComponent(name)}/stop?api-version=${API}`;
  const r = await call(url, { method: 'POST' });
  if (!r.ok && r.status !== 202) {
    const text = await r.text().catch(() => '');
    throw new Error(`ASA stop failed ${r.status}: ${text.slice(0, 600)}`);
  }
}

// ---------------------------------------------------------------------------
// Inputs (Microsoft.StreamAnalytics/streamingjobs/{job}/inputs/{name})
// ---------------------------------------------------------------------------

export type AsaInputType = 'Stream' | 'Reference';
export type AsaSerializationFormat = 'Json' | 'Csv' | 'Avro';

export interface AsaInputCreateSpec {
  name: string;
  inputType: AsaInputType;
  datasourceType:
    | 'Microsoft.EventHub/EventHub'
    | 'Microsoft.ServiceBus/EventHub'
    | 'Microsoft.Devices/IotHubs'
    | 'Microsoft.Storage/Blob';
  // datasource-specific
  eventHubName?: string;
  serviceBusNamespace?: string;
  sharedAccessPolicyName?: string;
  sharedAccessPolicyKey?: string;
  consumerGroupName?: string;
  iotHubNamespace?: string;
  endpoint?: string;
  storageAccount?: string;
  storageAccountKey?: string;
  container?: string;
  pathPattern?: string;
  dateFormat?: string;
  timeFormat?: string;
  // serialization
  serialization: AsaSerializationFormat;
  fieldDelimiter?: string;
  encoding?: 'UTF8';
}

function buildInputProperties(spec: AsaInputCreateSpec): any {
  const datasource: any = { type: spec.datasourceType, properties: {} };
  switch (spec.datasourceType) {
    case 'Microsoft.EventHub/EventHub':
    case 'Microsoft.ServiceBus/EventHub':
      datasource.properties = {
        eventHubName: spec.eventHubName,
        serviceBusNamespace: spec.serviceBusNamespace,
        sharedAccessPolicyName: spec.sharedAccessPolicyName,
        sharedAccessPolicyKey: spec.sharedAccessPolicyKey,
        consumerGroupName: spec.consumerGroupName,
      };
      break;
    case 'Microsoft.Devices/IotHubs':
      datasource.properties = {
        iotHubNamespace: spec.iotHubNamespace,
        sharedAccessPolicyName: spec.sharedAccessPolicyName,
        sharedAccessPolicyKey: spec.sharedAccessPolicyKey,
        consumerGroupName: spec.consumerGroupName,
        endpoint: spec.endpoint || 'messages/events',
      };
      break;
    case 'Microsoft.Storage/Blob':
      datasource.properties = {
        storageAccounts: [
          { accountName: spec.storageAccount, accountKey: spec.storageAccountKey },
        ],
        container: spec.container,
        pathPattern: spec.pathPattern || '',
        dateFormat: spec.dateFormat || 'yyyy/MM/dd',
        timeFormat: spec.timeFormat || 'HH',
      };
      break;
  }

  const serialization: any = { type: spec.serialization, properties: {} };
  if (spec.serialization === 'Csv') {
    serialization.properties = {
      fieldDelimiter: spec.fieldDelimiter || ',',
      encoding: spec.encoding || 'UTF8',
    };
  } else if (spec.serialization === 'Json') {
    serialization.properties = { encoding: spec.encoding || 'UTF8' };
  }

  return {
    type: spec.inputType,
    datasource,
    serialization,
  };
}

export async function createOrUpdateInput(
  jobName: string,
  spec: AsaInputCreateSpec,
): Promise<{ id: string; name: string }> {
  const cfg = readAsaConfig();
  const url = `${rgBase(cfg)}/${encodeURIComponent(jobName)}/inputs/${encodeURIComponent(spec.name)}?api-version=${API}`;
  const body = { properties: buildInputProperties(spec) };
  const r = await call(url, { method: 'PUT', body: JSON.stringify(body) });
  if (!r.ok && r.status !== 201) {
    const text = await r.text().catch(() => '');
    throw new Error(`ASA create-input failed ${r.status}: ${text.slice(0, 600)}`);
  }
  const j = (await r.json().catch(() => ({}))) as any;
  return { id: j?.id ?? '', name: j?.name ?? spec.name };
}

export async function deleteInput(jobName: string, inputName: string): Promise<void> {
  const cfg = readAsaConfig();
  const url = `${rgBase(cfg)}/${encodeURIComponent(jobName)}/inputs/${encodeURIComponent(inputName)}?api-version=${API}`;
  const r = await call(url, { method: 'DELETE' });
  if (!r.ok && r.status !== 204 && r.status !== 200) {
    const text = await r.text().catch(() => '');
    throw new Error(`ASA delete-input failed ${r.status}: ${text.slice(0, 600)}`);
  }
}

// ---------------------------------------------------------------------------
// Outputs (Microsoft.StreamAnalytics/streamingjobs/{job}/outputs/{name})
// ---------------------------------------------------------------------------

export interface AsaOutputCreateSpec {
  name: string;
  datasourceType:
    | 'Microsoft.Sql/Server/Database'
    | 'Microsoft.Storage/Blob'
    | 'Microsoft.Storage/Table'
    | 'Microsoft.ServiceBus/Queue'
    | 'Microsoft.ServiceBus/Topic'
    | 'Microsoft.EventHub/EventHub'
    | 'Microsoft.DBForPostgreSQL/servers/databases'
    | 'PowerBI'
    | 'Microsoft.DataLake/Accounts'
    | 'Microsoft.Kusto/clusters/databases';
  // sql
  server?: string;
  database?: string;
  user?: string;
  password?: string;
  table?: string;
  // blob/adls
  storageAccount?: string;
  storageAccountKey?: string;
  container?: string;
  pathPattern?: string;
  dateFormat?: string;
  timeFormat?: string;
  // service bus
  namespace?: string;
  queueName?: string;
  topicName?: string;
  sharedAccessPolicyName?: string;
  sharedAccessPolicyKey?: string;
  // event hub
  eventHubName?: string;
  // power bi
  dataset?: string;
  refreshToken?: string;
  groupId?: string;
  groupName?: string;
  // kusto / adx
  kustoClusterUrl?: string;
  kustoDatabase?: string;
  kustoTable?: string;
  // serialization
  serialization?: AsaSerializationFormat;
}

function buildOutputProperties(spec: AsaOutputCreateSpec): any {
  const ds: any = { type: spec.datasourceType, properties: {} };
  switch (spec.datasourceType) {
    case 'Microsoft.Sql/Server/Database':
      ds.properties = {
        server: spec.server,
        database: spec.database,
        user: spec.user,
        password: spec.password,
        table: spec.table,
      };
      break;
    case 'Microsoft.Storage/Blob':
      ds.properties = {
        storageAccounts: [{ accountName: spec.storageAccount, accountKey: spec.storageAccountKey }],
        container: spec.container,
        pathPattern: spec.pathPattern || '',
        dateFormat: spec.dateFormat || 'yyyy/MM/dd',
        timeFormat: spec.timeFormat || 'HH',
      };
      break;
    case 'Microsoft.Storage/Table':
      ds.properties = {
        accountName: spec.storageAccount,
        accountKey: spec.storageAccountKey,
        table: spec.table,
        partitionKey: 'partition',
        rowKey: 'rowKey',
      };
      break;
    case 'Microsoft.ServiceBus/Queue':
      ds.properties = {
        queueName: spec.queueName,
        serviceBusNamespace: spec.namespace,
        sharedAccessPolicyName: spec.sharedAccessPolicyName,
        sharedAccessPolicyKey: spec.sharedAccessPolicyKey,
      };
      break;
    case 'Microsoft.ServiceBus/Topic':
      ds.properties = {
        topicName: spec.topicName,
        serviceBusNamespace: spec.namespace,
        sharedAccessPolicyName: spec.sharedAccessPolicyName,
        sharedAccessPolicyKey: spec.sharedAccessPolicyKey,
      };
      break;
    case 'Microsoft.EventHub/EventHub':
      ds.properties = {
        eventHubName: spec.eventHubName,
        serviceBusNamespace: spec.namespace,
        sharedAccessPolicyName: spec.sharedAccessPolicyName,
        sharedAccessPolicyKey: spec.sharedAccessPolicyKey,
      };
      break;
    case 'PowerBI':
      ds.properties = {
        dataset: spec.dataset,
        table: spec.table,
        refreshToken: spec.refreshToken,
        groupId: spec.groupId,
        groupName: spec.groupName,
      };
      break;
    case 'Microsoft.Kusto/clusters/databases':
      ds.properties = {
        cluster: spec.kustoClusterUrl,
        database: spec.kustoDatabase,
        table: spec.kustoTable,
      };
      break;
  }

  const out: any = { datasource: ds };
  if (spec.serialization) {
    out.serialization = {
      type: spec.serialization,
      properties:
        spec.serialization === 'Csv'
          ? { fieldDelimiter: ',', encoding: 'UTF8' }
          : { encoding: 'UTF8' },
    };
  }
  return out;
}

export async function createOrUpdateOutput(
  jobName: string,
  spec: AsaOutputCreateSpec,
): Promise<{ id: string; name: string }> {
  const cfg = readAsaConfig();
  const url = `${rgBase(cfg)}/${encodeURIComponent(jobName)}/outputs/${encodeURIComponent(spec.name)}?api-version=${API}`;
  const body = { properties: buildOutputProperties(spec) };
  const r = await call(url, { method: 'PUT', body: JSON.stringify(body) });
  if (!r.ok && r.status !== 201) {
    const text = await r.text().catch(() => '');
    throw new Error(`ASA create-output failed ${r.status}: ${text.slice(0, 600)}`);
  }
  const j = (await r.json().catch(() => ({}))) as any;
  return { id: j?.id ?? '', name: j?.name ?? spec.name };
}

export async function deleteOutput(jobName: string, outputName: string): Promise<void> {
  const cfg = readAsaConfig();
  const url = `${rgBase(cfg)}/${encodeURIComponent(jobName)}/outputs/${encodeURIComponent(outputName)}?api-version=${API}`;
  const r = await call(url, { method: 'DELETE' });
  if (!r.ok && r.status !== 204 && r.status !== 200) {
    const text = await r.text().catch(() => '');
    throw new Error(`ASA delete-output failed ${r.status}: ${text.slice(0, 600)}`);
  }
}
