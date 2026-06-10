/**
 * business-events-client — Azure-native parity for Microsoft Fabric
 * "Business events" (Real-Time hub) publishing.
 *
 * ── What a "business event" is ───────────────────────────────────────────────
 * In Fabric, a business event is a NAMED, SCHEMA-TYPED governed signal defined
 * in the Real-Time hub. Publishers (Activator rules, eventstreams) emit the
 * event when a condition is met; the event is stored, made discoverable in the
 * Real-Time hub (Publishers / Consumers / Data preview tabs), and any consumer
 * can subscribe and react. See:
 *   https://learn.microsoft.com/fabric/real-time-hub/business-events/business-events-activator
 *
 * ── Azure-native backend (DEFAULT — no Microsoft Fabric required) ────────────
 * Per .claude/rules/no-fabric-dependency.md, the default backend is Azure:
 *
 *   • Definition (governance) — a business-event document in Cosmos
 *     (business-events container, PK /tenantId): name, description, the typed
 *     schema (property name + type), the transport binding (Event Hub name +
 *     optional Event Grid custom topic), capacity metering note, and the
 *     append-only publisher/consumer registry.
 *
 *   • Transport (durable, capacity-metered) — Azure Event Hubs. Each business
 *     event maps to an Event Hub on the deployment namespace
 *     (LOOM_EVENTHUB_NAMESPACE). Publishing sends a structured CloudEvents-1.0
 *     envelope to that hub over the existing HTTPS data plane
 *     (eventhubs-data-client.sendEvents) — the same metered namespace the rest
 *     of Loom's Real-Time surfaces use, so events are "capacity-metered".
 *
 *   • Fan-out / routing (consumers) — an optional Azure Event Grid custom topic
 *     (LOOM_BUSINESS_EVENTS_EGTOPIC). When configured, each publish is ALSO
 *     posted to the topic as an Event Grid event, so downstream Logic Apps,
 *     Functions, webhooks, and Service Bus subscriptions can route on
 *     eventType = the business-event name. Optional — absence is an honest
 *     gate, not a failure (Event Hubs delivery still works).
 *
 *   • Discoverability — the Real-Time hub "Business events" surface lists these
 *     Cosmos definitions with their publisher/consumer counts and recent
 *     activity, exactly like Fabric's Real-Time hub Business events page.
 *
 * Fabric is strictly opt-in (LOOM_BUSINESS_EVENTS_BACKEND=fabric); that path is
 * NOT implemented here yet and the default Azure path never touches Fabric.
 *
 * ── Auth ─────────────────────────────────────────────────────────────────────
 * Cosmos: the shared cosmos-client (Console UAMI, Cosmos Built-in Data
 * Contributor). Event Hubs send: eventhubs-data-client (Entra, Event Hubs Data
 * Sender). Event Grid publish: Console UAMI with "EventGrid Data Sender" on the
 * custom topic (AAD data-plane token, scope https://eventgrid.azure.net/.default).
 * Every backend error is surfaced verbatim — no mocks, no fabricated events.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { randomUUID } from 'crypto';
import { businessEventsContainer } from './cosmos-client';
import { sendEvents, readEventHubsDataConfig } from './eventhubs-data-client';

// ── Types ───────────────────────────────────────────────────────────────────

export type BusinessEventPropertyType = 'string' | 'number' | 'boolean' | 'datetime';

export interface BusinessEventProperty {
  name: string;
  type: BusinessEventPropertyType;
  required?: boolean;
  description?: string;
}

/** A registered publisher of a business event (Activator rule, eventstream, app). */
export interface BusinessEventPublisher {
  id: string;
  /** Display name shown in the Publishers tab. */
  name: string;
  /** What kind of source publishes (activator | eventstream | manual | app). */
  kind: 'activator' | 'eventstream' | 'manual' | 'app';
  /** Loom workspace the publisher lives in, if any. */
  workspaceId?: string;
  registeredAt: string;
  lastPublishedAt?: string;
  /** Count of events published by this publisher (best-effort, incremented on send). */
  publishCount?: number;
}

/** A registered consumer (subscriber) of a business event. */
export interface BusinessEventConsumer {
  id: string;
  name: string;
  /** activator (set-alert), function, logic-app, webhook, service-bus. */
  kind: 'activator' | 'function' | 'logic-app' | 'webhook' | 'service-bus';
  /** Delivery target (e.g. webhook URL, resource id) — echoed for transparency. */
  endpoint?: string;
  registeredAt: string;
}

/** The Cosmos-persisted business-event definition. */
export interface BusinessEvent {
  id: string;
  /** Cosmos partition key. */
  tenantId: string;
  /** The governed signal name, e.g. SalesTargetMissed. Unique per tenant. */
  name: string;
  description?: string;
  /** Schema-set grouping name (Fabric parity), e.g. RetailOperations. */
  schemaSet?: string;
  /** The typed event schema. */
  schema: BusinessEventProperty[];
  /** Event Hub (on LOOM_EVENTHUB_NAMESPACE) this event publishes to. */
  eventHub: string;
  /** Optional Event Grid custom topic for consumer fan-out (overrides env). */
  eventGridTopic?: string;
  publishers: BusinessEventPublisher[];
  consumers: BusinessEventConsumer[];
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** Public-facing view that omits the partition key. */
export type BusinessEventView = Omit<BusinessEvent, 'tenantId'>;

export class BusinessEventError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'BusinessEventError';
    this.status = status;
  }
}

// ── Credential (Event Grid data-plane) ───────────────────────────────────────

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const egCredential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

/** Event Grid data-plane AAD scope (custom-topic publish). */
export const EVENTGRID_DATA_SCOPE = 'https://eventgrid.azure.net/.default';

// ── Config helpers ───────────────────────────────────────────────────────────

/**
 * Default Event Hub name for new business events when the caller doesn't pin
 * one. Falls back to a stable conventional hub.
 */
export function defaultBusinessEventHub(): string {
  return (process.env.LOOM_BUSINESS_EVENTS_HUB || '').trim() || 'loom-business-events';
}

/** Resolved Event Grid custom-topic endpoint, or null when not configured. */
export function eventGridTopicEndpoint(override?: string): string | null {
  const raw = (override || process.env.LOOM_BUSINESS_EVENTS_EGTOPIC || '').trim();
  if (!raw) return null;
  // Accept either a bare hostname or a full https endpoint.
  if (raw.startsWith('http')) return raw.replace(/\/+$/, '');
  return `https://${raw}`;
}

/**
 * Config gate for the Event Hubs transport. A missing namespace is an honest
 * Azure infra gate (NOT a Fabric gate) — the definition surface still renders;
 * only publishing is blocked until set.
 */
export function transportConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_EVENTHUB_NAMESPACE) return { missing: 'LOOM_EVENTHUB_NAMESPACE' };
  return null;
}

// ── Validation ───────────────────────────────────────────────────────────────

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;
const PROP_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const VALID_TYPES: BusinessEventPropertyType[] = ['string', 'number', 'boolean', 'datetime'];

function sanitizeHubName(name: string): string {
  // Event Hub names: letters, numbers, periods, hyphens, underscores; 1-256.
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'loom-business-events';
}

export function validateSchema(schema: unknown): BusinessEventProperty[] {
  if (!Array.isArray(schema) || schema.length === 0) {
    throw new BusinessEventError('schema must be a non-empty array of properties', 400);
  }
  const seen = new Set<string>();
  return schema.map((raw: any) => {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (!PROP_NAME_RE.test(name)) {
      throw new BusinessEventError(`invalid property name "${name}" (letters/digits/underscore, must start with a letter)`, 400);
    }
    if (seen.has(name.toLowerCase())) throw new BusinessEventError(`duplicate property "${name}"`, 400);
    seen.add(name.toLowerCase());
    const type = raw?.type;
    if (!VALID_TYPES.includes(type)) {
      throw new BusinessEventError(`property "${name}" has invalid type "${type}" (allowed: ${VALID_TYPES.join(', ')})`, 400);
    }
    return {
      name,
      type,
      required: raw?.required === true,
      description: typeof raw?.description === 'string' ? raw.description : undefined,
    };
  });
}

/**
 * Validate an event payload against a schema. Returns a typed, coerced payload
 * (or throws BusinessEventError on the first failing field). This is what makes
 * the event "structured & governed" — payloads that don't match the contract
 * never reach the transport.
 */
export function validatePayload(
  schema: BusinessEventProperty[],
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const known = new Set(schema.map((p) => p.name));
  for (const prop of schema) {
    const v = payload[prop.name];
    if (v === undefined || v === null || v === '') {
      if (prop.required) throw new BusinessEventError(`missing required field "${prop.name}"`, 400);
      continue;
    }
    switch (prop.type) {
      case 'string':
        out[prop.name] = String(v);
        break;
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new BusinessEventError(`field "${prop.name}" must be a number`, 400);
        out[prop.name] = n;
        break;
      }
      case 'boolean':
        out[prop.name] = v === true || v === 'true' || v === 1 || v === '1';
        break;
      case 'datetime': {
        const d = new Date(v as string);
        if (Number.isNaN(d.getTime())) throw new BusinessEventError(`field "${prop.name}" must be a valid date/time`, 400);
        out[prop.name] = d.toISOString();
        break;
      }
    }
  }
  // Reject unknown fields so the contract is strict (governed signal).
  for (const k of Object.keys(payload)) {
    if (!known.has(k)) throw new BusinessEventError(`unknown field "${k}" is not part of the "${''}" event schema`, 400);
  }
  return out;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

function toView(e: BusinessEvent): BusinessEventView {
  const { tenantId: _t, ...rest } = e;
  return rest;
}

export async function listBusinessEvents(tenantId: string): Promise<BusinessEventView[]> {
  const c = await businessEventsContainer();
  const { resources } = await c.items
    .query<BusinessEvent>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.name',
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return resources.map(toView);
}

export async function getBusinessEvent(tenantId: string, id: string): Promise<BusinessEventView | null> {
  const c = await businessEventsContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<BusinessEvent>();
    return resource ? toView(resource) : null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export interface CreateBusinessEventInput {
  name: string;
  description?: string;
  schemaSet?: string;
  schema: unknown;
  eventHub?: string;
  eventGridTopic?: string;
}

export async function createBusinessEvent(
  tenantId: string,
  createdBy: string | undefined,
  input: CreateBusinessEventInput,
): Promise<BusinessEventView> {
  const name = (input.name || '').trim();
  if (!NAME_RE.test(name)) {
    throw new BusinessEventError('name must start with a letter and use letters, digits, hyphen or underscore (2-64 chars)', 400);
  }
  const schema = validateSchema(input.schema);
  const c = await businessEventsContainer();

  // Enforce per-tenant uniqueness of the signal name.
  const { resources: existing } = await c.items
    .query<BusinessEvent>({
      query: 'SELECT c.id FROM c WHERE c.tenantId = @t AND LOWER(c.name) = @n',
      parameters: [{ name: '@t', value: tenantId }, { name: '@n', value: name.toLowerCase() }],
    })
    .fetchAll();
  if (existing.length > 0) throw new BusinessEventError(`a business event named "${name}" already exists`, 409);

  const now = new Date().toISOString();
  const doc: BusinessEvent = {
    id: randomUUID(),
    tenantId,
    name,
    description: input.description?.trim() || undefined,
    schemaSet: input.schemaSet?.trim() || undefined,
    schema,
    eventHub: input.eventHub ? sanitizeHubName(input.eventHub) : defaultBusinessEventHub(),
    eventGridTopic: input.eventGridTopic?.trim() || undefined,
    publishers: [],
    consumers: [],
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  const { resource } = await c.items.create(doc);
  return toView(resource as BusinessEvent);
}

export interface UpdateBusinessEventInput {
  description?: string;
  schemaSet?: string;
  schema?: unknown;
  eventGridTopic?: string;
}

export async function updateBusinessEvent(
  tenantId: string,
  id: string,
  input: UpdateBusinessEventInput,
): Promise<BusinessEventView> {
  const c = await businessEventsContainer();
  const { resource } = await c.item(id, tenantId).read<BusinessEvent>();
  if (!resource) throw new BusinessEventError('business event not found', 404);
  if (input.description !== undefined) resource.description = input.description.trim() || undefined;
  if (input.schemaSet !== undefined) resource.schemaSet = input.schemaSet.trim() || undefined;
  if (input.schema !== undefined) resource.schema = validateSchema(input.schema);
  if (input.eventGridTopic !== undefined) resource.eventGridTopic = input.eventGridTopic.trim() || undefined;
  resource.updatedAt = new Date().toISOString();
  const { resource: saved } = await c.item(id, tenantId).replace(resource);
  return toView(saved as BusinessEvent);
}

export async function deleteBusinessEvent(tenantId: string, id: string): Promise<void> {
  const c = await businessEventsContainer();
  await c.item(id, tenantId).delete();
}

// ── Publisher / consumer registry ────────────────────────────────────────────

export async function registerConsumer(
  tenantId: string,
  id: string,
  consumer: Omit<BusinessEventConsumer, 'id' | 'registeredAt'>,
): Promise<BusinessEventView> {
  const c = await businessEventsContainer();
  const { resource } = await c.item(id, tenantId).read<BusinessEvent>();
  if (!resource) throw new BusinessEventError('business event not found', 404);
  resource.consumers = resource.consumers || [];
  resource.consumers.push({ ...consumer, id: randomUUID(), registeredAt: new Date().toISOString() });
  resource.updatedAt = new Date().toISOString();
  const { resource: saved } = await c.item(id, tenantId).replace(resource);
  return toView(saved as BusinessEvent);
}

export async function removeConsumer(tenantId: string, id: string, consumerId: string): Promise<BusinessEventView> {
  const c = await businessEventsContainer();
  const { resource } = await c.item(id, tenantId).read<BusinessEvent>();
  if (!resource) throw new BusinessEventError('business event not found', 404);
  resource.consumers = (resource.consumers || []).filter((x) => x.id !== consumerId);
  resource.updatedAt = new Date().toISOString();
  const { resource: saved } = await c.item(id, tenantId).replace(resource);
  return toView(saved as BusinessEvent);
}

// ── Publish (the core "publish structured governed signals" path) ────────────

export interface PublishInput {
  /** The structured event payload (validated against the schema). */
  data: Record<string, unknown>;
  /** Who/what is publishing — recorded in the publisher registry. */
  publisher?: { name: string; kind: BusinessEventPublisher['kind']; workspaceId?: string };
  /** Optional partition key (events sharing a key keep order on one partition). */
  partitionKey?: string;
}

export interface PublishResult {
  ok: true;
  /** The CloudEvents id minted for the published signal. */
  eventId: string;
  /** The business event name (CloudEvents type). */
  type: string;
  /** Event Hub the event was sent to. */
  eventHub: string;
  /** Whether the Event Grid custom-topic fan-out also fired. */
  eventGridDelivered: boolean;
  /** Honest note when the Event Grid fan-out is not configured. */
  eventGridNote?: string;
  publishedAt: string;
}

async function postToEventGrid(endpoint: string, cloudEvent: Record<string, unknown>): Promise<void> {
  const t = await egCredential.getToken(EVENTGRID_DATA_SCOPE);
  if (!t?.token) throw new BusinessEventError('failed to acquire Event Grid data-plane token', 401);
  // Event Grid custom topics accept the Event Grid schema array. We post a
  // single-element array shaped to the EventGridEvent schema, derived from the
  // CloudEvent we already built.
  const egEvent = [{
    id: cloudEvent.id,
    eventType: cloudEvent.type,
    subject: cloudEvent.subject || `businessEvents/${cloudEvent.type}`,
    eventTime: cloudEvent.time,
    dataVersion: '1.0',
    data: cloudEvent.data,
  }];
  const url = `${endpoint.replace(/\/+$/, '')}/api/events?api-version=2018-01-01`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(egEvent),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new BusinessEventError(`Event Grid publish failed (${res.status})${body ? `: ${body.slice(0, 240)}` : ''}`, res.status);
  }
}

/**
 * Publish one structured business event. Validates the payload against the
 * stored schema, wraps it in a CloudEvents-1.0 envelope, sends it to the
 * bound Event Hub (durable, capacity-metered), optionally fans it out to the
 * Event Grid custom topic, and records the publisher + activity on the
 * definition. Returns the minted event id + delivery detail.
 */
export async function publishBusinessEvent(
  tenantId: string,
  id: string,
  input: PublishInput,
): Promise<PublishResult> {
  const gate = transportConfigGate();
  if (gate) {
    throw new BusinessEventError(
      `Event Hubs transport not configured — set ${gate.missing} to publish business events.`,
      503,
    );
  }
  const c = await businessEventsContainer();
  const { resource } = await c.item(id, tenantId).read<BusinessEvent>();
  if (!resource) throw new BusinessEventError('business event not found', 404);

  // Strict schema validation — only contract-conforming payloads are published.
  let validated: Record<string, unknown>;
  try {
    validated = validatePayload(resource.schema, input.data || {});
  } catch (e) {
    if (e instanceof BusinessEventError) {
      // Inject the event name into the generic "unknown field" message.
      throw new BusinessEventError(e.message.replace('the "" event schema', `the "${resource.name}" event schema`), 400);
    }
    throw e;
  }

  const now = new Date().toISOString();
  const eventId = randomUUID();
  // CloudEvents-1.0 envelope (governed, structured).
  const cloudEvent = {
    specversion: '1.0',
    id: eventId,
    type: resource.name,
    source: `loom/business-events/${resource.id}`,
    subject: input.publisher?.workspaceId ? `workspaces/${input.publisher.workspaceId}` : undefined,
    time: now,
    datacontenttype: 'application/json',
    schemaset: resource.schemaSet || undefined,
    data: validated,
  };

  // 1) Durable, capacity-metered transport — Event Hubs.
  await sendEvents(
    resource.eventHub,
    [{
      body: cloudEvent,
      properties: {
        businessEvent: resource.name,
        eventId,
        ...(resource.schemaSet ? { schemaSet: resource.schemaSet } : {}),
      },
    }],
    { partitionKey: input.partitionKey },
  );

  // 2) Optional consumer fan-out — Event Grid custom topic.
  const egEndpoint = eventGridTopicEndpoint(resource.eventGridTopic);
  let eventGridDelivered = false;
  let eventGridNote: string | undefined;
  if (egEndpoint) {
    await postToEventGrid(egEndpoint, cloudEvent);
    eventGridDelivered = true;
  } else {
    eventGridNote =
      'Event Grid fan-out not configured — set LOOM_BUSINESS_EVENTS_EGTOPIC (or the event\'s eventGridTopic) ' +
      'to route this signal to webhooks / Logic Apps / Functions. Event Hubs delivery succeeded regardless.';
  }

  // 3) Record the publisher + activity (governance / discoverability).
  if (input.publisher?.name) {
    resource.publishers = resource.publishers || [];
    const existing = resource.publishers.find(
      (p) => p.name === input.publisher!.name && p.kind === input.publisher!.kind,
    );
    if (existing) {
      existing.lastPublishedAt = now;
      existing.publishCount = (existing.publishCount || 0) + 1;
    } else {
      resource.publishers.push({
        id: randomUUID(),
        name: input.publisher.name,
        kind: input.publisher.kind,
        workspaceId: input.publisher.workspaceId,
        registeredAt: now,
        lastPublishedAt: now,
        publishCount: 1,
      });
    }
    resource.updatedAt = now;
    await c.item(id, tenantId).replace(resource).catch(() => { /* activity record is best-effort */ });
  }

  return {
    ok: true,
    eventId,
    type: resource.name,
    eventHub: resource.eventHub,
    eventGridDelivered,
    eventGridNote,
    publishedAt: now,
  };
}

/** Re-export the data-plane config read so routes can echo the resolved namespace. */
export { readEventHubsDataConfig };
