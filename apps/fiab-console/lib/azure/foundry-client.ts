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
 * Auth scope:  https://management.azure.com/.default
 * UAMI role:   Contributor at the workspace scope.
 *
 * 404 → null. Any other non-2xx throws FoundryError(status, body).
 */
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

const ARM_SCOPE = 'https://management.azure.com/.default';
const ML_API = '2024-10-01';

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

function foundryBase(): string {
  const sub = required('LOOM_SUBSCRIPTION_ID');
  const rg = process.env.LOOM_FOUNDRY_RG || 'rg-csa-loom-admin-eastus2';
  const name = process.env.LOOM_FOUNDRY_NAME || 'aifoundry-csa-loom-eastus2';
  return `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.MachineLearningServices/workspaces/${name}`;
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

export async function listModels(): Promise<FoundryModelSummary[]> {
  const rows = await pagedList('/models');
  return rows.map(shapeModelContainer);
}

export async function getModel(name: string): Promise<FoundryModelSummary | null> {
  const res = await foundryFetch(`/models/${encodeURIComponent(name)}`);
  const j = await readJson<any>(res);
  return j ? shapeModelContainer(j) : null;
}

export async function listModelVersions(name: string): Promise<FoundryModelVersion[]> {
  const rows = await pagedList(`/models/${encodeURIComponent(name)}/versions`);
  return rows.map(shapeModelVersion);
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

export async function listOnlineEndpoints(): Promise<FoundryEndpoint[]> {
  const rows = await pagedList('/onlineEndpoints');
  return rows.map(shapeEndpoint);
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
  const url = `https://management.azure.com${fullPath}${sep}api-version=${init.apiVersion}${query}`;
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
// e.g. https://eastus2.api.azureml.ms/<segment>
async function amlDataPlaneFetch(
  segment: string,
  init: RequestInit = {},
): Promise<Response> {
  const region = process.env.LOOM_FOUNDRY_REGION || 'eastus2';
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token for AML data plane');
  const url = `https://${region}.api.azureml.ms${segment.startsWith('/') ? segment : '/' + segment}`;
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
  const res = await fetch(`https://${svc}.search.windows.net/indexes/${encodeURIComponent(name)}?api-version=${SEARCH_API}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...definition, name }),
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
