/**
 * Outbound webhook emitter (BR-WEBHOOK).
 *
 * `emitLoomEvent(evt)` is the single fire-and-forget entry point every choke
 * point calls. It:
 *   1. loads the tenant's enabled hooks subscribed to `evt.type`
 *      ({@link selectHooksForEvent}),
 *   2. delivers a signed JSON envelope to each — DIRECT HTTPS POST with an
 *      HMAC-SHA256 signature header + exponential-backoff retry (the zero-infra
 *      DEFAULT, per default-ON), OR through an Azure Event Grid custom topic
 *      when `LOOM_EVENTGRID_TOPIC_ENDPOINT` is set (opt-in alternative,
 *      honest-gated),
 *   3. records each delivery in the capped per-hook log.
 *
 * NEVER throws and NEVER blocks the caller — a mutation route calls it with a
 * bare `void emitLoomEvent({...})` after its Cosmos write, exactly like the
 * BR-SIEM `emitAuditEvent`. Delivery runs on a detached microtask.
 */

import crypto from 'node:crypto';
import type { LoomEventType } from '@/lib/events/event-types';
import { WEBHOOK_TEST_EVENT } from '@/lib/events/event-types';
import {
  computeWebhookSignature,
  backoffDelayMs,
  isDeliverySuccess,
  isRetriableStatus,
  selectHooksForEvent,
  DEFAULT_MAX_RETRIES,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  EVENT_HEADER,
  DELIVERY_ID_HEADER,
} from '@/lib/events/webhook-signing';
import {
  listHooks,
  recordDelivery,
  bumpHookStats,
  type WebhookRegistration,
  type WebhookDelivery,
} from '@/lib/events/webhook-registry';

export interface LoomEvent {
  /** Event type (or the system `webhook.test`). */
  type: LoomEventType | typeof WEBHOOK_TEST_EVENT;
  /** Tenant whose hooks should receive this (session `claims.oid`/`tid`). */
  tenantId: string;
  /** Stable id of the subject (item id / workspace id / data-product id …). */
  subject?: string;
  /** Human label of the subject, for the receiver's convenience. */
  subjectName?: string;
  /** Structured payload — serialised into the envelope `data`. */
  data?: Record<string, unknown>;
  /** Acting principal (oid/upn), when known. */
  actor?: { oid?: string; upn?: string };
}

/** The signed JSON envelope POSTed to a subscriber. */
export interface WebhookEnvelope {
  id: string;
  type: string;
  tenantId: string;
  subject?: string;
  subjectName?: string;
  actor?: { oid?: string; upn?: string };
  data: Record<string, unknown>;
  createdAt: string;
}

const EVENTGRID_DELIVERY_TIMEOUT_MS = 8000;
const DIRECT_DELIVERY_TIMEOUT_MS = 8000;

let warnedNoEventGrid = false;

/** Event Grid custom-topic config, or null (direct delivery is the default). */
export function eventGridConfig(): { endpoint: string; key: string } | null {
  const endpoint = (process.env.LOOM_EVENTGRID_TOPIC_ENDPOINT || '').trim();
  const key = (process.env.LOOM_EVENTGRID_TOPIC_KEY || '').trim();
  if (!endpoint || !key) {
    if (!warnedNoEventGrid && (endpoint || key)) {
      warnedNoEventGrid = true;
      // Partial config — one-time hint. (Fully-unset is the silent default.)
      // eslint-disable-next-line no-console
      console.debug(
        '[webhook] Event Grid fan-out needs BOTH LOOM_EVENTGRID_TOPIC_ENDPOINT and ' +
          'LOOM_EVENTGRID_TOPIC_KEY. Direct HTTPS delivery (the zero-infra default) is used.',
      );
    }
    return null;
  }
  return { endpoint, key };
}

function buildEnvelope(evt: LoomEvent): WebhookEnvelope {
  return {
    id: crypto.randomUUID(),
    type: evt.type,
    tenantId: evt.tenantId,
    ...(evt.subject ? { subject: evt.subject } : {}),
    ...(evt.subjectName ? { subjectName: evt.subjectName } : {}),
    ...(evt.actor ? { actor: evt.actor } : {}),
    data: evt.data ?? {},
    createdAt: new Date().toISOString(),
  };
}

/**
 * Deliver one envelope to one hook via DIRECT HTTPS POST with HMAC signing +
 * exponential-backoff retry. Returns the terminal delivery record. Exported for
 * the unit test of the retry/status handling (fetch is injectable).
 */
export async function deliverDirect(
  hook: Pick<WebhookRegistration, 'id' | 'tenantId' | 'url' | 'secret'>,
  envelope: WebhookEnvelope,
  opts: {
    maxRetries?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    backoff?: { baseMs?: number; factor?: number; capMs?: number };
  } = {},
): Promise<WebhookDelivery> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const body = JSON.stringify(envelope);
  const start = Date.now();

  let attempts = 0;
  let lastStatus = 0;
  let snippet = '';

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const wait = backoffDelayMs(attempt, opts.backoff);
    if (wait > 0) await sleep(wait);
    attempts = attempt;
    const ts = Math.floor(Date.now() / 1000);
    const signature = computeWebhookSignature(hook.secret, body, ts);
    try {
      const res = await doFetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [EVENT_HEADER]: envelope.type,
          [TIMESTAMP_HEADER]: String(ts),
          [SIGNATURE_HEADER]: signature,
          [DELIVERY_ID_HEADER]: envelope.id,
          'User-Agent': 'CSA-Loom-Webhook/1',
        },
        body,
        signal: AbortSignal.timeout(DIRECT_DELIVERY_TIMEOUT_MS),
      });
      lastStatus = res.status;
      snippet = (await res.text().catch(() => '')).slice(0, 300);
      if (isDeliverySuccess(res.status)) break;
      if (!isRetriableStatus(res.status)) break;
    } catch (e: any) {
      lastStatus = 0;
      snippet = String(e?.message || e).slice(0, 300);
      // network/timeout → retriable; loop continues
    }
  }

  return {
    id: envelope.id,
    webhookId: hook.id,
    tenantId: hook.tenantId,
    eventType: envelope.type,
    outcome: isDeliverySuccess(lastStatus) ? 'delivered' : 'failed',
    status: lastStatus,
    attempts,
    transport: 'direct',
    responseSnippet: snippet || undefined,
    durationMs: Date.now() - start,
    at: new Date().toISOString(),
  };
}

/**
 * Deliver one envelope via an Azure Event Grid custom topic (opt-in). Posts a
 * single Event Grid schema event authenticated with the topic access key
 * (`aeg-sas-key` header) — no RBAC role required. The subscriber's real webhook
 * is wired downstream by an Event Grid event subscription (their concern).
 */
export async function deliverEventGrid(
  hook: Pick<WebhookRegistration, 'id' | 'tenantId' | 'url'>,
  envelope: WebhookEnvelope,
  cfg: { endpoint: string; key: string },
  fetchImpl: typeof fetch = fetch,
): Promise<WebhookDelivery> {
  const start = Date.now();
  const egEvent = [
    {
      id: envelope.id,
      eventType: `Loom.${envelope.type}`,
      subject: `/tenants/${envelope.tenantId}/${envelope.subject ?? envelope.type}`,
      eventTime: envelope.createdAt,
      dataVersion: '1.0',
      data: { ...envelope, deliveryUrl: hook.url },
    },
  ];
  let status = 0;
  let snippet = '';
  try {
    const res = await fetchImpl(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'aeg-sas-key': cfg.key },
      body: JSON.stringify(egEvent),
      signal: AbortSignal.timeout(EVENTGRID_DELIVERY_TIMEOUT_MS),
    });
    status = res.status;
    snippet = (await res.text().catch(() => '')).slice(0, 300);
  } catch (e: any) {
    status = 0;
    snippet = String(e?.message || e).slice(0, 300);
  }
  return {
    id: envelope.id,
    webhookId: hook.id,
    tenantId: hook.tenantId,
    eventType: envelope.type,
    outcome: isDeliverySuccess(status) ? 'delivered' : 'failed',
    status,
    attempts: 1,
    transport: 'eventgrid',
    responseSnippet: snippet || undefined,
    durationMs: Date.now() - start,
    at: new Date().toISOString(),
  };
}

/**
 * Deliver an envelope to a single hook via the configured transport and log the
 * result. Exported so the per-hook "test fire" route can await one delivery.
 */
export async function deliverToHook(
  hook: WebhookRegistration,
  envelope: WebhookEnvelope,
): Promise<WebhookDelivery> {
  const eg = eventGridConfig();
  const delivery = eg
    ? await deliverEventGrid(hook, envelope, eg)
    : await deliverDirect(hook, envelope);
  await recordDelivery(delivery).catch(() => {});
  await bumpHookStats(hook.tenantId, hook.id, delivery.outcome, delivery.status);
  return delivery;
}

/**
 * Fire-and-forget fan-out of a Loom event to every subscribed, enabled hook.
 * NEVER throws / blocks. Returns void immediately; delivery happens detached.
 */
export function emitLoomEvent(evt: LoomEvent): void {
  try {
    if (!evt?.tenantId || !evt?.type) return;
    void (async () => {
      try {
        const hooks = await listHooks(evt.tenantId);
        const targets = selectHooksForEvent(hooks, evt.type);
        if (targets.length === 0) return;
        const envelope = buildEnvelope(evt);
        // Deliver in parallel; each hook's own errors are caught in deliverToHook.
        await Promise.all(
          targets.map((h) =>
            deliverToHook(h, { ...envelope, id: crypto.randomUUID() }).catch(() => {}),
          ),
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[webhook] fan-out failed:', (e as Error)?.message || e);
      }
    })();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[webhook] emit failed:', (e as Error)?.message || e);
  }
}
