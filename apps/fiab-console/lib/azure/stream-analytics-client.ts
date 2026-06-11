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
 * No mocks. Real ARM REST only (sovereign-cloud aware via cloud-endpoints).
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { armBase, armScope } from './cloud-endpoints';

const ARM_SCOPE = armScope();
// 2021-10-01-preview is the management-plane API version that supports
// `authenticationMode: 'Msi'` on Blob/ADLS Gen2 and Kusto/ADX outputs (and
// matches the deploy-planner ASA bicep). It is a superset of 2020-03-01 for
// list/get/transformations/start/stop/inputs/outputs, so we use it throughout.
const API = '2021-10-01-preview';
// The compile/test/sample-input query actions are only exposed on the
// preview API surface (Microsoft.StreamAnalytics/locations/*Query/action).
const API_PREVIEW = '2021-10-01-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
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

/**
 * Thrown when the sample-data Test Query path can't run because no result
 * storage write URI is configured. Compile-query (validation) still works
 * without it; only the "return sample output rows" path needs a place for
 * ASA to write the results.
 */
export class AsaTestNotAvailableError extends Error {
  constructor(public hint: string) {
    super('ASA sample-output Test Query is not available in this deployment.');
    this.name = 'AsaTestNotAvailableError';
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
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.StreamAnalytics/streamingjobs`;
}

/** Subscription/location-scoped base for the compile/test query RP actions. */
function locationBase(cfg: AsaConfig, location: string): string {
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/providers/Microsoft.StreamAnalytics/locations/${encodeURIComponent(location)}`;
}

async function call(url: string, init?: RequestInit): Promise<Response> {
  const tok = await credential.getToken(ARM_SCOPE);
  if (!tok?.token) throw new Error('Failed to acquire ARM token');
  return fetchWithTimeout(url, {
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
export interface AsaFunction { name: string; type?: string; binding?: string; }
export interface AsaJobDetail extends AsaJobSummary {
  inputs?: AsaInput[];
  outputs?: AsaOutput[];
  functions?: AsaFunction[];
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
  const functions: AsaFunction[] = (body.properties?.functions || []).map((f: any) => ({
    name: f.name,
    type: f.properties?.type,
    binding: f.properties?.properties?.binding?.type,
  }));
  return {
    ...base,
    inputs,
    outputs,
    functions,
    query: body.properties?.transformation?.properties?.query,
  };
}

// ---------------------------------------------------------------------------
// Streaming job (Microsoft.StreamAnalytics/streamingjobs/{name})
// ---------------------------------------------------------------------------

export interface AsaJobCreateSpec {
  name: string;
  location: string;        // e.g. 'eastus', 'usgovvirginia'
  streamingUnits?: number; // applied to the default transformation; default 3
}

/**
 * Idempotent ARM PUT to create (or update) a streaming job resource. The job
 * is created with a SystemAssigned identity so it can be granted Kusto / Event
 * Hubs data-plane RBAC independently. 200 = updated, 201 = created.
 */
export async function createOrUpdateJob(
  spec: AsaJobCreateSpec,
): Promise<{ id: string; name: string }> {
  const cfg = readAsaConfig();
  const url = `${rgBase(cfg)}/${encodeURIComponent(spec.name)}?api-version=${API}`;
  const body = {
    location: spec.location,
    identity: { type: 'SystemAssigned' },
    properties: {
      sku: { name: 'Standard' },
      eventsOutOfOrderPolicy: 'Adjust',
      outputErrorPolicy: 'Stop',
      eventsOutOfOrderMaxDelayInSeconds: 5,
      eventsLateArrivalMaxDelayInSeconds: 5,
      dataLocale: 'en-US',
      compatibilityLevel: '1.2',
      jobType: 'Cloud',
      contentStoragePolicy: 'SystemAccount',
    },
  };
  const r = await call(url, { method: 'PUT', body: JSON.stringify(body) });
  if (!r.ok && r.status !== 201) {
    const text = await r.text().catch(() => '');
    throw new Error(`ASA createOrUpdateJob failed ${r.status}: ${text.slice(0, 600)}`);
  }
  const j = (await r.json().catch(() => ({}))) as any;
  return { id: j?.id ?? '', name: j?.name ?? spec.name };
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
    | 'Microsoft.Kusto/clusters/databases';
  /**
   * Auth mode for ARM output datasources that support it (Blob/ADLS Gen2,
   * Kusto/ADX, Event Hub). Default 'Msi' — the ASA job is created with a
   * system-assigned managed identity by both bicep modules, so no connection
   * string / account key is required when RBAC is granted. 'ConnectionString'
   * is selected automatically when a key is supplied.
   */
  authenticationMode?: 'ConnectionString' | 'Msi' | 'UserToken';
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
    case 'Microsoft.Storage/Blob': {
      // ADLS Gen2 is reached through the same Blob datasource type (accountName
      // accepts an ADLS Gen2 account). MSI by default — the ASA job MI must hold
      // "Storage Blob Data Contributor" on the account. ConnectionString only
      // when an explicit account key is supplied.
      const blobMsi = !spec.storageAccountKey && spec.authenticationMode !== 'ConnectionString';
      ds.properties = {
        storageAccounts: [
          blobMsi
            ? { accountName: spec.storageAccount }
            : { accountName: spec.storageAccount, accountKey: spec.storageAccountKey },
        ],
        container: spec.container,
        pathPattern: spec.pathPattern || '',
        dateFormat: spec.dateFormat || 'yyyy/MM/dd',
        timeFormat: spec.timeFormat || 'HH',
        authenticationMode: spec.authenticationMode || (blobMsi ? 'Msi' : 'ConnectionString'),
      };
      break;
    }
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
    case 'Microsoft.EventHub/EventHub': {
      // SAS key when supplied, otherwise MSI (the ASA job MI needs "Azure Event
      // Hubs Data Sender" on the namespace/hub). Custom Event Hub + Activator
      // destinations both route through this type.
      const ehMsi = !spec.sharedAccessPolicyKey && spec.authenticationMode !== 'ConnectionString';
      ds.properties = {
        eventHubName: spec.eventHubName,
        serviceBusNamespace: spec.namespace,
        ...(ehMsi
          ? { authenticationMode: 'Msi' }
          : {
              sharedAccessPolicyName: spec.sharedAccessPolicyName,
              sharedAccessPolicyKey: spec.sharedAccessPolicyKey,
              authenticationMode: 'ConnectionString',
            }),
      };
      break;
    }
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
      // ADX / KQL Database output. MSI by default — the ASA job MI must be
      // granted the AllDatabasesIngestor (or table-scoped ingestor) role on the
      // ADX cluster (Kusto control command / az kusto cluster-principal-assignment).
      ds.properties = {
        cluster: spec.kustoClusterUrl,
        database: spec.kustoDatabase,
        table: spec.kustoTable,
        authenticationMode: spec.authenticationMode || 'Msi',
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

// ---------------------------------------------------------------------------
// Compile / Test query — the ASA "test your query before you start the job"
// surface. These are subscription/location-scoped RP actions exposed on the
// preview API:
//   POST .../locations/{location}/compileQuery  → validate SAQL, real errors
//   POST .../locations/{location}/testQuery     → run SAQL over sample input,
//                                                  write output to a SAS blob
// Built-in role "Stream Analytics Query Tester" (or "Stream Analytics
// Contributor") grants both. No mocks — real ARM, real diagnostics.
// ---------------------------------------------------------------------------

function defaultLocation(): string {
  return process.env.LOOM_ASA_LOCATION || (IS_GOV ? 'usgovvirginia' : 'eastus2');
}

/** Poll an Azure async operation (LRO) until terminal; return the final JSON. */
async function pollLro(initial: Response, label: string, timeoutMs = 60_000): Promise<any> {
  // Synchronous success — body already holds the result.
  if (initial.status === 200) {
    return await initial.json().catch(() => ({}));
  }
  if (initial.status !== 201 && initial.status !== 202) {
    const text = await initial.text().catch(() => '');
    throw new Error(`${label} failed ${initial.status}: ${text.slice(0, 600)}`);
  }
  const opUrl =
    initial.headers.get('azure-asyncoperation') ||
    initial.headers.get('Azure-AsyncOperation') ||
    initial.headers.get('location') ||
    initial.headers.get('Location');
  if (!opUrl) {
    // Some RP actions return 202 with the body inline.
    return await initial.json().catch(() => ({}));
  }
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() > deadline) {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s waiting on ${opUrl}`);
    }
    await new Promise((res) => setTimeout(res, 2000));
    const pr = await call(opUrl);
    const body = await pr.json().catch(() => ({}));
    const status = (body?.status || body?.properties?.status || '').toString();
    if (/succeeded/i.test(status)) return body;
    if (/failed|canceled|cancelled/i.test(status)) {
      const err = body?.error?.message || body?.properties?.error?.message || JSON.stringify(body).slice(0, 400);
      throw new Error(`${label} ${status}: ${err}`);
    }
    if (pr.status === 200 && !status) {
      // Operation-result endpoints return the final payload with 200 and no
      // running status once complete.
      return body;
    }
  }
}

export interface AsaCompileError {
  message: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  isGlobal?: boolean;
}

export interface AsaCompileResult {
  ok: boolean;
  errors: AsaCompileError[];
  warnings: string[];
  inputs: string[];
  outputs: string[];
  functions: string[];
}

/**
 * Compile (validate) a SAQL query without starting the job. Real ARM call —
 * returns the genuine compiler diagnostics. `inputNames` lets the compiler
 * resolve `FROM [alias]` references against the job's declared inputs.
 */
export async function compileQuery(
  query: string,
  opts?: { location?: string; inputNames?: string[]; functionNames?: string[]; compatibilityLevel?: string },
): Promise<AsaCompileResult> {
  const cfg = readAsaConfig();
  const location = opts?.location || defaultLocation();
  const url = `${locationBase(cfg, location)}/compileQuery?api-version=${API_PREVIEW}`;
  const body = {
    query,
    jobType: 'Cloud',
    compatibilityLevel: opts?.compatibilityLevel || '1.2',
    inputs: (opts?.inputNames || []).map((name) => ({
      name,
      type: 'Microsoft.StreamAnalytics/streamingjobs/inputs',
      properties: { type: 'Stream' },
    })),
    functions: (opts?.functionNames || []).map((name) => ({
      name,
      type: 'Microsoft.StreamAnalytics/streamingjobs/functions',
      properties: { type: 'Scalar' },
    })),
  };
  const r = await call(url, { method: 'POST', body: JSON.stringify(body) });
  const out = await pollLro(r, 'ASA compileQuery');
  const result = out?.properties || out || {};
  const errors: AsaCompileError[] = (result.errors || []).map((e: any) => ({
    message: e.message || String(e),
    startLine: e.startLine,
    startColumn: e.startColumn,
    endLine: e.endLine,
    endColumn: e.endColumn,
    isGlobal: e.isGlobal,
  }));
  return {
    ok: errors.length === 0,
    errors,
    warnings: (result.warnings || []).map((w: any) => (typeof w === 'string' ? w : w?.message || String(w))),
    inputs: result.inputs || [],
    outputs: result.outputs || [],
    functions: result.functions || [],
  };
}

export interface AsaTestSampleInput {
  /** Input alias the events belong to (matches a FROM [alias]). */
  inputAlias: string;
  events: any[];
}

export interface AsaTestResult {
  status: string;
  /** Storage location ASA wrote the test output to (if any). */
  outputUri?: string;
  /** Parsed output rows (when the result blob could be read inline). */
  outputRows: any[];
  errors?: string[];
}

/**
 * Run a SAQL query over sample input events using the ASA Test Query action,
 * and return the produced output rows.
 *
 * ASA's Test Query writes results to a storage location (a blob SAS), so this
 * needs LOOM_ASA_TEST_WRITE_URI (a container SAS URL with write/read). Without
 * it we throw AsaTestNotAvailableError — the route surfaces an honest gate
 * naming the env var + the "Stream Analytics Query Tester" role. The compile
 * path above needs no storage and remains the always-on validation.
 */
export async function testTransformation(
  jobName: string,
  query: string,
  sampleInputs: AsaTestSampleInput[],
): Promise<AsaTestResult> {
  const cfg = readAsaConfig();
  const writeUri = process.env.LOOM_ASA_TEST_WRITE_URI || '';
  if (!writeUri) {
    throw new AsaTestNotAvailableError(
      'Set LOOM_ASA_TEST_WRITE_URI to a blob container SAS URL (write+read) so ASA can write Test Query output, ' +
        'and grant the Loom Console UAMI the "Stream Analytics Query Tester" role (or Stream Analytics Contributor). ' +
        'Bicep: platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep.',
    );
  }

  // Resolve the job's real location + topology so the test reflects the job.
  const job = await getJob(jobName);
  const location = job.location || defaultLocation();
  const inputs = (job.inputs || []).map((i) => {
    const sample = sampleInputs.find((s) => s.inputAlias === i.name);
    return {
      name: i.name,
      type: 'Microsoft.StreamAnalytics/streamingjobs/inputs',
      properties: {
        type: i.type || 'Stream',
        serialization: { type: 'Json', properties: { encoding: 'UTF8' } },
        datasource: sample
          ? { type: 'Raw', properties: { payload: JSON.stringify(sample.events) } }
          : { type: 'Raw', properties: { payload: '[]' } },
      },
    };
  });

  const url = `${locationBase(cfg, location)}/testQuery?api-version=${API_PREVIEW}`;
  const reqBody = {
    diagnostics: { writeUri, path: `loom-asa-test/${jobName}/${Date.now()}` },
    streamingJob: {
      name: jobName,
      location,
      properties: {
        sku: { name: 'Standard' },
        compatibilityLevel: '1.2',
        transformation: { name: 'Transformation', properties: { streamingUnits: 1, query } },
        inputs,
        outputs: (job.outputs || []).map((o) => ({
          name: o.name,
          properties: { datasource: { type: 'Raw', properties: { payload: '' } } },
        })),
      },
    },
  };

  const r = await call(url, { method: 'POST', body: JSON.stringify(reqBody) });
  const out = await pollLro(r, 'ASA testQuery');
  const result = out?.properties || out || {};
  const status = (result.status || out?.status || 'Unknown').toString();
  const outputUri: string | undefined = result.outputUri || result.outputUrl;

  let outputRows: any[] = [];
  if (outputUri) {
    try {
      const blob = await fetchWithTimeout(outputUri);
      if (blob.ok) {
        const text = await blob.text();
        outputRows = parseAsaOutput(text);
      }
    } catch {
      // Output written but not inline-readable (e.g. SAS scope). Status +
      // outputUri are still returned as the receipt.
    }
  }
  return { status, outputUri, outputRows, errors: result.error ? [String(result.error?.message || result.error)] : undefined };
}

/** ASA test output is JSON-lines or a JSON array; parse defensively. */
function parseAsaOutput(text: string): any[] {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  try {
    const j = JSON.parse(trimmed);
    return Array.isArray(j) ? j : [j];
  } catch {
    // newline-delimited JSON
    const rows: any[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      try {
        rows.push(JSON.parse(l));
      } catch {
        /* skip non-JSON line */
      }
    }
    return rows;
  }
}
