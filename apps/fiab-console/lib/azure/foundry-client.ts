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
