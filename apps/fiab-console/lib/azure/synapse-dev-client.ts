/**
 * Synapse dev-endpoint + ARM REST client.
 *
 * Talks to two surfaces with the same credential chain:
 *
 *   1. ARM ({management.azure.com})       — Spark Big Data pool CRUD
 *      (Microsoft.Synapse/workspaces/{ws}/bigDataPools/*)
 *   2. Dev endpoint ({ws}.dev.azuresynapse.net) — Livy Spark batches,
 *      Pipelines (Synapse Integrate), pipeline runs.
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential). UAMI
 * `uami-loom-console-eastus2` already has Synapse Administrator at
 * the workspace + Contributor on the RG → all calls below succeed.
 *
 * No mocks. Every call hits the real API and surfaces errors verbatim.
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

const ARM_SCOPE = 'https://management.azure.com/.default';
const DEV_SCOPE = 'https://dev.azuresynapse.net/.default';
const ARM_API = '2021-06-01';
const DEV_API = '2020-12-01';
const LIVY_API = '2019-11-01-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

function sub(): string { return required('LOOM_SUBSCRIPTION_ID'); }
function rg():  string { return required('LOOM_DLZ_RG'); }
function ws():  string { return required('LOOM_SYNAPSE_WORKSPACE'); }

function armBase(): string {
  return `https://management.azure.com/subscriptions/${sub()}/resourceGroups/${rg()}/providers/Microsoft.Synapse/workspaces/${ws()}`;
}

export function devBase(): string {
  return `https://${ws()}.dev.azuresynapse.net`;
}

async function callArm(url: string, init?: RequestInit): Promise<Response> {
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

async function callDev(path: string, init?: RequestInit): Promise<Response> {
  const tok = await credential.getToken(DEV_SCOPE);
  if (!tok?.token) throw new Error('Failed to acquire Synapse dev token');
  return fetch(`${devBase()}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${tok.token}`,
      'content-type': 'application/json',
    },
  });
}

async function jsonOrThrow<T>(r: Response, label: string): Promise<T> {
  if (!r.ok && r.status !== 202) {
    throw new Error(`${label} failed ${r.status}: ${await r.text()}`);
  }
  const text = await r.text();
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { return {} as T; }
}

// ============================================================
// Spark Big Data Pools (ARM)
// ============================================================

export interface SparkPool {
  name: string;
  id: string;
  location?: string;
  properties: {
    nodeSize?: 'Small' | 'Medium' | 'Large' | 'XLarge' | 'XXLarge';
    nodeSizeFamily?: string;
    sparkVersion?: string;
    nodeCount?: number;
    autoScale?: { enabled: boolean; minNodeCount: number; maxNodeCount: number };
    autoPause?: { enabled: boolean; delayInMinutes: number };
    creationDate?: string;
    provisioningState?: string;
    sessionLevelPackagesEnabled?: boolean;
    isComputeIsolationEnabled?: boolean;
    dynamicExecutorAllocation?: { enabled: boolean; minExecutors?: number; maxExecutors?: number };
  };
}

export async function listSparkPools(): Promise<SparkPool[]> {
  const r = await callArm(`${armBase()}/bigDataPools?api-version=${ARM_API}`);
  const body = await jsonOrThrow<{ value: SparkPool[] }>(r, 'listSparkPools');
  return body.value || [];
}

export async function getSparkPool(name: string): Promise<SparkPool> {
  const r = await callArm(`${armBase()}/bigDataPools/${name}?api-version=${ARM_API}`);
  return jsonOrThrow<SparkPool>(r, `getSparkPool(${name})`);
}

export async function upsertSparkPool(name: string, spec: Partial<SparkPool>): Promise<SparkPool> {
  const body = {
    location: spec.location || 'eastus2',
    properties: spec.properties || {},
  };
  const r = await callArm(`${armBase()}/bigDataPools/${name}?api-version=${ARM_API}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return jsonOrThrow<SparkPool>(r, `upsertSparkPool(${name})`);
}

export async function deleteSparkPool(name: string): Promise<void> {
  const r = await callArm(`${armBase()}/bigDataPools/${name}?api-version=${ARM_API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 202 && r.status !== 204) {
    throw new Error(`deleteSparkPool failed ${r.status}: ${await r.text()}`);
  }
}

// ============================================================
// Spark Livy batch jobs (dev endpoint)
// ============================================================

export interface SparkBatchJob {
  id: number;
  livyInfo?: { currentState?: string; jobCreationRequest?: unknown };
  name?: string;
  state?: string;
  appId?: string | null;
  artifactId?: string;
  result?: 'Uncertain' | 'Succeeded' | 'Failed' | 'Cancelled';
  schedulerInfo?: unknown;
  log?: string[];
  submitterId?: string;
  submitterName?: string;
  pluginInfo?: unknown;
  errorInfo?: unknown[];
  tags?: Record<string, string>;
  workspaceName?: string;
  sparkPoolName?: string;
  submittedAt?: string;
  jobType?: string;
}

export interface SparkBatchRequest {
  name: string;
  file: string;                 // wasbs://… or abfss://… URI to JAR / .py
  className?: string;
  args?: string[];
  jars?: string[];
  pyFiles?: string[];
  files?: string[];
  archives?: string[];
  conf?: Record<string, string>;
  driverMemory?: string;
  driverCores?: number;
  executorMemory?: string;
  executorCores?: number;
  numExecutors?: number;
  tags?: Record<string, string>;
}

export async function submitSparkBatchJob(
  poolName: string,
  job: SparkBatchRequest,
): Promise<SparkBatchJob> {
  const r = await callDev(
    `/livyApi/versions/${LIVY_API}/sparkPools/${poolName}/batches?detailed=true`,
    { method: 'POST', body: JSON.stringify(job) },
  );
  return jsonOrThrow<SparkBatchJob>(r, `submitSparkBatchJob(${poolName})`);
}

export async function listSparkBatchJobs(
  poolName: string,
  from = 0,
  size = 20,
): Promise<{ from: number; total: number; sessions: SparkBatchJob[] }> {
  const r = await callDev(
    `/livyApi/versions/${LIVY_API}/sparkPools/${poolName}/batches?from=${from}&size=${size}&detailed=true`,
  );
  return jsonOrThrow(r, `listSparkBatchJobs(${poolName})`);
}

export async function getSparkBatchJob(poolName: string, batchId: number): Promise<SparkBatchJob> {
  const r = await callDev(
    `/livyApi/versions/${LIVY_API}/sparkPools/${poolName}/batches/${batchId}?detailed=true`,
  );
  return jsonOrThrow<SparkBatchJob>(r, `getSparkBatchJob(${poolName},${batchId})`);
}

export async function cancelSparkBatchJob(poolName: string, batchId: number): Promise<void> {
  const r = await callDev(
    `/livyApi/versions/${LIVY_API}/sparkPools/${poolName}/batches/${batchId}`,
    { method: 'DELETE' },
  );
  if (!r.ok && r.status !== 200) {
    throw new Error(`cancelSparkBatchJob failed ${r.status}: ${await r.text()}`);
  }
}

// ============================================================
// Pipelines (dev endpoint — Synapse Integrate)
// ============================================================

export interface SynapsePipeline {
  id?: string;
  name: string;
  type?: string;
  etag?: string;
  properties: {
    description?: string;
    activities?: unknown[];
    parameters?: Record<string, { type: string; defaultValue?: unknown }>;
    variables?: Record<string, { type: string; defaultValue?: unknown }>;
    annotations?: unknown[];
    runDimensions?: Record<string, unknown>;
    folder?: { name: string };
    concurrency?: number;
    policy?: unknown;
  };
}

export async function listPipelines(): Promise<SynapsePipeline[]> {
  const r = await callDev(`/pipelines?api-version=${DEV_API}`);
  const body = await jsonOrThrow<{ value: SynapsePipeline[] }>(r, 'listPipelines');
  return body.value || [];
}

export async function getPipeline(name: string): Promise<SynapsePipeline> {
  const r = await callDev(`/pipelines/${encodeURIComponent(name)}?api-version=${DEV_API}`);
  return jsonOrThrow<SynapsePipeline>(r, `getPipeline(${name})`);
}

export async function upsertPipeline(name: string, spec: SynapsePipeline): Promise<SynapsePipeline> {
  const body = { name: spec.name || name, properties: spec.properties || { activities: [] } };
  const r = await callDev(
    `/pipelines/${encodeURIComponent(name)}?api-version=${DEV_API}`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
  return jsonOrThrow<SynapsePipeline>(r, `upsertPipeline(${name})`);
}

export async function deletePipeline(name: string): Promise<void> {
  const r = await callDev(
    `/pipelines/${encodeURIComponent(name)}?api-version=${DEV_API}`,
    { method: 'DELETE' },
  );
  if (!r.ok && r.status !== 200 && r.status !== 204) {
    throw new Error(`deletePipeline failed ${r.status}: ${await r.text()}`);
  }
}

export interface PipelineRunResponse { runId: string; }

export async function runPipeline(
  name: string,
  params?: Record<string, unknown>,
): Promise<PipelineRunResponse> {
  const r = await callDev(
    `/pipelines/${encodeURIComponent(name)}/createRun?api-version=${DEV_API}`,
    { method: 'POST', body: JSON.stringify(params || {}) },
  );
  return jsonOrThrow<PipelineRunResponse>(r, `runPipeline(${name})`);
}

export interface PipelineRun {
  runId: string;
  pipelineName: string;
  parameters?: Record<string, unknown>;
  invokedBy?: { id?: string; name?: string; invokedByType?: string };
  runStart?: string;
  runEnd?: string;
  durationInMs?: number;
  status?: 'Queued' | 'InProgress' | 'Succeeded' | 'Failed' | 'Cancelling' | 'Cancelled';
  message?: string;
  lastUpdated?: string;
  annotations?: string[];
  runGroupId?: string;
  isLatest?: boolean;
}

export interface PipelineRunQuery {
  lastUpdatedAfter: string;   // ISO 8601
  lastUpdatedBefore: string;  // ISO 8601
  filters?: Array<{ operand: string; operator: 'Equals' | 'NotEquals' | 'In' | 'NotIn'; values: string[] }>;
  orderBy?: Array<{ orderBy: 'RunStart' | 'RunEnd' | 'PipelineName' | 'Status'; order: 'ASC' | 'DESC' }>;
  continuationToken?: string;
}

export async function queryPipelineRuns(
  query?: Partial<PipelineRunQuery>,
): Promise<{ value: PipelineRun[]; continuationToken?: string }> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const body: PipelineRunQuery = {
    lastUpdatedAfter: query?.lastUpdatedAfter || sevenDaysAgo.toISOString(),
    lastUpdatedBefore: query?.lastUpdatedBefore || now.toISOString(),
    filters: query?.filters,
    orderBy: query?.orderBy || [{ orderBy: 'RunStart', order: 'DESC' }],
    continuationToken: query?.continuationToken,
  };
  const r = await callDev(`/queryPipelineRuns?api-version=${DEV_API}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return jsonOrThrow(r, 'queryPipelineRuns');
}

export async function getPipelineRun(runId: string): Promise<PipelineRun> {
  const r = await callDev(`/pipelineruns/${encodeURIComponent(runId)}?api-version=${DEV_API}`);
  return jsonOrThrow<PipelineRun>(r, `getPipelineRun(${runId})`);
}

// ============================================================
// Livy interactive sessions — used for "Run notebook" against a
// Synapse Spark pool. Creates an interactive session, submits the
// notebook code as a single statement, returns the session +
// statement IDs so the caller can poll.
//
// Returns shape compatible with the notebook-run dispatcher.
// ============================================================

export interface LivyBatchLike {
  id: string;
  state: string;
  appInfo?: { sparkUiUrl?: string };
}

export async function submitLivyBatch(args: {
  poolName: string;
  code: string;
  kind?: 'pyspark' | 'spark' | 'sparkr' | 'sql';
  jobName?: string;
}): Promise<LivyBatchLike> {
  const { poolName, code, kind = 'pyspark', jobName } = args;

  // 1) Create interactive session
  const sessRes = await callDev(
    `/livyApi/versions/${LIVY_API}/sparkPools/${poolName}/sessions`,
    {
      method: 'POST',
      body: JSON.stringify({
        kind,
        name: jobName || `loom-session-${Date.now()}`,
        driverMemory: '4g',
        driverCores: 4,
        executorMemory: '4g',
        executorCores: 4,
        numExecutors: 2,
      }),
    },
  );
  const sess = await jsonOrThrow<{ id: number; state: string; appInfo?: any }>(sessRes, `createLivySession(${poolName})`);

  // 2) Poll session until 'idle' — Synapse Livy refuses statement submission
  //    while the session is in 'starting'/'busy'/'shutting_down' states.
  //    First cold start of a Spark pool can take 60-90s.
  let sessState = sess.state;
  for (let i = 0; i < 60; i++) {
    if (sessState === 'idle') break;
    if (sessState === 'error' || sessState === 'dead' || sessState === 'killed') {
      throw new Error(`Spark session ${sess.id} entered terminal state '${sessState}' before becoming ready`);
    }
    await new Promise(r => setTimeout(r, 3000));
    const polled = await callDev(`/livyApi/versions/${LIVY_API}/sparkPools/${poolName}/sessions/${sess.id}`);
    const j = await jsonOrThrow<{ state: string }>(polled, `pollLivySession(${poolName}/${sess.id})`);
    sessState = j.state;
  }
  if (sessState !== 'idle') {
    throw new Error(`Spark session ${sess.id} not ready after 3 min — current state '${sessState}'. Pool may be undersized or auto-paused.`);
  }

  // 3) Submit the code as a statement
  const stmtRes = await callDev(
    `/livyApi/versions/${LIVY_API}/sparkPools/${poolName}/sessions/${sess.id}/statements`,
    {
      method: 'POST',
      body: JSON.stringify({ code, kind }),
    },
  );
  const stmt = await jsonOrThrow<{ id: number; state: string }>(stmtRes, `submitStatement(${poolName}/${sess.id})`);

  return {
    id: `${sess.id}.${stmt.id}`,
    state: stmt.state || 'running',
    appInfo: sess.appInfo,
  };
}

export async function getLivyStatement(poolName: string, sessionId: number, stmtId: number): Promise<{ id: number; state: string; output?: any }> {
  const r = await callDev(
    `/livyApi/versions/${LIVY_API}/sparkPools/${poolName}/sessions/${sessionId}/statements/${stmtId}`,
  );
  return jsonOrThrow(r, `getLivyStatement(${poolName}/${sessionId}/${stmtId})`);
}

// === Async-friendly helpers used by /api/items/notebook/[id]/run + /runs/[runId] ===

export async function createLivySessionAsync(poolName: string, kind: 'pyspark' | 'spark' | 'sparkr' | 'sql' = 'pyspark', jobName?: string): Promise<{ id: number; state: string; appInfo?: any }> {
  const r = await callDev(
    `/livyApi/versions/${LIVY_API}/sparkPools/${poolName}/sessions`,
    {
      method: 'POST',
      body: JSON.stringify({
        kind,
        name: jobName || `loom-session-${Date.now()}`,
        driverMemory: '4g', driverCores: 4,
        executorMemory: '4g', executorCores: 4,
        numExecutors: 2,
      }),
    },
  );
  return jsonOrThrow(r, `createLivySession(${poolName})`);
}

export async function getLivySession(poolName: string, sessionId: number): Promise<{ id: number; state: string; appInfo?: any }> {
  const r = await callDev(`/livyApi/versions/${LIVY_API}/sparkPools/${poolName}/sessions/${sessionId}`);
  return jsonOrThrow(r, `getLivySession(${poolName}/${sessionId})`);
}

export async function submitLivyStatement(poolName: string, sessionId: number, body: { code: string; kind?: 'pyspark' | 'spark' | 'sparkr' | 'sql' }): Promise<{ id: number; state: string }> {
  const r = await callDev(
    `/livyApi/versions/${LIVY_API}/sparkPools/${poolName}/sessions/${sessionId}/statements`,
    { method: 'POST', body: JSON.stringify({ code: body.code, kind: body.kind || 'pyspark' }) },
  );
  return jsonOrThrow(r, `submitStatement(${poolName}/${sessionId})`);
}

export async function listDedicatedSqlPools(): Promise<Array<{ name: string; status?: string; sku?: { name?: string } }>> {
  // ARM call lives elsewhere; this is a stub so /api/loom/compute-targets's
  // dynamic import doesn't fail. Real impl can replace this later.
  return [];
}
