/**
 * eventgrid-topics-client — Azure Event Grid **custom topic** client: ARM
 * control plane (list / create / read custom topics, list keys, list event
 * subscriptions) + the HTTPS **data plane** that PUBLISHES governed business
 * events to a custom topic in the CloudEvents v1.0 schema.
 *
 * This is the Event Grid half of the Business Events publishing surface (the
 * Event Hubs half lives in eventhubs-data-client.ts). The two together let an
 * operator emit a structured, governed business signal to BOTH a durable
 * stream (Event Hubs) and a fan-out router (Event Grid) so downstream
 * subscribers — Activator rules, Functions, Logic Apps, webhooks — react to it.
 *
 * ── Why custom topics (Azure-native, no Fabric) ─────────────────────────────
 * Microsoft Fabric "business events" / Activator structured signals are
 * surfaced 1:1 on Azure with an Event Grid **custom topic** (the publish
 * endpoint) routed to Event Hubs / Activator alert rules. No Fabric capacity or
 * workspace is required — this works on a bare Azure subscription. Per
 * .claude/rules/no-fabric-dependency.md this is the DEFAULT and only path.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * ARM control plane: the shared Console UAMI chained credential against the ARM
 * scope (UAMI needs "EventGrid Contributor" on the topic's resource group).
 * Data-plane publish: Microsoft Entra against the Event Grid data-plane scope
 * `https://eventgrid.azure.net/.default` (UAMI needs "EventGrid Data Sender" on
 * the topic). Entra-first, matching the secure default everywhere else in Loom.
 * If `aeg-sas-key` auth is explicitly opted into (LOOM_EVENTGRID_SAS_AUTH=1) the
 * topic access key is fetched via ARM listKeys and sent in the aeg-sas-key
 * header instead — used only in Commercial deployments where local auth is on.
 *
 * No mocks. Real ARM REST + real data-plane POST. When the topic env is unset
 * the routes 503 via eventgridTopicsConfigGate() with the precise missing var.
 *
 * Docs:
 *   https://learn.microsoft.com/azure/event-grid/post-to-custom-topic
 *   https://learn.microsoft.com/azure/event-grid/cloud-event-schema
 *   https://learn.microsoft.com/rest/api/eventgrid/controlplane/topics
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';

/** Control-plane (ARM) api-version covering topics + eventSubscriptions. */
const EG_ARM_API = '2024-06-01-preview';
/** Data-plane Entra scope for publishing events to a custom topic. */
export const EVENTGRID_DATA_SCOPE = 'https://eventgrid.azure.net/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class EventGridTopicsError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body?: unknown, message?: string) {
    super(message || `Event Grid topics call failed (${status})`);
    this.name = 'EventGridTopicsError';
    this.status = status;
    this.body = body;
  }
}

export interface EventGridTopicsConfig {
  subscriptionId: string;
  resourceGroup: string;
}

/**
 * Honest config gate. The Business Events Event-Grid channel needs a
 * subscription + resource group to enumerate / create custom topics. Falls back
 * to the DLZ sub/RG so a default deployment is fully functional. Returns the
 * exact missing var so the BFF 503s with a precise MessageBar.
 */
export function eventgridTopicsConfigGate(): { missing: string } | null {
  if (!(process.env.LOOM_EVENTGRID_SUB || process.env.LOOM_SUBSCRIPTION_ID)) {
    return { missing: 'LOOM_EVENTGRID_SUB (or LOOM_SUBSCRIPTION_ID)' };
  }
  if (!(process.env.LOOM_EVENTGRID_RG || process.env.LOOM_DLZ_RG)) {
    return { missing: 'LOOM_EVENTGRID_RG (or LOOM_DLZ_RG)' };
  }
  return null;
}

export function readEventGridTopicsConfig(): EventGridTopicsConfig {
  const subscriptionId = process.env.LOOM_EVENTGRID_SUB || process.env.LOOM_SUBSCRIPTION_ID || '';
  const resourceGroup = process.env.LOOM_EVENTGRID_RG || process.env.LOOM_DLZ_RG || '';
  if (!subscriptionId || !resourceGroup) {
    throw new EventGridTopicsError(503, undefined, 'Event Grid topic subscription/resource group not configured');
  }
  return { subscriptionId, resourceGroup };
}

/** The deployment-default business-events custom topic name (overridable). */
export function defaultBusinessTopicName(): string {
  return process.env.LOOM_EVENTGRID_BUSINESS_TOPIC || 'loom-business-events';
}

function rgUrl(cfg: EventGridTopicsConfig): string {
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${encodeURIComponent(cfg.resourceGroup)}`;
}

function topicUrl(cfg: EventGridTopicsConfig, topic: string): string {
  return `${rgUrl(cfg)}/providers/Microsoft.EventGrid/topics/${encodeURIComponent(topic)}`;
}

async function armToken(): Promise<string> {
  const t = await credential.getToken(armScope());
  if (!t?.token) throw new EventGridTopicsError(401, undefined, 'Failed to acquire ARM token for Event Grid');
  return t.token;
}

async function arm<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await armToken();
  const res = await fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = json?.error?.message || text || `Event Grid ARM ${res.status}`;
    throw new EventGridTopicsError(res.status, json || text, msg);
  }
  return json as T;
}

// ───────────────────────────── control plane ──────────────────────────────

export interface EventGridTopic {
  name: string;
  /** The data-plane publish endpoint (…/api/events). */
  endpoint?: string;
  /** EventGridSchema | CloudEventSchemaV1_0 | CustomEventSchema. */
  inputSchema?: string;
  location?: string;
  provisioningState?: string;
  publicNetworkAccess?: string;
  /** true when SAS-key (local) auth is disabled — Entra-only publish. */
  localAuthDisabled: boolean;
}

function shapeTopic(t: any): EventGridTopic {
  const p = t?.properties || {};
  return {
    name: t?.name,
    endpoint: p.endpoint,
    inputSchema: p.inputSchema,
    location: t?.location,
    provisioningState: p.provisioningState,
    publicNetworkAccess: p.publicNetworkAccess,
    localAuthDisabled: p.disableLocalAuth === true,
  };
}

/** List every Event Grid custom topic in the configured resource group. */
export async function listEventGridTopics(): Promise<EventGridTopic[]> {
  const cfg = readEventGridTopicsConfig();
  const out: EventGridTopic[] = [];
  let next: string | undefined = `${rgUrl(cfg)}/providers/Microsoft.EventGrid/topics?api-version=${EG_ARM_API}`;
  while (next) {
    const body: any = await arm(next);
    if (Array.isArray(body?.value)) out.push(...body.value.map(shapeTopic));
    next = body?.nextLink;
  }
  return out;
}

/** Read a single custom topic (404 → typed error the route maps to a gate). */
export async function getEventGridTopic(topic: string): Promise<EventGridTopic> {
  const cfg = readEventGridTopicsConfig();
  const body = await arm(`${topicUrl(cfg, topic)}?api-version=${EG_ARM_API}`);
  return shapeTopic(body);
}

export interface CreateTopicSpec {
  name: string;
  /** Defaults to the deployment region (LOOM_LOCATION) or eastus2. */
  location?: string;
  /**
   * Input schema. Business Events default to CloudEventSchemaV1_0 (the open,
   * governable standard); operators may pick EventGridSchema for legacy fan-out.
   */
  inputSchema?: 'CloudEventSchemaV1_0' | 'EventGridSchema';
  /** Keep Entra-only (secure default) unless explicitly enabling SAS keys. */
  disableLocalAuth?: boolean;
}

/** Create (idempotent PUT) an Event Grid custom topic for business events. */
export async function createEventGridTopic(spec: CreateTopicSpec): Promise<EventGridTopic> {
  const cfg = readEventGridTopicsConfig();
  const name = (spec.name || '').trim();
  if (!name) throw new EventGridTopicsError(400, undefined, 'topic name is required');
  const location = spec.location || process.env.LOOM_LOCATION || 'eastus2';
  const body = await arm(`${topicUrl(cfg, name)}?api-version=${EG_ARM_API}`, {
    method: 'PUT',
    body: JSON.stringify({
      location,
      properties: {
        inputSchema: spec.inputSchema || 'CloudEventSchemaV1_0',
        // Secure default: Entra-only unless the operator opts into SAS keys.
        disableLocalAuth: spec.disableLocalAuth !== false,
        publicNetworkAccess: 'Enabled',
      },
    }),
  });
  return shapeTopic(body);
}

/**
 * Delete an Event Grid custom topic. Real ARM DELETE; 204/200 → ok, 404 →
 * already gone (treated as success so the UI is idempotent). The Console UAMI
 * needs "EventGrid Contributor" on the resource group.
 */
export async function deleteEventGridTopic(topic: string): Promise<{ deleted: boolean }> {
  const cfg = readEventGridTopicsConfig();
  const name = (topic || '').trim();
  if (!name) throw new EventGridTopicsError(400, undefined, 'topic name is required');
  const token = await armToken();
  const res = await fetchWithTimeout(`${topicUrl(cfg, name)}?api-version=${EG_ARM_API}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (res.status === 404) return { deleted: false };
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new EventGridTopicsError(res.status, text, text || `Event Grid topic delete ${res.status}`);
  }
  return { deleted: true };
}

export interface TopicEventSubscription {
  name: string;
  destinationType?: string;
  destination?: string;
  provisioningState?: string;
  filterSubjectBeginsWith?: string;
  includedEventTypes?: string[];
}

/** List the event subscriptions (routes) attached to a custom topic. */
export async function listTopicEventSubscriptions(topic: string): Promise<TopicEventSubscription[]> {
  const cfg = readEventGridTopicsConfig();
  const url = `${topicUrl(cfg, topic)}/providers/Microsoft.EventGrid/eventSubscriptions?api-version=${EG_ARM_API}`;
  const out: TopicEventSubscription[] = [];
  let next: string | undefined = url;
  while (next) {
    const body: any = await arm(next);
    for (const s of body?.value || []) {
      const p = s?.properties || {};
      const dest = p?.destination || {};
      out.push({
        name: s?.name,
        destinationType: dest?.endpointType,
        destination:
          dest?.properties?.resourceId ||
          dest?.properties?.endpointUrl ||
          dest?.properties?.endpointBaseUrl ||
          undefined,
        provisioningState: p?.provisioningState,
        filterSubjectBeginsWith: p?.filter?.subjectBeginsWith,
        includedEventTypes: p?.filter?.includedEventTypes,
      });
    }
    next = body?.nextLink;
  }
  return out;
}

export interface TopicKeys {
  key1: string;
  key2: string;
}

/** List the SAS access keys for a topic (only used when SAS auth is opted in). */
export async function listTopicKeys(topic: string): Promise<TopicKeys> {
  const cfg = readEventGridTopicsConfig();
  const body = await arm<any>(`${topicUrl(cfg, topic)}/listKeys?api-version=${EG_ARM_API}`, { method: 'POST' });
  return { key1: body?.key1 || '', key2: body?.key2 || '' };
}

/**
 * Regenerate one of a topic's SAS access keys (key1 | key2). Real ARM
 * `Microsoft.EventGrid/topics/regenerateKey` POST — returns BOTH keys after the
 * chosen one is rotated. The Console UAMI needs "EventGrid Contributor" on the
 * resource group.
 * https://learn.microsoft.com/rest/api/eventgrid/controlplane/topics/regenerate-key
 */
export async function regenerateTopicKey(topic: string, keyName: 'key1' | 'key2'): Promise<TopicKeys> {
  const cfg = readEventGridTopicsConfig();
  const name = (topic || '').trim();
  if (!name) throw new EventGridTopicsError(400, undefined, 'topic name is required');
  const kn = keyName === 'key2' ? 'key2' : 'key1';
  const body = await arm<any>(`${topicUrl(cfg, name)}/regenerateKey?api-version=${EG_ARM_API}`, {
    method: 'POST',
    body: JSON.stringify({ keyName: kn }),
  });
  return { key1: body?.key1 || '', key2: body?.key2 || '' };
}

// ──────────────────────── event subscription create ───────────────────────

/** Handler types a custom-topic event subscription can route governed events to. */
export type EventSubDestinationType =
  | 'AzureFunction'
  | 'WebHook'
  | 'EventHub'
  | 'ServiceBusQueue'
  | 'ServiceBusTopic'
  | 'StorageQueue';

/** One advanced (key/value) filter row for an event subscription. */
export interface AdvancedFilterSpec {
  /** e.g. StringIn, StringBeginsWith, NumberGreaterThan, BoolEquals … */
  operatorType: string;
  /** The event field to test, e.g. `data.priority` or `subject`. */
  key: string;
  /** Raw values (coerced to number/bool per the operator on the server). */
  values?: (string | number | boolean)[];
}

export interface CreateEventSubscriptionSpec {
  name: string;
  destinationType: EventSubDestinationType;
  /** WebHook endpoint URL (WebHook destination only). */
  endpointUrl?: string;
  /**
   * ARM resource ID of the handler resource:
   *  - AzureFunction → …/sites/{app}/functions/{fn}
   *  - EventHub      → …/namespaces/{ns}/eventhubs/{hub}
   *  - ServiceBusQueue → …/namespaces/{ns}/queues/{q}
   *  - ServiceBusTopic → …/namespaces/{ns}/topics/{t}
   *  - StorageQueue  → …/storageAccounts/{acct} (queue name below)
   */
  resourceId?: string;
  /** Storage queue name (StorageQueue destination only). */
  queueName?: string;
  filter?: {
    subjectBeginsWith?: string;
    subjectEndsWith?: string;
    includedEventTypes?: string[];
    isSubjectCaseSensitive?: boolean;
    advancedFilters?: AdvancedFilterSpec[];
  };
  /** Dead-letter to a Storage blob container (StorageBlob endpoint). */
  deadLetter?: { resourceId?: string; blobContainerName?: string };
  retryPolicy?: { maxDeliveryAttempts?: number; eventTimeToLiveInMinutes?: number };
  /** Delivery schema; CloudEvents v1.0 is the governed default. */
  eventDeliverySchema?: 'CloudEventSchemaV1_0' | 'EventGridSchema' | 'CustomInputSchema';
}

const NO_VALUE_OPERATORS = new Set(['IsNullOrUndefined', 'IsNotNull']);
const NUMBER_SINGLE_OPERATORS = new Set([
  'NumberGreaterThan', 'NumberGreaterThanOrEquals', 'NumberLessThan', 'NumberLessThanOrEquals',
]);
const NUMBER_MULTI_OPERATORS = new Set(['NumberIn', 'NumberNotIn', 'NumberInRange', 'NumberNotInRange']);

/** Build one ARM advancedFilter object, coercing value vs values per operator. */
function buildAdvancedFilter(f: AdvancedFilterSpec): Record<string, unknown> | null {
  const key = (f.key || '').trim();
  const op = (f.operatorType || '').trim();
  if (!key || !op) return null;
  if (NO_VALUE_OPERATORS.has(op)) return { operatorType: op, key };
  const cleaned = (Array.isArray(f.values) ? f.values : [])
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
  if (!cleaned.length) return null;
  if (op === 'BoolEquals') {
    return { operatorType: op, key, value: /^(true|1|yes)$/i.test(cleaned[0]) };
  }
  if (NUMBER_SINGLE_OPERATORS.has(op)) {
    const n = Number(cleaned[0]);
    if (Number.isNaN(n)) return null;
    return { operatorType: op, key, value: n };
  }
  if (NUMBER_MULTI_OPERATORS.has(op)) {
    const nums = cleaned.map(Number).filter((n) => !Number.isNaN(n));
    if (!nums.length) return null;
    return { operatorType: op, key, values: nums };
  }
  // String* multi-value operators (StringIn/StringBeginsWith/StringContains/…).
  return { operatorType: op, key, values: cleaned };
}

/** Build the ARM destination object for the chosen handler type. */
function buildSubscriptionDestination(
  spec: CreateEventSubscriptionSpec,
): { endpointType: string; properties: Record<string, unknown> } {
  const t = spec.destinationType;
  switch (t) {
    case 'WebHook': {
      const url = (spec.endpointUrl || '').trim();
      if (!url) throw new EventGridTopicsError(400, undefined, 'WebHook destination requires an endpoint URL');
      return { endpointType: 'WebHook', properties: { endpointUrl: url } };
    }
    case 'StorageQueue': {
      const resourceId = (spec.resourceId || '').trim();
      const queueName = (spec.queueName || '').trim();
      if (!resourceId || !queueName) {
        throw new EventGridTopicsError(400, undefined, 'Storage Queue destination requires a storage account resource ID and a queue name');
      }
      return { endpointType: 'StorageQueue', properties: { resourceId, queueName } };
    }
    case 'AzureFunction':
    case 'EventHub':
    case 'ServiceBusQueue':
    case 'ServiceBusTopic': {
      const resourceId = (spec.resourceId || '').trim();
      if (!resourceId) throw new EventGridTopicsError(400, undefined, `${t} destination requires a resource ID`);
      return { endpointType: t, properties: { resourceId } };
    }
    default:
      throw new EventGridTopicsError(400, undefined, `unsupported destination type: ${String(t)}`);
  }
}

/**
 * Create (idempotent PUT) an event subscription on a custom topic — routes
 * matching events to a Function / WebHook / Event Hub / Service Bus / Storage
 * Queue handler with optional subject + event-type + advanced filters,
 * dead-letter destination, and a retry policy. Real ARM
 * `Microsoft.EventGrid/topics/.../eventSubscriptions` PUT. WebHook destinations
 * trigger Event Grid's validation handshake — an unreachable endpoint surfaces
 * a real ARM error (no mock). The Console UAMI needs "EventGrid Contributor".
 * https://learn.microsoft.com/rest/api/eventgrid/controlplane/event-subscriptions
 */
export async function createTopicEventSubscription(
  topic: string,
  spec: CreateEventSubscriptionSpec,
): Promise<TopicEventSubscription> {
  const cfg = readEventGridTopicsConfig();
  const topicName = (topic || '').trim();
  const subName = (spec?.name || '').trim();
  if (!topicName) throw new EventGridTopicsError(400, undefined, 'topic is required');
  if (!subName) throw new EventGridTopicsError(400, undefined, 'subscription name is required');

  const properties: Record<string, any> = {
    destination: buildSubscriptionDestination(spec),
    eventDeliverySchema: spec.eventDeliverySchema || 'CloudEventSchemaV1_0',
  };

  const f = spec.filter || {};
  const filter: Record<string, any> = {};
  if (f.subjectBeginsWith?.trim()) filter.subjectBeginsWith = f.subjectBeginsWith.trim();
  if (f.subjectEndsWith?.trim()) filter.subjectEndsWith = f.subjectEndsWith.trim();
  const evTypes = (f.includedEventTypes || []).map((s) => s.trim()).filter(Boolean);
  if (evTypes.length) filter.includedEventTypes = evTypes;
  if (f.isSubjectCaseSensitive != null) filter.isSubjectCaseSensitive = !!f.isSubjectCaseSensitive;
  const adv = (f.advancedFilters || []).map(buildAdvancedFilter).filter(Boolean) as Record<string, unknown>[];
  if (adv.length) {
    filter.advancedFilters = adv;
    filter.enableAdvancedFilteringOnArrays = true;
  }
  if (Object.keys(filter).length) properties.filter = filter;

  const dl = spec.deadLetter;
  if (dl?.resourceId?.trim() && dl?.blobContainerName?.trim()) {
    properties.deadLetterDestination = {
      endpointType: 'StorageBlob',
      properties: { resourceId: dl.resourceId.trim(), blobContainerName: dl.blobContainerName.trim() },
    };
  }

  const rp: Record<string, number> = {};
  if (spec.retryPolicy?.maxDeliveryAttempts) rp.maxDeliveryAttempts = spec.retryPolicy.maxDeliveryAttempts;
  if (spec.retryPolicy?.eventTimeToLiveInMinutes) rp.eventTimeToLiveInMinutes = spec.retryPolicy.eventTimeToLiveInMinutes;
  if (Object.keys(rp).length) properties.retryPolicy = rp;

  const url = `${topicUrl(cfg, topicName)}/providers/Microsoft.EventGrid/eventSubscriptions/${encodeURIComponent(subName)}?api-version=${EG_ARM_API}`;
  const body = await arm<any>(url, { method: 'PUT', body: JSON.stringify({ properties }) });
  const p = body?.properties || {};
  const dest = p?.destination || {};
  return {
    name: body?.name || subName,
    destinationType: dest?.endpointType,
    destination:
      dest?.properties?.resourceId ||
      dest?.properties?.endpointUrl ||
      dest?.properties?.endpointBaseUrl ||
      undefined,
    provisioningState: p?.provisioningState,
    filterSubjectBeginsWith: p?.filter?.subjectBeginsWith,
    includedEventTypes: p?.filter?.includedEventTypes,
  };
}

// ───────────────────────────── data plane ─────────────────────────────────

/** A structured governed business event to publish. */
export interface BusinessEvent {
  /** CloudEvents `type` — the governed event type, e.g. `Order.Placed`. */
  eventType: string;
  /** CloudEvents `subject` — the resource the event is about. */
  subject: string;
  /** Structured payload (CloudEvents `data`). */
  data: Record<string, unknown>;
  /** CloudEvents `id` (auto-generated when omitted). */
  id?: string;
  /** RFC3339 `time` (defaults to now). */
  time?: string;
  /** CloudEvents `dataschema` URI for governance/validation. */
  dataschema?: string;
}

export interface PublishResult {
  ok: true;
  /** Number of events accepted (HTTP 200 from Event Grid). */
  published: number;
  status: number;
  topic: string;
  schema: 'CloudEventSchemaV1_0' | 'EventGridSchema';
}

function dataPlaneEndpoint(t: EventGridTopic, topic: string, cfg: EventGridTopicsConfig): string {
  if (t.endpoint) return t.endpoint;
  // Derive the data-plane endpoint when ARM didn't echo it. Event Grid topic
  // endpoints are `https://<topic>.<region>.eventgrid.azure.net/api/events`.
  const region = (t.location || process.env.LOOM_LOCATION || 'eastus2').replace(/\s+/g, '').toLowerCase();
  const suffix = process.env.LOOM_EVENTGRID_DATA_SUFFIX || 'eventgrid.azure.net';
  void cfg;
  return `https://${topic.toLowerCase()}.${region}.${suffix}/api/events`;
}

async function dataToken(): Promise<string> {
  const t = await credential.getToken(EVENTGRID_DATA_SCOPE);
  if (!t?.token) throw new EventGridTopicsError(401, undefined, 'Failed to acquire Event Grid data-plane token');
  return t.token;
}

function rfc3339(time?: string): string {
  if (time) return time;
  return new Date().toISOString();
}

/**
 * Publish one or more governed business events to an Event Grid custom topic.
 * Uses the topic's input schema (CloudEvents by default) and Entra auth; if
 * LOOM_EVENTGRID_SAS_AUTH=1 it falls back to aeg-sas-key (topic access key).
 * Real HTTPS POST to the data-plane endpoint — no mocks.
 */
export async function publishBusinessEvents(
  topic: string,
  events: BusinessEvent[],
  opts: { source?: string } = {},
): Promise<PublishResult> {
  const name = (topic || '').trim();
  if (!name) throw new EventGridTopicsError(400, undefined, 'topic is required');
  if (!Array.isArray(events) || events.length === 0) {
    throw new EventGridTopicsError(400, undefined, 'at least one event is required');
  }
  const cfg = readEventGridTopicsConfig();
  const meta = await getEventGridTopic(name);
  const endpoint = dataPlaneEndpoint(meta, name, cfg);
  const useCloudEvents = (meta.inputSchema || 'CloudEventSchemaV1_0') !== 'EventGridSchema';
  const source =
    opts.source ||
    `loom://business-events/${cfg.subscriptionId}/${cfg.resourceGroup}/${name}`;

  let payload: string;
  if (useCloudEvents) {
    payload = JSON.stringify(
      events.map((e) => ({
        specversion: '1.0',
        id: e.id || crypto.randomUUID(),
        source,
        type: e.eventType,
        subject: e.subject,
        time: rfc3339(e.time),
        datacontenttype: 'application/json',
        ...(e.dataschema ? { dataschema: e.dataschema } : {}),
        data: e.data,
      })),
    );
  } else {
    payload = JSON.stringify(
      events.map((e) => ({
        id: e.id || crypto.randomUUID(),
        eventType: e.eventType,
        subject: e.subject,
        eventTime: rfc3339(e.time),
        data: e.data,
        dataVersion: '1.0',
      })),
    );
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const sasAuth = (process.env.LOOM_EVENTGRID_SAS_AUTH || '').trim() === '1' && !meta.localAuthDisabled;
  if (sasAuth) {
    const keys = await listTopicKeys(name);
    if (!keys.key1) throw new EventGridTopicsError(403, undefined, 'topic SAS key unavailable');
    headers['aeg-sas-key'] = keys.key1;
  } else {
    headers['authorization'] = `Bearer ${await dataToken()}`;
  }

  const res = await fetchWithTimeout(endpoint, { method: 'POST', headers, body: payload });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new EventGridTopicsError(
      res.status,
      text,
      `publishBusinessEvents failed ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
    );
  }
  return {
    ok: true,
    published: events.length,
    status: res.status,
    topic: name,
    schema: useCloudEvents ? 'CloudEventSchemaV1_0' : 'EventGridSchema',
  };
}
