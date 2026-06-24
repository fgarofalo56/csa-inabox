/**
 * Synapse dev-endpoint + ARM REST client.
 *
 * Talks to two surfaces with the same credential chain:
 *
 *   1. ARM (the cloud's ARM control plane)  — Spark Big Data pool CRUD
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

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armHost, detectLoomCloud } from './cloud-endpoints';
import { discoverResourceCoordsByName } from './resource-graph-coords';

// Cloud-aware endpoint hosts. ARM host comes from cloud-endpoints (AZURE_CLOUD /
// LOOM_ARM_ENDPOINT aware); AZURE_ARM_HOST stays as an explicit per-call override.
//
// The Synapse Studio dev-plane host is sovereign-cloud aware and AUTO-DERIVED
// from detectLoomCloud() — identical to synapse-artifacts-client.ts so the Livy
// Spark-batch submit path (Spark job definition Run) and the artifact CRUD path
// resolve to the SAME host in every boundary. Commercial / GCC run on
// `dev.azuresynapse.net`; GCC-High / IL5 / DoD run on the Azure Government host
// `dev.azuresynapse.usgovcloudapi.net`. Without this split a Gov deployment's
// Livy submit silently hits the Commercial host and 401s on the wrong token
// audience. An explicit env override (AZURE_SYNAPSE_DEV_HOST_SUFFIX) still wins
// for clouds we don't enumerate (e.g. China: `dev.azuresynapse.azure.cn`). The
// Livy/ARM API versions + paths are identical across clouds — only the host
// (and therefore the token audience, handled automatically by the credential)
// changes.
function synapseDevHostSuffix(): string {
  const override = process.env.AZURE_SYNAPSE_DEV_HOST_SUFFIX;
  if (override) return override.replace(/^\.+/, '').replace(/\/+$/, '');
  const cloud = detectLoomCloud();
  return cloud === 'GCC-High' || cloud === 'DoD'
    ? 'dev.azuresynapse.usgovcloudapi.net'
    : 'dev.azuresynapse.net';
}

const ARM_HOST = process.env.AZURE_ARM_HOST || armHost();
const DEV_HOST_SUFFIX = synapseDevHostSuffix();

const ARM_SCOPE = `https://${ARM_HOST}/.default`;
const DEV_SCOPE = `https://${DEV_HOST_SUFFIX}/.default`;
const ARM_API = '2021-06-01';
const DEV_API = '2020-12-01';
const LIVY_API = '2019-11-01-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

// LOOM_SYNAPSE_SUB wins when set (a reused Synapse workspace in another
// subscription, emitted by the BYO wizard); falls back to LOOM_SUBSCRIPTION_ID
// (the deployment sub) when empty so cross-sub reuse hits the right ARM scope.
//
// `target` (optional) is the domain-resolved deploy target from
// `lib/azure/topology.ts → resolveDeployTarget` — when a multi-domain create
// route supplies it, the Synapse ARM scope follows the OWNING domain's DLZ
// subscription + resource group instead of the flat env default. Absent (the
// single-sub default), the env behaviour every existing deployment has today is
// preserved exactly.
export interface SynapseArmTarget { subscriptionId?: string; resourceGroup?: string; }
function sub(t?: SynapseArmTarget): string {
  return (t?.subscriptionId || '').trim() || process.env.LOOM_SYNAPSE_SUB || required('LOOM_SUBSCRIPTION_ID');
}
function rg(t?: SynapseArmTarget): string {
  return (t?.resourceGroup || '').trim() || required('LOOM_DLZ_RG');
}
function ws():  string { return required('LOOM_SYNAPSE_WORKSPACE'); }

function armBase(t?: SynapseArmTarget): string {
  return `https://${ARM_HOST}/subscriptions/${sub(t)}/resourceGroups/${rg(t)}/providers/Microsoft.Synapse/workspaces/${ws()}`;
}

export function devBase(): string {
  // Sovereign-cloud aware. Prefer the explicit LOOM_SYNAPSE_DEV_SUFFIX
  // (e.g. `azuresynapse.us` for an alternate Gov host shape), otherwise use the
  // auto-derived DEV_HOST_SUFFIX (sovereign-aware via detectLoomCloud():
  // `dev.azuresynapse.net` in Commercial/GCC, `dev.azuresynapse.usgovcloudapi.net`
  // in GCC-High/IL5/DoD — or the AZURE_SYNAPSE_DEV_HOST_SUFFIX override).
  const suffix = process.env.LOOM_SYNAPSE_DEV_SUFFIX;
  if (suffix) return `https://${ws()}.dev.${suffix}`;
  return `https://${ws()}.${DEV_HOST_SUFFIX}`;
}

async function callArmRaw(url: string, init?: RequestInit): Promise<Response> {
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

// ---------------------------------------------------------------------------
// DLZ coordinate self-heal (generalized from synapse-pool-arm.ts / PR #1445).
//
// In the multi-sub dlz-attach topology the env resolves the DEFAULT workspace
// coords to the ADMIN plane (LOOM_SYNAPSE_SUB || LOOM_SUBSCRIPTION_ID +
// LOOM_DLZ_RG), but the workspace can actually live in the DLZ sub — so the
// configured control-plane URL (bigDataPools / sqlPools / kustoPools) 404s (or
// 403s). On a 404/403 (or transport error) for a DEFAULT-workspace URL we
// discover the workspace's REAL {subscriptionId, resourceGroup} by name via
// Azure Resource Graph, cache it, and retry by rewriting the
// /subscriptions/<sub>/resourceGroups/<rg> segment — one choke-point fix for
// every control-plane op. Scoped to the DEFAULT workspace: explicit domain
// `target` URLs (armBase(target), which carry authoritative coords) and the
// dev-plane (callDev — no sub/rg in its host) are NOT rewritten.
// ---------------------------------------------------------------------------

let resolvedDefaultCoords: { subscriptionId: string; resourceGroup: string } | null = null;

function defaultWorkspaceSegment(coords: { subscriptionId: string; resourceGroup: string }): string {
  return `/subscriptions/${coords.subscriptionId}/resourceGroups/${coords.resourceGroup}/providers/Microsoft.Synapse/workspaces/${ws()}`;
}

/** True when `url` targets the env-configured DEFAULT workspace (so self-heal is safe). */
function isDefaultWorkspaceUrl(url: string): boolean {
  try {
    return url.includes(defaultWorkspaceSegment({ subscriptionId: sub(), resourceGroup: rg() }));
  } catch {
    return false;
  }
}

async function callArm(url: string, init?: RequestInit): Promise<Response> {
  if (resolvedDefaultCoords && isDefaultWorkspaceUrl(url)) {
    const healed = url.replace(
      defaultWorkspaceSegment({ subscriptionId: sub(), resourceGroup: rg() }),
      defaultWorkspaceSegment(resolvedDefaultCoords),
    );
    return callArmRaw(healed, init);
  }

  const res = await callArmRaw(url, init).catch(() => null);
  if (res && res.ok) return res;

  if ((!res || res.status === 404 || res.status === 403) && isDefaultWorkspaceUrl(url)) {
    const discovered = await discoverResourceCoordsByName({
      resourceType: 'Microsoft.Synapse/workspaces',
      name: ws(),
      credential,
    });
    if (discovered) {
      resolvedDefaultCoords = discovered;
      const healed = url.replace(
        defaultWorkspaceSegment({ subscriptionId: sub(), resourceGroup: rg() }),
        defaultWorkspaceSegment(discovered),
      );
      return callArmRaw(healed, init);
    }
  }
  return res ?? callArmRaw(url, init);
}

async function callDev(path: string, init?: RequestInit): Promise<Response> {
  const tok = await credential.getToken(DEV_SCOPE);
  if (!tok?.token) throw new Error('Failed to acquire Synapse dev token');
  return fetchWithTimeout(`${devBase()}${path}`, {
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
    const pr = await fetchWithTimeout(loc, { headers: { authorization: `Bearer ${tok.token}` } });
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

/**
 * Upsert a linked service by name (Synapse Studio dev REST). Used to
 * auto-provision the linked services a bundled pipeline's activities reference
 * so the pipeline document validates on commit (Synapse rejects a pipeline that
 * references a non-existent linked service: "invalid reference '<name>'").
 */
export async function upsertLinkedService(name: string, properties: Record<string, unknown>): Promise<void> {
  const r = await callDev(
    `/linkedservices/${encodeURIComponent(name)}?api-version=${DEV_API}`,
    { method: 'PUT', body: JSON.stringify({ name, properties }) },
  );
  await commitArtifact<unknown>(r, `upsertLinkedService(${name})`);
}

/** Upsert a dataset by name (Synapse Studio dev REST) — same purpose as
 *  upsertLinkedService: satisfy a pipeline's DatasetReference on commit. */
export async function upsertDataset(name: string, properties: Record<string, unknown>): Promise<void> {
  const r = await callDev(
    `/datasets/${encodeURIComponent(name)}?api-version=${DEV_API}`,
    { method: 'PUT', body: JSON.stringify({ name, properties }) },
  );
  await commitArtifact<unknown>(r, `upsertDataset(${name})`);
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
 * Per-activity output for a single Synapse pipeline run (dev endpoint
 * `/pipelineruns/{runId}/queryActivityruns`). The Pipeline Copilot's error
 * assistant filters these to status==='Failed' to explain the REAL failure
 * (errorCode + message), the Synapse sibling of adf-client.listActivityRuns.
 */
export interface SynapseActivityRun {
  activityRunId: string;
  activityName: string;
  activityType: string;
  pipelineName?: string;
  pipelineRunId?: string;
  status?: 'Queued' | 'InProgress' | 'Succeeded' | 'Failed' | 'Cancelled' | 'Skipped';
  activityRunStart?: string;
  activityRunEnd?: string;
  durationInMs?: number;
  input?: unknown;
  output?: unknown;
  error?: { errorCode?: string; message?: string; failureType?: string };
}

export async function listActivityRuns(
  runId: string,
  windowDays = 1,
): Promise<SynapseActivityRun[]> {
  const now = new Date();
  const start = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const r = await callDev(
    `/pipelineruns/${encodeURIComponent(runId)}/queryActivityruns?api-version=${DEV_API}`,
    {
      method: 'POST',
      body: JSON.stringify({
        lastUpdatedAfter: start.toISOString(),
        lastUpdatedBefore: now.toISOString(),
      }),
    },
  );
  const body = await jsonOrThrow<{ value: SynapseActivityRun[] }>(r, `listActivityRuns(${runId})`);
  return body.value || [];
}

// ============================================================
// Linked services + datasets (dev endpoint) — backs the Pipeline Copilot
// `/` source/dest completion + connection-grounded generation. Same surface
// the Manage hub uses, distinct host from ADF.
// ============================================================

export interface SynapseLinkedService {
  id?: string;
  name: string;
  type?: string;
  properties: { type: string; description?: string; typeProperties?: Record<string, unknown> };
}

export async function listLinkedServices(): Promise<SynapseLinkedService[]> {
  const r = await callDev(`/linkedservices?api-version=${DEV_API}`);
  const body = await jsonOrThrow<{ value: SynapseLinkedService[] }>(r, 'listLinkedServices');
  return body.value || [];
}

export interface SynapseDataset {
  id?: string;
  name: string;
  type?: string;
  properties: {
    type: string;
    linkedServiceName?: { referenceName: string; type: string };
    typeProperties?: Record<string, unknown>;
  };
}

export async function listDatasets(): Promise<SynapseDataset[]> {
  const r = await callDev(`/datasets?api-version=${DEV_API}`);
  const body = await jsonOrThrow<{ value: SynapseDataset[] }>(r, 'listDatasets');
  return body.value || [];
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

/**
 * Per-session sizing knobs surfaced by the notebook editor's "Configure
 * session" dialog. Each maps 1:1 onto a real Livy session-create field. Omit
 * any and the Synapse defaults below apply.
 */
export interface LivySessionSizing {
  numExecutors?: number;
  executorMemory?: string;   // e.g. "4g"
  executorCores?: number;
  driverMemory?: string;     // e.g. "4g"
  driverCores?: number;
  heartbeatTimeoutInSecond?: number;  // session idle timeout
  /**
   * spark.* properties for the Livy session `conf` (from a config preset, the
   * notebook config builder, and/or the Synapse→Log-Analytics diagnostic
   * defaults). Applied at session create — a conf change needs a new session.
   */
  conf?: Record<string, string>;
}

export async function createLivySessionAsync(
  poolName: string,
  kind: 'pyspark' | 'spark' | 'sparkr' | 'sql' = 'pyspark',
  jobName?: string,
  sizing?: LivySessionSizing,
): Promise<{ id: number; state: string; appInfo?: any; request: Record<string, unknown> }> {
  // Build the real Livy session-create body. Sizing overrides the Synapse
  // defaults; the body is returned verbatim so callers can show an honest
  // "Spark session JSON" receipt of exactly what provisioned the session.
  const request: Record<string, unknown> = {
    kind,
    name: jobName || `loom-session-${Date.now()}`,
    driverMemory: sizing?.driverMemory || '4g',
    driverCores: sizing?.driverCores ?? 4,
    executorMemory: sizing?.executorMemory || '4g',
    executorCores: sizing?.executorCores ?? 4,
    numExecutors: sizing?.numExecutors ?? 2,
  };
  if (typeof sizing?.heartbeatTimeoutInSecond === 'number' && sizing.heartbeatTimeoutInSecond > 0) {
    request.heartbeatTimeoutInSecond = sizing.heartbeatTimeoutInSecond;
  }
  // spark.* properties (preset + builder + Synapse→LA diagnostics) → Livy `conf`.
  if (sizing?.conf && Object.keys(sizing.conf).length) {
    request.conf = { ...sizing.conf };
  }
  const r = await callDev(
    `/livyApi/versions/${LIVY_API}/sparkPools/${poolName}/sessions`,
    { method: 'POST', body: JSON.stringify(request) },
  );
  const sess = await jsonOrThrow<{ id: number; state: string; appInfo?: any }>(r, `createLivySession(${poolName})`);
  return { ...sess, request };
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
/**
 * List the Synapse Data Explorer (Kusto) pools on the deployment-default
 * workspace from ARM (Microsoft.Synapse/workspaces/{ws}/kustoPools). These are
 * the workspace-scoped Kusto pools the KQL-script editor's "Connect to"
 * dropdown surfaces. The kustoPools resource uses its own preview api-version
 * (2021-06-01-preview), not the workspace ARM_API. Returns [] (not an error)
 * when the workspace isn't configured so the BFF can render a clean empty
 * dropdown + honest "create a Kusto pool" hint rather than 500.
 *
 * Learn: https://learn.microsoft.com/rest/api/synapse/kusto-pools/list-by-workspace
 */
export async function listKustoPools(): Promise<Array<{ name: string; state?: string; provisioningState?: string; sku?: { name?: string } }>> {
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) return [];
  const r = await callArm(`${armBase()}/kustoPools?api-version=2021-06-01-preview`);
  // A workspace without the Data Explorer feature returns 404/empty — treat as none.
  if (r.status === 404) return [];
  const body = await jsonOrThrow<{ value?: Array<{ name: string; properties?: { state?: string; provisioningState?: string }; sku?: { name?: string } }> }>(r, 'listKustoPools');
  return (body.value || []).map((p) => ({
    name: p.name,
    state: p.properties?.state,
    provisioningState: p.properties?.provisioningState,
    sku: p.sku,
  }));
}

/**
 * List the databases inside a Synapse Kusto pool from ARM
 * (.../kustoPools/{pool}/databases). Backs the KQL-script editor's "Use
 * database" dropdown. Returns the readable database name (the ARM resource name
 * is `{pool}/{database}`; we strip the pool prefix).
 *
 * Learn: https://learn.microsoft.com/rest/api/synapse/databases/list-by-kusto-pool
 */
export async function listKustoPoolDatabases(poolName: string): Promise<string[]> {
  if (!process.env.LOOM_SYNAPSE_WORKSPACE || !poolName) return [];
  const r = await callArm(`${armBase()}/kustoPools/${encodeURIComponent(poolName)}/databases?api-version=2021-06-01-preview`);
  if (r.status === 404) return [];
  const body = await jsonOrThrow<{ value?: Array<{ name: string }> }>(r, `listKustoPoolDatabases(${poolName})`);
  return (body.value || []).map((d) => {
    const n = d.name || '';
    const slash = n.indexOf('/');
    return slash >= 0 ? n.slice(slash + 1) : n;
  });
}

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

/**
 * Create a Synapse Dedicated SQL pool (the Azure-native DEFAULT warehouse
 * backend in Gov boundaries, per `.claude/rules/no-fabric-dependency.md`).
 *
 * ARM PUT /.../sqlPools/{name}?api-version=2021-06-01 with body
 *   { location, sku: { name: '<DWxxxxc>' },
 *     properties: { createMode: 'Default', collation } }
 *
 * Provisioning is asynchronous — ARM returns 200/201 (or 202 + Location) with
 * the pool's initial properties; the pool reaches Online after a few minutes.
 * Returns the immediate ARM response; polling to Online is the caller's job
 * (the UI polls via getDedicatedPool / listDedicatedSqlPools).
 *
 * `location` MUST be supplied (ARM PUT requires it). The route resolves it
 * from LOOM_LOCATION (the deployment region) before calling.
 */
export async function createDedicatedSqlPool(
  name: string,
  sku: string,
  location: string,
  collation = 'SQL_Latin1_General_CP1_CI_AS',
  target?: SynapseArmTarget,
): Promise<{ name: string; sku?: { name?: string; tier?: string }; properties?: any }> {
  if (!name) throw new Error('createDedicatedSqlPool: name is required');
  if (!location) throw new Error('createDedicatedSqlPool: location is required');
  if (!sku || !/^DW\d+c$/i.test(sku)) {
    throw new Error(`createDedicatedSqlPool: invalid sku ${sku}; expected DWxxxxc`);
  }
  const body = {
    location,
    sku: { name: sku },
    properties: { createMode: 'Default', collation },
  };
  const r = await callArm(
    `${armBase(target)}/sqlPools/${encodeURIComponent(name)}?api-version=${ARM_API}`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
  return jsonOrThrow(r, `createDedicatedSqlPool(${name},${sku})`);
}

/**
 * Delete a Synapse Dedicated SQL pool (ARM DELETE). Idempotent: a 404 (pool
 * already gone) is swallowed; any other non-2xx surfaces verbatim. Like create,
 * delete is asynchronous (202 + Location) — the immediate return means the
 * delete was accepted.
 */
export async function deleteDedicatedSqlPool(name: string): Promise<void> {
  if (!name) throw new Error('deleteDedicatedSqlPool: name is required');
  const r = await callArm(
    `${armBase()}/sqlPools/${encodeURIComponent(name)}?api-version=${ARM_API}`,
    { method: 'DELETE' },
  );
  if (r.ok || r.status === 202 || r.status === 204 || r.status === 404) return;
  throw new Error(`deleteDedicatedSqlPool(${name}) failed ${r.status}: ${await r.text()}`);
}

