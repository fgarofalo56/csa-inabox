/**
 * Copilot Studio / Power Platform client — for the v3 Copilot Studio editor family
 * (Agents, Knowledge sources, Topics, Actions, Channels, Analytics).
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) via ManagedIdentityCredential,
 * chained with DefaultAzureCredential for local dev.
 *
 * Copilot Studio agents (formerly "Power Virtual Agents bots") are stored
 * as Dataverse rows of entity `msdyn_copilot` inside a Power Platform
 * environment. The Dataverse Web API is reached at:
 *   https://<env-host>.crm.dynamics.com/api/data/v9.2/<entityset>
 *
 * Scopes:
 *   - Power Platform admin (BAP)   : https://api.bap.microsoft.com/.default
 *       used to list environments + admin analytics
 *   - Dataverse (per environment)  : https://<env-host>.crm.dynamics.com/.default
 *       used for all CRUD against msdyn_copilot, msdyn_knowledgesources,
 *       msdyn_botcomponents (topics), msdyn_bot_actions, msdyn_botchannels.
 *
 * Pre-requisites for real data:
 *   1. The UAMI service principal must exist as a Dataverse application user
 *      in the target environment, with a security role (typically
 *      "System Customizer" or "Copilot Studio Maker") granting access to
 *      the msdyn_* entities.
 *   2. The tenant admin must approve the SP for Power Platform usage if
 *      Tenant isolation is enabled.
 *   3. Each environment surfaced here must have Copilot Studio enabled.
 *
 * All errors surface as CopilotStudioError with status + body so the BFF
 * route can pass them to the editor UI verbatim (operators see the real
 * error rather than a sanitized 500).
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ClientSecretCredential,
  type TokenCredential,
} from '@azure/identity';

const BAP_BASE = process.env.LOOM_POWER_PLATFORM_BAP_BASE || 'https://api.bap.microsoft.com';
const BAP_SCOPE = 'https://api.bap.microsoft.com/.default';
const BAP_API_VERSION = '2020-10-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const uamiCredential: TokenCredential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

// Dataverse credential — Copilot Studio agents/knowledge live in Dataverse.
// UAMIs can't be Dataverse Application Users, so route those scopes through
// the MSAL Web App SP when configured. See powerplatform-client.ts.
const dataverseClientId = process.env.LOOM_DATAVERSE_CLIENT_ID;
const dataverseClientSecret = process.env.LOOM_DATAVERSE_CLIENT_SECRET;
const dataverseTenantId = process.env.LOOM_DATAVERSE_TENANT_ID || process.env.AZURE_TENANT_ID;
const dataverseCredential: TokenCredential | null =
  (dataverseClientId && dataverseClientSecret && dataverseTenantId)
    ? new ClientSecretCredential(dataverseTenantId, dataverseClientId, dataverseClientSecret)
    : null;

const isDataverseScope = (scope: string) => /\.crm[0-9]*\.dynamics\.com\/\.default$/.test(scope);

const credential = uamiCredential;

export class CopilotStudioError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string) {
    super(message);
    this.name = 'CopilotStudioError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

async function getToken(scope: string): Promise<string> {
  const cred = (isDataverseScope(scope) && dataverseCredential) ? dataverseCredential : uamiCredential;
  const t = await cred.getToken(scope);
  if (!t?.token) throw new CopilotStudioError(`Failed to acquire AAD token for ${scope}`, 401);
  return t.token;
}

interface CallOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  scope: string;
  headers?: Record<string, string>;
}

async function rawCall<T = any>(url: string, opts: CallOpts): Promise<T> {
  const token = await getToken(opts.scope);
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'odata-maxversion': '4.0',
      'odata-version': '4.0',
      ...(opts.headers || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || json?.message || text || `${opts.method ?? 'GET'} ${url} failed`).toString();
    // Detect "Copilot Studio not enabled in this env" — the msdyn_copilots table
    // and msdyn_knowledgesources table only exist when the env's admin has
    // enabled Copilot Studio (separate per-env add-on, PPAC → env → Copilot
    // Studio → Enable). Surface as a friendly 503 so editors render a quiet
    // MessageBar instead of a loud error.
    const isCsNotEnabled =
      res.status === 404 &&
      /Resource not found for the segment '(msdyn_copilots?|msdyn_knowledgesources?|msdyn_botcomponents?)'/i.test(msg);
    if (isCsNotEnabled) {
      throw new CopilotStudioError(
        'Copilot Studio is not enabled in this environment. ' +
        'Enable it from Power Platform admin centre → Environments → <env> → Settings → Product → Features → "Copilot Studio".',
        503, json || text, url,
      );
    }
    throw new CopilotStudioError(msg, res.status, json || text, url);
  }
  return (json as T) ?? ({} as T);
}

// ============================================================
// Environment resolution
// ============================================================

export interface PpEnvironment {
  id: string;            // GUID
  name: string;
  displayName: string;
  location?: string;
  type?: string;
  /** Dataverse host, e.g. orgxxxxx.crm.dynamics.com */
  dataverseHost?: string;
  /** Whether the environment has Dataverse provisioned */
  hasDataverse: boolean;
}

function bapUrl(path: string, query?: Record<string, string | undefined>): string {
  const u = new URL(`${BAP_BASE}${path}`);
  u.searchParams.set('api-version', BAP_API_VERSION);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) u.searchParams.set(k, v);
    }
  }
  return u.toString();
}

export async function listEnvironments(): Promise<PpEnvironment[]> {
  const j = await rawCall<{ value: any[] }>(
    bapUrl('/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments'),
    { scope: BAP_SCOPE },
  );
  return (j.value || []).map((e) => {
    const dvUrl: string | undefined = e?.properties?.linkedEnvironmentMetadata?.instanceUrl;
    let host: string | undefined;
    if (dvUrl) {
      try { host = new URL(dvUrl).host; } catch { /* ignore */ }
    }
    return {
      id: e.name,
      name: e.name,
      displayName: e?.properties?.displayName || e.name,
      location: e?.location,
      type: e?.properties?.environmentSku,
      dataverseHost: host,
      hasDataverse: Boolean(host),
    };
  });
}

async function envHost(envId: string): Promise<string> {
  const envs = await listEnvironments();
  const env = envs.find((e) => e.id === envId || e.name === envId);
  if (!env) throw new CopilotStudioError(`Environment ${envId} not found`, 404);
  if (!env.dataverseHost) {
    throw new CopilotStudioError(
      `Environment ${envId} does not have Dataverse provisioned — Copilot Studio requires Dataverse.`,
      409,
    );
  }
  return env.dataverseHost;
}

function dvScope(host: string): string {
  return `https://${host}/.default`;
}

function dvUrl(host: string, path: string, query?: Record<string, string | undefined>): string {
  const u = new URL(`https://${host}/api/data/v9.2${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) u.searchParams.set(k, v);
    }
  }
  return u.toString();
}

// ============================================================
// Agents (msdyn_copilot)
// ============================================================

export interface CopilotAgent {
  id: string;                   // msdyn_copilotid
  name: string;                 // msdyn_name
  description?: string;
  instructions?: string;
  modelDeployment?: string;
  schemaName?: string;
  state?: 'Draft' | 'Published' | 'Disabled' | string;
  createdOn?: string;
  modifiedOn?: string;
}

const AGENT_SELECT = [
  'msdyn_copilotid',
  'msdyn_name',
  'msdyn_description',
  'msdyn_instructions',
  'msdyn_modeldeployment',
  'msdyn_schemaname',
  'statecode',
  'createdon',
  'modifiedon',
].join(',');

function mapAgent(r: any): CopilotAgent {
  return {
    id: r.msdyn_copilotid,
    name: r.msdyn_name,
    description: r.msdyn_description,
    instructions: r.msdyn_instructions,
    modelDeployment: r.msdyn_modeldeployment,
    schemaName: r.msdyn_schemaname,
    state: r.statecode === 0 ? 'Draft' : r.statecode === 1 ? 'Published' : r.statecode === 2 ? 'Disabled' : String(r.statecode ?? ''),
    createdOn: r.createdon,
    modifiedOn: r.modifiedon,
  };
}

export async function listAgents(envId: string): Promise<CopilotAgent[]> {
  const host = await envHost(envId);
  const j = await rawCall<{ value: any[] }>(
    dvUrl(host, '/msdyn_copilots', { $select: AGENT_SELECT, $orderby: 'modifiedon desc' }),
    { scope: dvScope(host) },
  );
  return (j.value || []).map(mapAgent);
}

export async function getAgent(envId: string, id: string): Promise<CopilotAgent> {
  const host = await envHost(envId);
  const j = await rawCall<any>(
    dvUrl(host, `/msdyn_copilots(${id})`, { $select: AGENT_SELECT }),
    { scope: dvScope(host) },
  );
  return mapAgent(j);
}

export interface AgentUpsertBody {
  name: string;
  description?: string;
  instructions?: string;
  modelDeployment?: string;
}

export async function createAgent(envId: string, body: AgentUpsertBody): Promise<CopilotAgent> {
  const host = await envHost(envId);
  const dvBody: Record<string, any> = {
    msdyn_name: body.name,
  };
  if (body.description) dvBody.msdyn_description = body.description;
  if (body.instructions) dvBody.msdyn_instructions = body.instructions;
  if (body.modelDeployment) dvBody.msdyn_modeldeployment = body.modelDeployment;
  const j = await rawCall<any>(dvUrl(host, '/msdyn_copilots'), {
    scope: dvScope(host),
    method: 'POST',
    body: dvBody,
    headers: { prefer: 'return=representation' },
  });
  return mapAgent(j);
}

export async function updateAgent(envId: string, id: string, body: Partial<AgentUpsertBody>): Promise<CopilotAgent> {
  const host = await envHost(envId);
  const dvBody: Record<string, any> = {};
  if (body.name !== undefined) dvBody.msdyn_name = body.name;
  if (body.description !== undefined) dvBody.msdyn_description = body.description;
  if (body.instructions !== undefined) dvBody.msdyn_instructions = body.instructions;
  if (body.modelDeployment !== undefined) dvBody.msdyn_modeldeployment = body.modelDeployment;
  const j = await rawCall<any>(dvUrl(host, `/msdyn_copilots(${id})`), {
    scope: dvScope(host),
    method: 'PATCH',
    body: dvBody,
    headers: { prefer: 'return=representation' },
  });
  return mapAgent(j);
}

export async function deleteAgent(envId: string, id: string): Promise<void> {
  const host = await envHost(envId);
  await rawCall(dvUrl(host, `/msdyn_copilots(${id})`), { scope: dvScope(host), method: 'DELETE' });
}

export async function publishAgent(envId: string, id: string): Promise<{ ok: true }> {
  const host = await envHost(envId);
  // Dataverse bound action: msdyn_PublishCopilot (entity-bound)
  await rawCall(dvUrl(host, `/msdyn_copilots(${id})/Microsoft.Dynamics.CRM.msdyn_PublishCopilot`), {
    scope: dvScope(host),
    method: 'POST',
    body: {},
  });
  return { ok: true };
}

// ============================================================
// Knowledge sources (msdyn_knowledgesources)
// ============================================================

export type KnowledgeSourceType = 'url' | 'file' | 'sharepoint' | 'dataverse-table';

export interface KnowledgeSource {
  id: string;
  name: string;
  type: KnowledgeSourceType | string;
  uri?: string;
  status?: string;
  agentId?: string;
}

const KS_SELECT = [
  'msdyn_knowledgesourceid',
  'msdyn_name',
  'msdyn_type',
  'msdyn_uri',
  'msdyn_status',
  '_msdyn_copilotid_value',
].join(',');

function mapKnowledge(r: any): KnowledgeSource {
  return {
    id: r.msdyn_knowledgesourceid,
    name: r.msdyn_name,
    type: r.msdyn_type,
    uri: r.msdyn_uri,
    status: r.msdyn_status,
    agentId: r._msdyn_copilotid_value,
  };
}

export async function listKnowledgeSources(envId: string, agentId: string): Promise<KnowledgeSource[]> {
  const host = await envHost(envId);
  const j = await rawCall<{ value: any[] }>(
    dvUrl(host, '/msdyn_knowledgesources', {
      $select: KS_SELECT,
      $filter: `_msdyn_copilotid_value eq ${agentId}`,
      $orderby: 'createdon desc',
    }),
    { scope: dvScope(host) },
  );
  return (j.value || []).map(mapKnowledge);
}

export interface KnowledgeSourcePayload {
  type: KnowledgeSourceType;
  /** name displayed in the editor */
  name?: string;
  /** URL/file URI/SharePoint site URL/Dataverse table logical name */
  uri?: string;
}

export async function addKnowledgeSource(
  envId: string,
  agentId: string,
  payload: KnowledgeSourcePayload,
): Promise<KnowledgeSource> {
  const host = await envHost(envId);
  const body: Record<string, any> = {
    msdyn_type: payload.type,
    'msdyn_copilotid@odata.bind': `/msdyn_copilots(${agentId})`,
  };
  if (payload.name) body.msdyn_name = payload.name;
  if (payload.uri) body.msdyn_uri = payload.uri;
  const j = await rawCall<any>(dvUrl(host, '/msdyn_knowledgesources'), {
    scope: dvScope(host),
    method: 'POST',
    body,
    headers: { prefer: 'return=representation' },
  });
  return mapKnowledge(j);
}

export async function deleteKnowledgeSource(envId: string, id: string): Promise<void> {
  const host = await envHost(envId);
  await rawCall(dvUrl(host, `/msdyn_knowledgesources(${id})`), { scope: dvScope(host), method: 'DELETE' });
}

// ============================================================
// Topics (msdyn_botcomponents, componenttype eq 9)
// ============================================================

export interface CopilotTopic {
  id: string;
  name: string;
  triggerPhrases: string[];
  flowYaml?: string;
  agentId?: string;
  modifiedOn?: string;
}

const TOPIC_SELECT = [
  'msdyn_botcomponentid',
  'name',
  'componenttype',
  'data',
  'content',
  '_msdyn_copilotid_value',
  'modifiedon',
].join(',');

function parseTopicData(raw: any): { triggerPhrases: string[]; flowYaml?: string } {
  let triggerPhrases: string[] = [];
  let flowYaml: string | undefined;
  if (typeof raw?.content === 'string') flowYaml = raw.content;
  if (typeof raw?.data === 'string') {
    try {
      const obj = JSON.parse(raw.data);
      if (Array.isArray(obj?.triggerPhrases)) triggerPhrases = obj.triggerPhrases.map(String);
      if (typeof obj?.flowYaml === 'string') flowYaml = obj.flowYaml;
    } catch { /* leave as raw */ }
  }
  return { triggerPhrases, flowYaml };
}

function mapTopic(r: any): CopilotTopic {
  const parsed = parseTopicData(r);
  return {
    id: r.msdyn_botcomponentid,
    name: r.name,
    triggerPhrases: parsed.triggerPhrases,
    flowYaml: parsed.flowYaml,
    agentId: r._msdyn_copilotid_value,
    modifiedOn: r.modifiedon,
  };
}

export async function listTopics(envId: string, agentId: string): Promise<CopilotTopic[]> {
  const host = await envHost(envId);
  const j = await rawCall<{ value: any[] }>(
    dvUrl(host, '/msdyn_botcomponents', {
      $select: TOPIC_SELECT,
      $filter: `componenttype eq 9 and _msdyn_copilotid_value eq ${agentId}`,
      $orderby: 'modifiedon desc',
    }),
    { scope: dvScope(host) },
  );
  return (j.value || []).map(mapTopic);
}

export async function getTopic(envId: string, id: string): Promise<CopilotTopic> {
  const host = await envHost(envId);
  const j = await rawCall<any>(
    dvUrl(host, `/msdyn_botcomponents(${id})`, { $select: TOPIC_SELECT }),
    { scope: dvScope(host) },
  );
  return mapTopic(j);
}

export interface TopicUpsertBody {
  agentId: string;
  name: string;
  triggerPhrases: string[];
  flowYaml: string;
}

export async function upsertTopic(envId: string, body: TopicUpsertBody, id?: string): Promise<CopilotTopic> {
  const host = await envHost(envId);
  const dvBody: Record<string, any> = {
    name: body.name,
    componenttype: 9,
    data: JSON.stringify({ triggerPhrases: body.triggerPhrases, flowYaml: body.flowYaml }),
    content: body.flowYaml,
  };
  if (!id) dvBody['msdyn_copilotid@odata.bind'] = `/msdyn_copilots(${body.agentId})`;
  const path = id ? `/msdyn_botcomponents(${id})` : '/msdyn_botcomponents';
  const j = await rawCall<any>(dvUrl(host, path), {
    scope: dvScope(host),
    method: id ? 'PATCH' : 'POST',
    body: dvBody,
    headers: { prefer: 'return=representation' },
  });
  return mapTopic(j);
}

export async function deleteTopic(envId: string, id: string): Promise<void> {
  const host = await envHost(envId);
  await rawCall(dvUrl(host, `/msdyn_botcomponents(${id})`), { scope: dvScope(host), method: 'DELETE' });
}

// ============================================================
// Actions (msdyn_bot_actions)
// ============================================================

export interface CopilotAction {
  id: string;
  name: string;
  type?: string;
  connectorId?: string;
  flowId?: string;
  agentId?: string;
  enabled?: boolean;
}

const ACTION_SELECT = [
  'msdyn_bot_actionid',
  'msdyn_name',
  'msdyn_type',
  'msdyn_connectorid',
  'msdyn_flowid',
  '_msdyn_copilotid_value',
  'statecode',
].join(',');

function mapAction(r: any): CopilotAction {
  return {
    id: r.msdyn_bot_actionid,
    name: r.msdyn_name,
    type: r.msdyn_type,
    connectorId: r.msdyn_connectorid,
    flowId: r.msdyn_flowid,
    agentId: r._msdyn_copilotid_value,
    enabled: r.statecode === 0,
  };
}

export async function listActions(envId: string, agentId: string): Promise<CopilotAction[]> {
  const host = await envHost(envId);
  const j = await rawCall<{ value: any[] }>(
    dvUrl(host, '/msdyn_bot_actions', {
      $select: ACTION_SELECT,
      $filter: `_msdyn_copilotid_value eq ${agentId}`,
      $orderby: 'createdon desc',
    }),
    { scope: dvScope(host) },
  );
  return (j.value || []).map(mapAction);
}

export interface ActionUpsertBody {
  agentId: string;
  name: string;
  type: 'power-automate-flow' | 'custom-connector' | 'prebuilt' | string;
  connectorId?: string;
  flowId?: string;
}

export async function bindAction(envId: string, body: ActionUpsertBody): Promise<CopilotAction> {
  const host = await envHost(envId);
  const dvBody: Record<string, any> = {
    msdyn_name: body.name,
    msdyn_type: body.type,
    'msdyn_copilotid@odata.bind': `/msdyn_copilots(${body.agentId})`,
  };
  if (body.connectorId) dvBody.msdyn_connectorid = body.connectorId;
  if (body.flowId) dvBody.msdyn_flowid = body.flowId;
  const j = await rawCall<any>(dvUrl(host, '/msdyn_bot_actions'), {
    scope: dvScope(host),
    method: 'POST',
    body: dvBody,
    headers: { prefer: 'return=representation' },
  });
  return mapAction(j);
}

export async function deleteAction(envId: string, id: string): Promise<void> {
  const host = await envHost(envId);
  await rawCall(dvUrl(host, `/msdyn_bot_actions(${id})`), { scope: dvScope(host), method: 'DELETE' });
}

// ============================================================
// Channels (msdyn_botchannels)
// ============================================================

export type ChannelType = 'teams' | 'web' | 'direct-line' | 'slack' | 'facebook' | 'custom' | string;

export interface CopilotChannel {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  embedUrl?: string;
  agentId?: string;
  config?: Record<string, any>;
}

const CHANNEL_SELECT = [
  'msdyn_botchannelid',
  'msdyn_name',
  'msdyn_type',
  'msdyn_enabled',
  'msdyn_embedurl',
  'msdyn_configuration',
  '_msdyn_copilotid_value',
].join(',');

function mapChannel(r: any): CopilotChannel {
  let config: Record<string, any> | undefined;
  if (typeof r.msdyn_configuration === 'string' && r.msdyn_configuration) {
    try { config = JSON.parse(r.msdyn_configuration); } catch { /* leave raw */ }
  }
  return {
    id: r.msdyn_botchannelid,
    name: r.msdyn_name,
    type: r.msdyn_type,
    enabled: Boolean(r.msdyn_enabled),
    embedUrl: r.msdyn_embedurl,
    agentId: r._msdyn_copilotid_value,
    config,
  };
}

export async function listChannels(envId: string, agentId: string): Promise<CopilotChannel[]> {
  const host = await envHost(envId);
  const j = await rawCall<{ value: any[] }>(
    dvUrl(host, '/msdyn_botchannels', {
      $select: CHANNEL_SELECT,
      $filter: `_msdyn_copilotid_value eq ${agentId}`,
    }),
    { scope: dvScope(host) },
  );
  return (j.value || []).map(mapChannel);
}

export async function publishToChannel(
  envId: string,
  agentId: string,
  channelType: ChannelType,
  config: Record<string, any> = {},
): Promise<CopilotChannel> {
  const host = await envHost(envId);
  const dvBody: Record<string, any> = {
    msdyn_name: `${channelType}-channel`,
    msdyn_type: channelType,
    msdyn_enabled: true,
    msdyn_configuration: JSON.stringify(config),
    'msdyn_copilotid@odata.bind': `/msdyn_copilots(${agentId})`,
  };
  const j = await rawCall<any>(dvUrl(host, '/msdyn_botchannels'), {
    scope: dvScope(host),
    method: 'POST',
    body: dvBody,
    headers: { prefer: 'return=representation' },
  });
  return mapChannel(j);
}

// ============================================================
// Analytics (Power Platform admin analytics REST)
// ============================================================

export interface CopilotAnalytics {
  agentId: string;
  windowDays: number;
  sessions: number;
  resolvedSessions: number;
  escalatedSessions: number;
  satisfactionScore?: number;
  resolutionRate?: number;
  escalationRate?: number;
  daily?: { date: string; sessions: number }[];
}

export async function getAnalytics(envId: string, agentId: string, days = 30): Promise<CopilotAnalytics> {
  // Admin BAP analytics endpoint for Copilot Studio bots. If the analytics
  // pipeline has not produced data yet, BAP returns an empty result — we
  // surface zeros rather than throw, because that's the truthful state.
  const url = bapUrl(
    `/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${envId}/copilots/${agentId}/analytics`,
    { window: `${days}d` },
  );
  try {
    const j = await rawCall<any>(url, { scope: BAP_SCOPE });
    const sessions = Number(j?.sessions ?? j?.totalSessions ?? 0);
    const resolved = Number(j?.resolvedSessions ?? j?.resolved ?? 0);
    const escalated = Number(j?.escalatedSessions ?? j?.escalated ?? 0);
    const csat = j?.satisfactionScore ?? j?.csat;
    const daily = Array.isArray(j?.daily)
      ? j.daily.map((d: any) => ({ date: String(d.date), sessions: Number(d.sessions ?? 0) }))
      : undefined;
    return {
      agentId,
      windowDays: days,
      sessions,
      resolvedSessions: resolved,
      escalatedSessions: escalated,
      satisfactionScore: typeof csat === 'number' ? csat : undefined,
      resolutionRate: sessions > 0 ? resolved / sessions : undefined,
      escalationRate: sessions > 0 ? escalated / sessions : undefined,
      daily,
    };
  } catch (e) {
    if (e instanceof CopilotStudioError && (e.status === 404 || e.status === 204)) {
      return { agentId, windowDays: days, sessions: 0, resolvedSessions: 0, escalatedSessions: 0 };
    }
    throw e;
  }
}

// ============================================================
// Test chat (Bot Framework Direct Line)
// ============================================================
//
// The in-product "Test your agent" panel talks to the published agent over
// Direct Line. A web client can't reach the agent without a Direct Line
// token, minted by exchanging the agent's Direct Line secret at
// https://directline.botframework.com/v3/directline/tokens/generate.
//
// Copilot Studio does not expose the per-agent Direct Line secret through
// Dataverse, so the secret is supplied out-of-band as an env var
// (LOOM_COPILOT_DIRECTLINE_SECRET) for the deployment's shared test agent,
// or per-agent via LOOM_COPILOT_DIRECTLINE_SECRET_<AGENTID-UPPER-NODASH>.
// When no secret is configured we surface an honest infra-gate to the UI.

const DIRECTLINE_TOKEN_URL =
  process.env.LOOM_DIRECTLINE_TOKEN_URL || 'https://directline.botframework.com/v3/directline/tokens/generate';

/** Resolve a Direct Line secret for the given agent, if configured. */
function directLineSecretFor(agentId: string): string | undefined {
  const perAgentKey = `LOOM_COPILOT_DIRECTLINE_SECRET_${agentId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()}`;
  return process.env[perAgentKey] || process.env.LOOM_COPILOT_DIRECTLINE_SECRET || undefined;
}

export interface DirectLineToken {
  token: string;
  conversationId?: string;
  expiresInSeconds?: number;
  endpoint: string;
}

/**
 * Mint a single-conversation Direct Line token for the agent's test chat.
 * Throws CopilotStudioError(424) when no Direct Line secret is configured so
 * the BFF can render an honest infra-gate MessageBar (no mock token).
 */
export async function getDirectLineToken(agentId: string): Promise<DirectLineToken> {
  const secret = directLineSecretFor(agentId);
  if (!secret) {
    throw new CopilotStudioError(
      'Test chat requires a Direct Line secret. Publish this agent in Copilot Studio, ' +
      'open Settings → Channels → Web/Direct Line, copy a channel secret, and set ' +
      `LOOM_COPILOT_DIRECTLINE_SECRET_${agentId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()} ` +
      '(or LOOM_COPILOT_DIRECTLINE_SECRET for a shared test agent) on the console app.',
      424,
    );
  }
  const res = await fetch(DIRECTLINE_TOKEN_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok || !json?.token) {
    throw new CopilotStudioError(
      json?.error?.message || `Direct Line token generation failed (HTTP ${res.status})`,
      res.status || 502,
      json || text,
      DIRECTLINE_TOKEN_URL,
    );
  }
  return {
    token: json.token,
    conversationId: json.conversationId,
    expiresInSeconds: json.expires_in,
    endpoint: 'https://directline.botframework.com/v3/directline',
  };
}
