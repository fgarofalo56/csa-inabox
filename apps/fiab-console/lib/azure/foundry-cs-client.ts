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

/**
 * Optional explicit account selector threaded from the UI's account picker.
 * When provided, every client call targets THIS account instead of the
 * env-var default / discovery result. `{ name, rg? }` — rg defaults to the
 * Foundry RG (LOOM_FOUNDRY_RG) when omitted.
 */
export interface AccountSelector { name: string; rg?: string }

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

/**
 * List ALL Microsoft.CognitiveServices accounts in the subscription that can
 * host model deployments / AOAI (kind in {AIServices, OpenAI, CognitiveServices}).
 * Drives the AI Foundry account picker so every Foundry surface can target a
 * user-selected account instead of the single env-var default.
 *
 * ARM: GET /subscriptions/{sub}/providers/Microsoft.CognitiveServices/accounts
 *      (Operation Accounts_List). Grounded in Microsoft Learn.
 */
export async function listAccounts(): Promise<CsAccount[]> {
  const res = await armFetch(
    `/subscriptions/${sub()}/providers/Microsoft.CognitiveServices/accounts`,
  );
  const j = await readJson<{ value?: any[] }>(res);
  const all = (j?.value || []).map(shapeAccount);
  // Surface only model-hosting kinds; keep stable, predictable order.
  const HOSTING = new Set(['aiservices', 'openai', 'cognitiveservices']);
  return all
    .filter((a) => HOSTING.has(String(a.kind || '').toLowerCase()))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/**
 * Resolve the model-hosting Cognitive Services account.
 *
 * Resolution order:
 *   1. `selector` (from the UI account picker) — explicit name (+ optional rg)
 *   2. LOOM_AOAI_ACCOUNT (+ optional LOOM_AOAI_RG) — env default
 *   3. Discover the first AIServices/OpenAI account in LOOM_FOUNDRY_RG
 *
 * The single-account cache only applies to the env/discovery default (no
 * selector); an explicit selector always resolves fresh so per-request account
 * switching is correct.
 */
export async function resolveAccount(force = false, selector?: AccountSelector): Promise<CsAccount> {
  if (selector?.name) {
    const accountRg = selector.rg || rg();
    const res = await armFetch(
      `/subscriptions/${sub()}/resourceGroups/${encodeURIComponent(accountRg)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(selector.name)}`,
    );
    const j = await readJson<any>(res);
    if (!j) {
      throw new CsNotConfiguredError(
        `Selected AI Foundry account "${selector.name}" was not found in resource group "${accountRg}". ` +
        `Pick a different account from the AI Foundry account picker, or provision one (kind=AIServices) via ` +
        `platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep.`,
      );
    }
    return shapeAccount(j);
  }

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

export async function listModelDeployments(selector?: AccountSelector): Promise<{ account: CsAccount; deployments: ModelDeployment[] }> {
  const acct = await resolveAccount(false, selector);
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
  raiPolicyName?: string;     // content filter policy (e.g. "Microsoft.DefaultV2")
}

export async function createModelDeployment(input: CreateDeploymentInput, selector?: AccountSelector): Promise<ModelDeployment> {
  const acct = await resolveAccount(false, selector);
  const body: any = {
    sku: { name: input.skuName || 'GlobalStandard', capacity: input.capacity ?? 10 },
    properties: {
      model: {
        format: input.modelFormat || 'OpenAI',
        name: input.modelName,
        ...(input.modelVersion ? { version: input.modelVersion } : {}),
      },
      ...(input.raiPolicyName ? { raiPolicyName: input.raiPolicyName } : {}),
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

export async function deleteModelDeployment(deploymentName: string, selector?: AccountSelector): Promise<void> {
  const acct = await resolveAccount(false, selector);
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
  /** Stable id used by the UI for selection / detail lookup. */
  id: string;
  name: string;
  /** Publisher / provider — "OpenAI", "Microsoft", "Meta", "Mistral AI", "DeepSeek", "Cohere", "xAI", … */
  publisher?: string;
  /** Deployment model format ("OpenAI", "Microsoft", "Meta", …). */
  format?: string;
  version?: string;
  /** Default version flag from the account list-models response. */
  isDefaultVersion?: boolean;
  skus?: string[];
  defaultCapacity?: number;
  maxCapacity?: number;
  lifecycleStatus?: string;
  /** Deprecation/retirement date if the model is being sunset. */
  deprecationInference?: string;
  /** Inference tasks the model supports — "chat-completion", "embeddings", "image-generation", … */
  inferenceTasks: string[];
  /** Capability flags: chatCompletion, embeddings, imageGenerations, etc. */
  capabilities: string[];
  /** Deployment options derivable from the SKUs (GlobalStandard, Standard, ProvisionedManaged, …). */
  deploymentOptions: string[];
  /** Whether this model can be deployed to *this* account (account list-models = yes). */
  deployableHere: boolean;
}

/** Map raw publisher/format strings → curated collection name for the Collections filter. */
function collectionFor(publisher?: string, format?: string): string {
  const p = (publisher || format || '').toLowerCase();
  if (p.includes('openai')) return 'OpenAI';
  if (p.includes('microsoft') || p.includes('phi')) return 'Microsoft';
  if (p.includes('meta') || p.includes('llama')) return 'Meta';
  if (p.includes('mistral')) return 'Mistral AI';
  if (p.includes('deepseek')) return 'DeepSeek';
  if (p.includes('cohere')) return 'Cohere';
  if (p.includes('xai') || p.includes('grok')) return 'xAI';
  if (p.includes('nvidia')) return 'NVIDIA';
  if (p.includes('ai21')) return 'AI21 Labs';
  if (p.includes('core42') || p.includes('jais')) return 'Core42';
  if (p.includes('nixtla')) return 'Nixtla';
  if (p.includes('stability')) return 'Stability AI';
  if (p.includes('black forest') || p.includes('flux')) return 'Black Forest Labs';
  return publisher || format || 'Other';
}

/** Infer inference tasks + capabilities from a model name when the API row lacks them. */
function inferTasks(name: string): { inferenceTasks: string[]; capabilities: string[] } {
  const n = name.toLowerCase();
  const tasks = new Set<string>();
  const caps = new Set<string>();
  if (/embed/.test(n)) { tasks.add('embeddings'); caps.add('embeddings'); }
  if (/dall-?e|image|flux|stable-?diffusion|imagen/.test(n)) { tasks.add('image-generation'); caps.add('imageGenerations'); }
  if (/whisper|transcrib/.test(n)) { tasks.add('audio-transcription'); caps.add('audioTranscription'); }
  if (/tts|text-to-speech/.test(n)) { tasks.add('text-to-speech'); caps.add('textToSpeech'); }
  if (/rerank/.test(n)) { tasks.add('text-rerank'); caps.add('rerank'); }
  if (/timegen|forecast/.test(n)) { tasks.add('time-series-forecasting'); }
  if (tasks.size === 0) { tasks.add('chat-completion'); caps.add('chatCompletion'); }
  return { inferenceTasks: [...tasks], capabilities: [...caps] };
}

function shapeCatalogModel(r: any): CatalogModel {
  const m = r.model || r;
  const skus: string[] = (m.skus || []).map((s: any) => s.name).filter(Boolean);
  const maxCapacity = (m.skus || []).reduce((mx: number, s: any) => Math.max(mx, s?.capacity?.maximum ?? 0), 0);
  const defaultCapacity = m.skus?.[0]?.capacity?.default ?? undefined;
  const apiCaps: string[] = m.capabilities
    ? Object.entries(m.capabilities).filter(([, v]) => v === true || v === 'true').map(([k]) => k)
    : [];
  const apiTasks: string[] = Array.isArray(m.inferenceTasks) ? m.inferenceTasks : [];
  const inferred = inferTasks(m.name || '');
  const publisher = m.publisher || m.format;
  return {
    id: `${m.name}:${m.version || 'default'}`,
    name: m.name,
    publisher: collectionFor(publisher, m.format),
    format: m.format,
    version: m.version,
    isDefaultVersion: m.isDefaultVersion === true || m.isDefaultVersion === 'true',
    skus,
    defaultCapacity,
    maxCapacity: maxCapacity || undefined,
    lifecycleStatus: m.lifecycleStatus,
    deprecationInference: m.deprecation?.inference,
    inferenceTasks: apiTasks.length ? apiTasks : inferred.inferenceTasks,
    capabilities: apiCaps.length ? apiCaps : inferred.capabilities,
    deploymentOptions: skus.length ? skus : ['GlobalStandard'],
    deployableHere: true,
  };
}

/**
 * Account-scoped catalog — the REAL set of models deployable to this Cognitive
 * Services / AIServices account in its region. This is what
 * `az cognitiveservices account list-models` returns and is the ground truth
 * for the deploy flow: every row here is deployable via the deployments PUT.
 *
 * The public ai.azure.com/explore/models registry catalog is NOT reachable with
 * the ARM management token server-side, so we source from the account
 * list-models API and tag each row deployableHere=true so the UI never promises
 * a deploy it can't fulfil.
 */
export async function listCatalogModels(selector?: AccountSelector): Promise<{ account: CsAccount; models: CatalogModel[] }> {
  const acct = await resolveAccount(false, selector);
  const res = await armFetch(`${accountPath(acct)}/models`);
  const j = await readJson<{ value?: any[] }>(res);
  const rows = j?.value || [];
  const models = rows.map(shapeCatalogModel)
    // De-dupe by name, preferring the default version.
    .reduce((acc: CatalogModel[], m: CatalogModel) => {
      const existing = acc.find((x) => x.name === m.name);
      if (!existing) { acc.push(m); return acc; }
      if (m.isDefaultVersion && !existing.isDefaultVersion) Object.assign(existing, m);
      return acc;
    }, [])
    .sort((a: CatalogModel, b: CatalogModel) => a.name.localeCompare(b.name));
  return { account: acct, models };
}

// ---------------- Chat playground (data-plane chat completions) ----------------

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatParams { temperature?: number; maxTokens?: number; topP?: number; stop?: string[] }
export interface ChatResult {
  content: string;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  model?: string;
}

const AOAI_DATA_API = process.env.LOOM_AOAI_API_VERSION || '2024-10-21';
const COG_SCOPE = 'https://cognitiveservices.azure.com/.default';

async function dataPlaneToken(): Promise<string> {
  const t = await credential.getToken(COG_SCOPE);
  if (!t?.token) throw new Error('Failed to acquire Cognitive Services data-plane token');
  return t.token;
}

/** Resolve the AOAI data-plane endpoint host (e.g. https://acct.openai.azure.com). */
async function aoaiEndpoint(acct: CsAccount): Promise<string> {
  if (acct.endpoint) return acct.endpoint.replace(/\/$/, '');
  const res = await armFetch(accountPath(acct));
  const j = await readJson<any>(res);
  const ep = j?.properties?.endpoint
    || j?.properties?.endpoints?.['OpenAI Language Model Instance API']
    || j?.properties?.endpoints?.['Azure AI Model Inference API'];
  if (!ep) throw new CsError(404, null, 'AOAI account has no resolvable data-plane endpoint.');
  return String(ep).replace(/\/$/, '');
}

/**
 * Run a chat completion against a REAL deployed model on this account. Throws a
 * CsError (404/DeploymentNotFound) when the deployment doesn't exist so the
 * route can surface an honest "deploy a chat model first" gate.
 */
export async function chatCompletion(
  deploymentName: string,
  messages: ChatMessage[],
  params: ChatParams = {},
  selector?: AccountSelector,
): Promise<ChatResult> {
  const acct = await resolveAccount(false, selector);
  const endpoint = await aoaiEndpoint(acct);
  const tok = await dataPlaneToken();
  const url = `${endpoint}/openai/deployments/${encodeURIComponent(deploymentName)}/chat/completions?api-version=${AOAI_DATA_API}`;
  const body: any = { messages };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.stop && params.stop.length) body.stop = params.stop;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = undefined;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  if (!res.ok) {
    const msg = parsed?.error?.message || (typeof parsed === 'string' ? parsed : `Chat completion failed (${res.status})`);
    throw new CsError(res.status, parsed, msg);
  }
  const choice = parsed?.choices?.[0];
  return {
    content: choice?.message?.content ?? '',
    finishReason: choice?.finish_reason,
    usage: parsed?.usage
      ? { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens, totalTokens: parsed.usage.total_tokens }
      : undefined,
    model: parsed?.model,
  };
}

// ---------------- Quota / usages (per region) ----------------

export interface UsageRow {
  name: string;
  unit?: string;
  currentValue?: number;
  limit?: number;
}

export async function listUsages(location?: string, selector?: AccountSelector): Promise<{ account: CsAccount; location: string; usages: UsageRow[] }> {
  const acct = await resolveAccount(false, selector);
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

export async function getAccountKeys(selector?: AccountSelector): Promise<{ account: CsAccount; keys: AccountKeys }> {
  const acct = await resolveAccount(false, selector);
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

export async function getNetworking(selector?: AccountSelector): Promise<{ account: CsAccount; networking: NetworkingInfo }> {
  const acct = await resolveAccount(false, selector);
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

export async function setPublicNetworkAccess(enabled: boolean, selector?: AccountSelector): Promise<NetworkingInfo> {
  const acct = await resolveAccount(false, selector);
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

export async function listRoleAssignments(selector?: AccountSelector): Promise<{ account: CsAccount; assignments: RoleAssignmentRow[] }> {
  const acct = await resolveAccount(false, selector);
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

export async function listActivityLog(hours = 24, selector?: AccountSelector): Promise<{ account: CsAccount; events: ActivityRow[] }> {
  const acct = await resolveAccount(false, selector);
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
