/**
 * business-events-store — Cosmos read/write for the **governed business-event
 * type registry**.
 *
 * This is what makes the Business Events publishing surface "structured and
 * GOVERNED" rather than a free-for-all event firehose: an operator registers a
 * governed event TYPE (name, category, a typed field schema, the channels it
 * publishes to, an owner) once, and every publish is validated against that
 * registered schema before it is emitted to Event Hubs / Event Grid. Unknown
 * required fields, missing fields, or type mismatches are rejected with a
 * precise error — the same governance gate Fabric's Activator "business events"
 * applies, but Azure-native (Cosmos + Event Grid + Event Hubs, no Fabric).
 *
 * Storage: the main `loom` Cosmos database, container `business-event-types`,
 * partitioned by `/id`. Created on first write (createIfNotExists) so a fresh
 * environment needs no extra ARM/Bicep step beyond the Cosmos account.
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) → Cosmos DB Built-in Data
 * Contributor at account scope (the same grant cosmos-client.ts relies on).
 *
 * No mocks. Real Cosmos data plane. The pure helpers (validation + the field
 * type list) carry no Azure-SDK import so they stay unit-testable in isolation.
 */

import type { Container } from '@azure/cosmos';

/** Supported field primitive types for a governed event schema. */
export type BusinessFieldType = 'string' | 'number' | 'boolean' | 'datetime' | 'json';

export const BUSINESS_FIELD_TYPES: BusinessFieldType[] = [
  'string',
  'number',
  'boolean',
  'datetime',
  'json',
];

/** Channels a governed event type fans out to. */
export type BusinessChannel = 'eventgrid' | 'eventhub';

/** One typed field in a governed event-type schema. */
export interface BusinessEventField {
  name: string;
  type: BusinessFieldType;
  required: boolean;
  description?: string;
}

/** A registered, governed business-event type. */
export interface BusinessEventType {
  /** Document id — slug of the event type, e.g. `order.placed`. */
  id: string;
  /** Governed type name used as the CloudEvents `type`, e.g. `Order.Placed`. */
  eventType: string;
  /** Display name. */
  displayName: string;
  /** Domain/category for grouping (e.g. Commerce, Operations, Security). */
  category: string;
  description?: string;
  /** Typed field schema the payload is validated against. */
  fields: BusinessEventField[];
  /** Channels this type publishes to (at least one). */
  channels: BusinessChannel[];
  /** Event Grid custom topic name (when `eventgrid` is a channel). */
  eventGridTopic?: string;
  /** Event Hub entity name (when `eventhub` is a channel). */
  eventHubName?: string;
  /** Owning team / steward for governance. */
  owner?: string;
  updatedAt?: string;
  updatedBy?: string;
}

const DB_ID = process.env.LOOM_COSMOS_DB || 'loom';
const CONTAINER_ID = process.env.LOOM_BUSINESS_EVENTS_CONTAINER || 'business-event-types';

let _client: any = null;
let _container: Container | null = null;

export function businessEventsConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_COSMOS_ENDPOINT) return { missing: 'LOOM_COSMOS_ENDPOINT' };
  return null;
}

function endpoint(): string {
  const v = process.env.LOOM_COSMOS_ENDPOINT;
  if (!v) throw new Error('LOOM_COSMOS_ENDPOINT not set — cannot reach the business-event registry');
  return v;
}

async function credential() {
  const { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } = await import('@azure/identity');
  const clientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const chain: any[] = [];
  if (clientId) chain.push(new ManagedIdentityCredential({ clientId }));
  chain.push(new DefaultAzureCredential());
  return new ChainedTokenCredential(...chain);
}

async function client(): Promise<any> {
  if (_client) return _client;
  const { CosmosClient } = await import('@azure/cosmos');
  _client = new CosmosClient({ endpoint: endpoint(), aadCredentials: await credential() });
  return _client;
}

async function container(): Promise<Container> {
  if (_container) return _container;
  const { database } = await (await client()).databases.createIfNotExists({ id: DB_ID });
  const { container: c } = await database.containers.createIfNotExists({
    id: CONTAINER_ID,
    partitionKey: { paths: ['/id'] },
  });
  _container = c;
  return c;
}

/** Slugify an event-type name into a stable document id. */
export function eventTypeId(eventType: string): string {
  return (eventType || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

/** List every registered governed event type, newest-updated first. */
export async function listEventTypes(): Promise<BusinessEventType[]> {
  const c = await container();
  const { resources } = await c.items
    .query<BusinessEventType>('SELECT * FROM c ORDER BY c.updatedAt DESC')
    .fetchAll();
  return resources ?? [];
}

/** Read one registered governed event type. Returns null when not found. */
export async function getEventType(id: string): Promise<BusinessEventType | null> {
  const c = await container();
  try {
    const { resource } = await c.item(id, id).read<BusinessEventType>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Upsert a governed event type. Stamps id (from eventType) + updatedAt. */
export async function upsertEventType(
  spec: Omit<BusinessEventType, 'id' | 'updatedAt'>,
  updatedBy?: string,
): Promise<BusinessEventType> {
  const c = await container();
  const id = eventTypeId(spec.eventType);
  if (!id) throw new Error('eventType is required');
  const doc: BusinessEventType = {
    ...spec,
    id,
    updatedAt: new Date().toISOString(),
    ...(updatedBy ? { updatedBy } : {}),
  };
  const { resource } = await c.items.upsert<BusinessEventType>(doc);
  return (resource as BusinessEventType) ?? doc;
}

/** Delete a governed event type by id. */
export async function deleteEventType(id: string): Promise<void> {
  const c = await container();
  try {
    await c.item(id, id).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}

/**
 * Validate a payload against a governed event type's field schema. Returns the
 * list of governance errors (empty = valid). PURE — no I/O, unit-testable.
 */
export function validatePayload(
  type: Pick<BusinessEventType, 'fields'>,
  payload: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const fieldNames = new Set(type.fields.map((f) => f.name));
  for (const f of type.fields) {
    const present = Object.prototype.hasOwnProperty.call(payload, f.name);
    if (!present) {
      if (f.required) errors.push(`Missing required field "${f.name}".`);
      continue;
    }
    const v = payload[f.name];
    if (v === null || v === undefined) {
      if (f.required) errors.push(`Required field "${f.name}" is null.`);
      continue;
    }
    switch (f.type) {
      case 'string':
        if (typeof v !== 'string') errors.push(`Field "${f.name}" must be a string.`);
        break;
      case 'number':
        if (typeof v !== 'number' || Number.isNaN(v)) errors.push(`Field "${f.name}" must be a number.`);
        break;
      case 'boolean':
        if (typeof v !== 'boolean') errors.push(`Field "${f.name}" must be a boolean.`);
        break;
      case 'datetime':
        if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
          errors.push(`Field "${f.name}" must be an ISO-8601 datetime string.`);
        }
        break;
      case 'json':
        if (typeof v !== 'object') errors.push(`Field "${f.name}" must be a JSON object or array.`);
        break;
    }
  }
  // Reject unknown extra fields to keep the governed contract tight.
  for (const k of Object.keys(payload)) {
    if (!fieldNames.has(k)) errors.push(`Unknown field "${k}" is not part of the governed schema.`);
  }
  return errors;
}
