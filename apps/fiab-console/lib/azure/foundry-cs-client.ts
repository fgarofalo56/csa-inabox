/**
 * Azure AI Foundry — Cognitive Services (AIServices / OpenAI) account client.
 *
 * The AI Foundry *hub* (Microsoft.MachineLearningServices/workspaces, handled
 * in foundry-client.ts) does NOT host model deployments. Model deployments,
 * model catalog, regional quota, account keys and the AOAI endpoint all live on
 * a sibling **Microsoft.CognitiveServices/accounts** resource (kind=AIServices
 * or kind=OpenAI). This client targets that account.
 *
 * Resolution order for the account:
 *   1. LOOM_AOAI_ACCOUNT (+ optional LOOM_AOAI_RG) — explicit override
 *   2. Discover: list CognitiveServices accounts in LOOM_FOUNDRY_RG, prefer
 *      kind in {AIServices, OpenAI}.
 * When neither resolves, throws CsNotConfiguredError so routes can return an
 * honest infra-gate (no fake data). See .claude/rules/no-vaporware.md.
 *
 * Auth: ARM management-plane scope (https://management.azure.com/.default) via
 * the same ChainedTokenCredential strategy as foundry-client.ts. The Console
 * UAMI needs `Cognitive Services Contributor` (deployments + keys) at the
 * account scope; `Reader` is enough for the read-only tabs.
 */
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

const ARM_SCOPE = 'https://management.azure.com/.default';
const CS_API = '2024-10-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class CsError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Cognitive Services call failed (${status})`);
    this.name = 'CsError';
    this.status = status;
    this.body = body;
  }
}

/** Thrown when no AOAI / AIServices account can be resolved in this deployment. */
export class CsNotConfiguredError extends Error {
  hint: string;
  constructor(hint: string) {
    super('No Azure AI Foundry model-hosting account (Cognitive Services) is configured in this deployment.');
    this.name = 'CsNotConfiguredError';
    this.hint = hint;
  }
}

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}
function sub(): string { return required('LOOM_SUBSCRIPTION_ID'); }
function rg(): string { return process.env.LOOM_FOUNDRY_RG || 'rg-csa-loom-admin-eastus2'; }

async function token(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new Error('Failed to acquire ARM token for Cognitive Services');
  return t.token;
}

async function armFetch(
  fullPath: string,
  init: RequestInit & { query?: Record<string, string>; apiVersion?: string } = {},
): Promise<Response> {
  const tok = await token();
  const sep = fullPath.includes('?') ? '&' : '?';
  const query = init.query ? '&' + new URLSearchParams(init.query).toString() : '';
  const url = `https://management.azure.com${fullPath}${sep}api-version=${init.apiVersion || CS_API}${query}`;
  const { query: _q, apiVersion: _av, ...rest } = init;
  return fetch(url, {
    ...rest,
    headers: { ...(rest.headers || {}), authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
  });
}

async function readJson<T>(res: Response): Promise<T | null> {
  if (res.status === 404) return null;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  if (!res.ok) {
    const msg = (parsed as any)?.error?.message || (typeof parsed === 'string' ? parsed : `Cognitive Services ${res.status}`);
    throw new CsError(res.status, parsed, msg);
  }
  return (parsed as T) ?? ({} as T);
}

// ---------------- Account resolution ----------------

export interface CsAccount {
  id: string;
  name: string;
  rg: string;
  location: string;
  kind?: string;
  sku?: string;
  endpoint?: string;
  publicNetworkAccess?: string;
  customSubDomainName?: string;
  provisioningState?: string;
  identity?: unknown;
}

let _accountCache: CsAccount | null = null;

function shapeAccount(raw: any): CsAccount {
  const p = raw?.properties || {};
  const idParts = String(raw?.id || '').split('/');
  const rgIdx = idParts.findIndex((x) => x.toLowerCase() === 'resourcegroups');
  return {
    id: raw?.id,
    name: raw?.name,
    rg: rgIdx >= 0 ? idParts[rgIdx + 1] : rg(),
    location: raw?.location,
    kind: raw?.kind,
    sku: raw?.sku?.name,
    endpoint: p.endpoint || p.endpoints?.['Azure AI Model Inference']?.endpoint,
    publicNetworkAccess: p.publicNetworkAccess,
    customSubDomainName: p.customSubDomainName,
    provisioningState: p.provisioningState,
    identity: raw?.identity,
  };
}

/** Resolve the model-hosting Cognitive Services account; cache after first hit. */
export async function resolveAccount(force = false): Promise<CsAccount> {
  if (_accountCache && !force) return _accountCache;

  const explicit = process.env.LOOM_AOAI_ACCOUNT;
  if (explicit) {
    const accountRg = process.env.LOOM_AOAI_RG || rg();
    const res = await armFetch(
      `/subscriptions/${sub()}/resourceGroups/${accountRg}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(explicit)}`,
    );
    const j = await readJson<any>(res);
    if (!j) {
      throw new CsNotConfiguredError(
        `LOOM_AOAI_ACCOUNT="${explicit}" was set but no Cognitive Services account by that name exists in resource group "${accountRg}". ` +
        `Create one (kind=AIServices) via platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep, or correct LOOM_AOAI_ACCOUNT / LOOM_AOAI_RG.`,
      );
    }
    _accountCache = shapeAccount(j);
    return _accountCache;
  }

  // Discover in the Foundry RG.
  const res = await armFetch(
    `/subscriptions/${sub()}/resourceGroups/${rg()}/providers/Microsoft.CognitiveServices/accounts`,
  );
  const j = await readJson<{ value?: any[] }>(res);
  const all = j?.value || [];
  if (all.length === 0) {
    throw new CsNotConfiguredError(
      `No Microsoft.CognitiveServices account found in resource group "${rg()}". AI Foundry model deployments, quota, ` +
      `keys and the AOAI endpoint require an AIServices/OpenAI account. Provision one (kind=AIServices) in ` +
      `platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep and grant the Console UAMI "Cognitive Services Contributor", ` +
      `then set LOOM_AOAI_ACCOUNT to its name.`,
    );
  }
  const preferred = all.find((a) => ['aiservices', 'openai'].includes(String(a.kind || '').toLowerCase())) || all[0];
  _accountCache = shapeAccount(preferred);
  return _accountCache;
}

function accountPath(acct: CsAccount): string {
  return `/subscriptions/${sub()}/resourceGroups/${acct.rg}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(acct.name)}`;
}

// ---------------- Model deployments ----------------

export interface ModelDeployment {
  id: string;
  name: string;
  modelName?: string;
  modelFormat?: string;
  modelVersion?: string;
  skuName?: string;
  capacity?: number;
  provisioningState?: string;
  raiPolicyName?: string;
  createdAt?: string;
}

function shapeDeployment(raw: any): ModelDeployment {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    modelName: p.model?.name,
    modelFormat: p.model?.format,
    modelVersion: p.model?.version,
    skuName: raw?.sku?.name,
    capacity: raw?.sku?.capacity ?? p.currentCapacity,
    provisioningState: p.provisioningState,
    raiPolicyName: p.raiPolicyName,
    createdAt: raw?.systemData?.createdAt,
  };
}

export async function listModelDeployments(): Promise<{ account: CsAccount; deployments: ModelDeployment[] }> {
  const acct = await resolveAccount();
  const res = await armFetch(`${accountPath(acct)}/deployments`);
  const j = await readJson<{ value?: any[] }>(res);
  return { account: acct, deployments: (j?.value || []).map(shapeDeployment) };
}

export interface CreateDeploymentInput {
  deploymentName: string;
  modelName: string;          // e.g. gpt-4o-mini
  modelFormat?: string;       // OpenAI (default)
  modelVersion?: string;      // optional; defaults to model default
  skuName?: string;           // GlobalStandard (default), Standard, DataZoneStandard…
  capacity?: number;          // tokens-per-minute / 1000 (default 10)
}

export async function createModelDeployment(input: CreateDeploymentInput): Promise<ModelDeployment> {
  const acct = await resolveAccount();
  const body: any = {
    sku: { name: input.skuName || 'GlobalStandard', capacity: input.capacity ?? 10 },
    properties: {
      model: {
        format: input.modelFormat || 'OpenAI',
        name: input.modelName,
        ...(input.modelVersion ? { version: input.modelVersion } : {}),
      },
      versionUpgradeOption: 'OnceNewDefaultVersionAvailable',
    },
  };
  const res = await armFetch(
    `${accountPath(acct)}/deployments/${encodeURIComponent(input.deploymentName)}`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
  // PUT returns 200 (sync) or 201/202 (async). Read body when present.
  if (res.status === 202) {
    return {
      id: `${accountPath(acct)}/deployments/${input.deploymentName}`,
      name: input.deploymentName,
      modelName: input.modelName,
      modelFormat: input.modelFormat || 'OpenAI',
      modelVersion: input.modelVersion,
      skuName: input.skuName || 'GlobalStandard',
      capacity: input.capacity ?? 10,
      provisioningState: 'Creating',
    };
  }
  const j = await readJson<any>(res);
  return shapeDeployment(j);
}

export async function deleteModelDeployment(deploymentName: string): Promise<void> {
  const acct = await resolveAccount();
  const res = await armFetch(
    `${accountPath(acct)}/deployments/${encodeURIComponent(deploymentName)}`,
    { method: 'DELETE' },
  );
  if (!res.ok && ![202, 204, 404].includes(res.status)) {
    const t = await res.text();
    throw new CsError(res.status, t, `Delete deployment failed: ${t.slice(0, 240)}`);
  }
}

// ---------------- Model catalog (account-scoped) ----------------

export interface CatalogModel {
  name: string;
  format?: string;
  version?: string;
  skus?: string[];
  maxCapacity?: number;
  lifecycleStatus?: string;
}

export async function listCatalogModels(): Promise<{ account: CsAccount; models: CatalogModel[] }> {
  const acct = await resolveAccount();
  // Account-scoped models endpoint returns the models available to deploy in
  // this account's region.
  const res = await armFetch(`${accountPath(acct)}/models`);
  const j = await readJson<{ value?: any[] }>(res);
  const rows = j?.value || [];
  const models: CatalogModel[] = rows.map((r: any) => {
    const m = r.model || r;
    const skus = (m.skus || []).map((s: any) => s.name).filter(Boolean);
    const maxCapacity = (m.skus || []).reduce(
      (mx: number, s: any) => Math.max(mx, s?.capacity?.maximum ?? 0),
      0,
    );
    return {
      name: m.name,
      format: m.format,
      version: m.version,
      skus,
      maxCapacity: maxCapacity || undefined,
      lifecycleStatus: m.lifecycleStatus,
    };
  });
  return { account: acct, models };
}

// ---------------- Quota / usages (per region) ----------------

export interface UsageRow {
  name: string;
  unit?: string;
  currentValue?: number;
  limit?: number;
}

export async function listUsages(location?: string): Promise<{ account: CsAccount; location: string; usages: UsageRow[] }> {
  const acct = await resolveAccount();
  const loc = location || acct.location;
  const res = await armFetch(
    `/subscriptions/${sub()}/providers/Microsoft.CognitiveServices/locations/${encodeURIComponent(loc)}/usages`,
  );
  const j = await readJson<{ value?: any[] }>(res);
  const usages: UsageRow[] = (j?.value || []).map((u: any) => ({
    name: u.name?.localizedValue || u.name?.value || u.name,
    unit: u.unit,
    currentValue: u.currentValue,
    limit: u.limit,
  }));
  return { account: acct, location: loc, usages };
}

// ---------------- Account keys + endpoint ----------------

export interface AccountKeys {
  endpoint?: string;
  key1?: string;
  key2?: string;
  regionalEndpoints?: Record<string, string>;
}

export async function getAccountKeys(): Promise<{ account: CsAccount; keys: AccountKeys }> {
  const acct = await resolveAccount();
  const res = await armFetch(`${accountPath(acct)}/listKeys`, { method: 'POST' });
  const j = await readJson<any>(res);
  // Re-fetch the account to surface endpoint map (listKeys returns only keys).
  const accRes = await armFetch(accountPath(acct));
  const accJson = await readJson<any>(accRes);
  return {
    account: acct,
    keys: {
      endpoint: accJson?.properties?.endpoint,
      key1: j?.key1,
      key2: j?.key2,
      regionalEndpoints: accJson?.properties?.endpoints,
    },
  };
}

// ---------------- Networking (public access + PE) ----------------

export interface NetworkingInfo {
  publicNetworkAccess?: string;
  ipRules?: string[];
  virtualNetworkRules?: string[];
  defaultAction?: string;
  privateEndpoints?: { name: string; state?: string; groupIds?: string[] }[];
}

export async function getNetworking(): Promise<{ account: CsAccount; networking: NetworkingInfo }> {
  const acct = await resolveAccount();
  const res = await armFetch(accountPath(acct));
  const j = await readJson<any>(res);
  const p = j?.properties || {};
  const peRes = await armFetch(`${accountPath(acct)}/privateEndpointConnections`).catch(() => null);
  const peJson = peRes ? await readJson<{ value?: any[] }>(peRes).catch(() => null) : null;
  return {
    account: acct,
    networking: {
      publicNetworkAccess: p.publicNetworkAccess,
      defaultAction: p.networkAcls?.defaultAction,
      ipRules: (p.networkAcls?.ipRules || []).map((r: any) => r.value),
      virtualNetworkRules: (p.networkAcls?.virtualNetworkRules || []).map((r: any) => r.id),
      privateEndpoints: (peJson?.value || []).map((pe: any) => ({
        name: pe.name,
        state: pe.properties?.privateLinkServiceConnectionState?.status,
        groupIds: pe.properties?.groupIds,
      })),
    },
  };
}

export async function setPublicNetworkAccess(enabled: boolean): Promise<NetworkingInfo> {
  const acct = await resolveAccount();
  const body = {
    properties: {
      publicNetworkAccess: enabled ? 'Enabled' : 'Disabled',
    },
  };
  const res = await armFetch(accountPath(acct), { method: 'PATCH', body: JSON.stringify(body) });
  if (!res.ok && res.status !== 202) {
    const t = await res.text();
    throw new CsError(res.status, t, `Set public network access failed: ${t.slice(0, 240)}`);
  }
  return (await getNetworking()).networking;
}

// ---------------- Role assignments (RBAC at the account scope) ----------------

export interface RoleAssignmentRow {
  id: string;
  principalId: string;
  principalType?: string;
  roleDefinitionId: string;
  roleName?: string;
  scope?: string;
}

// Well-known Cognitive Services role definition GUIDs → friendly names.
const ROLE_NAMES: Record<string, string> = {
  'a97b65f3-24c7-4388-baec-2e87135dc908': 'Cognitive Services User',
  '25fbc0a9-bd7c-42a3-aa1a-3b75d497ee68': 'Cognitive Services Contributor',
  'a001fd3d-188f-4b5d-821b-7da978bf7442': 'Cognitive Services OpenAI Contributor',
  '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd': 'Cognitive Services OpenAI User',
  'b24988ac-6180-42a0-ab88-20f7382dd24c': 'Contributor',
  '8e3af657-a8ff-443c-a75c-2fe8c4bcb635': 'Owner',
  'acdd72a7-3385-48ef-bd42-f606fba81ae7': 'Reader',
  '64702f94-c441-49e6-a78b-ef80e0188fee': 'Azure AI Developer',
  'f6c7c914-8db3-469d-8ca1-694a8f32e121': 'AzureML Data Scientist',
};

export async function listRoleAssignments(): Promise<{ account: CsAccount; assignments: RoleAssignmentRow[] }> {
  const acct = await resolveAccount();
  const res = await armFetch(
    `${accountPath(acct)}/providers/Microsoft.Authorization/roleAssignments`,
    { apiVersion: '2022-04-01', query: { '$filter': 'atScope()' } },
  );
  const j = await readJson<{ value?: any[] }>(res);
  const assignments: RoleAssignmentRow[] = (j?.value || []).map((a: any) => {
    const defId = String(a.properties?.roleDefinitionId || '');
    const guid = defId.split('/').pop() || '';
    return {
      id: a.id,
      principalId: a.properties?.principalId,
      principalType: a.properties?.principalType,
      roleDefinitionId: defId,
      roleName: ROLE_NAMES[guid] || guid,
      scope: a.properties?.scope,
    };
  });
  return { account: acct, assignments };
}

// ---------------- Activity log (ARM, account-scoped) ----------------

export interface ActivityRow {
  timestamp?: string;
  operationName?: string;
  status?: string;
  caller?: string;
  level?: string;
  resourceId?: string;
}

export async function listActivityLog(hours = 24): Promise<{ account: CsAccount; events: ActivityRow[] }> {
  const acct = await resolveAccount();
  const since = new Date(Date.now() - Math.max(1, Math.min(24 * 7, hours)) * 3600 * 1000).toISOString();
  const filter = `eventTimestamp ge '${since}' and resourceUri eq '${acct.id}'`;
  const res = await armFetch(
    `/subscriptions/${sub()}/providers/Microsoft.Insights/eventtypes/management/values`,
    { apiVersion: '2015-04-01', query: { '$filter': filter } },
  );
  const j = await readJson<{ value?: any[] }>(res);
  const events: ActivityRow[] = (j?.value || []).slice(0, 200).map((e: any) => ({
    timestamp: e.eventTimestamp,
    operationName: e.operationName?.localizedValue || e.operationName?.value,
    status: e.status?.localizedValue || e.status?.value,
    caller: e.caller,
    level: e.level,
    resourceId: e.resourceId,
  }));
  return { account: acct, events };
}
