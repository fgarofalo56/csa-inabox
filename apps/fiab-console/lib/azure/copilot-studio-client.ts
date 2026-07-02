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
 *       msdyn_botcomponents (topics), msdyn_plugin / msdyn_pluginaction
 *       (actions/tools — the current-tenant plugin model), and the channel
 *       surface. NOTE: agent ACTIONS are modelled by the plugin pair
 *       msdyn_plugin (the agent's plugin/skill) + msdyn_pluginaction (the
 *       individual action), NOT the legacy/likely-nonexistent
 *       `msdyn_bot_actions` set — verified against Dataverse EntityDefinitions
 *       (see the Actions section comment). CHANNEL state really lives in Azure
 *       Bot Service: the msdyn_botchannels read is retained only so a genuine
 *       404 surfaces the honest "Channel state lives in Azure Bot Service"
 *       message rather than a fake empty success.
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

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ClientSecretCredential,
  type TokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

const BAP_BASE = process.env.LOOM_POWER_PLATFORM_BAP_BASE || 'https://api.bap.microsoft.com';
const BAP_SCOPE = 'https://api.bap.microsoft.com/.default';
const BAP_API_VERSION = '2020-10-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const uamiCredential: TokenCredential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
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
  const res = await fetchWithTimeout(url, {
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
    // ----------------------------------------------------------------
    // Honest error classification (H1 — see docs/fiab/audit §2 H1).
    //
    // Dataverse reports a missing entity-SET or a missing COLUMN with very
    // different shapes. We must:
    //   (a) map ONLY the canonical Copilot-Studio core entities — the ones
    //       that genuinely don't exist until an admin enables Copilot Studio
    //       on the environment — to the friendly "enable Copilot Studio" 503;
    //   (b) surface EVERY other missing entity-set / missing column as an
    //       HONEST schema error that names the offending entity/column, so a
    //       wrong table (e.g. msdyn_botchannels, msdyn_bot_actions) or an
    //       invented scalar column (e.g. msdyn_instructions) is not masked as
    //       a benign enablement gate.
    //
    // The previous handler matched msdyn_botcomponents (topics) AND, more
    // dangerously, would have masked any of the three core names while letting
    // the genuinely-fabricated tables fall through inconsistently. We tighten
    // it to the true Copilot-Studio enablement surfaces only.
    // ----------------------------------------------------------------
    const segMatch = msg.match(/Resource not found for the segment '([^']+)'/i);
    const missingSegment = segMatch?.[1];
    // Columns that don't exist surface as "Could not find a property named 'X'"
    // (read) or "An undeclared property 'X' ... was found" (write).
    const propMatch = msg.match(/(?:Could not find a property named|undeclared property)\s+'([^']+)'/i);
    const missingProperty = propMatch?.[1];

    // The entity sets whose absence truly means "Copilot Studio add-on not
    // enabled on this environment". msdyn_copilots is the agent table; its
    // absence is the authoritative signal. Knowledge sources / bot components
    // are provisioned alongside it.
    const CS_ENABLEMENT_ENTITIES = /^(msdyn_copilots?|msdyn_knowledgesources?|msdyn_botcomponents?)$/i;

    if (res.status === 404 && missingSegment && CS_ENABLEMENT_ENTITIES.test(missingSegment)) {
      throw new CopilotStudioError(
        'Copilot Studio is not enabled in this environment. ' +
        'Enable it from Power Platform admin centre → Environments → <env> → Settings → Product → Features → "Copilot Studio".',
        503, json || text, url,
      );
    }

    // A missing entity SET that is NOT a core enablement entity is a genuine
    // schema error — the Dataverse table this client targets does not exist in
    // this org (the leading suspects: msdyn_botchannels, msdyn_bot_actions).
    // Surface it honestly so the operator sees the real cause instead of a
    // misleading "enable Copilot Studio" message.
    if (res.status === 404 && missingSegment) {
      throw new CopilotStudioError(
        `Dataverse entity set '${missingSegment}' was not found in this environment. ` +
        `This table is not part of the standard Copilot Studio schema in this org — ` +
        `verify the entity name against the live tenant's Dataverse metadata ` +
        `(GET /api/data/v9.2/EntityDefinitions?$select=LogicalName,EntitySetName). ` +
        `Channel state lives in Azure Bot Service and Actions are modelled by ` +
        `msdyn_plugin / msdyn_pluginaction on current tenants.`,
        502, json || text, url,
      );
    }

    // A missing COLUMN (400 on write, 404 on $select read) is likewise a real
    // schema error — name the column so an invented field (e.g.
    // msdyn_instructions / msdyn_modeldeployment) is not hidden.
    if (missingProperty) {
      throw new CopilotStudioError(
        `Dataverse column '${missingProperty}' does not exist on the target entity in this environment. ` +
        `Verify the column logical name against the live tenant's Dataverse metadata before writing it.`,
        res.status === 404 ? 502 : res.status, json || text, url,
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
// Actions / Tools (msdyn_plugin + msdyn_pluginaction)
// ============================================================
//
// PROD-BUG FIX (Wave-B Merge #7): the previous code targeted the entity set
// `msdyn_bot_actions`, which does not exist in the current Copilot Studio
// Dataverse schema — every list/bind/delete 404'd. On current tenants an
// agent's actions/tools are the PLUGIN model:
//
//   • msdyn_plugin       — the agent's plugin/skill container (one per agent,
//                          carrying the connector/flow binding); columns follow
//                          the Service-Copilot mirror (`msdyn_servicecopilotplugin`)
//                          verified in Dataverse docs: msdyn_pluginname,
//                          msdyn_plugintype {0 Dataverse | 1 CustomConnector |
//                          2 Connector}, msdyn_pluginuniquename.
//   • msdyn_pluginaction — the individual action exposed by that plugin;
//                          columns msdyn_name, msdyn_connectorname, statecode,
//                          and the plugin lookup _msdyn_plugin_value.
//
// The plugin↔copilot relationship: a plugin/action is bound to its agent via
// the botcomponent/copilot lookup `_msdyn_copilotid_value` (the same lookup the
// topics/knowledge surfaces already filter on in this client), so we filter
// pluginactions by that real relationship rather than the invented
// `msdyn_bot_actions._msdyn_copilotid_value`.
//
// CONFIRMED action columns (round-2). Verified against the Service-Copilot
// mirror entity msdyn_servicecopilotpluginaction — the documented twin of the
// msdyn_pluginaction container this client targets, identical field conventions
// (learn.microsoft.com/dynamics365/developer/reference/entities/msdyn_servicecopilotpluginaction):
//   • msdyn_name                  — action display name (writable)
//   • msdyn_connectorname         — connector binding (writable String) ✅
//   • msdyn_actionuniquename      — action's unique name (writable String,
//                                   MaxLength 1000) — the Power Automate flow's
//                                   unique name is the documented value here ✅
//   • msdyn_parameterconfiguration — input/output parameter mapping serialised
//                                   as JSON (writable Memo, MaxLength 1,048,576);
//                                   there is NO per-parameter child entity ✅
//   • statecode / _msdyn_copilotid_value — state + agent association
// msdyn_pluginname / msdyn_plugintype / msdyn_pluginuniquename are columns on
// the PLUGIN CONTAINER (msdyn_servicecopilotplugin), NOT on the action row, so
// they are never written to the action here (that was the round-1 bug).
//
// A genuine 404 on either set (e.g. an org that has not provisioned the plugin
// model) still surfaces honestly via the rawCall handler, which names the
// missing entity set — never a fake empty success. A column variant absent on a
// given org's msdyn_pluginaction is caught by the undeclared-property handler.

/**
 * A single mapped input/output parameter for an action (Copilot Studio
 * "Inputs / Outputs" surface). Structured + typed so the editor renders a
 * mapping GRID (dropdowns + typed inputs), never a freeform JSON textarea
 * (no-freeform-config). Persisted to the action's msdyn_parameterconfiguration
 * Memo column as JSON — the same shape Copilot Studio itself serialises.
 */
export interface ActionParameter {
  /** Parameter name (the input/output identifier). */
  name: string;
  /** Whether this is an input the agent fills or an output it reads. */
  direction: 'input' | 'output';
  /** Logical data type (String | Number | Boolean | Date | Choice | Table). */
  type: string;
  /**
   * "How will the agent fill this input?" — 'dynamic' = Dynamically fill,
   * 'value' = Set as a value (then `value` carries the literal/variable/Power Fx).
   */
  valueKind?: 'dynamic' | 'value';
  /** The literal / variable / Power Fx expression when valueKind === 'value'. */
  value?: string;
}

export interface CopilotAction {
  id: string;
  name: string;
  type?: string;
  connectorId?: string;
  flowId?: string;
  agentId?: string;
  enabled?: boolean;
  /** Mapped input/output parameters parsed from msdyn_parameterconfiguration. */
  parameters?: ActionParameter[];
}

// msdyn_pluginaction columns (+ the plugin lookup carrying connector/flow id).
// Round-2: select the confirmed action unique-name + parameter-config columns so
// the bound mapping round-trips back into the editor grid.
const ACTION_SELECT = [
  'msdyn_pluginactionid',
  'msdyn_name',
  'msdyn_connectorname',
  'msdyn_actionuniquename',
  'msdyn_parameterconfiguration',
  '_msdyn_plugin_value',
  '_msdyn_copilotid_value',
  'statecode',
].join(',');

/**
 * Parse the action's msdyn_parameterconfiguration Memo JSON into the typed
 * ActionParameter[] the editor grid renders. Best-effort: malformed/legacy JSON
 * NEVER throws — a bound action with an unreadable mapping still lists.
 */
function parseActionParameters(raw: any): ActionParameter[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const obj = JSON.parse(raw);
    const arr = Array.isArray(obj) ? obj : Array.isArray(obj?.parameters) ? obj.parameters : null;
    if (!Array.isArray(arr)) return undefined;
    const out: ActionParameter[] = [];
    for (const p of arr) {
      if (!p || typeof p.name !== 'string') continue;
      out.push({
        name: p.name,
        direction: p.direction === 'output' ? 'output' : 'input',
        type: typeof p.type === 'string' && p.type ? p.type : 'String',
        valueKind: p.valueKind === 'value' ? 'value' : p.valueKind === 'dynamic' ? 'dynamic' : undefined,
        value: typeof p.value === 'string' ? p.value : undefined,
      });
    }
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map a msdyn_pluginaction row to the editor's CopilotAction shape.
 *
 * The public interface (id/name/type/connectorId/flowId/agentId/enabled) is
 * preserved verbatim so the ActionsPanel UI and the BFF route contract are
 * unchanged. `type` is derived from the plugin type when expanded; `connectorId`
 * comes from the plugin connector name; `flowId` from the Power Automate flow
 * binding when the plugin type is a flow/Dataverse plugin.
 */
function mapAction(r: any): CopilotAction {
  const plugin = r.msdyn_plugin ?? r['msdyn_PluginId'] ?? null;
  const pluginType: number | undefined =
    plugin?.msdyn_plugintype ?? r.msdyn_plugintype;
  const type =
    pluginType === 1 ? 'custom-connector'
    : pluginType === 2 ? 'connector'
    : pluginType === 0 ? 'power-automate-flow'
    : undefined;
  return {
    id: r.msdyn_pluginactionid,
    name: r.msdyn_name,
    type,
    connectorId: r.msdyn_connectorname ?? plugin?.msdyn_pluginuniquename,
    // Round-2: the flow's unique name is the confirmed action column
    // msdyn_actionuniquename (msdyn_pluginname is a plugin-container column,
    // absent on the action row). Fall back to the expanded plugin name only.
    flowId: r.msdyn_actionuniquename ?? plugin?.msdyn_pluginname,
    agentId: r._msdyn_copilotid_value ?? r._msdyn_plugin_value,
    enabled: r.statecode === 0,
    parameters: parseActionParameters(r.msdyn_parameterconfiguration),
  };
}

// Memoised per host+attribute: does this org's msdyn_pluginaction expose the
// given column? This is the HONEST entity-check the parameter-mapping write
// depends on — if the column is absent we throw a precise 422 naming the
// EntityDefinitions/Attributes probe rather than silently dropping the mapping.
const _actionAttrCache = new Map<string, Promise<boolean>>();
function actionEntitySupportsAttribute(host: string, attribute: string): Promise<boolean> {
  const key = `${host}|${attribute}`;
  const cached = _actionAttrCache.get(key);
  if (cached) return cached;
  const safe = attribute.replace(/'/g, "''");
  const probe = rawCall<{ value: any[] }>(
    dvUrl(host, `/EntityDefinitions(LogicalName='msdyn_pluginaction')/Attributes`, {
      $select: 'LogicalName',
      $filter: `LogicalName eq '${safe}'`,
    }),
    { scope: dvScope(host) },
  )
    .then((j) => Array.isArray(j?.value) && j.value.length > 0)
    .catch(() => false);
  _actionAttrCache.set(key, probe);
  return probe;
}

export async function listActions(envId: string, agentId: string): Promise<CopilotAction[]> {
  const host = await envHost(envId);
  const j = await rawCall<{ value: any[] }>(
    dvUrl(host, '/msdyn_pluginactions', {
      $select: ACTION_SELECT,
      // Filter by the real plugin↔copilot relationship (the botcomponent/copilot
      // lookup the rest of this client already uses).
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
  type: 'power-automate-flow' | 'custom-connector' | 'connector' | 'prebuilt' | string;
  connectorId?: string;
  flowId?: string;
  /**
   * Mapped input/output parameters (the Inputs/Outputs grid). Persisted to the
   * action's msdyn_parameterconfiguration Memo column as JSON. Optional and
   * backward-compatible: when absent the action binds exactly as before.
   */
  parameters?: ActionParameter[];
}

const PARAM_CONFIG_ATTR = 'msdyn_parameterconfiguration';

/** Serialise the mapped parameters into the action's Memo column JSON. */
function serializeActionParameters(parameters: ActionParameter[]): string {
  return JSON.stringify({
    version: 1,
    parameters: parameters.map((p) => ({
      name: p.name,
      direction: p.direction === 'output' ? 'output' : 'input',
      type: p.type || 'String',
      valueKind: p.valueKind === 'value' ? 'value' : 'dynamic',
      value: p.valueKind === 'value' ? (p.value ?? '') : undefined,
    })),
  });
}

/**
 * Bind an action to the agent. On the plugin model an action is created as a
 * msdyn_pluginaction row bound to the agent's plugin (the copilot lookup carries
 * the agent association). We persist the connector binding via msdyn_connectorname
 * and let the plugin type drive `type`. Body field names follow the CONFIRMED
 * msdyn_(servicecopilot)pluginaction schema (see section comment):
 *   • connectorId → msdyn_connectorname     (confirmed writable on the action)
 *   • flowId      → msdyn_actionuniquename   (confirmed writable on the action;
 *                                             the flow's unique name is the
 *                                             documented value — NOT
 *                                             msdyn_pluginname, which is a
 *                                             plugin-container column)
 *   • parameters  → msdyn_parameterconfiguration (Memo JSON), gated on an
 *                   honest EntityDefinitions/Attributes pre-flight check.
 */
export async function bindAction(envId: string, body: ActionUpsertBody): Promise<CopilotAction> {
  const host = await envHost(envId);
  const pluginType =
    body.type === 'custom-connector' ? 1
    : body.type === 'connector' ? 2
    : 0; // power-automate-flow / Dataverse default
  // When a parameter mapping is supplied, confirm the action entity actually
  // exposes the Memo column FIRST. If it is absent we throw an honest 422 (the
  // action is NOT created — no partial/fake success, and the mapping is never
  // silently dropped) naming the exact metadata probe to run.
  let parameterConfiguration: string | undefined;
  if (body.parameters?.length) {
    const supported = await actionEntitySupportsAttribute(host, PARAM_CONFIG_ATTR);
    if (!supported) {
      throw new CopilotStudioError(
        `Parameter mapping cannot be persisted: column '${PARAM_CONFIG_ATTR}' was not found on ` +
        `the msdyn_pluginaction entity in this environment. Verify it via ` +
        `GET /api/data/v9.2/EntityDefinitions(LogicalName='msdyn_pluginaction')/Attributes` +
        `?$select=LogicalName&$filter=LogicalName eq '${PARAM_CONFIG_ATTR}'. ` +
        `The action was not created so no partial mapping is left behind.`,
        422, { attribute: PARAM_CONFIG_ATTR, gated: true },
      );
    }
    parameterConfiguration = serializeActionParameters(body.parameters);
  }
  const dvBody: Record<string, any> = {
    msdyn_name: body.name,
    msdyn_plugintype: pluginType,
    // Bind to the agent via the copilot relationship the plugin model exposes.
    'msdyn_copilotid@odata.bind': `/msdyn_copilots(${body.agentId})`,
  };
  // Connector / flow binding columns on the plugin action (confirmed names).
  if (body.connectorId) dvBody.msdyn_connectorname = body.connectorId;
  if (body.flowId) dvBody.msdyn_actionuniquename = body.flowId;
  if (parameterConfiguration !== undefined) dvBody[PARAM_CONFIG_ATTR] = parameterConfiguration;
  const j = await rawCall<any>(dvUrl(host, '/msdyn_pluginactions'), {
    scope: dvScope(host),
    method: 'POST',
    body: dvBody,
    headers: { prefer: 'return=representation' },
  });
  return mapAction(j);
}

/**
 * Update the input/output parameter mapping of an already-bound action. Runs the
 * same honest EntityDefinitions/Attributes pre-flight as bindAction — a missing
 * Memo column throws 422 rather than silently no-op'ing — then PATCHes the
 * action's msdyn_parameterconfiguration column. Real Dataverse write, no stub.
 */
export async function updateActionParameters(
  envId: string,
  id: string,
  parameters: ActionParameter[],
): Promise<CopilotAction> {
  const host = await envHost(envId);
  const supported = await actionEntitySupportsAttribute(host, PARAM_CONFIG_ATTR);
  if (!supported) {
    throw new CopilotStudioError(
      `Parameter mapping cannot be persisted: column '${PARAM_CONFIG_ATTR}' was not found on ` +
      `the msdyn_pluginaction entity in this environment. Verify it via ` +
      `GET /api/data/v9.2/EntityDefinitions(LogicalName='msdyn_pluginaction')/Attributes` +
      `?$select=LogicalName&$filter=LogicalName eq '${PARAM_CONFIG_ATTR}'.`,
      422, { attribute: PARAM_CONFIG_ATTR, gated: true },
    );
  }
  const j = await rawCall<any>(dvUrl(host, `/msdyn_pluginactions(${id})`), {
    scope: dvScope(host),
    method: 'PATCH',
    body: { [PARAM_CONFIG_ATTR]: serializeActionParameters(parameters) },
    headers: { prefer: 'return=representation' },
  });
  return mapAction(j);
}

export async function deleteAction(envId: string, id: string): Promise<void> {
  const host = await envHost(envId);
  await rawCall(dvUrl(host, `/msdyn_pluginactions(${id})`), { scope: dvScope(host), method: 'DELETE' });
}

// ============================================================
// Channels (msdyn_botchannels — read-only honesty surface)
// ============================================================
//
// PROD-BUG NOTE (Wave-B Merge #7): a channel's real enablement state does NOT
// live in Dataverse — it lives in Azure Bot Service (Teams / Direct Line / Web
// Chat) and third-party OAuth registrations (Slack / Facebook). The
// `msdyn_botchannels` entity set is likely-nonexistent on current tenants.
//
// We DELIBERATELY keep reading `msdyn_botchannels` here so that a genuine 404
// is surfaced HONESTLY by the rawCall handler (which emits "...Channel state
// lives in Azure Bot Service..." and names the missing entity set) — and we do
// NOT swallow that 404 into an empty `[]` for the standalone Channels surface.
// Returning `[]` would be vaporware: it would present "no channels configured"
// as a benign success when the truth is the channel inventory must be read from
// Azure Bot Service. publishToChannel() already honest-gates every real channel
// type with a 501 (channelEnablementGate), so there is no silent fake-success
// write path either.

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
  // NOTE: rawCall THROWS on a 404 missing-entity-set (honest "Channel state
  // lives in Azure Bot Service" message) — we intentionally let that propagate
  // rather than catch-and-return [], so the standalone Channels surface shows
  // the real cause instead of a fake "0 channels" success. The `|| []` below
  // only guards a genuine 200 with a missing `value` array.
  const j = await rawCall<{ value: any[] }>(
    dvUrl(host, '/msdyn_botchannels', {
      $select: CHANNEL_SELECT,
      $filter: `_msdyn_copilotid_value eq ${agentId}`,
    }),
    { scope: dvScope(host) },
  );
  return (j.value || []).map(mapChannel);
}

/**
 * Per-channel real-enablement requirements (H2 — see docs/fiab/audit §2 H2).
 *
 * Inserting an `msdyn_botchannels` Dataverse row does NOT enable a channel:
 * the actual destination wiring lives in Azure Bot Service (Teams / Direct
 * Line / Web Chat) and in third-party OAuth registrations (Slack / Facebook).
 * Reporting "Published" off a Dataverse insert is vaporware. We therefore
 * honest-gate the channels that require out-of-band registration, naming the
 * exact configuration the operator must complete at the destination. A channel
 * is only marked enabled by this client when the call it makes genuinely
 * effects the channel.
 *
 * `null` means: this channel CAN be represented purely by the Dataverse row in
 * this estate (used internally by the M365 publish orchestration for the
 * msteams/M365-Copilot combined channel, whose downstream approval is itself
 * surfaced as a tenant action).
 */
function channelEnablementGate(channelType: ChannelType): string | null {
  switch (channelType) {
    case 'teams':
      return (
        'Teams channel enablement requires Azure Bot Service channel registration. ' +
        'Register the agent as an Azure Bot (Microsoft.BotService/botServices), add the ' +
        'Microsoft Teams channel, and package/side-load the Teams app manifest. ' +
        'Set LOOM_BOTSERVICE_RESOURCE_ID (+ Microsoft App registration) so Loom can ' +
        'drive the registration; this is not done by a Dataverse row alone.'
      );
    case 'direct-line':
      return (
        'Direct Line requires an Azure Bot Service Direct Line channel + site secret. ' +
        'Add the Direct Line channel on the Azure Bot resource and capture a site secret; ' +
        'set LOOM_COPILOT_DIRECTLINE_SECRET (or the per-agent variant) — used by the ' +
        'Test chat panel. A Dataverse row does not provision Direct Line.'
      );
    case 'web':
      return (
        'Web Chat requires a Direct Line secret (Web Chat is a Direct Line client). ' +
        'Provision Direct Line on the Azure Bot resource, then embed the Web Chat ' +
        'control with a token minted from that secret. Set LOOM_COPILOT_DIRECTLINE_SECRET.'
      );
    case 'slack':
      return (
        'Slack channel requires a Slack app (client id/secret + signing secret) registered ' +
        'on the Azure Bot Service Slack channel, plus the Slack OAuth redirect/verification flow. ' +
        'Configure the Slack channel on the Azure Bot resource; a Dataverse row does not ' +
        'establish the Slack OAuth connection.'
      );
    case 'facebook':
      return (
        'Facebook (Messenger) channel requires a Facebook Page access token + App secret + ' +
        'verify token configured on the Azure Bot Service Facebook channel, and the Messenger ' +
        'webhook subscription. Configure it on the Azure Bot resource; a Dataverse row does not ' +
        'establish the Messenger webhook.'
      );
    case 'custom':
      return (
        'A custom channel maps to Copilot Studio’s "publish to a mobile or custom app" ' +
        '(a Direct Line token + endpoint your app exchanges) or an Azure Bot Service relay bot ' +
        'with a custom adapter — NOT a Dataverse row. Provision Direct Line on the Azure Bot ' +
        'resource and set LOOM_COPILOT_DIRECTLINE_SECRET, and/or register the Azure Bot ' +
        '(LOOM_BOTSERVICE_RESOURCE_ID) for a custom-adapter relay. A msdyn_botchannels insert does ' +
        'not wire a custom channel, so Loom will not report it published off one.'
      );
    default:
      return null;
  }
}

export async function publishToChannel(
  envId: string,
  agentId: string,
  channelType: ChannelType,
  config: Record<string, any> = {},
): Promise<CopilotChannel> {
  // H2: refuse to report success for channels whose real enablement is an
  // Azure Bot Service / OAuth action this client cannot perform. The honest
  // path is a precise gate naming what to configure, NOT a Dataverse insert
  // that silently reaches nothing.
  const gate = channelEnablementGate(channelType);
  if (gate) {
    throw new CopilotStudioError(gate, 501, { channelType, gated: true });
  }
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
// Publish to Microsoft 365 Copilot (Teams + M365 channel)
// ============================================================
//
// A Loom data agent becomes discoverable / chattable in Microsoft 365 Copilot
// by representing it as a Copilot Studio agent (Dataverse msdyn_copilot),
// publishing it, then enabling the "Teams and Microsoft 365 Copilot" channel
// with the "make available in Microsoft 365 Copilot" flag set. This mirrors
// the portal flow (Copilot Studio → Channels → Teams and Microsoft 365 Copilot
// → "Make agent available in Microsoft 365 Copilot" → Add channel) using the
// Dataverse Web API so the whole publish is one button in Loom.
//
// References:
//   learn.microsoft.com/microsoft-copilot-studio/publication-add-bot-to-microsoft-teams
//   learn.microsoft.com/microsoft-365/copilot/extensibility/publish
//
// After this completes the agent appears as a pending request in the Microsoft
// 365 admin center (Agents → All agents → Requests); a tenant admin approves it
// to make it available to end users in the M365 Copilot Agent Store. That admin
// approval is a tenant action outside Loom's RBAC — surfaced in the result hint.

/** The Dataverse channel type for the combined Teams + Microsoft 365 Copilot channel. */
const M365_CHANNEL_TYPE = 'msteams';

/** Resolve the Power Platform environment to publish into, by id or the default env var. */
export function resolvePublishEnvId(envId?: string): string | null {
  const v = (envId || process.env.LOOM_COPILOT_STUDIO_ENVIRONMENT_ID || '').trim();
  return v || null;
}

/** Find an existing Copilot Studio agent by exact display name (idempotent upsert support). */
export async function findAgentByName(envId: string, name: string): Promise<CopilotAgent | null> {
  const host = await envHost(envId);
  const safe = name.replace(/'/g, "''");
  const j = await rawCall<{ value: any[] }>(
    dvUrl(host, '/msdyn_copilots', {
      $select: AGENT_SELECT,
      $filter: `msdyn_name eq '${safe}'`,
      $top: '1',
    }),
    { scope: dvScope(host) },
  );
  const row = (j.value || [])[0];
  return row ? mapAgent(row) : null;
}

/** Create the agent if absent, else patch instructions/description in place. */
export async function upsertAgentByName(envId: string, body: AgentUpsertBody): Promise<CopilotAgent> {
  const existing = await findAgentByName(envId, body.name);
  if (existing) {
    return updateAgent(envId, existing.id, {
      description: body.description,
      instructions: body.instructions,
      modelDeployment: body.modelDeployment,
    });
  }
  return createAgent(envId, body);
}

export interface M365PublishResult {
  envId: string;
  agentId: string;
  agentName: string;
  agentState?: string;
  channelId: string;
  channelEnabled: boolean;
  m365CopilotEnabled: boolean;
  /** Deep link into the M365 Copilot / Teams app once an admin approves the agent. */
  shareUrl?: string;
}

export interface M365PublishInput {
  name: string;
  description?: string;
  instructions?: string;
  modelDeployment?: string;
  /** Knowledge / source references to attach (e.g. a published Foundry agent or AI Search index). */
  knowledge?: KnowledgeSourcePayload[];
  /** Whether to flip "Make agent available in Microsoft 365 Copilot" (default true). */
  availableInM365Copilot?: boolean;
}

/**
 * End-to-end publish of a Loom data agent to Microsoft 365 Copilot:
 *   1. upsert the Copilot Studio agent (idempotent by name)
 *   2. attach any knowledge sources (best-effort; non-fatal on a single failure)
 *   3. publish the agent (msdyn_PublishCopilot)
 *   4. enable the Teams + Microsoft 365 Copilot channel with the M365 flag set
 *
 * Throws CopilotStudioError on any hard failure so the BFF surfaces the real
 * Dataverse error verbatim.
 */
export async function publishToM365Copilot(envId: string, input: M365PublishInput): Promise<M365PublishResult> {
  const host = await envHost(envId);
  const availableInM365Copilot = input.availableInM365Copilot !== false;

  // 1. upsert the agent
  const agent = await upsertAgentByName(envId, {
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    modelDeployment: input.modelDeployment,
  });

  // 2. attach knowledge (best-effort — a single source failure must not abort
  //    the publish; the source can be re-added from the editor afterwards).
  if (input.knowledge?.length) {
    const existing = await listKnowledgeSources(envId, agent.id).catch(() => [] as KnowledgeSource[]);
    const haveUris = new Set(existing.map((k) => (k.uri || '').toLowerCase()).filter(Boolean));
    for (const ks of input.knowledge) {
      if (ks.uri && haveUris.has(ks.uri.toLowerCase())) continue;
      await addKnowledgeSource(envId, agent.id, ks).catch(() => undefined);
    }
  }

  // 3. publish
  await publishAgent(envId, agent.id);

  // 4. enable Teams + M365 Copilot channel. Re-use the existing channel row if
  //    one is already present so re-publishing is idempotent.
  const channels = await listChannels(envId, agent.id).catch(() => [] as CopilotChannel[]);
  const existingChannel = channels.find((c) => c.type === M365_CHANNEL_TYPE);
  const channelConfig = {
    enableTeams: true,
    enableMicrosoft365Copilot: availableInM365Copilot,
    // "make agent available in Microsoft 365 Copilot" toggle from the portal panel.
    makeAvailableInMicrosoft365Copilot: availableInM365Copilot,
  };
  let channel: CopilotChannel;
  if (existingChannel) {
    const j = await rawCall<any>(dvUrl(host, `/msdyn_botchannels(${existingChannel.id})`), {
      scope: dvScope(host),
      method: 'PATCH',
      body: { msdyn_enabled: true, msdyn_configuration: JSON.stringify(channelConfig) },
      headers: { prefer: 'return=representation' },
    });
    channel = mapChannel(j);
  } else {
    channel = await publishToChannel(envId, agent.id, M365_CHANNEL_TYPE, channelConfig);
  }

  return {
    envId,
    agentId: agent.id,
    agentName: agent.name,
    agentState: agent.state,
    channelId: channel.id,
    channelEnabled: channel.enabled,
    m365CopilotEnabled: availableInM365Copilot,
    shareUrl: channel.embedUrl,
  };
}

// ============================================================
// Analytics (Power Platform admin analytics REST)
// ============================================================

export interface CopilotAnalytics {
  agentId: string;
  windowDays: number;
  /**
   * Whether a real analytics backend produced these numbers. When false the
   * numeric fields are absent and `gateReason` explains what to provision —
   * the editor must NOT render zeros as if they were measured telemetry
   * (H3 — see docs/fiab/audit §2 H3 / §4 vaporware register).
   */
  available: boolean;
  /** Present only when `available` is false. */
  gateReason?: string;
  sessions?: number;
  resolvedSessions?: number;
  escalatedSessions?: number;
  satisfactionScore?: number;
  resolutionRate?: number;
  escalationRate?: number;
  daily?: { date: string; sessions: number }[];
}

const ANALYTICS_GATE_REASON =
  'Copilot Studio analytics backend is not available in this deployment. ' +
  'No measured telemetry was returned for this agent/window. ' +
  'Conversation KPIs come from Dataverse session/transcript tables ' +
  '(msdyn_botsession / msdyn_conversationtranscript) projected with ' +
  'Application Insights — provision that pipeline (or grant the Loom UAMI ' +
  'access to the admin analytics API) to surface real sessions / resolution ' +
  '/ CSAT. Zeros are intentionally NOT shown so an empty backend is not ' +
  'mistaken for "0 sessions".';

export async function getAnalytics(envId: string, agentId: string, days = 30): Promise<CopilotAnalytics> {
  // Admin BAP analytics endpoint for Copilot Studio bots.
  //
  // H3: previously a 404/204 (no backend / no data) was coerced into an
  // all-zeros KPI object, which rendered plausible-but-fabricated "0 sessions
  // / — CSAT" telemetry. Per no-vaporware that is forbidden. We now return an
  // explicit `available: false` gated state so the editor shows an honest
  // MessageBar instead of fake numbers. Only a genuine, non-empty backend
  // response yields `available: true` with measured values.
  const url = bapUrl(
    `/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${envId}/copilots/${agentId}/analytics`,
    { window: `${days}d` },
  );
  let j: any;
  try {
    j = await rawCall<any>(url, { scope: BAP_SCOPE });
  } catch (e) {
    if (e instanceof CopilotStudioError && (e.status === 404 || e.status === 204)) {
      return { agentId, windowDays: days, available: false, gateReason: ANALYTICS_GATE_REASON };
    }
    throw e;
  }

  // A 200 with an empty/null body (BAP returns 200 + no payload when the
  // analytics pipeline exists but has produced nothing) is also "not
  // available" — do NOT manufacture zeros.
  const hasAnyMetric =
    j != null &&
    (j.sessions != null || j.totalSessions != null ||
     j.resolvedSessions != null || j.resolved != null ||
     j.escalatedSessions != null || j.escalated != null ||
     Array.isArray(j.daily));
  if (!hasAnyMetric) {
    return { agentId, windowDays: days, available: false, gateReason: ANALYTICS_GATE_REASON };
  }

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
    available: true,
    sessions,
    resolvedSessions: resolved,
    escalatedSessions: escalated,
    satisfactionScore: typeof csat === 'number' ? csat : undefined,
    resolutionRate: sessions > 0 ? resolved / sessions : undefined,
    escalationRate: sessions > 0 ? escalated / sessions : undefined,
    daily,
  };
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
  const res = await fetchWithTimeout(DIRECTLINE_TOKEN_URL, {
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
