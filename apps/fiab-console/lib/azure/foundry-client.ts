/**
 * Azure AI Foundry (hub workspace) management-plane client.
 *
 * Targets the Loom Console UAMI via ChainedTokenCredential:
 *   1. ManagedIdentityCredential({ clientId: LOOM_UAMI_CLIENT_ID }) — prod path
 *   2. DefaultAzureCredential — local dev / az login fallback
 *
 * AI Foundry hub == Microsoft.MachineLearningServices/workspaces (kind=Hub).
 * Most read ops resolve through ARM; the data-plane (api.azureml.ms) is only
 * needed for things like running jobs / deploying — out of scope for this
 * editor wave.
 *
 * Auth scope:  the sovereign-cloud ARM .default scope
 * UAMI role:   Contributor at the workspace scope.
 *
 * 404 → null. Any other non-2xx throws FoundryError(status, body).
 */
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { armBase, armScope, amlDataPlaneHost } from './cloud-endpoints';

const ARM_SCOPE = armScope();
const ML_API = '2024-10-01';

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

function foundryBase(): string {
  const sub = required('LOOM_SUBSCRIPTION_ID');
  const rg = process.env.LOOM_FOUNDRY_RG || 'rg-csa-loom-admin-eastus2';
  const name = process.env.LOOM_FOUNDRY_NAME || 'aifoundry-csa-loom-eastus2';
  return `${armBase()}/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.MachineLearningServices/workspaces/${name}`;
}

export class FoundryError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `AI Foundry call failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function foundryFetch(
  path: string,
  init: RequestInit & { query?: Record<string, string>; apiVersion?: string } = {},
): Promise<Response> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token for AI Foundry');
  const apiVer = init.apiVersion || ML_API;
  const sep = path.includes('?') ? '&' : '?';
  const query = init.query
    ? '&' + new URLSearchParams(init.query).toString()
    : '';
  const url = `${foundryBase()}${path}${sep}api-version=${apiVer}${query}`;
  const { query: _q, apiVersion: _av, ...rest } = init;
  return fetch(url, {
    ...rest,
    headers: {
      ...(rest.headers || {}),
      authorization: `Bearer ${token.token}`,
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
      (typeof parsed === 'string' ? parsed : `AI Foundry ${res.status}`);
    throw new FoundryError(res.status, parsed, msg);
  }
  return (parsed as T) ?? ({} as T);
}

// Paged value collector — ARM returns { value: [], nextLink?: string }
async function pagedList(path: string, init: Parameters<typeof foundryFetch>[1] = {}): Promise<any[]> {
  const out: any[] = [];
  let res = await foundryFetch(path, init);
  let j = await readJson<{ value?: any[]; nextLink?: string }>(res);
  while (j) {
    if (Array.isArray(j.value)) out.push(...j.value);
    if (!j.nextLink) break;
    const token = await credential.getToken(ARM_SCOPE);
    res = await fetch(j.nextLink, { headers: { authorization: `Bearer ${token!.token}` } });
    j = await readJson<{ value?: any[]; nextLink?: string }>(res);
  }
  return out;
}

// ---------------- Workspace (hub) info ----------------

export interface FoundryWorkspaceInfo {
  name: string;
  rg: string;
  location?: string;
  kind?: string;
  hubResourceId?: string;
  friendlyName?: string;
  description?: string;
  discoveryUrl?: string;
  provisioningState?: string;
  publicNetworkAccess?: string;
  storageAccount?: string;
  keyVault?: string;
  applicationInsights?: string;
  containerRegistry?: string;
  identity?: unknown;
}

export async function getWorkspaceInfo(): Promise<FoundryWorkspaceInfo | null> {
  const res = await foundryFetch('');
  const j = await readJson<any>(res);
  if (!j) return null;
  const p = j.properties || {};
  return {
    name: j.name,
    rg: process.env.LOOM_FOUNDRY_RG || 'rg-csa-loom-admin-eastus2',
    location: j.location,
    kind: j.kind,
    hubResourceId: p.hubResourceId,
    friendlyName: p.friendlyName,
    description: p.description,
    discoveryUrl: p.discoveryUrl,
    provisioningState: p.provisioningState,
    publicNetworkAccess: p.publicNetworkAccess,
    storageAccount: p.storageAccount,
    keyVault: p.keyVault,
    applicationInsights: p.applicationInsights,
    containerRegistry: p.containerRegistry,
    identity: j.identity,
  };
}

// ---------------- Connections ----------------

export interface FoundryConnection {
  id: string;
  name: string;
  category?: string;
  target?: string;
  authType?: string;
  isSharedToAll?: boolean;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

function shapeConnection(raw: any): FoundryConnection {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    category: p.category,
    target: p.target,
    authType: p.authType,
    isSharedToAll: p.isSharedToAll,
    createdAt: raw?.systemData?.createdAt,
    metadata: p.metadata,
  };
}

export async function listConnections(): Promise<FoundryConnection[]> {
  const rows = await pagedList('/connections');
  return rows.map(shapeConnection);
}

// ---------------- Models (registered models) ----------------

export interface FoundryModelSummary {
  id: string;
  name: string;
  description?: string;
  tags?: Record<string, string>;
  properties?: Record<string, string>;
  latestVersion?: string;
  /** ARM systemData.createdAt — when the model container was first registered. */
  createdAt?: string;
  /** ARM systemData.lastModifiedAt — last version registration / metadata edit. */
  lastModifiedAt?: string;
}

export interface FoundryModelVersion {
  id: string;
  name: string;
  version: string;
  description?: string;
  tags?: Record<string, string>;
  properties?: Record<string, string>;
  modelType?: string;
  modelUri?: string;
  createdAt?: string;
  flavors?: Record<string, unknown>;
}

function shapeModelContainer(raw: any): FoundryModelSummary {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    description: p.description,
    tags: p.tags,
    properties: p.properties,
    latestVersion: p.latestVersion,
    createdAt: raw?.systemData?.createdAt,
    lastModifiedAt: raw?.systemData?.lastModifiedAt,
  };
}

function shapeModelVersion(raw: any): FoundryModelVersion {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    version: p.version || (raw?.name as string),
    description: p.description,
    tags: p.tags,
    properties: p.properties,
    modelType: p.modelType,
    modelUri: p.modelUri,
    createdAt: raw?.systemData?.createdAt,
    flavors: p.flavors,
  };
}

/**
 * Build an ARM-relative path under a *named* ML workspace's model registry.
 * When `workspaceName` is omitted, the hub workspace (env LOOM_FOUNDRY_NAME)
 * is used. Going through `armFetch` means a Loom model item can bind to ANY
 * AML workspace the UAMI can read, not just the hub.
 */
function modelsArmBase(workspaceName?: string): string {
  return `${workspaceArmBase(workspaceName)}/models`;
}

export async function listModels(workspaceName?: string): Promise<FoundryModelSummary[]> {
  if (!workspaceName) {
    // Hub default — keep the existing /models hub-relative path.
    const rows = await pagedList('/models');
    return rows.map(shapeModelContainer);
  }
  const res = await armFetch(modelsArmBase(workspaceName), { apiVersion: ML_API });
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).map(shapeModelContainer);
}

export async function getModel(name: string, workspaceName?: string): Promise<FoundryModelSummary | null> {
  if (!workspaceName) {
    const res = await foundryFetch(`/models/${encodeURIComponent(name)}`);
    const j = await readJson<any>(res);
    return j ? shapeModelContainer(j) : null;
  }
  const res = await armFetch(`${modelsArmBase(workspaceName)}/${encodeURIComponent(name)}`, { apiVersion: ML_API });
  const j = await readJson<any>(res);
  return j ? shapeModelContainer(j) : null;
}

export async function listModelVersions(name: string, workspaceName?: string): Promise<FoundryModelVersion[]> {
  if (!workspaceName) {
    const rows = await pagedList(`/models/${encodeURIComponent(name)}/versions`);
    return rows.map(shapeModelVersion);
  }
  const res = await armFetch(`${modelsArmBase(workspaceName)}/${encodeURIComponent(name)}/versions`, { apiVersion: ML_API });
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).map(shapeModelVersion);
}

export async function getModelVersion(name: string, version: string, workspaceName?: string): Promise<FoundryModelVersion | null> {
  const res = workspaceName
    ? await armFetch(`${modelsArmBase(workspaceName)}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`, { apiVersion: ML_API })
    : await foundryFetch(`/models/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`);
  const j = await readJson<any>(res);
  return j ? shapeModelVersion(j) : null;
}

// ---------------- Online endpoints + deployments ----------------

export interface FoundryEndpoint {
  id: string;
  name: string;
  location?: string;
  authMode?: string;
  provisioningState?: string;
  scoringUri?: string;
  swaggerUri?: string;
  traffic?: Record<string, number>;
}

export interface FoundryDeployment {
  id: string;
  name: string;
  endpointName: string;
  model?: string;
  instanceType?: string;
  provisioningState?: string;
  appInsightsEnabled?: boolean;
}

function shapeEndpoint(raw: any): FoundryEndpoint {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    location: raw?.location,
    authMode: p.authMode,
    provisioningState: p.provisioningState,
    scoringUri: p.scoringUri,
    swaggerUri: p.swaggerUri,
    traffic: p.traffic,
  };
}

function shapeDeployment(raw: any, endpointName: string): FoundryDeployment {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    endpointName,
    model: p.model,
    instanceType: p.instanceType,
    provisioningState: p.provisioningState,
    appInsightsEnabled: p.appInsightsEnabled,
  };
}

export async function listOnlineEndpoints(workspaceName?: string): Promise<FoundryEndpoint[]> {
  if (!workspaceName) {
    const rows = await pagedList('/onlineEndpoints');
    return rows.map(shapeEndpoint);
  }
  const res = await armFetch(`${workspaceArmBase(workspaceName)}/onlineEndpoints`, { apiVersion: ML_API });
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).map(shapeEndpoint);
}

export async function listDeployments(): Promise<FoundryDeployment[]> {
  const endpoints = await listOnlineEndpoints();
  const all: FoundryDeployment[] = [];
  for (const ep of endpoints) {
    try {
      const rows = await pagedList(`/onlineEndpoints/${encodeURIComponent(ep.name)}/deployments`);
      for (const r of rows) all.push(shapeDeployment(r, ep.name));
    } catch (e) {
      // Per-endpoint failure shouldn't sink the whole list
      if (e instanceof FoundryError && e.status === 404) continue;
      throw e;
    }
  }
  return all;
}

// ---------------- Computes ----------------

export interface FoundryCompute {
  id: string;
  name: string;
  location?: string;
  computeType?: string;
  provisioningState?: string;
  state?: string;
  vmSize?: string;
  createdOn?: string;
}

function shapeCompute(raw: any): FoundryCompute {
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

export async function listComputes(): Promise<FoundryCompute[]> {
  const rows = await pagedList('/computes');
  return rows.map(shapeCompute);
}

// ---------------- Jobs (experiments / runs) ----------------

export interface FoundryJob {
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
  properties?: Record<string, string>;
  services?: Record<string, unknown>;
}

function shapeJob(raw: any): FoundryJob {
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
    properties: p.properties,
    services: p.services,
  };
}

export async function listJobs(): Promise<FoundryJob[]> {
  const rows = await pagedList('/jobs');
  return rows.map(shapeJob);
}

export async function getJob(name: string): Promise<FoundryJob | null> {
  const res = await foundryFetch(`/jobs/${encodeURIComponent(name)}`);
  const j = await readJson<any>(res);
  return j ? shapeJob(j) : null;
}

// ---------------- Datastores ----------------

export interface FoundryDatastore {
  id: string;
  name: string;
  datastoreType?: string;
  isDefault?: boolean;
  description?: string;
  tags?: Record<string, string>;
  accountName?: string;
  containerName?: string;
}

function shapeDatastore(raw: any): FoundryDatastore {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    datastoreType: p.datastoreType,
    isDefault: p.isDefault,
    description: p.description,
    tags: p.tags,
    accountName: p.accountName,
    containerName: p.containerName,
  };
}

export async function listDatastores(): Promise<FoundryDatastore[]> {
  const rows = await pagedList('/datastores');
  return rows.map(shapeDatastore);
}

// =====================================================================
// v2.5 — AI Foundry sub-editor surfaces
// =====================================================================
//
// Generic ARM fetch (sibling workspaces, ai-search, app-insights, etc).
// path is a full ARM path beginning with /subscriptions/...
// 404 → null. Other non-2xx throws FoundryError.

async function armFetch(
  fullPath: string,
  init: RequestInit & { query?: Record<string, string>; apiVersion: string } = { apiVersion: ML_API },
): Promise<Response> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token');
  const sep = fullPath.includes('?') ? '&' : '?';
  const query = init.query ? '&' + new URLSearchParams(init.query).toString() : '';
  const url = `${armBase()}${fullPath}${sep}api-version=${init.apiVersion}${query}`;
  const { query: _q, apiVersion: _av, ...rest } = init;
  return fetch(url, {
    ...rest,
    headers: {
      ...(rest.headers || {}),
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  });
}

// Data-plane fetch against the AML regional endpoint.
// Sovereign-cloud aware: <region>.api.azureml.ms (Commercial/GCC) vs
// <region>.api.ml.azure.us (GCC-High / IL5) — see cloud-endpoints.amlDataPlaneHost.
async function amlDataPlaneFetch(
  segment: string,
  init: RequestInit = {},
): Promise<Response> {
  const region = process.env.LOOM_FOUNDRY_REGION || 'eastus2';
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token for AML data plane');
  const url = `https://${amlDataPlaneHost(region)}${segment.startsWith('/') ? segment : '/' + segment}`;
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  });
}

function rg(): string {
  return process.env.LOOM_FOUNDRY_RG || 'rg-csa-loom-admin-eastus2';
}
function sub(): string {
  return required('LOOM_SUBSCRIPTION_ID');
}
function hubName(): string {
  return process.env.LOOM_FOUNDRY_NAME || 'aifoundry-csa-loom-eastus2';
}
function hubResourceId(): string {
  return `/subscriptions/${sub()}/resourceGroups/${rg()}/providers/Microsoft.MachineLearningServices/workspaces/${hubName()}`;
}

// ---------------- Projects (child of Hub) ----------------

export interface FoundryProject {
  id: string;
  name: string;
  displayName?: string;
  location?: string;
  kind?: string;
  hubResourceId?: string;
  description?: string;
  provisioningState?: string;
  discoveryUrl?: string;
  createdAt?: string;
}

function shapeProject(raw: any): FoundryProject {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    displayName: p.friendlyName,
    location: raw?.location,
    kind: raw?.kind,
    hubResourceId: p.hubResourceId,
    description: p.description,
    provisioningState: p.provisioningState,
    discoveryUrl: p.discoveryUrl,
    createdAt: raw?.systemData?.createdAt,
  };
}

// ---------------- ML workspaces (model-binding picker) ----------------

export interface MlWorkspaceSummary {
  name: string;
  rg: string;
  location?: string;
  kind?: string;          // Default | Hub | Project | FeatureStore
  friendlyName?: string;
  provisioningState?: string;
  isHub?: boolean;
  discoveryUrl?: string;
}

/**
 * List the Azure Machine Learning workspaces (default, hub, project, feature
 * store) in the configured RG. Real ARM:
 *   GET .../resourceGroups/{rg}/providers/Microsoft.MachineLearningServices/workspaces
 * Used by the ml-model bind picker so a Loom model item can bind to a model
 * registered in any of the tenant's AML workspaces.
 */
export async function listMlWorkspaces(): Promise<MlWorkspaceSummary[]> {
  const res = await armFetch(
    `/subscriptions/${sub()}/resourceGroups/${rg()}/providers/Microsoft.MachineLearningServices/workspaces`,
    { apiVersion: ML_API },
  );
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).map((w: any) => {
    const p = w?.properties || {};
    const kind = (w?.kind || 'Default');
    return {
      name: w?.name,
      rg: rg(),
      location: w?.location,
      kind,
      friendlyName: p.friendlyName,
      provisioningState: p.provisioningState,
      isHub: String(kind).toLowerCase() === 'hub',
      discoveryUrl: p.discoveryUrl,
    } as MlWorkspaceSummary;
  });
}

export async function listProjects(): Promise<FoundryProject[]> {
  // List all ML workspaces in the RG, filter to kind=project + hubResourceId matches our hub.
  const res = await armFetch(
    `/subscriptions/${sub()}/resourceGroups/${rg()}/providers/Microsoft.MachineLearningServices/workspaces`,
    { apiVersion: ML_API },
  );
  const j = await readJson<{ value?: any[] }>(res);
  const all = j?.value || [];
  const hub = hubResourceId().toLowerCase();
  return all
    .filter((w) => (w?.kind || '').toLowerCase() === 'project'
                && (w?.properties?.hubResourceId || '').toLowerCase() === hub)
    .map(shapeProject);
}

export async function getProject(name: string): Promise<FoundryProject | null> {
  const res = await armFetch(
    `/subscriptions/${sub()}/resourceGroups/${rg()}/providers/Microsoft.MachineLearningServices/workspaces/${encodeURIComponent(name)}`,
    { apiVersion: ML_API },
  );
  const j = await readJson<any>(res);
  return j ? shapeProject(j) : null;
}

export async function createProject(name: string, displayName: string, description?: string): Promise<FoundryProject> {
  const hub = await getWorkspaceInfo();
  const location = hub?.location || 'eastus2';
  const body = {
    location,
    kind: 'Project',
    identity: { type: 'SystemAssigned' },
    properties: {
      friendlyName: displayName,
      description: description || '',
      hubResourceId: hubResourceId(),
    },
  };
  const res = await armFetch(
    `/subscriptions/${sub()}/resourceGroups/${rg()}/providers/Microsoft.MachineLearningServices/workspaces/${encodeURIComponent(name)}`,
    { apiVersion: ML_API, method: 'PUT', body: JSON.stringify(body) },
  );
  const j = await readJson<any>(res);
  return shapeProject(j);
}

export async function deleteProject(name: string): Promise<void> {
  const res = await armFetch(
    `/subscriptions/${sub()}/resourceGroups/${rg()}/providers/Microsoft.MachineLearningServices/workspaces/${encodeURIComponent(name)}`,
    { apiVersion: ML_API, method: 'DELETE' },
  );
  if (!res.ok && res.status !== 404 && res.status !== 202 && res.status !== 204) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Delete project failed: ${t}`);
  }
}

// ---------------- Prompt Flow (AML data-plane) ----------------

export interface PromptFlow {
  flowId?: string;
  flowName?: string;
  flowType?: string;
  description?: string;
  experimentId?: string;
  createdDate?: string;
  lastModifiedDate?: string;
  flowDefinition?: unknown;
}

function projectDataPlaneSegment(projectName: string, sub_: string, rg_: string): string {
  return `/flow/api/subscriptions/${sub_}/resourceGroups/${rg_}/providers/Microsoft.MachineLearningServices/workspaces/${encodeURIComponent(projectName)}`;
}

export async function listPromptFlows(projectName: string): Promise<PromptFlow[]> {
  const seg = `${projectDataPlaneSegment(projectName, sub(), rg())}/PromptFlows?pageSize=50`;
  const res = await amlDataPlaneFetch(seg);
  if (!res.ok) {
    if (res.status === 404) return [];
    const t = await res.text();
    throw new FoundryError(res.status, t, `Prompt Flow list failed (${res.status}): ${t.slice(0, 240)} | endpoint=${seg} | hint=ensure project exists and UAMI has AzureML Data Scientist role`);
  }
  const j: any = await res.json().catch(() => ({}));
  const arr = j?.results || j?.value || (Array.isArray(j) ? j : []);
  return arr.map((r: any) => ({
    flowId: r.flowId || r.id,
    flowName: r.flowName || r.name,
    flowType: r.flowType || r.type,
    description: r.description,
    experimentId: r.experimentId,
    createdDate: r.createdDate,
    lastModifiedDate: r.lastModifiedDate,
    flowDefinition: r.flowDefinition,
  }));
}

export async function getPromptFlow(projectName: string, flowId: string): Promise<PromptFlow | null> {
  const seg = `${projectDataPlaneSegment(projectName, sub(), rg())}/PromptFlows/${encodeURIComponent(flowId)}`;
  const res = await amlDataPlaneFetch(seg);
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Prompt Flow get failed: ${t.slice(0, 240)}`);
  }
  const r: any = await res.json();
  return {
    flowId: r.flowId || r.id,
    flowName: r.flowName || r.name,
    flowType: r.flowType || r.type,
    description: r.description,
    flowDefinition: r.flowDefinition || r,
  };
}

export async function createPromptFlow(projectName: string, body: { flowName: string; flowType?: string; flowDefinition: unknown; description?: string }): Promise<PromptFlow> {
  const seg = `${projectDataPlaneSegment(projectName, sub(), rg())}/PromptFlows`;
  const res = await amlDataPlaneFetch(seg, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Prompt Flow create failed (${res.status}): ${t.slice(0, 240)}`);
  }
  return await res.json();
}

export async function deletePromptFlow(projectName: string, flowId: string): Promise<void> {
  const seg = `${projectDataPlaneSegment(projectName, sub(), rg())}/PromptFlows/${encodeURIComponent(flowId)}`;
  const res = await amlDataPlaneFetch(seg, { method: 'DELETE' });
  if (!res.ok && res.status !== 404 && res.status !== 204) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Prompt Flow delete failed: ${t.slice(0, 240)}`);
  }
}

export async function updatePromptFlow(projectName: string, flowId: string, flowDefinition: unknown): Promise<PromptFlow> {
  const seg = `${projectDataPlaneSegment(projectName, sub(), rg())}/PromptFlows/${encodeURIComponent(flowId)}`;
  const res = await amlDataPlaneFetch(seg, { method: 'PUT', body: JSON.stringify({ flowDefinition }) });
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Prompt Flow update failed (${res.status}): ${t.slice(0, 240)}`);
  }
  return await res.json();
}

export async function submitFlowRun(projectName: string, flowId: string, inputs: Record<string, unknown>): Promise<any> {
  const seg = `${projectDataPlaneSegment(projectName, sub(), rg())}/PromptFlows/${encodeURIComponent(flowId)}/submit`;
  const res = await amlDataPlaneFetch(seg, { method: 'POST', body: JSON.stringify({ inputs }) });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch {}
  if (!res.ok) {
    throw new FoundryError(res.status, parsed, `Flow run failed (${res.status}): ${text.slice(0, 240)}`);
  }
  return parsed;
}

// ---------------- Evaluations (AML data-plane) ----------------

export interface FoundryEvaluation {
  id: string;
  name?: string;
  displayName?: string;
  status?: string;
  evaluatorIds?: string[];
  datasetId?: string;
  modelDeployment?: string;
  metrics?: Record<string, number>;
  createdDate?: string;
}

export async function listEvaluations(projectName: string): Promise<FoundryEvaluation[]> {
  const seg = `${projectDataPlaneSegment(projectName, sub(), rg())}/evaluations?pageSize=50`;
  const res = await amlDataPlaneFetch(seg);
  if (!res.ok) {
    if (res.status === 404) return [];
    const t = await res.text();
    throw new FoundryError(res.status, t, `Evaluations list failed (${res.status}): ${t.slice(0, 240)} | endpoint=${seg} | hint=ensure project + AML data plane reachable`);
  }
  const j: any = await res.json().catch(() => ({}));
  const arr = j?.results || j?.value || (Array.isArray(j) ? j : []);
  return arr.map((r: any) => ({
    id: r.id || r.evaluationId,
    name: r.name,
    displayName: r.displayName,
    status: r.status,
    evaluatorIds: r.evaluatorIds,
    datasetId: r.datasetId,
    modelDeployment: r.modelDeployment,
    metrics: r.metrics,
    createdDate: r.createdDate,
  }));
}

export async function getEvaluation(projectName: string, id: string): Promise<FoundryEvaluation | null> {
  const seg = `${projectDataPlaneSegment(projectName, sub(), rg())}/evaluations/${encodeURIComponent(id)}`;
  const res = await amlDataPlaneFetch(seg);
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Evaluation get failed: ${t.slice(0, 240)}`);
  }
  return await res.json();
}

export async function createEvaluation(projectName: string, body: {
  displayName: string;
  datasetId: string;
  modelDeployment?: string;
  evaluatorIds: string[];
}): Promise<any> {
  const seg = `${projectDataPlaneSegment(projectName, sub(), rg())}/evaluations`;
  const res = await amlDataPlaneFetch(seg, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Evaluation create failed (${res.status}): ${t.slice(0, 240)}`);
  }
  return await res.json();
}

export async function getEvaluationResults(projectName: string, id: string): Promise<any> {
  const seg = `${projectDataPlaneSegment(projectName, sub(), rg())}/evaluations/${encodeURIComponent(id)}/results`;
  const res = await amlDataPlaneFetch(seg);
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Evaluation results failed: ${t.slice(0, 240)}`);
  }
  return await res.json();
}

// ---------------- Content Safety ----------------
// Env-gated: when LOOM_CONTENT_SAFETY_ENDPOINT is missing, we surface
// NotDeployed so the editor can show an honest MessageBar.

export class NotDeployedError extends Error {
  service: string;
  hint: string;
  constructor(service: string, hint: string) {
    super(`${service} is not provisioned in this deployment`);
    this.service = service;
    this.hint = hint;
  }
}

function contentSafetyEndpoint(): string {
  const ep = process.env.LOOM_CONTENT_SAFETY_ENDPOINT;
  if (!ep) throw new NotDeployedError('Azure AI Content Safety',
    'Set LOOM_CONTENT_SAFETY_ENDPOINT to a deployed Content Safety resource (e.g. https://<name>.cognitiveservices.azure.com).');
  return ep.replace(/\/$/, '');
}

async function contentSafetyToken(): Promise<string> {
  const t = await credential.getToken('https://cognitiveservices.azure.com/.default');
  if (!t?.token) throw new Error('Failed to acquire token for Content Safety');
  return t.token;
}

export async function moderateText(text: string, categories?: string[]): Promise<any> {
  const ep = contentSafetyEndpoint();
  const tok = await contentSafetyToken();
  const body: any = { text };
  if (categories?.length) body.categories = categories;
  const res = await fetch(`${ep}/contentsafety/text:analyze?api-version=2024-09-01`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Content Safety text analyze failed: ${t.slice(0, 240)}`);
  }
  return await res.json();
}

export async function moderateImage(imageBase64: string): Promise<any> {
  const ep = contentSafetyEndpoint();
  const tok = await contentSafetyToken();
  const res = await fetch(`${ep}/contentsafety/image:analyze?api-version=2024-09-01`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ image: { content: imageBase64 } }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Content Safety image analyze failed: ${t.slice(0, 240)}`);
  }
  return await res.json();
}

export async function listContentSafetyPolicies(): Promise<{ name: string; thresholds: Record<string, number> }[]> {
  // The data-plane "blocklists" + "categories" are the closest analog. Surface
  // the default category set for now; real custom blocklists in v2.6.
  contentSafetyEndpoint(); // throws NotDeployedError if not configured
  return [
    { name: 'default', thresholds: { hate: 4, selfHarm: 4, sexual: 4, violence: 4 } },
  ];
}

// ---------------- Tracing (App Insights via ARM) ----------------

function appInsightsResourceId(): string {
  // Hub workspace has an applicationInsights property — we resolve it on demand.
  // We let getWorkspaceInfo() supply it.
  return ''; // sentinel — resolved at call time
}

export interface TraceRow {
  timestamp: string;
  name?: string;
  operationName?: string;
  duration?: number;
  success?: boolean;
  resultCode?: string;
  message?: string;
  customDimensions?: Record<string, unknown>;
}

export async function queryTraces(opts: { hours?: number; operation?: string } = {}): Promise<TraceRow[]> {
  void appInsightsResourceId; // keep helper exported reference style
  const ws = await getWorkspaceInfo();
  const appiId = ws?.applicationInsights;
  if (!appiId) {
    throw new NotDeployedError('Application Insights',
      'The Foundry hub has no applicationInsights resource bound. Bind one in the hub workspace properties.');
  }
  const hours = Math.max(1, Math.min(24 * 7, opts.hours || 24));
  let query = `union traces, dependencies, customEvents | where timestamp > ago(${hours}h)`;
  if (opts.operation) query += ` | where operation_Name == "${opts.operation.replace(/"/g, '\\"')}"`;
  query += ` | order by timestamp desc | take 200 | project timestamp, name, operation_Name, duration, success, resultCode, message, customDimensions`;
  // App Insights query via Log Analytics-backed API. /query supports KQL.
  // Using 2015-05-01 (stable GA) on the application/components resource.
  const path = `${appiId}/api/query`;
  const res = await armFetch(path, { apiVersion: '2015-05-01', method: 'POST', body: JSON.stringify({ query }) });
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `App Insights query failed (${res.status}): ${t.slice(0, 240)} | endpoint=${path}`);
  }
  const j: any = await res.json();
  const table = j?.tables?.[0];
  if (!table) return [];
  const cols: string[] = (table.columns || []).map((c: any) => c.name);
  const rows: any[][] = table.rows || [];
  return rows.map((r) => {
    const o: any = {};
    cols.forEach((c, i) => { o[c] = r[i]; });
    return {
      timestamp: o.timestamp,
      name: o.name,
      operationName: o.operation_Name,
      duration: o.duration,
      success: o.success,
      resultCode: o.resultCode,
      message: o.message,
      customDimensions: o.customDimensions,
    } as TraceRow;
  });
}

// ---------------- AI Search ----------------

function searchService(): string {
  const s = process.env.LOOM_AI_SEARCH_SERVICE;
  if (!s) throw new NotDeployedError('Azure AI Search',
    'AI Search is not yet provisioned in this deployment (eastus2 capacity hold). Set LOOM_AI_SEARCH_SERVICE to a deployed service name once available.');
  return s;
}

async function searchToken(): Promise<string> {
  const t = await credential.getToken('https://search.azure.com/.default');
  if (!t?.token) throw new Error('Failed to acquire token for AI Search');
  return t.token;
}

const SEARCH_API = '2024-07-01';

export interface SearchIndexSummary {
  name: string;
  fields?: { name: string; type: string; key?: boolean; searchable?: boolean }[];
  defaultScoringProfile?: string;
}

export async function listIndexes(): Promise<SearchIndexSummary[]> {
  const svc = searchService();
  const tok = await searchToken();
  const res = await fetch(`https://${svc}.search.windows.net/indexes?api-version=${SEARCH_API}&$select=name,fields`, {
    headers: { authorization: `Bearer ${tok}` },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Search list indexes failed: ${t.slice(0, 240)}`);
  }
  const j: any = await res.json();
  return (j.value || []).map((x: any) => ({
    name: x.name,
    fields: x.fields,
    defaultScoringProfile: x.defaultScoringProfile,
  }));
}

export async function getIndex(name: string): Promise<any | null> {
  const svc = searchService();
  const tok = await searchToken();
  const res = await fetch(`https://${svc}.search.windows.net/indexes/${encodeURIComponent(name)}?api-version=${SEARCH_API}`, {
    headers: { authorization: `Bearer ${tok}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Search get index failed: ${t.slice(0, 240)}`);
  }
  return await res.json();
}

export async function upsertIndex(name: string, definition: any): Promise<any> {
  const svc = searchService();
  const tok = await searchToken();
  // Sanitize: API 2024-07-01 rejects 'description' on ScoringProfile (it's
  // valid only on the top-level Index, not on scoring profiles). App bundles
  // keep description in their source for documentation, so we strip it here
  // at the API boundary instead of mutating the bundle definition.
  const cleaned = { ...definition, name };
  if (Array.isArray(cleaned.scoringProfiles)) {
    cleaned.scoringProfiles = cleaned.scoringProfiles.map((p: any) => {
      const { description: _description, ...rest } = p || {};
      return rest;
    });
  }
  const res = await fetch(`https://${svc}.search.windows.net/indexes/${encodeURIComponent(name)}?api-version=${SEARCH_API}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(cleaned),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Search upsert index failed: ${t.slice(0, 240)}`);
  }
  return await res.json();
}

export async function searchIndex(name: string, query: string, top = 25): Promise<any> {
  const svc = searchService();
  const tok = await searchToken();
  const res = await fetch(`https://${svc}.search.windows.net/indexes/${encodeURIComponent(name)}/docs/search?api-version=${SEARCH_API}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ search: query, top }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Search query failed: ${t.slice(0, 240)}`);
  }
  return await res.json();
}

export async function listDocuments(name: string, top = 25): Promise<any> {
  return searchIndex(name, '*', top);
}

/**
 * Upload (mergeOrUpload) documents into an index via the data-plane
 * `/docs/index` endpoint. Each doc gets `@search.action = mergeOrUpload`
 * unless it already carries one.
 */
export async function uploadDocuments(name: string, docs: any[]): Promise<{ uploaded: number; results: any[] }> {
  const svc = searchService();
  const tok = await searchToken();
  const value = docs.map((d) => ({ '@search.action': 'mergeOrUpload', ...d }));
  const res = await fetch(`https://${svc}.search.windows.net/indexes/${encodeURIComponent(name)}/docs/index?api-version=${SEARCH_API}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Search upload documents failed: ${t.slice(0, 240)}`);
  }
  const j: any = await res.json();
  const results = j?.value || [];
  const uploaded = results.filter((r: any) => r?.status).length;
  return { uploaded, results };
}

/**
 * Vector (k-NN) search against a vector field. `vector` is the query
 * embedding, `field` the vector field name, `k` the neighbor count.
 * When `text` is supplied it runs a hybrid (text + vector) query.
 */
export async function vectorSearch(name: string, opts: {
  vector: number[]; field: string; k?: number; text?: string; select?: string;
}): Promise<any> {
  const svc = searchService();
  const tok = await searchToken();
  const body: any = {
    vectorQueries: [{ kind: 'vector', vector: opts.vector, fields: opts.field, k: opts.k || 5 }],
    top: opts.k || 5,
  };
  if (opts.text) body.search = opts.text;
  if (opts.select) body.select = opts.select;
  const res = await fetch(`https://${svc}.search.windows.net/indexes/${encodeURIComponent(name)}/docs/search?api-version=${SEARCH_API}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Vector search failed: ${t.slice(0, 240)}`);
  }
  return await res.json();
}

/**
 * Build a vector index definition (AI Search 2024-07-01) from a simple
 * spec: a key field, a content field, and a single vector field with the
 * given dimensions + metric. Used by the vector-store editor's Create.
 */
export function buildVectorIndexDefinition(opts: {
  indexName: string; dim: number; metric: 'cosine' | 'euclidean' | 'dotProduct';
  vectorField?: string; contentField?: string;
}): any {
  const vectorField = opts.vectorField || 'embedding';
  const contentField = opts.contentField || 'content';
  const profileName = 'loom-vec-profile';
  const algoName = 'loom-hnsw';
  return {
    name: opts.indexName,
    fields: [
      { name: 'id', type: 'Edm.String', key: true, filterable: true },
      { name: contentField, type: 'Edm.String', searchable: true, retrievable: true },
      {
        name: vectorField, type: 'Collection(Edm.Single)', searchable: true, retrievable: true,
        dimensions: opts.dim, vectorSearchProfile: profileName,
      },
    ],
    vectorSearch: {
      algorithms: [{ name: algoName, kind: 'hnsw', hnswParameters: { metric: opts.metric, m: 4, efConstruction: 400, efSearch: 500 } }],
      profiles: [{ name: profileName, algorithm: algoName }],
    },
  };
}

// ---------------- Compute (extended) ----------------

export async function getCompute(name: string): Promise<FoundryCompute | null> {
  const res = await foundryFetch(`/computes/${encodeURIComponent(name)}`);
  const j = await readJson<any>(res);
  return j ? shapeCompute(j) : null;
}

export async function createCompute(name: string, body: {
  computeType: 'AmlCompute' | 'ComputeInstance';
  vmSize: string;
  minNodeCount?: number;
  maxNodeCount?: number;
}): Promise<FoundryCompute> {
  const ws = await getWorkspaceInfo();
  const location = ws?.location || 'eastus2';
  const propsInner: any = body.computeType === 'AmlCompute'
    ? {
        vmSize: body.vmSize,
        vmPriority: 'Dedicated',
        scaleSettings: {
          minNodeCount: body.minNodeCount ?? 0,
          maxNodeCount: body.maxNodeCount ?? 1,
          nodeIdleTimeBeforeScaleDown: 'PT15M',
        },
      }
    : { vmSize: body.vmSize };
  const armBody = {
    location,
    properties: {
      computeType: body.computeType,
      properties: propsInner,
    },
  };
  const res = await foundryFetch(`/computes/${encodeURIComponent(name)}`, {
    method: 'PUT', body: JSON.stringify(armBody),
  });
  const j = await readJson<any>(res);
  return shapeCompute(j);
}

/**
 * Update an AmlCompute compute target's vmSize + scaleSettings. ARM only
 * permits scaleSettings (min/max nodes + idle time) and vmSize via PATCH;
 * ComputeInstance does not support PATCH (must be deleted + recreated).
 */
export async function updateAmlComputeScale(name: string, body: {
  vmSize?: string;
  minNodeCount?: number;
  maxNodeCount?: number;
  nodeIdleTimeBeforeScaleDown?: string; // ISO 8601, e.g. "PT15M"
}): Promise<FoundryCompute> {
  const existing = await getCompute(name);
  if (!existing) throw new FoundryError(404, null, `Compute ${name} not found`);
  const props: any = {
    computeType: 'AmlCompute',
    properties: {
      vmSize: body.vmSize ?? (existing as any).vmSize,
      vmPriority: 'Dedicated',
      scaleSettings: {
        minNodeCount: body.minNodeCount ?? 0,
        maxNodeCount: body.maxNodeCount ?? 1,
        nodeIdleTimeBeforeScaleDown: body.nodeIdleTimeBeforeScaleDown ?? 'PT15M',
      },
    },
  };
  const ws = await getWorkspaceInfo();
  const armBody = {
    location: ws?.location || 'eastus2',
    properties: props,
  };
  const res = await foundryFetch(`/computes/${encodeURIComponent(name)}`, {
    method: 'PATCH', body: JSON.stringify(armBody),
  });
  if (!res.ok && res.status !== 202) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `updateAmlComputeScale failed: ${t.slice(0, 240)}`);
  }
  if (res.status === 202) {
    return { ...(existing as any), provisioningState: 'Updating' };
  }
  const j = await readJson<any>(res);
  return shapeCompute(j);
}

export async function startCompute(name: string): Promise<void> {
  const res = await foundryFetch(`/computes/${encodeURIComponent(name)}/start`, { method: 'POST' });
  if (!res.ok && res.status !== 202 && res.status !== 204) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Compute start failed: ${t.slice(0, 240)}`);
  }
}

export async function stopCompute(name: string): Promise<void> {
  const res = await foundryFetch(`/computes/${encodeURIComponent(name)}/stop`, { method: 'POST' });
  if (!res.ok && res.status !== 202 && res.status !== 204) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Compute stop failed: ${t.slice(0, 240)}`);
  }
}

export async function deleteCompute(name: string): Promise<void> {
  const res = await foundryFetch(`/computes/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 202 && res.status !== 204 && res.status !== 404) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `Compute delete failed: ${t.slice(0, 240)}`);
  }
}

// ---------------- Datasets / Data assets ----------------
//
// Data assets live under a workspace (hub OR project). Each named asset has
// many versions. We list containers then attach latestVersion.

export interface DataAsset {
  id: string;
  name: string;
  description?: string;
  tags?: Record<string, string>;
  latestVersion?: string;
  dataType?: string;          // UriFile | UriFolder | MLTable
  dataUri?: string;
  createdAt?: string;
}

function shapeDataAsset(raw: any): DataAsset {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    description: p.description,
    tags: p.tags,
    latestVersion: p.latestVersion,
    dataType: p.dataType,
    dataUri: p.dataUri,
    createdAt: raw?.systemData?.createdAt,
  };
}

function workspaceArmBase(workspaceName?: string): string {
  const ws = workspaceName || hubName();
  return `/subscriptions/${sub()}/resourceGroups/${rg()}/providers/Microsoft.MachineLearningServices/workspaces/${encodeURIComponent(ws)}`;
}

export async function listDataAssets(workspaceName?: string): Promise<DataAsset[]> {
  const path = `${workspaceArmBase(workspaceName)}/data`;
  const res = await armFetch(path, { apiVersion: ML_API });
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).map(shapeDataAsset);
}

export async function getDataAsset(name: string, workspaceName?: string): Promise<{ container: DataAsset | null; versions: any[] }> {
  const base = `${workspaceArmBase(workspaceName)}/data/${encodeURIComponent(name)}`;
  const res = await armFetch(base, { apiVersion: ML_API });
  const cj = await readJson<any>(res);
  if (!cj) return { container: null, versions: [] };
  const vres = await armFetch(`${base}/versions`, { apiVersion: ML_API });
  const vj = await readJson<{ value?: any[] }>(vres);
  return {
    container: shapeDataAsset(cj),
    versions: (vj?.value || []).map((v: any) => ({
      name: v.name,
      version: v.properties?.dataVersion || v.name,
      dataType: v.properties?.dataType,
      dataUri: v.properties?.dataUri,
      description: v.properties?.description,
      createdAt: v.systemData?.createdAt,
    })),
  };
}

export async function createDataAsset(name: string, body: {
  dataType: 'uri_file' | 'uri_folder' | 'mltable';
  dataUri: string;
  version?: string;
  description?: string;
  workspaceName?: string;
}): Promise<any> {
  const ver = body.version || '1';
  const path = `${workspaceArmBase(body.workspaceName)}/data/${encodeURIComponent(name)}/versions/${encodeURIComponent(ver)}`;
  const armBody = {
    properties: {
      dataType: body.dataType,
      dataUri: body.dataUri,
      description: body.description || '',
    },
  };
  const res = await armFetch(path, { apiVersion: ML_API, method: 'PUT', body: JSON.stringify(armBody) });
  const j = await readJson<any>(res);
  return j;
}

// =====================================================================
// ML model lifecycle — register a model version + serve it from a
// managed online endpoint. All real ARM PUTs against the hub workspace.
// =====================================================================

/**
 * Register a new model version under the hub workspace's model registry.
 * `modelUri` points at the model artifact (azureml:// or a run output path).
 */
export async function registerModelVersion(name: string, body: {
  version?: string;
  modelUri: string;
  modelType?: string;       // custom_model | mlflow_model | triton_model
  description?: string;
  workspaceName?: string;
}): Promise<FoundryModelVersion> {
  const ver = body.version || String(Date.now());
  const path = `${workspaceArmBase(body.workspaceName)}/models/${encodeURIComponent(name)}/versions/${encodeURIComponent(ver)}`;
  const armBody = {
    properties: {
      modelUri: body.modelUri,
      modelType: body.modelType || 'custom_model',
      description: body.description || '',
    },
  };
  const res = await armFetch(path, { apiVersion: ML_API, method: 'PUT', body: JSON.stringify(armBody) });
  const j = await readJson<any>(res);
  return shapeModelVersion(j);
}

/**
 * Resolve a workspace's location for endpoint/deployment ARM bodies. For the
 * hub we already have getWorkspaceInfo(); for a named bound workspace we read
 * its ARM resource. Falls back to the env region.
 */
async function workspaceLocation(workspaceName?: string): Promise<string> {
  const fallback = process.env.LOOM_FOUNDRY_REGION || 'eastus2';
  if (!workspaceName) {
    const ws = await getWorkspaceInfo();
    return ws?.location || fallback;
  }
  try {
    const res = await armFetch(workspaceArmBase(workspaceName), { apiVersion: ML_API });
    const j = await readJson<any>(res);
    return j?.location || fallback;
  } catch {
    return fallback;
  }
}

/** Create (or upsert) a managed online endpoint on the bound (or hub) workspace. */
export async function createOnlineEndpoint(name: string, opts: { authMode?: 'Key' | 'AMLToken'; workspaceName?: string } = {}): Promise<FoundryEndpoint> {
  const location = await workspaceLocation(opts.workspaceName);
  const armBody = {
    location,
    identity: { type: 'SystemAssigned' },
    properties: { authMode: opts.authMode || 'Key' },
  };
  const path = `${workspaceArmBase(opts.workspaceName)}/onlineEndpoints/${encodeURIComponent(name)}`;
  const res = await armFetch(path, { apiVersion: ML_API, method: 'PUT', body: JSON.stringify(armBody) });
  if (res.status === 202) return { id: '', name, authMode: opts.authMode || 'Key', provisioningState: 'Creating' };
  const j = await readJson<any>(res);
  return shapeEndpoint(j);
}

/**
 * Create a deployment under an online endpoint that serves `modelId`
 * (full ARM id of the model version, or azureml:<name>:<version>).
 */
export async function createOnlineDeployment(endpointName: string, deploymentName: string, body: {
  modelId: string;
  instanceType?: string;
  instanceCount?: number;
  workspaceName?: string;
}): Promise<FoundryDeployment> {
  const location = await workspaceLocation(body.workspaceName);
  const armBody = {
    location,
    sku: { name: 'Default', capacity: body.instanceCount ?? 1 },
    properties: {
      endpointComputeType: 'Managed',
      model: body.modelId,
      instanceType: body.instanceType || 'Standard_DS3_v2',
    },
  };
  const res = await armFetch(
    `${workspaceArmBase(body.workspaceName)}/onlineEndpoints/${encodeURIComponent(endpointName)}/deployments/${encodeURIComponent(deploymentName)}`,
    { apiVersion: ML_API, method: 'PUT', body: JSON.stringify(armBody) },
  );
  if (res.status === 202) return { id: '', name: deploymentName, endpointName, model: body.modelId, instanceType: body.instanceType, provisioningState: 'Creating' };
  const j = await readJson<any>(res);
  return shapeDeployment(j, endpointName);
}

/**
 * Submit a command job (real-time training/inference run) to the hub.
 * Minimal viable command-job payload — enough to genuinely create a run.
 */
export async function submitCommandJob(body: {
  displayName?: string;
  experimentName?: string;
  command: string;
  environmentId: string;       // azureml://… or azureml:<name>:<version>
  computeId?: string;          // azureml:<compute-name>
  codeId?: string;             // optional code asset
}): Promise<FoundryJob> {
  const name = `job-${Date.now().toString(36)}`;
  const path = `${workspaceArmBase()}/jobs/${encodeURIComponent(name)}`;
  const armBody = {
    properties: {
      jobType: 'Command',
      displayName: body.displayName || name,
      experimentName: body.experimentName || 'loom-runs',
      command: body.command,
      environmentId: body.environmentId,
      ...(body.computeId ? { computeId: body.computeId } : {}),
      ...(body.codeId ? { codeId: body.codeId } : {}),
    },
  };
  const res = await armFetch(path, { apiVersion: ML_API, method: 'PUT', body: JSON.stringify(armBody) });
  const j = await readJson<any>(res);
  return shapeJob(j);
}

// =====================================================================
// AML Job Schedules — notebook scheduling (recurrence only, no raw cron).
//
// Real ARM control plane:
//   Microsoft.MachineLearningServices/workspaces/schedules (api 2024-10-01, GA).
//   PUT    .../schedules/{name}      → create / update (enable is a re-PUT)
//   GET    .../schedules             → list (paged value/nextLink)
//   GET    .../schedules/{name}      → read one
//
// Trigger is RecurrenceTrigger (frequency Minute|Hour|Day|Week|Month + integer
// interval) — the dropdown wizard never exposes a cron expression. The action
// is a CreateJob action wrapping a Command job that runs the notebook on the
// schedule. ARM-only, so armBase() covers Commercial + GCC-High/IL5 unchanged.
//
// Grounded in Microsoft Learn:
//   https://learn.microsoft.com/azure/templates/microsoft.machinelearningservices/2024-10-01/workspaces/schedules
//   https://learn.microsoft.com/azure/machine-learning/how-to-schedule-pipeline-job
// =====================================================================

export type AmlFrequency = 'Minute' | 'Hour' | 'Day' | 'Week' | 'Month';

/** Curated AzureML registry environment the scheduled Command job runs in when
 *  the caller doesn't pin one. Overridable via env so a deployment can point at
 *  its own environment. */
const DEFAULT_SCHEDULE_ENVIRONMENT =
  process.env.LOOM_AML_SCHEDULE_ENVIRONMENT ||
  'azureml://registries/azureml/environments/sklearn-1.5/labels/latest';

export interface AmlScheduleConfig {
  subscriptionId: string;
  resourceGroup: string;
  workspace: string;
}

/** Raised when the AML workspace needed for scheduling isn't configured. The
 *  route surfaces `hint` in a Fluent MessageBar; the wizard still renders. */
export class AmlScheduleNotConfiguredError extends Error {
  hint: string;
  missing: string[];
  constructor(missing: string[]) {
    super('Azure ML job scheduling is not configured in this deployment');
    this.name = 'AmlScheduleNotConfiguredError';
    this.missing = missing;
    this.hint =
      `Set ${missing.join(' + ')} to a deployed Azure Machine Learning workspace, ` +
      `then grant the Console UAMI the AzureML Data Scientist role on it. ` +
      `LOOM_AML_WORKSPACE / LOOM_AML_RG fall back to LOOM_FOUNDRY_NAME / LOOM_FOUNDRY_RG.`;
  }
}

/**
 * Resolve the AML workspace used for notebook schedules. Workspace + RG honor
 * the task's dedicated vars first, then fall back to the Foundry hub env so an
 * already-configured Loom keeps working without new vars. No silent default for
 * the workspace name — an unset workspace is an honest gate, not a guess.
 */
export function amlScheduleConfig(): AmlScheduleConfig {
  const missing: string[] = [];
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID;
  if (!subscriptionId) missing.push('LOOM_SUBSCRIPTION_ID');
  const workspace = process.env.LOOM_AML_WORKSPACE || process.env.LOOM_FOUNDRY_NAME;
  if (!workspace) missing.push('LOOM_AML_WORKSPACE');
  if (missing.length) throw new AmlScheduleNotConfiguredError(missing);
  const resourceGroup =
    process.env.LOOM_AML_RG || process.env.LOOM_FOUNDRY_RG || 'rg-csa-loom-admin-eastus2';
  return { subscriptionId: subscriptionId!, resourceGroup, workspace: workspace! };
}

/** True when scheduling can be reached (env is set). Lets routes branch without try/catch. */
export function isAmlScheduleConfigured(): boolean {
  try { amlScheduleConfig(); return true; } catch { return false; }
}

function amlScheduleArmBase(cfg: AmlScheduleConfig): string {
  return `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}` +
    `/providers/Microsoft.MachineLearningServices/workspaces/${encodeURIComponent(cfg.workspace)}/schedules`;
}

/**
 * The ARM-safe schedule-name prefix for a notebook item. Schedule resource
 * names allow `[A-Za-z0-9_-]`; we sanitise the Cosmos item id and key every
 * schedule by this prefix so listing for one notebook is a simple filter.
 */
export function notebookSchedulePrefix(notebookId: string): string {
  const safe = String(notebookId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'nb';
  return `loom-nb-${safe}-`;
}

export interface AmlSchedule {
  name: string;
  displayName?: string;
  isEnabled: boolean;
  provisioningState?: string;
  triggerType?: string;
  frequency?: string;
  interval?: number;
  startTime?: string;
  timeZone?: string;
  createdAt?: string;
  jobType?: string;
  actionType?: string;
}

function shapeSchedule(raw: any): AmlSchedule {
  const p = raw?.properties || {};
  const trig = p.trigger || {};
  const action = p.action || {};
  const jobDef = action.jobDefinition || {};
  return {
    name: raw?.name,
    displayName: p.displayName,
    isEnabled: p.isEnabled !== false,
    provisioningState: p.provisioningState,
    triggerType: trig.triggerType,
    frequency: trig.frequency,
    interval: typeof trig.interval === 'number' ? trig.interval : undefined,
    startTime: trig.startTime,
    timeZone: trig.timeZone,
    createdAt: raw?.systemData?.createdAt,
    jobType: jobDef.jobType,
    actionType: action.actionType,
  };
}

/** GET .../schedules → all schedules whose name starts with `prefix` (paged). */
export async function listNotebookSchedules(prefix: string): Promise<AmlSchedule[]> {
  const cfg = amlScheduleConfig();
  const base = amlScheduleArmBase(cfg);
  const all: any[] = [];
  let res = await armFetch(base, { apiVersion: ML_API });
  let j = await readJson<{ value?: any[]; nextLink?: string }>(res);
  while (j) {
    if (Array.isArray(j.value)) all.push(...j.value);
    if (!j.nextLink) break;
    const token = await credential.getToken(ARM_SCOPE);
    res = await fetch(j.nextLink, { headers: { authorization: `Bearer ${token!.token}` } });
    j = await readJson<{ value?: any[]; nextLink?: string }>(res);
  }
  return all.map(shapeSchedule).filter((s) => !prefix || (s.name || '').startsWith(prefix));
}

/** GET .../schedules/{name} → one schedule (null on 404). */
export async function getSchedule(name: string): Promise<AmlSchedule | null> {
  const cfg = amlScheduleConfig();
  const res = await armFetch(`${amlScheduleArmBase(cfg)}/${encodeURIComponent(name)}`, { apiVersion: ML_API });
  const j = await readJson<any>(res);
  return j ? shapeSchedule(j) : null;
}

/**
 * PUT .../schedules/{name} → create (or update) a recurrence schedule that runs
 * the notebook as a Command job. `computeId` is optional — when omitted the
 * Command job runs on AML serverless compute.
 */
export async function createNotebookSchedule(name: string, body: {
  displayName: string;
  frequency: AmlFrequency;
  interval: number;
  startTime?: string;        // ISO-8601 UTC
  timeZone?: string;
  isEnabled?: boolean;
  command?: string;
  environmentId?: string;
  computeId?: string;
  experimentName?: string;
}): Promise<AmlSchedule> {
  const cfg = amlScheduleConfig();
  const trigger: Record<string, unknown> = {
    triggerType: 'Recurrence',
    frequency: body.frequency,
    interval: Math.max(1, Math.floor(body.interval || 1)),
    timeZone: body.timeZone || 'UTC',
    ...(body.startTime ? { startTime: body.startTime } : {}),
  };
  const jobDefinition: Record<string, unknown> = {
    jobType: 'Command',
    displayName: body.displayName || name,
    experimentName: body.experimentName || 'loom-notebook-schedules',
    command: body.command || 'echo loom-scheduled-notebook-run',
    environmentId: body.environmentId || DEFAULT_SCHEDULE_ENVIRONMENT,
    ...(body.computeId ? { computeId: body.computeId } : {}),
  };
  const armBody = {
    properties: {
      displayName: body.displayName || name,
      isEnabled: body.isEnabled !== false,
      trigger,
      action: { actionType: 'CreateJob', jobDefinition },
    },
  };
  const res = await armFetch(`${amlScheduleArmBase(cfg)}/${encodeURIComponent(name)}`,
    { apiVersion: ML_API, method: 'PUT', body: JSON.stringify(armBody) });
  const j = await readJson<any>(res);
  if (!j) throw new FoundryError(res.status, null, 'Schedule create returned no body');
  return shapeSchedule(j);
}

/**
 * Toggle a schedule's enabled state. AML has no PATCH for schedules in GA, so
 * we GET the existing resource, flip `isEnabled`, and re-PUT the (read-only
 * fields stripped) properties.
 */
export async function setScheduleEnabled(name: string, isEnabled: boolean): Promise<AmlSchedule> {
  const cfg = amlScheduleConfig();
  const path = `${amlScheduleArmBase(cfg)}/${encodeURIComponent(name)}`;
  const getRes = await armFetch(path, { apiVersion: ML_API });
  const existing = await readJson<any>(getRes);
  if (!existing) throw new FoundryError(404, null, `Schedule ${name} not found`);
  const props = existing.properties || {};
  // provisioningState is server-owned — drop it before the re-PUT.
  const { provisioningState: _ps, ...mutable } = props;
  const armBody = { properties: { ...mutable, isEnabled } };
  const putRes = await armFetch(path, { apiVersion: ML_API, method: 'PUT', body: JSON.stringify(armBody) });
  const j = await readJson<any>(putRes);
  return shapeSchedule(j || { ...existing, properties: { ...mutable, isEnabled } });
}
