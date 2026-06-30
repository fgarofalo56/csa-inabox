/**
 * aml-client — typed Azure Machine Learning CONTROL-PLANE REST client.
 *
 * This single module serves two integrated surfaces, both pure ARM (every
 * object is a child of `Microsoft.MachineLearningServices/workspaces/<ws>`):
 *
 *   1. The Data Science experiences: computes, datastores, experiments / runs
 *      (ARM "jobs"), models, schedules, environments — list surfaces.
 *   2. The notebook "Azure ML" path: list Compute Instances (CI), auto-start a
 *      stopped CI, read datastores (with abfss:// / wasbs:// path building for
 *      the Datastore Explorer), submit a Command job onto a CI, and poll it.
 *
 * Everything routes through one sovereign-cloud-aware fetch helper. Workspace
 * coordinates come from `resolve-aml-target.ts` (LOOM_AML_* → LOOM_FOUNDRY_*
 * fallback), so an already-deployed Loom keeps working without new config.
 *
 * Grounding (Microsoft Learn — Azure Machine Learning REST, api-version
 * 2024-10-01 GA):
 *   GET  <ws>/computes      https://learn.microsoft.com/rest/api/azureml/compute/list
 *   POST <ws>/computes/{n}/start                                   (202, no body)
 *   GET  <ws>/datastores    https://learn.microsoft.com/rest/api/azureml/datastores/list
 *   PUT  <ws>/jobs/{name}                                          (Command job)
 *   GET  <ws>/jobs          https://learn.microsoft.com/rest/api/azureml/jobs/list
 *   GET  <ws>/models        https://learn.microsoft.com/rest/api/azureml/model-containers/list
 *   GET  <ws>/schedules     https://learn.microsoft.com/rest/api/azureml/schedules/list
 *   GET  <ws>/environments  https://learn.microsoft.com/rest/api/azureml/environment-containers/list
 *
 * Cloud routing: the ARM host + AAD scope come from `cloud-endpoints.ts`
 * (`armBase()` / `armScope()`), resolved at REQUEST time so AZURE_CLOUD /
 * LOOM_ARM_ENDPOINT pick the `management.usgovcloudapi.net` host in Government.
 *
 * Auth: ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
 * DefaultAzureCredential) against the ARM `.default` scope — identical to
 * adf-client.ts / foundry-client.ts / mlflow-client.ts. The Console UAMI must
 * hold the "AzureML Data Scientist" role (role ID
 * f6c7c914-8db3-469d-8ca1-694a8f32e121) on the workspace; ml-workspace.bicep
 * already grants it.
 *
 * NO mocks, NO `return []` placeholders. Real ARM REST only. When env is unset
 * the BFF gates via `amlConfigGate()` / `amlIsConfigured()` with the exact
 * missing variable. NO Fabric dependency — works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset (Azure-native by default, per
 * no-fabric-dependency.md).
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope, isGovCloud } from './cloud-endpoints';
import {
  resolveAmlTarget,
  amlWorkspaceArmPath,
  AmlNotConfiguredError,
  type AmlTarget,
} from './resolve-aml-target';

/** Stable GA api-version for Microsoft.MachineLearningServices control plane. */
const ML_API = '2024-10-01';
/**
 * api-version that ships the Compute Instance `updateIdleShutdownSetting`
 * control-plane action (it isn't exposed under the 2024-10-01 GA compute
 * surface). Used ONLY for that one POST.
 * https://learn.microsoft.com/rest/api/azureml/compute-instances
 */
const ML_IDLE_SHUTDOWN_API = '2021-07-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Non-404 AML control-plane REST failure. */
export class AmlError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Azure ML control-plane call failed (${status})`);
    this.name = 'AmlError';
    this.status = status;
    this.body = body;
  }
}

// Re-export the resolver surface so route handlers import everything AML from
// one module.
export {
  resolveAmlTarget,
  amlWorkspaceArmPath,
  isAmlConfigured,
  amlDataPlaneHostSuffix,
  AmlNotConfiguredError,
  type AmlTarget,
} from './resolve-aml-target';

// ============================================================
// Config / gate helpers
// ============================================================

/** Resolved AML workspace coordinates + the full ARM base (host + path). */
export interface AmlConfig {
  subscriptionId: string;
  resourceGroup: string;
  workspace: string;
  region: string;
  /** Full ARM resource base for the workspace (host + path, no api-version). */
  base: string;
}

/**
 * Resolve the AML workspace config (coordinates + full ARM base) from env.
 * Delegates to `resolveAmlTarget()`; throws `AmlNotConfiguredError` (carrying
 * the exact missing vars) when the workspace can't be addressed.
 */
export function amlConfig(): AmlConfig {
  const t = resolveAmlTarget();
  return { ...t, base: `${armBase()}${amlWorkspaceArmPath(t)}` };
}

/** True when the AML workspace can be addressed (env is set). Lets callers branch without try/catch. */
export function amlIsConfigured(): boolean {
  try {
    resolveAmlTarget();
    return true;
  } catch {
    return false;
  }
}

/**
 * Honest config gate. Returns the exact missing env var so the BFF can 503 with
 * a precise Fluent MessageBar instead of a generic 500. Returns null when the
 * workspace coordinates resolve.
 */
export function amlConfigGate(): { missing: string } | null {
  try {
    resolveAmlTarget();
    return null;
  } catch (e) {
    if (e instanceof AmlNotConfiguredError) return { missing: e.missing.join(' + ') };
    throw e;
  }
}

// ============================================================
// Fetch foundation
// ============================================================

/**
 * ARM fetch against `<armBase><workspaceArmPath><path>?api-version=ML_API`.
 * `armBase()` / `armScope()` are evaluated here (request time) so the
 * sovereign-cloud host is correct even when AZURE_CLOUD changes after import.
 */
async function amlFetch(
  path: string,
  init: RequestInit & { query?: Record<string, string>; target?: AmlTarget; apiVersion?: string } = {},
): Promise<Response> {
  const token = await credential.getToken(armScope());
  if (!token?.token) throw new AmlError(401, undefined, 'Failed to acquire ARM token for Azure ML');
  const { query, target, apiVersion, ...rest } = init;
  const wsPath = amlWorkspaceArmPath(target ?? resolveAmlTarget());
  const extra = query ? '&' + new URLSearchParams(query).toString() : '';
  const url = `${armBase()}${wsPath}${path}?api-version=${apiVersion ?? ML_API}${extra}`;
  return fetchWithTimeout(url, {
    ...rest,
    headers: {
      ...(rest.headers || {}),
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  });
}

async function readAmlJson<T>(res: Response, label: string): Promise<T | null> {
  if (res.status === 404) return null;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg =
      (parsed as any)?.error?.message ||
      (typeof parsed === 'string' ? parsed : `Azure ML ${res.status}`);
    throw new AmlError(res.status, parsed, `${label} failed ${res.status}: ${String(msg).slice(0, 280)}`);
  }
  return (parsed as T) ?? ({} as T);
}

/**
 * Paged ARM value collector — ARM returns `{ value: [], nextLink?: string }`.
 * Follows `nextLink` with the same bearer until exhausted.
 */
async function pagedList(path: string, label: string): Promise<any[]> {
  const out: any[] = [];
  let res = await amlFetch(path);
  let j = await readAmlJson<{ value?: any[]; nextLink?: string }>(res, label);
  while (j) {
    if (Array.isArray(j.value)) out.push(...j.value);
    if (!j.nextLink) break;
    const token = await credential.getToken(armScope());
    res = await fetchWithTimeout(j.nextLink, { headers: { authorization: `Bearer ${token!.token}` } });
    j = await readAmlJson<{ value?: any[]; nextLink?: string }>(res, label);
  }
  return out;
}

// ============================================================
// 1. Computes
// ============================================================

export interface AmlCompute {
  id: string;
  name: string;
  location?: string;
  computeType?: string;
  provisioningState?: string;
  state?: string;
  vmSize?: string;
  createdOn?: string;
  /**
   * AmlCompute cluster scale ceiling (scaleSettings.maxNodeCount). AutoML caps
   * max-concurrent-trials at this — submitting more concurrent trials than the
   * cluster has nodes is a hard AML 400 ("max concurrent iterations is larger
   * than max node of compute"). Undefined for ComputeInstance / when absent.
   */
  maxNodeCount?: number;
}

/** A Compute Instance view (subset of AmlCompute) used by the notebook path. */
export type AmlComputeInstance = AmlCompute;

function shapeCompute(raw: any): AmlCompute {
  const p = raw?.properties || {};
  const inner = p.properties || {};
  const maxNodeCount =
    typeof inner?.scaleSettings?.maxNodeCount === 'number'
      ? inner.scaleSettings.maxNodeCount
      : undefined;
  return {
    id: raw?.id,
    name: raw?.name,
    location: raw?.location,
    computeType: p.computeType,
    provisioningState: p.provisioningState,
    state: inner.state || p.provisioningState,
    vmSize: inner.vmSize,
    createdOn: p.createdOn,
    maxNodeCount,
  };
}

/** GET <ws>/computes — the acceptance-test surface (live compute list). */
export async function listComputes(): Promise<AmlCompute[]> {
  const rows = await pagedList('/computes', 'listComputes');
  return rows.map(shapeCompute);
}

/**
 * List the workspace's Compute Instances (CI). Filters the merged compute list
 * to `computeType === 'ComputeInstance'` (AmlCompute clusters / others are
 * dropped — a notebook runs on a CI).
 */
export async function listCIs(): Promise<AmlComputeInstance[]> {
  const rows = await pagedList('/computes', 'listCIs');
  return rows
    .filter((r) => (r?.properties?.computeType || '') === 'ComputeInstance')
    .map(shapeCompute);
}

/** Whether a CI state means it's ready to run cells. */
const CI_RUNNING = ['Running', 'running', 'Online', 'Available'];
export function ciIsRunning(state?: string): boolean {
  return CI_RUNNING.includes(state || '');
}
/** Whether a CI state means it's stopped and can be (auto-)started. */
const CI_STOPPED = ['Stopped', 'stopped', 'Deallocated'];
export function ciIsStopped(state?: string): boolean {
  return CI_STOPPED.includes(state || '');
}

/**
 * Start a stopped Compute Instance.
 *   POST {base}/computes/{name}/start?api-version=2024-10-01  → 202 Accepted
 * Idempotent enough for auto-start: a 4xx that says "already running" is
 * swallowed so the caller's debounced auto-start doesn't surface a scary error.
 */
export async function startCI(name: string): Promise<void> {
  const res = await amlFetch(`/computes/${encodeURIComponent(name)}/start`, { method: 'POST' });
  if (res.ok || res.status === 202 || res.status === 204) return;
  const t = await res.text().catch(() => '');
  // Treat "already started / not stopped" conflicts as success for auto-start.
  if (res.status === 409 || /already|not.*stopped|running/i.test(t)) return;
  throw new AmlError(res.status, t, `Compute Instance start failed: ${t.slice(0, 240)}`);
}

/** Read a single CI (state probe after start). */
export async function getCI(name: string): Promise<AmlComputeInstance | null> {
  const res = await amlFetch(`/computes/${encodeURIComponent(name)}`);
  const j = await readAmlJson<any>(res, 'getCI');
  return j ? shapeCompute(j) : null;
}

/**
 * The workspace's region (= the ARM `location` a new compute is created in).
 * Resolved from env via `resolveAmlTarget()` so create requests don't re-read
 * `LOOM_AML_REGION` in every caller.
 */
export function amlRegion(target: AmlTarget = resolveAmlTarget()): string {
  return target.region;
}

/**
 * Stop a running Compute Instance.
 *   POST {base}/computes/{name}/stop?api-version=2024-10-01  → 202 Accepted
 * A 4xx that says "already stopped / not running" is swallowed so a redundant
 * Stop click doesn't surface a scary error (mirrors startCI's idempotence).
 */
export async function stopCI(name: string): Promise<void> {
  const res = await amlFetch(`/computes/${encodeURIComponent(name)}/stop`, { method: 'POST' });
  if (res.ok || res.status === 202 || res.status === 204) return;
  const t = await res.text().catch(() => '');
  if (res.status === 409 || /already|not.*running|stopped|deallocat/i.test(t)) return;
  throw new AmlError(res.status, t, `Compute Instance stop failed: ${t.slice(0, 240)}`);
}

/**
 * Create a Compute Instance.
 *   PUT {base}/computes/{name}?api-version=2024-10-01
 *   body { location, properties: { computeType:'ComputeInstance',
 *          properties: { vmSize, idleTimeBeforeShutdown? } } }
 * Provisioning is async — ARM answers 202 (returns a 'Creating' placeholder) or
 * 200/201 with the resource body. A non-202 failure (e.g. 404 workspace) throws
 * AmlError so the route surfaces an honest error — never a faked success.
 */
export async function createCI(
  name: string,
  opts: { vmSize: string; idleTimeBeforeShutdown?: string },
): Promise<AmlComputeInstance> {
  const target = resolveAmlTarget();
  const inner: Record<string, unknown> = { vmSize: opts.vmSize };
  if (opts.idleTimeBeforeShutdown) inner.idleTimeBeforeShutdown = opts.idleTimeBeforeShutdown;
  const armBody = {
    location: amlRegion(target),
    properties: {
      computeType: 'ComputeInstance',
      properties: inner,
    },
  };
  const res = await amlFetch(`/computes/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(armBody),
    target,
  });
  if (res.status === 202) {
    return { id: '', name, computeType: 'ComputeInstance', provisioningState: 'Creating', state: 'Creating', vmSize: opts.vmSize };
  }
  const j = await readAmlJson<any>(res, 'createCI');
  return j
    ? shapeCompute(j)
    : { id: '', name, computeType: 'ComputeInstance', provisioningState: 'Creating', state: 'Creating', vmSize: opts.vmSize };
}

/**
 * Update a Compute Instance's idle-shutdown TTL (auto-stop after N idle time).
 *   POST {base}/computes/{name}/updateIdleShutdownSetting?api-version=2021-07-01
 *   body { idleTimeBeforeShutdown: "PT30M" }   (ISO-8601 duration)
 * This action lives only on the 2021-07-01 compute surface, so it overrides the
 * default ML_API. The workspace's own MI must hold Contributor on itself or the
 * idle timer won't fire (durable bicep grant; see the AML impl plan A3).
 */
export async function updateCiIdleShutdown(name: string, idleTimeBeforeShutdown: string): Promise<void> {
  const res = await amlFetch(`/computes/${encodeURIComponent(name)}/updateIdleShutdownSetting`, {
    method: 'POST',
    apiVersion: ML_IDLE_SHUTDOWN_API,
    body: JSON.stringify({ idleTimeBeforeShutdown }),
  });
  if (res.ok || res.status === 202 || res.status === 204) return;
  const t = await res.text().catch(() => '');
  throw new AmlError(res.status, t, `Update idle-shutdown failed: ${t.slice(0, 240)}`);
}

// ============================================================
// 2. Datastores
// ============================================================

export interface AmlDatastore {
  id?: string;
  name: string;
  datastoreType?: string;       // AzureBlob | AzureDataLakeGen2 | AzureFile | AzureDataLakeGen1 | OneLake | …
  isDefault?: boolean;
  description?: string;
  accountName?: string;
  containerName?: string;       // AzureBlob
  filesystem?: string;          // AzureDataLakeGen2
  endpoint?: string;            // cloud storage suffix, e.g. "core.windows.net"
  tags?: Record<string, string>;
  /** abfss:// for ADLS Gen2 datastores (null otherwise). */
  abfssPath?: string | null;
  /** wasbs:// for Blob datastores (null otherwise). */
  wasbsPath?: string | null;
}

/** Blob host suffix for the active cloud (endpoint property is the storage suffix). */
function blobSuffix(endpoint?: string): string {
  if (endpoint) return `blob.${endpoint.replace(/^\./, '')}`;
  return isGovCloud() ? 'blob.core.usgovcloudapi.net' : 'blob.core.windows.net';
}
/** DFS host suffix for the active cloud (endpoint property is the storage suffix). */
function dfsHostSuffix(endpoint?: string): string {
  if (endpoint) return `dfs.${endpoint.replace(/^\./, '')}`;
  return isGovCloud() ? 'dfs.core.usgovcloudapi.net' : 'dfs.core.windows.net';
}

/**
 * Build the canonical fully-qualified URI a Spark/Python cell uses to read a
 * datastore's backing storage. ADLS Gen2 → abfss://, Blob → wasbs://, else null.
 */
export function toAbfssPath(ds: { datastoreType?: string; accountName?: string; filesystem?: string; endpoint?: string }): string | null {
  if (ds.datastoreType === 'AzureDataLakeGen2' && ds.accountName && ds.filesystem) {
    return `abfss://${ds.filesystem}@${ds.accountName}.${dfsHostSuffix(ds.endpoint)}/`;
  }
  return null;
}
export function toWasbsPath(ds: { datastoreType?: string; accountName?: string; containerName?: string; endpoint?: string }): string | null {
  if (ds.datastoreType === 'AzureBlob' && ds.accountName && ds.containerName) {
    return `wasbs://${ds.containerName}@${ds.accountName}.${blobSuffix(ds.endpoint)}/`;
  }
  return null;
}

function shapeDatastore(raw: any): AmlDatastore {
  const p = raw?.properties || {};
  const ds: AmlDatastore = {
    id: raw?.id,
    name: raw?.name,
    datastoreType: p.datastoreType,
    isDefault: p.isDefault,
    description: p.description,
    accountName: p.accountName,
    containerName: p.containerName,
    filesystem: p.filesystem,
    endpoint: p.endpoint,
    tags: p.tags,
  };
  ds.abfssPath = toAbfssPath(ds);
  ds.wasbsPath = toWasbsPath(ds);
  return ds;
}

export async function listDatastores(): Promise<AmlDatastore[]> {
  const rows = await pagedList('/datastores', 'listDatastores');
  return rows.map(shapeDatastore);
}

/** Notebook Datastore Explorer surface — same data as listDatastores, named for the editor. */
export async function listAmlDatastores(): Promise<AmlDatastore[]> {
  const rows = await pagedList('/datastores', 'listAmlDatastores');
  return rows.map(shapeDatastore);
}

// ============================================================
// 3. Experiments / Runs (ARM "jobs")
// ============================================================

export interface AmlJob {
  id?: string;
  name: string;
  displayName?: string;
  jobType?: string;
  experimentName?: string;
  status?: string;
  startTimeUtc?: string;
  endTimeUtc?: string;
  computeId?: string;
  command?: string;
  description?: string;
  tags?: Record<string, string>;
}

function shapeJob(raw: any): AmlJob {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    displayName: p.displayName,
    jobType: p.jobType,
    experimentName: p.experimentName,
    status: p.status,
    startTimeUtc: p.startTimeUtc,
    endTimeUtc: p.endTimeUtc,
    computeId: p.computeId,
    command: p.command,
    description: p.description,
    tags: p.tags,
  };
}

/**
 * GET <ws>/jobs — the workspace's runs. Optionally filter to one experiment
 * (ARM supports the `$filter` and `listViewType` query params) and cap results.
 */
export async function listJobs(opts: { experimentName?: string; maxResults?: number } = {}): Promise<AmlJob[]> {
  const query: Record<string, string> = {};
  if (opts.experimentName) query.$filter = `properties.experimentName eq '${opts.experimentName}'`;
  const cap = opts.maxResults ?? 200;
  const out: AmlJob[] = [];
  let res = await amlFetch('/jobs', { query });
  let j = await readAmlJson<{ value?: any[]; nextLink?: string }>(res, 'listJobs');
  while (j) {
    if (Array.isArray(j.value)) for (const r of j.value) out.push(shapeJob(r));
    if (!j.nextLink || out.length >= cap) break;
    const token = await credential.getToken(armScope());
    res = await fetchWithTimeout(j.nextLink, { headers: { authorization: `Bearer ${token!.token}` } });
    j = await readAmlJson<{ value?: any[]; nextLink?: string }>(res, 'listJobs');
  }
  return out.slice(0, cap);
}

/** Default curated AML environment that ships Python 3.10 (used when no env override is given). */
export const DEFAULT_AML_ENVIRONMENT =
  'azureml://registries/azureml/environments/sklearn-1.5/labels/latest';

/** Single-quote a string for a POSIX shell `-c` argument (the CI runs Linux). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Submit a Command job that runs `code` on the given Compute Instance.
 *   PUT {base}/jobs/{name}?api-version=2024-10-01
 * The command runs `python -c "<code>"` (or `Rscript -e` for R) on the CI's
 * default compute. Returns the job so the caller can poll getCiJob().
 */
export async function submitCiJob(opts: {
  ciName: string;
  code: string;
  lang?: 'python' | 'r';
  displayName?: string;
}): Promise<AmlJob> {
  const t = resolveAmlTarget();
  const name = `loom-nb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const computeId =
    `/subscriptions/${t.subscriptionId}/resourceGroups/${t.resourceGroup}` +
    `/providers/Microsoft.MachineLearningServices/workspaces/${t.workspace}/computes/${opts.ciName}`;
  const command = opts.lang === 'r'
    ? `Rscript -e ${shellQuote(opts.code)}`
    : `python -c ${shellQuote(opts.code)}`;
  const armBody = {
    properties: {
      jobType: 'Command',
      displayName: opts.displayName || 'Loom notebook cell run',
      experimentName: 'loom-notebook-runs',
      command,
      environmentId: DEFAULT_AML_ENVIRONMENT,
      computeId,
    },
  };
  const res = await amlFetch(`/jobs/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(armBody),
  });
  const j = await readAmlJson<any>(res, 'submitCiJob');
  return j ? shapeJob(j) : { name, status: 'NotStarted', jobType: 'Command' };
}

/** Poll a Command job's status. Null on 404. */
export async function getCiJob(name: string): Promise<AmlJob | null> {
  const res = await amlFetch(`/jobs/${encodeURIComponent(name)}`);
  const j = await readAmlJson<any>(res, 'getCiJob');
  return j ? shapeJob(j) : null;
}

/** AML terminal job states. */
const AML_TERMINAL = ['Completed', 'Failed', 'Canceled', 'NotResponding'];
export function amlJobIsTerminal(status?: string): boolean {
  return AML_TERMINAL.includes(status || '');
}

// ============================================================
// 4. Models (model containers)
// ============================================================

export interface AmlModel {
  id: string;
  name: string;
  latestVersion?: string;
  description?: string;
  tags?: Record<string, string>;
}

function shapeModel(raw: any): AmlModel {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    latestVersion: p.latestVersion,
    description: p.description,
    tags: p.tags,
  };
}

export async function listModels(): Promise<AmlModel[]> {
  const rows = await pagedList('/models', 'listModels');
  return rows.map(shapeModel);
}

// ============================================================
// 5. Schedules
// ============================================================

export interface AmlSchedule {
  id: string;
  name: string;
  displayName?: string;
  isEnabled?: boolean;
  provisioningState?: string;
  triggerType?: string;
  description?: string;
}

function shapeSchedule(raw: any): AmlSchedule {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    displayName: p.displayName,
    isEnabled: p.isEnabled,
    provisioningState: p.provisioningState,
    triggerType: p.trigger?.triggerType,
    description: p.description,
  };
}

export async function listSchedules(): Promise<AmlSchedule[]> {
  const rows = await pagedList('/schedules', 'listSchedules');
  return rows.map(shapeSchedule);
}

// ============================================================
// 6. Environments (environment containers)
// ============================================================

export interface AmlEnvironment {
  id: string;
  name: string;
  latestVersion?: string;
  description?: string;
  isAnonymous?: boolean;
  tags?: Record<string, string>;
}

function shapeEnvironment(raw: any): AmlEnvironment {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    latestVersion: p.latestVersion,
    description: p.description,
    isAnonymous: p.isAnonymous,
    tags: p.tags,
  };
}

export async function listEnvironments(): Promise<AmlEnvironment[]> {
  const rows = await pagedList('/environments', 'listEnvironments');
  return rows.map(shapeEnvironment);
}
