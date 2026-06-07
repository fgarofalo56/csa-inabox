/**
 * aml-client — typed Azure Machine Learning CONTROL-PLANE REST client.
 *
 * Covers the standalone AML workspace surfaces the Data Science experiences
 * need: computes, datastores, experiments / runs (ARM "jobs"), models,
 * schedules, and environments. Everything here is pure ARM — each object is a
 * child resource of `Microsoft.MachineLearningServices/workspaces/<ws>` — so a
 * single sovereign-cloud-aware fetch helper serves them all.
 *
 * Grounding (Microsoft Learn — Azure Machine Learning REST, api-version
 * 2024-10-01 GA):
 *   GET <ws>/computes      https://learn.microsoft.com/rest/api/azureml/compute/list
 *   GET <ws>/datastores    https://learn.microsoft.com/rest/api/azureml/datastores/list
 *   GET <ws>/jobs          https://learn.microsoft.com/rest/api/azureml/jobs/list
 *   GET <ws>/models        https://learn.microsoft.com/rest/api/azureml/model-containers/list
 *   GET <ws>/schedules     https://learn.microsoft.com/rest/api/azureml/schedules/list
 *   GET <ws>/environments  https://learn.microsoft.com/rest/api/azureml/environment-containers/list
 *
 * Cloud routing: the ARM host + AAD scope come from `cloud-endpoints.ts`
 * (`armBase()` / `armScope()`), resolved at REQUEST time so AZURE_CLOUD /
 * LOOM_ARM_ENDPOINT pick the `management.usgovcloudapi.net` host in Government.
 * The workspace coordinates come from `resolve-aml-target.ts`.
 *
 * Auth: ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
 * DefaultAzureCredential) against the ARM `.default` scope — identical to
 * adf-client.ts / foundry-client.ts / mlflow-client.ts. The Console UAMI must
 * hold the "AzureML Data Scientist" role (role ID
 * f6c7c914-8db3-469d-8ca1-694a8f32e121) on the workspace; ml-workspace.bicep
 * already grants it.
 *
 * NO mocks, NO `return []` placeholders. Real ARM REST only. When env is unset
 * the BFF 503s via `amlConfigGate()` with the exact missing variable. NO Fabric
 * dependency — works with LOOM_DEFAULT_FABRIC_WORKSPACE unset (Azure-native by
 * default, per no-fabric-dependency.md).
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { armBase, armScope } from './cloud-endpoints';
import {
  resolveAmlTarget,
  amlWorkspaceArmPath,
  AmlNotConfiguredError,
  type AmlTarget,
} from './resolve-aml-target';

/** Stable GA api-version for Microsoft.MachineLearningServices control plane. */
const ML_API = '2024-10-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
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

/**
 * ARM fetch against `<armBase><workspaceArmPath><path>?api-version=ML_API`.
 * `armBase()` / `armScope()` are evaluated here (request time) so the
 * sovereign-cloud host is correct even when AZURE_CLOUD changes after import.
 */
async function amlFetch(
  path: string,
  init: RequestInit & { query?: Record<string, string>; target?: AmlTarget } = {},
): Promise<Response> {
  const token = await credential.getToken(armScope());
  if (!token?.token) throw new AmlError(401, undefined, 'Failed to acquire ARM token for Azure ML');
  const { query, target, ...rest } = init;
  const wsPath = amlWorkspaceArmPath(target ?? resolveAmlTarget());
  const extra = query ? '&' + new URLSearchParams(query).toString() : '';
  const url = `${armBase()}${wsPath}${path}?api-version=${ML_API}${extra}`;
  return fetch(url, {
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
    res = await fetch(j.nextLink, { headers: { authorization: `Bearer ${token!.token}` } });
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
}

function shapeCompute(raw: any): AmlCompute {
  const p = raw?.properties || {};
  const inner = p.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    location: raw?.location,
    computeType: p.computeType,
    provisioningState: p.provisioningState,
    state: inner.state || p.provisioningState,
    vmSize: inner.vmSize,
    createdOn: p.createdOn,
  };
}

/** GET <ws>/computes — the acceptance-test surface (live Compute Instance list). */
export async function listComputes(): Promise<AmlCompute[]> {
  const rows = await pagedList('/computes', 'listComputes');
  return rows.map(shapeCompute);
}

// ============================================================
// 2. Datastores
// ============================================================

export interface AmlDatastore {
  id: string;
  name: string;
  datastoreType?: string;
  isDefault?: boolean;
  description?: string;
  accountName?: string;
  containerName?: string;
  tags?: Record<string, string>;
}

function shapeDatastore(raw: any): AmlDatastore {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    datastoreType: p.datastoreType,
    isDefault: p.isDefault,
    description: p.description,
    accountName: p.accountName,
    containerName: p.containerName,
    tags: p.tags,
  };
}

export async function listDatastores(): Promise<AmlDatastore[]> {
  const rows = await pagedList('/datastores', 'listDatastores');
  return rows.map(shapeDatastore);
}

// ============================================================
// 3. Experiments / Runs (ARM "jobs")
// ============================================================

export interface AmlJob {
  id: string;
  name: string;
  displayName?: string;
  jobType?: string;
  experimentName?: string;
  status?: string;
  startTimeUtc?: string;
  endTimeUtc?: string;
  computeId?: string;
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
    res = await fetch(j.nextLink, { headers: { authorization: `Bearer ${token!.token}` } });
    j = await readAmlJson<{ value?: any[]; nextLink?: string }>(res, 'listJobs');
  }
  return out.slice(0, cap);
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
