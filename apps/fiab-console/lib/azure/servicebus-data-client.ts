/**
 * Azure Service Bus — DATA-plane client (Service Bus Explorer: Send + Peek).
 *
 * The data-plane counterpart to the ARM control-plane servicebus-client.ts.
 * Unlike Event Hubs (whose receive path is AMQP-only), Service Bus exposes a
 * real HTTPS/REST data plane for BOTH send and receive, so this needs no extra
 * SDK dependency — plain fetch over 443:
 *
 *   - Send      POST https://<ns>.<serviceBusSuffix>/<entity>/messages
 *               body = the message payload; BrokerProperties header carries
 *               Label / SessionId / PartitionKey.
 *   - Peek      Non-destructive "peek" is implemented with Peek-Lock + Unlock:
 *               POST …/<entity>/messages/head?timeout=<s>   (peek-lock, 201)
 *               then PUT <lock-uri>                          (unlock → returns
 *               the message to the queue). We peek-lock up to N distinct
 *               messages, capture them, then release every lock — so the batch
 *               is read WITHOUT consuming anything.
 *
 * <entity> is a queue name, or a subscription path `<topic>/subscriptions/<sub>`.
 *
 * Auth: Microsoft Entra against the Service Bus data-plane scope
 * `https://servicebus.azure.net/.default` (cloud-invariant), using the SAME
 * credential chain as every other Loom client. The namespace deploys with
 * disableLocalAuth:true (Entra-only), so the Console UAMI must hold "Azure
 * Service Bus Data Sender" (send) / "Data Receiver" (peek), or "Data Owner".
 * A missing role surfaces the real 401/403 from the service verbatim — no mocks,
 * no faked messages.
 *
 * Docs:
 *   https://learn.microsoft.com/rest/api/servicebus/send-message-to-queue
 *   https://learn.microsoft.com/rest/api/servicebus/peek-lock-message
 *   https://learn.microsoft.com/rest/api/servicebus/unlock-message
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { serviceBusSuffix } from './cloud-endpoints';
import { servicebusConfigGate } from './servicebus-client';

/** Service Bus DATA-plane token scope (cloud-invariant, distinct from ARM). */
export const SERVICEBUS_DATA_SCOPE = 'https://servicebus.azure.net/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Generic data-plane error (carries HTTP status + raw service body). */
export class ServiceBusDataError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body?: unknown, message?: string) {
    super(message || `Service Bus data-plane call failed (${status})`);
    this.name = 'ServiceBusDataError';
    this.status = status;
    this.body = body;
  }
}

/** Resolved data-plane target derived from env (no SAS — Entra only). */
export interface ServiceBusDataConfig {
  fullyQualifiedNamespace: string;
}

/** Build the fully-qualified namespace host from LOOM_SERVICEBUS_NAMESPACE. */
export function readServiceBusDataConfig(): ServiceBusDataConfig {
  const raw = (process.env.LOOM_SERVICEBUS_NAMESPACE || '').trim();
  if (!raw) throw new ServiceBusDataError(503, undefined, 'Service Bus namespace not configured');
  const suffix = (process.env.LOOM_SERVICEBUS_DATA_SUFFIX || serviceBusSuffix()).replace(/^\.+|\.+$/g, '');
  const fqdn = raw.includes('.') ? raw.replace(/\/+$/, '') : `${raw}.${suffix}`;
  return { fullyQualifiedNamespace: fqdn };
}

function base(cfg: ServiceBusDataConfig): string {
  return `https://${cfg.fullyQualifiedNamespace}`;
}

async function bearer(): Promise<string> {
  const t = await credential.getToken(SERVICEBUS_DATA_SCOPE);
  if (!t?.token) throw new ServiceBusDataError(401, undefined, 'Failed to acquire Service Bus data-plane token');
  return t.token;
}

/** Encode an entity path (queue, or `topic/subscriptions/sub`) segment-wise. */
function encodeEntityPath(entityPath: string): string {
  return entityPath.split('/').map(encodeURIComponent).join('/');
}

export interface SendMessageInput {
  /** Message payload. Strings are sent verbatim; objects are JSON-serialized. */
  body: string | Record<string, unknown> | unknown[];
  /** BrokerProperties.Label (a.k.a. Subject). */
  label?: string;
  /** BrokerProperties.SessionId — required for session-enabled entities. */
  sessionId?: string;
  /** BrokerProperties.PartitionKey. */
  partitionKey?: string;
  /** BrokerProperties.MessageId (auto-assigned by the service when omitted). */
  messageId?: string;
}

export interface SendMessageResult {
  ok: true;
  status: number;
  entity: string;
}

function bodyToString(b: SendMessageInput['body']): { text: string; contentType: string } {
  if (typeof b === 'string') return { text: b, contentType: 'text/plain' };
  return { text: JSON.stringify(b), contentType: 'application/json' };
}

/**
 * Send one message to a queue or topic via the real HTTPS data plane REST.
 * `entity` is a queue name or a topic name (send targets an entity, not a
 * subscription). Request-scoped fetch — the service replies 201 and the request
 * completes (serverless-safe, no long-lived AMQP link).
 */
export async function sendMessage(entity: string, input: SendMessageInput): Promise<SendMessageResult> {
  const ent = (entity || '').trim();
  if (!ent) throw new ServiceBusDataError(400, undefined, 'entity is required');
  if (input?.body === undefined || input?.body === null || input?.body === '') {
    throw new ServiceBusDataError(400, undefined, 'a non-empty message body is required');
  }
  const cfg = readServiceBusDataConfig();
  const token = await bearer();
  const { text, contentType } = bodyToString(input.body);

  const broker: Record<string, string> = {};
  if (input.label?.trim()) broker.Label = input.label.trim();
  if (input.sessionId?.trim()) broker.SessionId = input.sessionId.trim();
  if (input.partitionKey?.trim()) broker.PartitionKey = input.partitionKey.trim();
  if (input.messageId?.trim()) broker.MessageId = input.messageId.trim();

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': contentType,
  };
  if (Object.keys(broker).length > 0) headers['BrokerProperties'] = JSON.stringify(broker);

  const url = `${base(cfg)}/${encodeEntityPath(ent)}/messages`;
  const res = await fetchWithTimeout(url, { method: 'POST', headers, body: text });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ServiceBusDataError(res.status, body, `sendMessage failed ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
  return { ok: true, status: res.status, entity: ent };
}

export interface PeekedMessage {
  messageId?: string;
  sequenceNumber?: number;
  label?: string;
  enqueuedTime?: string;
  contentType?: string;
  deliveryCount?: number;
  body: unknown;
}

export interface PeekResult {
  ok: true;
  entity: string;
  messages: PeekedMessage[];
}

function parseBrokerProps(h: Headers): Record<string, unknown> {
  const raw = h.get('BrokerProperties') || h.get('brokerproperties');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function decodeBody(text: string, contentType: string | null): unknown {
  if (!text) return '';
  if (contentType && /json/i.test(contentType)) {
    try { return JSON.parse(text); } catch { /* fall through to text */ }
  }
  return text;
}

/**
 * Non-destructively peek up to `max` messages from a queue or a subscription
 * path (`topic/subscriptions/sub`). Implemented as Peek-Lock (which locks each
 * message so successive calls return DISTINCT messages) followed by Unlock on
 * every locked message — the batch is read without consuming anything. A 204 No
 * Content means the entity had no more available messages, so we stop early.
 */
export async function peekMessages(
  entityPath: string,
  opts: { max?: number; timeoutSeconds?: number } = {},
): Promise<PeekResult> {
  const ent = (entityPath || '').trim();
  if (!ent) throw new ServiceBusDataError(400, undefined, 'entityPath is required');
  const cfg = readServiceBusDataConfig();
  const token = await bearer();
  const max = Math.max(1, Math.min(opts.max ?? 20, 100));
  const timeout = Math.max(1, Math.min(opts.timeoutSeconds ?? 5, 30));

  const headUrl = `${base(cfg)}/${encodeEntityPath(ent)}/messages/head?timeout=${timeout}`;
  const messages: PeekedMessage[] = [];
  const lockUris: string[] = [];

  try {
    for (let i = 0; i < max; i++) {
      // Peek-Lock: locks the next available message and returns it (201). A 204
      // means no more messages are currently available.
      const res = await fetchWithTimeout(headUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 204) break;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ServiceBusDataError(res.status, body, `peek failed ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
      }
      const lockUri = res.headers.get('location') || res.headers.get('Location') || '';
      const bp = parseBrokerProps(res.headers);
      const text = await res.text().catch(() => '');
      messages.push({
        messageId: typeof bp.MessageId === 'string' ? bp.MessageId : undefined,
        sequenceNumber: typeof bp.SequenceNumber === 'number' ? bp.SequenceNumber : (bp.SequenceNumber != null ? Number(bp.SequenceNumber) : undefined),
        label: typeof bp.Label === 'string' ? bp.Label : undefined,
        enqueuedTime: typeof bp.EnqueuedTimeUtc === 'string' ? bp.EnqueuedTimeUtc : undefined,
        deliveryCount: typeof bp.DeliveryCount === 'number' ? bp.DeliveryCount : undefined,
        contentType: res.headers.get('content-type') || undefined,
        body: decodeBody(text, res.headers.get('content-type')),
      });
      if (lockUri) lockUris.push(lockUri);
    }
  } finally {
    // Release every lock (Unlock) so the peek is non-destructive — best-effort.
    await Promise.all(
      lockUris.map(async (uri) => {
        try {
          await fetchWithTimeout(uri, { method: 'PUT', headers: { authorization: `Bearer ${token}` } });
        } catch { /* best-effort unlock */ }
      }),
    );
  }

  return { ok: true, entity: ent, messages };
}

/** Re-export the shared config gate so the BFF route can 503 consistently. */
export { servicebusConfigGate };
