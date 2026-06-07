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

// Cloud-aware endpoint hosts. Default to Azure Commercial; override per
// sovereign cloud via env so the same code path works in GCC / GCC-High / IL5:
//   AZURE_ARM_HOST=management.usgovcloudapi.net
//   AZURE_SYNAPSE_DEV_HOST_SUFFIX=dev.azuresynapse.usgovcloudapi.net
// The Livy/ARM API versions + paths are identical across clouds — only the host
// (and therefore the token audience, handled automatically by the credential)
// changes.
const ARM_HOST = process.env.AZURE_ARM_HOST || 'management.azure.com';
const DEV_HOST_SUFFIX = process.env.AZURE_SYNAPSE_DEV_HOST_SUFFIX || 'dev.azuresynapse.net';

const ARM_SCOPE = `https://${ARM_HOST}/.default`;
const DEV_SCOPE = `https://${DEV_HOST_SUFFIX}/.default`;
const ARM_API = '2021-06-01';
const DEV_API = '2020-12-01';
const LIVY_API = '2019-11-01-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
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
  return `https://${ARM_HOST}/subscriptions/${sub()}/resourceGroups/${rg()}/providers/Microsoft.Synapse/workspaces/${ws()}`;
}

export function devBase(): string {
  // Sovereign-cloud aware. Prefer the explicit LOOM_SYNAPSE_DEV_SUFFIX
  // (e.g. `azuresynapse.us` for GCC-High / DoD), otherwise use the
  // AZURE_SYNAPSE_DEV_HOST_SUFFIX host (default `dev.azuresynapse.net`).
  const suffix = process.env.LOOM_SYNAPSE_DEV_SUFFIX;
  if (suffix) return `https://${ws()}.dev.${suffix}`;
  return `https://${ws()}.${DEV_HOST_SUFFIX}`;
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

/**
 * Synapse dev artifact PUTs (pipelines / datasets / linked services / triggers)
 * are LONG-RUNNING operations: a 202 means "accepted", NOT "committed". The
 * artifact only exists once the async operation reaches Succeeded — and it can
 * reach Failed when the artifact references something that doesn't resolve (a
 * missing dataset / linked service / pool), in which case the entity is NEVER
 * created. Treating the 202 as success (the old behaviour) reported "created"
 * for artifacts that silently failed to commit — the root cause of later
 * "Entity <name> not found" errors on debug/run.
 *
 * This polls the operation to a terminal state and throws the REAL error on
 * failure. On 200 (synchronous commit) it returns immediately.
 *
 * Docs: https://learn.microsoft.com/rest/api/synapse/data-plane/pipeline/create-or-update-pipeline
 *       (202 + Location header → GET operationResults until terminal)
 */
async function commitArtifact<T>(r: Response, label: string): Promise<T> {
  if (!r.ok && r.status !== 202) {
    throw new Error(`${label} failed ${r.status}: ${await r.text()}`);
  }
  if (r.status !== 202) {
    const text = await r.text();
    if (!text) return {} as T;
    try { return JSON.parse(text) as T; } catch { return {} as T; }
  }
  // 202 — poll the operation. Synapse returns a Location (operationResults) URL.
  const loc = r.headers.get('location') || r.headers.get('Location');
  // Capture the 202 body (often the artifact echo) so we can still return it.
  let accepted: T = {} as T;
  try { const t = await r.text(); if (t) accepted = JSON.parse(t) as T; } catch { /* ignore */ }
  if (!loc) return accepted; // no operation URL — best effort.

  const tok = await credential.getToken(DEV_SCOPE);
  if (!tok?.token) throw new Error('Failed to acquire Synapse dev token');
  const deadline = Date.now() + 90_000; // commit settles in seconds; cap at 90s.
  let delay = 1000;
  // The Location is an absolute URL on the dev host.
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, delay));
    delay = Math.min(delay * 1.5, 5000);
    const pr = await fetch(loc, { headers: { authorization: `Bearer ${tok.token}` } });
    if (pr.status === 202) continue; // still running
    const body = await pr.text();
    let parsed: any = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch { /* non-JSON */ }
    const status = (parsed?.status || '').toString();
    if (!pr.ok) {
      throw new Error(`${label} commit failed ${pr.status}: ${body || '(no body)'}`);
    }
    if (status === 'Failed' || status === 'Cancelled') {
      const detail = parsed?.error?.message || parsed?.error?.code || body || 'unknown';
      throw new Error(`${label} did not commit (${status}): ${detail}`);
    }
    if (status === '' || status === 'Succeeded') {
      // Succeeded (or a terminal 200 with the artifact body).
      return (parsed && Object.keys(parsed).length ? parsed : accepted) as T;
    }
    // InProgress / Accepted → keep polling.
  }
  throw new Error(`${label} did not commit within 90s (operation still in progress)`);
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

/**
 * Scale a Spark Big Data pool. Either set a fixed `nodeCount` (and disable
 * autoScale) OR provide an `autoScale: { enabled, minNodeCount, maxNodeCount }`
 * block to use autoscale. Mirrors the Synapse Studio "Scale" dialog.
 *
 * Implemented as a PATCH against the ARM bigDataPools resource. The Synapse
 * RP supports targeted property updates without re-PUTing the full body, so
 * we send only the scale-related properties + the location (required).
 */
export async function scaleSparkPool(
  name: string,
  spec: {
    nodeCount?: number;
    autoScale?: { enabled: boolean; minNodeCount: number; maxNodeCount: number };
    location?: string;
  },
): Promise<SparkPool> {
  const properties: Record<string, unknown> = {};
  if (typeof spec.nodeCount === 'number') properties.nodeCount = spec.nodeCount;
  if (spec.autoScale) properties.autoScale = spec.autoScale;
  if (!Object.keys(properties).length) {
    throw new Error('scaleSparkPool: provide nodeCount or autoScale');
  }
  const body: Record<string, unknown> = { properties };
  if (spec.location) body.location = spec.location;
  const r = await callArm(`${armBase()}/bigDataPools/${name}?api-version=${ARM_API}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return jsonOrThrow<SparkPool>(r, `scaleSparkPool(${name})`);
}

/**
 * Update auto-pause behaviour on a Spark Big Data pool. delayInMinutes is
 * the idle threshold before the pool auto-pauses. Setting `enabled: false`
 * disables auto-pause entirely (Spark idles forever).
 *
 * Synapse RP rejects PATCH on a pool that's in a transient provisioning
 * state — surface the 4xx verbatim so the BFF can show the message bar.
 */
export async function setSparkPoolAutoPause(
  name: string,
  spec: { enabled: boolean; delayInMinutes?: number; location?: string },
): Promise<SparkPool> {
  if (spec.enabled && (spec.delayInMinutes == null || spec.delayInMinutes < 5)) {
    throw new Error('setSparkPoolAutoPause: delayInMinutes must be ≥ 5 when enabled');
  }
  const properties: Record<string, unknown> = {
    autoPause: spec.enabled
      ? { enabled: true, delayInMinutes: spec.delayInMinutes }
      : { enabled: false },
  };
  const body: Record<string, unknown> = { properties };
  if (spec.location) body.location = spec.location;
  const r = await callArm(`${armBase()}/bigDataPools/${name}?api-version=${ARM_API}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return jsonOrThrow<SparkPool>(r, `setSparkPoolAutoPause(${name})`);
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
  return commitArtifact<SynapsePipeline>(r, `upsertPipeline(${name})`);
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

// ============================================================
// Synapse triggers (dev REST — same surface as ADF, distinct host)
// ============================================================

export interface SynapseTrigger {
  id?: string;
  name: string;
  type?: string;
  etag?: string;
  properties: {
    type: 'ScheduleTrigger' | 'TumblingWindowTrigger' | 'BlobEventsTrigger' | 'CustomEventsTrigger' | string;
    description?: string;
    runtimeState?: 'Started' | 'Stopped' | 'Disabled';
    pipelines?: Array<{
      pipelineReference: { referenceName: string; type: 'PipelineReference' };
      parameters?: Record<string, unknown>;
    }>;
    annotations?: unknown[];
    typeProperties?: Record<string, unknown>;
  };
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

/**
 * Debug a Synapse Pipeline — creates a run with `isRecovery=false`
 * and `?isDebugRun=true`, which Synapse Studio uses to evaluate
 * activities against the in-memory edited spec rather than the saved
 * spec. Returns the runId so the editor can poll status.
 *
 * Note: Synapse Studio also supports passing override activity specs
 * via a separate POST body (`debugInfo`); we omit that for now since
 * the editor only debugs the persisted spec.
 */
export async function debugPipeline(
  name: string,
  params?: Record<string, unknown>,
): Promise<PipelineRunResponse> {
  const r = await callDev(
    `/pipelines/${encodeURIComponent(name)}/createRun?api-version=${DEV_API}&isRecovery=false&isDebugRun=true`,
    { method: 'POST', body: JSON.stringify(params || {}) },
  );
  return jsonOrThrow<PipelineRunResponse>(r, `debugPipeline(${name})`);
}

// ============================================================
// Triggers (dev endpoint — Synapse Integrate)
// ============================================================

export async function listTriggers(): Promise<SynapseTrigger[]> {
  const r = await callDev(`/triggers?api-version=${DEV_API}`);
  const body = await jsonOrThrow<{ value: SynapseTrigger[] }>(r, 'listTriggers');
  return body.value || [];
}

export async function getTrigger(name: string): Promise<SynapseTrigger> {
  const r = await callDev(`/triggers/${encodeURIComponent(name)}?api-version=${DEV_API}`);
  return jsonOrThrow<SynapseTrigger>(r, `getTrigger(${name})`);
}

export async function upsertTrigger(name: string, spec: SynapseTrigger): Promise<SynapseTrigger> {
  const body = { name: spec.name || name, properties: spec.properties };
  const r = await callDev(
    `/triggers/${encodeURIComponent(name)}?api-version=${DEV_API}`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
  return commitArtifact<SynapseTrigger>(r, `upsertTrigger(${name})`);
}

export async function deleteTrigger(name: string): Promise<void> {
  const r = await callDev(`/triggers/${encodeURIComponent(name)}?api-version=${DEV_API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 204) {
    throw new Error(`deleteTrigger failed ${r.status}: ${await r.text()}`);
  }
}

export async function startTrigger(name: string): Promise<void> {
  const r = await callDev(
    `/triggers/${encodeURIComponent(name)}/start?api-version=${DEV_API}`,
    { method: 'POST' },
  );
  if (!r.ok && r.status !== 200 && r.status !== 202) {
    throw new Error(`startTrigger failed ${r.status}: ${await r.text()}`);
  }
}

export async function stopTrigger(name: string): Promise<void> {
  const r = await callDev(
    `/triggers/${encodeURIComponent(name)}/stop?api-version=${DEV_API}`,
    { method: 'POST' },
  );
  if (!r.ok && r.status !== 200 && r.status !== 202) {
    throw new Error(`stopTrigger failed ${r.status}: ${await r.text()}`);
  }
}

/** Helper: filter listTriggers() to those that reference a given pipeline name. */
export async function listTriggersForPipeline(pipelineName: string): Promise<SynapseTrigger[]> {
  const all = await listTriggers();
  return all.filter((t) =>
    (t.properties.pipelines || []).some(
      (p) => p.pipelineReference?.referenceName === pipelineName,
    ),
  );
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

/**
 * Run a single Spark SQL statement against a Synapse Spark pool via Livy and
 * wait for it to complete. Used for lakehouse schema DDL (CREATE SCHEMA,
 * ALTER TABLE … RENAME TO, DROP SCHEMA) where the BFF must confirm the DDL
 * actually committed before patching the registry.
 *
 * Creates an interactive `sql`-kind session, polls it to 'idle' (Spark cold
 * start can take 60-90s), submits the statement, then polls the statement to a
 * terminal state. Throws the real Spark error verbatim on failure so the BFF
 * can surface it in a MessageBar. Returns the statement output text on success.
 */
export async function runSparkSqlAndWait(poolName: string, sql: string): Promise<{ output: string }> {
  // 1) Create + poll session to idle.
  const sess = await createLivySessionAsync(poolName, 'sql', `loom-schema-ddl-${Date.now()}`);
  let sessState = sess.state;
  for (let i = 0; i < 60 && sessState !== 'idle'; i++) {
    if (sessState === 'error' || sessState === 'dead' || sessState === 'killed') {
      throw new Error(`Spark session ${sess.id} entered terminal state '${sessState}' before becoming ready`);
    }
    await new Promise((res) => setTimeout(res, 3000));
    sessState = (await getLivySession(poolName, sess.id)).state;
  }
  if (sessState !== 'idle') {
    throw new Error(`Spark session ${sess.id} not ready after 3 min — current state '${sessState}'. Pool may be undersized or auto-paused.`);
  }

  // 2) Submit the SQL statement.
  const stmt = await submitLivyStatement(poolName, sess.id, { code: sql, kind: 'sql' });

  // 3) Poll the statement to a terminal state.
  let st: { id: number; state: string; output?: any } = { id: stmt.id, state: stmt.state };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (st.state === 'available' || st.state === 'error' || st.state === 'cancelled') break;
    await new Promise((res) => setTimeout(res, 2000));
    st = await getLivyStatement(poolName, sess.id, stmt.id);
  }
  const out = st.output || {};
  // Livy statement output: { status: 'ok' | 'error', evalue?, traceback?, data? }
  if (st.state !== 'available' || out.status === 'error') {
    const detail = out.evalue || (Array.isArray(out.traceback) ? out.traceback.join('') : '') || `statement state '${st.state}'`;
    throw new Error(`Spark SQL failed: ${detail}`);
  }
  const text = out?.data?.['text/plain'] || '';
  return { output: typeof text === 'string' ? text : JSON.stringify(text) };
}

/**
 * List the Dedicated SQL pools attached to the Loom Synapse workspace via
 * ARM. Returns the raw ARM shape (name + status + sku) — callers only need
 * those fields for compute-target discovery. Returns [] if the workspace
 * env var is missing; surfaces ARM errors verbatim.
 */
export async function listDedicatedSqlPools(): Promise<Array<{ name: string; status?: string; sku?: { name?: string } }>> {
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) return [];
  const r = await callArm(`${armBase()}/sqlPools?api-version=${ARM_API}`);
  const body = await jsonOrThrow<{ value?: Array<{ name: string; properties?: { status?: string }; sku?: { name?: string } }> }>(r, 'listDedicatedSqlPools');
  return (body.value || []).map((p) => ({
    name: p.name,
    status: p.properties?.status,
    sku: p.sku,
  }));
}

/**
 * Resume a specific Synapse Dedicated SQL pool by name (ARM REST POST .../resume).
 * Used by /api/loom/compute-targets/[id]/start when the id starts with
 * "dedicated-sql:".
 */
export async function resumeDedicatedPool(name: string): Promise<void> {
  if (!name) throw new Error('resumeDedicatedPool: name is required');
  const r = await callArm(`${armBase()}/sqlPools/${encodeURIComponent(name)}/resume?api-version=${ARM_API}`, { method: 'POST' });
  if (!r.ok && r.status !== 202) {
    throw new Error(`resumeDedicatedPool(${name}) failed ${r.status}: ${await r.text()}`);
  }
}

/**
 * Pause a specific Synapse Dedicated SQL pool by name (ARM REST POST .../pause).
 * Used by /api/loom/compute-targets/[id]/stop when the id starts with
 * "dedicated-sql:".
 */
export async function pauseDedicatedPool(name: string): Promise<void> {
  if (!name) throw new Error('pauseDedicatedPool: name is required');
  const r = await callArm(`${armBase()}/sqlPools/${encodeURIComponent(name)}/pause?api-version=${ARM_API}`, { method: 'POST' });
  if (!r.ok && r.status !== 202) {
    throw new Error(`pauseDedicatedPool(${name}) failed ${r.status}: ${await r.text()}`);
  }
}

/**
 * Update the SKU (DWU service objective) for a Synapse Dedicated SQL pool.
 * Valid SKU names are DW100c, DW200c, DW300c, DW400c, DW500c, DW1000c,
 * DW1500c, DW2000c, DW2500c, DW3000c, DW5000c, DW6000c, DW7500c, DW10000c,
 * DW15000c, DW30000c.
 *
 * ARM call: PATCH /.../sqlPools/{name} with body
 *   { sku: { name: '<DWxxxxc>' } }
 *
 * Scale operation is asynchronous; the pool state moves to "Scaling" for
 * a few minutes then back to "Online". Returns the immediate ARM response;
 * polling for completion is the caller's responsibility.
 */
export async function updateDedicatedPoolSku(
  name: string,
  newSku: string,
): Promise<{ name: string; sku?: { name?: string; tier?: string }; properties?: any }> {
  if (!name) throw new Error('updateDedicatedPoolSku: name is required');
  if (!newSku || !/^DW\d+c$/i.test(newSku)) {
    throw new Error(`updateDedicatedPoolSku: invalid sku ${newSku}; expected DWxxxxc`);
  }
  const r = await callArm(
    `${armBase()}/sqlPools/${encodeURIComponent(name)}?api-version=${ARM_API}`,
    { method: 'PATCH', body: JSON.stringify({ sku: { name: newSku } }) },
  );
  return jsonOrThrow(r, `updateDedicatedPoolSku(${name},${newSku})`);
}

/**
 * Get a single dedicated SQL pool's current state + SKU (for the scaling
 * card's "current" indicator).
 */
export async function getDedicatedPool(name: string): Promise<{ name: string; sku?: { name?: string; tier?: string }; properties?: any }> {
  if (!name) throw new Error('getDedicatedPool: name is required');
  const r = await callArm(`${armBase()}/sqlPools/${encodeURIComponent(name)}?api-version=${ARM_API}`);
  return jsonOrThrow(r, `getDedicatedPool(${name})`);
}

