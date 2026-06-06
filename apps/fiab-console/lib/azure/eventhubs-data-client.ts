/**
 * Azure Event Hubs — DATA-plane client (Data Explorer: Send + Peek/View events).
 *
 * This is the data plane that complements the ARM control plane in
 * eventhubs-client.ts. It talks to the Event Hubs runtime endpoint
 *   https://<namespace>.servicebus.windows.net/<eventHub>/messages
 * NOT to management.azure.com. The two are deliberately separate clients.
 *
 * ── Auth ───────────────────────────────────────────────────────────────────
 * The deployment namespace sets `disableLocalAuth: true`, so SAS keys are
 * disabled. We authenticate with Microsoft Entra (AAD) using the SAME
 * credential chain as the ARM client — ChainedTokenCredential(
 * ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID), DefaultAzureCredential) —
 * but against the Event Hubs data-plane resource scope
 * `https://eventhubs.azure.net/.default` (NOT the ARM scope). The Console UAMI
 * holds "Azure Event Hubs Data Owner" on the namespace, which grants both
 * send (Data Sender) and receive (Data Receiver). If that role is missing the
 * real 401/403 from the service is surfaced verbatim (honest, never faked).
 *
 * ── Send (REAL, dependency-free) ────────────────────────────────────────────
 * Event Hubs exposes an HTTPS data-plane REST API for PUBLISHING events
 * (no extra dependency — just fetch over 443):
 *   - Single event : POST …/<hub>/messages
 *                     Content-Type: application/atom+xml;type=entry;charset=utf-8
 *                     body = the raw event payload
 *                     BrokerProperties header carries PartitionKey
 *                     UserProperties header carries custom app properties
 *   - Batch        : POST …/<hub>/messages
 *                     Content-Type: application/vnd.microsoft.servicebus.json
 *                     body = [{ "Body": "...", "UserProperties": {...} }, …]
 *   - To a partition (by key) : BrokerProperties: { "PartitionKey": "<key>" }
 * Grounded in Learn:
 *   https://learn.microsoft.com/rest/api/eventhub/send-event
 *   https://learn.microsoft.com/rest/api/eventhub/send-batch-events
 *   https://learn.microsoft.com/rest/api/eventhub/event-hubs-runtime-rest
 *   https://learn.microsoft.com/rest/api/eventhub/get-azure-active-directory-token
 *
 * ── Peek / View (HONEST GATE) ───────────────────────────────────────────────
 * Event Hubs has NO HTTPS REST receive path. Receiving/peeking events is an
 * AMQP-1.0 (or Kafka) operation that requires the @azure/event-hubs SDK, which
 * is NOT a dependency of this app (and must not be added per the build rules).
 * Rather than fake events, peekEvents() throws a typed
 * EventHubsReceiveUnavailableError describing exactly what to provision to
 * enable it (add @azure/event-hubs + LOOM_EVENTHUB_RECEIVE_ENABLED). The BFF
 * surfaces this as an honest MessageBar; the full View UI still renders. This
 * is the documented "honest infra/dependency-gate" allowed by no-vaporware.md.
 *
 * No mocks. Send hits the real runtime endpoint. Peek tells the truth.
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { eventhubsConfigGate } from './eventhubs-client';

/**
 * Event Hubs DATA-plane token scope. Distinct from the ARM scope used by the
 * control-plane client. Per Learn the AAD resource is `https://eventhubs.azure.net`.
 */
export const EVENTHUBS_DATA_SCOPE = 'https://eventhubs.azure.net/.default';

/** Media type for single-event sends (atom entry, per the runtime REST docs). */
export const SINGLE_SEND_CONTENT_TYPE = 'application/atom+xml;type=entry;charset=utf-8';
/** Media type for batch sends (servicebus JSON envelope). */
export const BATCH_SEND_CONTENT_TYPE = 'application/vnd.microsoft.servicebus.json';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Generic data-plane error (carries the HTTP status + raw service body). */
export class EventHubsDataError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Event Hubs data-plane call failed (${status})`);
    this.name = 'EventHubsDataError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Thrown by peekEvents(): receiving events needs the AMQP data plane
 * (@azure/event-hubs), which is not bundled. Honest dependency-gate — names
 * exactly what to add / set. Never returns fake events.
 */
export class EventHubsReceiveUnavailableError extends Error {
  readonly code = 'receive_unavailable';
  /** npm dependency that would enable receive. */
  readonly dependency = '@azure/event-hubs';
  /** env flag the operator sets once the dependency is bundled. */
  readonly envVar = 'LOOM_EVENTHUB_RECEIVE_ENABLED';
  readonly hint: string;
  constructor() {
    super(
      'Viewing (peeking) events requires the AMQP data plane. Event Hubs has no ' +
        'HTTPS REST receive path; receiving events needs the @azure/event-hubs SDK ' +
        '(AMQP-over-WebSocket), which is not bundled in this deployment. Sending ' +
        'events works today over the REST data plane. To enable View events, add ' +
        'the @azure/event-hubs dependency and set LOOM_EVENTHUB_RECEIVE_ENABLED=1.',
    );
    this.name = 'EventHubsReceiveUnavailableError';
    this.hint =
      'Add @azure/event-hubs to apps/fiab-console and set LOOM_EVENTHUB_RECEIVE_ENABLED=1 ' +
      'so the BFF can open an EventHubConsumerClient over AMQP and peek a bounded batch.';
  }
}

/** Resolved data-plane target derived from env (no SAS — Entra only). */
export interface EventHubsDataConfig {
  /** Fully-qualified namespace, e.g. `loom-evhns.servicebus.windows.net`. */
  fullyQualifiedNamespace: string;
}

/**
 * Build the fully-qualified namespace from LOOM_EVENTHUB_NAMESPACE. Accepts
 * either a bare namespace name (`loom-evhns`) or an already-qualified host
 * (`loom-evhns.servicebus.windows.net`) and an explicit sovereign-cloud
 * suffix override via LOOM_EVENTHUB_DATA_SUFFIX (e.g. servicebus.usgovcloudapi.net).
 */
export function readEventHubsDataConfig(): EventHubsDataConfig {
  const raw = (process.env.LOOM_EVENTHUB_NAMESPACE || '').trim();
  if (!raw) throw new EventHubsDataError(503, undefined, 'Event Hubs namespace not configured');
  const suffix = (process.env.LOOM_EVENTHUB_DATA_SUFFIX || 'servicebus.windows.net').replace(/^\.+|\.+$/g, '');
  const fqdn = raw.includes('.') ? raw.replace(/\/+$/, '') : `${raw}.${suffix}`;
  return { fullyQualifiedNamespace: fqdn };
}

function dataEndpoint(cfg: EventHubsDataConfig): string {
  return `https://${cfg.fullyQualifiedNamespace}`;
}

async function bearer(): Promise<string> {
  const t = await credential.getToken(EVENTHUBS_DATA_SCOPE);
  if (!t?.token) throw new EventHubsDataError(401, undefined, 'Failed to acquire Event Hubs data-plane token');
  return t.token;
}

/** One event to publish. `body` is the payload; properties become UserProperties. */
export interface SendEvent {
  /** Event payload. Strings are sent verbatim; objects are JSON-serialized. */
  body: string | Record<string, unknown> | unknown[];
  /** Optional custom application properties (UserProperties). */
  properties?: Record<string, string | number | boolean>;
}

export interface SendOptions {
  /** Partition key — events sharing a key land on the same partition, in order. */
  partitionKey?: string;
}

export interface SendResult {
  ok: true;
  /** Number of events accepted by the service. */
  sent: number;
  /** HTTP status returned by the runtime endpoint (201 on success). */
  status: number;
  /** Whether the batch envelope was used (true) or a single send (false). */
  batched: boolean;
}

function bodyToString(b: SendEvent['body']): string {
  return typeof b === 'string' ? b : JSON.stringify(b);
}

/**
 * Publish one or more events to `eventHub` via the real HTTPS data-plane REST.
 *
 *  - 1 event  → single send (atom entry) with BrokerProperties/UserProperties headers.
 *  - N events → batch send (servicebus JSON) with per-event Body/UserProperties.
 *
 * The connection is request-scoped: fetch opens it, the service replies 201,
 * and the request completes — no long-lived AMQP link (serverless-safe).
 */
export async function sendEvents(
  eventHub: string,
  events: SendEvent[],
  opts: SendOptions = {},
): Promise<SendResult> {
  const hub = (eventHub || '').trim();
  if (!hub) throw new EventHubsDataError(400, undefined, 'eventHub is required');
  if (!Array.isArray(events) || events.length === 0) {
    throw new EventHubsDataError(400, undefined, 'at least one event is required');
  }
  const cfg = readEventHubsDataConfig();
  const token = await bearer();
  const url = `${dataEndpoint(cfg)}/${encodeURIComponent(hub)}/messages`;
  const partitionKey = opts.partitionKey?.trim() || undefined;

  const batched = events.length > 1;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
  };
  if (partitionKey) {
    // PartitionKey rides on the BrokerProperties header (single + batch).
    headers['BrokerProperties'] = JSON.stringify({ PartitionKey: partitionKey });
  }

  let payload: string;
  if (batched) {
    headers['content-type'] = BATCH_SEND_CONTENT_TYPE;
    // Each element: { Body, UserProperties? }. UserProperties cannot be sent in
    // headers for batch sends — they go in the per-event JSON envelope.
    payload = JSON.stringify(
      events.map((e) => {
        const item: Record<string, unknown> = { Body: bodyToString(e.body) };
        if (e.properties && Object.keys(e.properties).length > 0) {
          item.UserProperties = e.properties;
        }
        return item;
      }),
    );
  } else {
    headers['content-type'] = SINGLE_SEND_CONTENT_TYPE;
    const single = events[0];
    if (single.properties && Object.keys(single.properties).length > 0) {
      // UserProperties header is a comma-separated list of name:value pairs.
      headers['UserProperties'] = JSON.stringify(single.properties);
    }
    payload = bodyToString(single.body);
  }

  const res = await fetch(url, { method: 'POST', headers, body: payload });
  if (!res.ok) {
    // Surface the real service error (401/403 when the Data role is missing).
    const text = await res.text().catch(() => '');
    throw new EventHubsDataError(res.status, text, `sendEvents failed ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
  }
  return { ok: true, sent: events.length, status: res.status, batched };
}

/** A single received/peeked event, shaped for the View grid. */
export interface ReceivedEvent {
  /** Per-partition byte offset of the event. */
  offset?: string;
  /** Monotonic per-partition sequence number. */
  sequenceNumber?: number;
  /** Service-side enqueue timestamp (ISO 8601). */
  enqueuedTime?: string;
  /** Partition this event was read from. */
  partitionId?: string;
  /** Partition key it was published with, if any. */
  partitionKey?: string;
  /** Decoded event payload. */
  body: unknown;
  /** Custom application properties. */
  properties?: Record<string, unknown>;
}

export interface PeekOptions {
  /** Partition id to read from (e.g. "0"). Required for a direct receiver. */
  partition?: string;
  /** Upper bound on events to return. */
  maxEvents?: number;
  /** Start at the latest position (true) vs the earliest retained (false). */
  fromLatest?: boolean;
  /** Consumer group to read under (defaults to $Default). */
  consumerGroup?: string;
  /** Max time (ms) to wait for the bounded batch before returning. */
  maxWaitMs?: number;
}

export interface PeekResult {
  ok: true;
  partition?: string;
  events: ReceivedEvent[];
}

/**
 * Peek (view) a bounded batch of recent events from `eventHub`.
 *
 * NOTE: Event Hubs has no HTTPS REST receive — receiving is AMQP-only and
 * requires the @azure/event-hubs SDK, which is not bundled. This throws the
 * honest {@link EventHubsReceiveUnavailableError}. When the dependency is added
 * and LOOM_EVENTHUB_RECEIVE_ENABLED is set, this is where an
 * EventHubConsumerClient would open, read a bounded batch with a short
 * maxWaitTime, and close. It never returns fabricated events.
 */
export async function peekEvents(
  eventHub: string,
  _opts: PeekOptions = {},
): Promise<PeekResult> {
  const hub = (eventHub || '').trim();
  if (!hub) throw new EventHubsDataError(400, undefined, 'eventHub is required');
  // Validate the namespace is configured so a misconfig reads as a config gate
  // (503) rather than the dependency gate.
  readEventHubsDataConfig();
  // Honest dependency-gate: no AMQP receive available in this runtime.
  throw new EventHubsReceiveUnavailableError();
}

/** Re-export the shared config gate so the BFF route can 503 consistently. */
export { eventhubsConfigGate };
