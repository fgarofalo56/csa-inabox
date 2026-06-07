/**
 * Azure Machine Learning — control-plane (ARM) client for the notebook AML path.
 *
 * This is a *separate* AML workspace client from foundry-client.ts (which
 * targets the AI Foundry hub). It drives the dedicated AML workspace that the
 * deploy-planner `ml-workspace.bicep` module provisions, so the notebook editor
 * can:
 *   - list Compute Instances (CI)               → listCIs()
 *   - start a stopped CI (auto-start)           → startCI()
 *   - read the workspace datastores             → listAmlDatastores()
 *   - submit a Command job onto a CI            → submitCiJob() (run-route)
 *   - poll that job's status                    → getCiJob()
 *
 * ALL calls go through the ARM control plane (armBase() from cloud-endpoints),
 * which is sovereign-cloud-aware (Commercial / GCC / GCC-High / IL5). The AML
 * data-plane endpoint (*.api.azureml.ms) is NOT used here.
 *
 * Config resolution mirrors mlflow-client.ts so an already-configured Loom
 * keeps working: LOOM_AML_WORKSPACE / LOOM_AML_REGION / LOOM_AML_RG fall back
 * to the Foundry hub env when the dedicated AML vars aren't set.
 *
 * Honest infra-gate: when the workspace can't be resolved from env,
 * `amlConfig()` throws `AmlNotConfiguredError` carrying the exact env vars to
 * set. Routes surface that as a Fluent MessageBar; the editor still renders.
 *
 * No Fabric dependency: this is the Azure-native default backend for the AML
 * notebook path. When LOOM_AML_WORKSPACE is unset, `amlIsConfigured()` returns
 * false cleanly and the AML toggle simply shows the gate — the Fabric path is
 * unaffected.
 *
 * Real ARM (verified against Microsoft Learn — Machine Learning
 *   workspaces/computes + workspaces/datastores + workspaces/jobs, 2024-10-01):
 *   GET  {base}/computes?api-version=2024-10-01
 *   POST {base}/computes/{name}/start?api-version=2024-10-01      (202, no body)
 *   GET  {base}/datastores?api-version=2024-10-01                 (paged)
 *   PUT  {base}/jobs/{name}?api-version=2024-10-01                (Command job)
 *   GET  {base}/jobs/{name}?api-version=2024-10-01
 */
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { armBase, armScope, isGovCloud } from './cloud-endpoints';

const ARM_SCOPE = armScope();
const ML_API = '2024-10-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Raised when the AML workspace needed for the notebook AML path isn't configured. */
export class AmlNotConfiguredError extends Error {
  hint: string;
  missing: string[];
  constructor(missing: string[]) {
    super('Azure Machine Learning workspace is not configured in this deployment');
    this.name = 'AmlNotConfiguredError';
    this.missing = missing;
    this.hint =
      `Set ${missing.join(' + ')} to a deployed Azure Machine Learning workspace ` +
      `(the deploy-planner mlWorkspace module provisions one), then grant the ` +
      `Console UAMI the AzureML Data Scientist role on it. ` +
      `LOOM_AML_WORKSPACE / LOOM_AML_REGION fall back to LOOM_FOUNDRY_NAME / ` +
      `LOOM_FOUNDRY_REGION when those are set.`;
  }
}

/** Non-404 AML ARM failure. */
export class AmlError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Azure ML call failed (${status})`);
    this.name = 'AmlError';
    this.status = status;
    this.body = body;
  }
}

export interface AmlConfig {
  subscriptionId: string;
  resourceGroup: string;
  workspace: string;
  region: string;
  /** Full ARM resource path under the workspace (no api-version). */
  base: string;
}

/**
 * Resolve the AML workspace ARM base from env. Workspace + region honor the
 * task's dedicated vars first, then fall back to the Foundry hub env.
 */
export function amlConfig(): AmlConfig {
  const missing: string[] = [];
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID;
  if (!subscriptionId) missing.push('LOOM_SUBSCRIPTION_ID');

  const workspace = process.env.LOOM_AML_WORKSPACE || process.env.LOOM_FOUNDRY_NAME;
  if (!workspace) missing.push('LOOM_AML_WORKSPACE');

  const region = process.env.LOOM_AML_REGION || process.env.LOOM_FOUNDRY_REGION;
  if (!region) missing.push('LOOM_AML_REGION');

  if (missing.length) throw new AmlNotConfiguredError(missing);

  const resourceGroup =
    process.env.LOOM_AML_RG ||
    process.env.LOOM_FOUNDRY_RG ||
    'rg-csa-loom-admin-eastus2';

  const base =
    `${armBase()}/subscriptions/${subscriptionId}` +
    `/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.MachineLearningServices/workspaces/${workspace}`;

  return { subscriptionId: subscriptionId!, resourceGroup, workspace: workspace!, region: region!, base };
}

/** True when the AML workspace can be addressed (env is set). Lets callers branch without try/catch. */
export function amlIsConfigured(): boolean {
  try {
    amlConfig();
    return true;
  } catch {
    return false;
  }
}

async function authHeader(): Promise<string> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token for Azure ML');
  return `Bearer ${token.token}`;
}

async function amlFetch(
  pathUnderWorkspace: string,
  init: RequestInit & { query?: Record<string, string>; apiVersion?: string } = {},
): Promise<Response> {
  const cfg = amlConfig();
  const apiVer = init.apiVersion || ML_API;
  const sep = pathUnderWorkspace.includes('?') ? '&' : '?';
  const query = init.query ? '&' + new URLSearchParams(init.query).toString() : '';
  const url = `${cfg.base}${pathUnderWorkspace}${sep}api-version=${apiVer}${query}`;
  const { query: _q, apiVersion: _av, ...rest } = init;
  return fetch(url, {
    ...rest,
    headers: {
      ...(rest.headers || {}),
      authorization: await authHeader(),
      'content-type': 'application/json',
    },
  });
}

async function readJson<T>(res: Response): Promise<T | null> {
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
    throw new AmlError(res.status, parsed, `Azure ML ${res.status}: ${String(msg).slice(0, 280)}`);
  }
  return (parsed as T) ?? ({} as T);
}

/** Paged ARM list — follows nextLink, raw bearer on each continuation. */
async function pagedList(pathUnderWorkspace: string): Promise<any[]> {
  const out: any[] = [];
  let res = await amlFetch(pathUnderWorkspace);
  let j = await readJson<{ value?: any[]; nextLink?: string }>(res);
  while (j) {
    if (Array.isArray(j.value)) out.push(...j.value);
    if (!j.nextLink) break;
    res = await fetch(j.nextLink, { headers: { authorization: await authHeader() } });
    j = await readJson<{ value?: any[]; nextLink?: string }>(res);
  }
  return out;
}

// ---------------- Compute Instances ----------------

export interface AmlComputeInstance {
  name: string;
  vmSize?: string;
  /** ComputeInstance lifecycle state: Creating | Running | Stopped | Stopping | Starting | … */
  state?: string;
  provisioningState?: string;
  computeType?: string;
}

function shapeCompute(raw: any): AmlComputeInstance {
  const p = raw?.properties || {};
  const inner = p.properties || {};
  return {
    name: raw?.name,
    vmSize: inner.vmSize,
    state: inner.state || p.provisioningState,
    provisioningState: p.provisioningState,
    computeType: p.computeType,
  };
}

/**
 * List the workspace's Compute Instances (CI). Filters the merged compute list
 * to `computeType === 'ComputeInstance'` (AmlCompute clusters / others are
 * dropped — a notebook runs on a CI).
 */
export async function listCIs(): Promise<AmlComputeInstance[]> {
  const rows = await pagedList('/computes');
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
  const j = await readJson<any>(res);
  return j ? shapeCompute(j) : null;
}

// ---------------- Datastores ----------------

export interface AmlDatastore {
  name: string;
  datastoreType: string;       // AzureBlob | AzureDataLakeGen2 | AzureFile | AzureDataLakeGen1 | OneLake | …
  isDefault?: boolean;
  accountName?: string;
  containerName?: string;      // AzureBlob
  filesystem?: string;         // AzureDataLakeGen2
  endpoint?: string;           // cloud storage suffix, e.g. "core.windows.net"
  description?: string;
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
    name: raw?.name,
    datastoreType: p.datastoreType,
    isDefault: p.isDefault,
    accountName: p.accountName,
    containerName: p.containerName,
    filesystem: p.filesystem,
    endpoint: p.endpoint,
    description: p.description,
  };
  ds.abfssPath = toAbfssPath(ds);
  ds.wasbsPath = toWasbsPath(ds);
  return ds;
}

export async function listAmlDatastores(): Promise<AmlDatastore[]> {
  const rows = await pagedList('/datastores');
  return rows.map(shapeDatastore);
}

// ---------------- Command jobs (run a notebook cell on a CI) ----------------

export interface AmlJob {
  name: string;
  displayName?: string;
  status?: string;            // NotStarted | Starting | Running | Finalizing | Completed | Failed | Canceled | …
  jobType?: string;
  computeId?: string;
  command?: string;
}

function shapeJob(raw: any): AmlJob {
  const p = raw?.properties || {};
  return {
    name: raw?.name,
    displayName: p.displayName,
    status: p.status,
    jobType: p.jobType,
    computeId: p.computeId,
    command: p.command,
  };
}

/** Default curated AML environment that ships Python 3.10 (used when no env override is given). */
export const DEFAULT_AML_ENVIRONMENT =
  'azureml://registries/azureml/environments/sklearn-1.5/labels/latest';

/**
 * Submit a Command job that runs `code` on the given Compute Instance.
 *   PUT {base}/jobs/{name}?api-version=2024-10-01
 * The command runs `python -c "<code>"` (or `Rscript -e` for R) on the CI's
 * default compute. Returns the job name so the caller can poll getCiJob().
 */
export async function submitCiJob(opts: {
  ciName: string;
  code: string;
  lang?: 'python' | 'r';
  displayName?: string;
}): Promise<AmlJob> {
  const cfg = amlConfig();
  const name = `loom-nb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const computeId =
    `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}` +
    `/providers/Microsoft.MachineLearningServices/workspaces/${cfg.workspace}/computes/${opts.ciName}`;
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
  const j = await readJson<any>(res);
  return j ? shapeJob(j) : { name, status: 'NotStarted', jobType: 'Command' };
}

/** Poll a Command job's status. Null on 404. */
export async function getCiJob(name: string): Promise<AmlJob | null> {
  const res = await amlFetch(`/jobs/${encodeURIComponent(name)}`);
  const j = await readJson<any>(res);
  return j ? shapeJob(j) : null;
}

/** AML terminal job states. */
const AML_TERMINAL = ['Completed', 'Failed', 'Canceled', 'NotResponding'];
export function amlJobIsTerminal(status?: string): boolean {
  return AML_TERMINAL.includes(status || '');
}

/** Single-quote a string for a POSIX shell `-c` argument (the CI runs Linux). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
