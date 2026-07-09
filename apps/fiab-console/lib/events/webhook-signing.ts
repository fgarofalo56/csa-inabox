/**
 * Pure webhook delivery logic (BR-WEBHOOK) — HMAC-SHA256 signing/verify,
 * retry/backoff schedule, and event-type filtering. NO Cosmos, NO fetch, NO
 * process.env: every function here is deterministic and unit-tested so the
 * security-critical signing and the retry policy can be reasoned about in
 * isolation.
 *
 * Signature scheme (GitHub / Stripe / Azure Event Grid style):
 *   - The signed payload is `${timestamp}.${rawBody}` (timestamp bound in so a
 *     captured body can't be replayed with a new time).
 *   - `X-Loom-Signature: sha256=<hex>` where hex = HMAC_SHA256(secret, signed).
 *   - `X-Loom-Timestamp: <unix-seconds>` and `X-Loom-Event: <type>` accompany it.
 *   Receivers recompute the HMAC over `${X-Loom-Timestamp}.${rawBody}` with the
 *   shared secret and constant-time compare — {@link verifyWebhookSignature}
 *   does exactly that, so a subscriber can copy it.
 */

import crypto from 'node:crypto';

export const SIGNATURE_HEADER = 'x-loom-signature';
export const TIMESTAMP_HEADER = 'x-loom-timestamp';
export const EVENT_HEADER = 'x-loom-event';
export const DELIVERY_ID_HEADER = 'x-loom-delivery-id';

/**
 * Compute the `sha256=<hex>` signature for a webhook body. `timestamp` is unix
 * seconds; the HMAC is taken over `${timestamp}.${body}`.
 */
export function computeWebhookSignature(secret: string, body: string, timestamp: number): string {
  const mac = crypto.createHmac('sha256', secret);
  mac.update(`${timestamp}.${body}`, 'utf8');
  return `sha256=${mac.digest('hex')}`;
}

/**
 * Constant-time verify of a `sha256=<hex>` signature against the body+timestamp.
 * Optionally rejects a timestamp older/newer than `toleranceSecs` (replay
 * window; 0 disables the freshness check). Returns false on any malformed input
 * rather than throwing, so a receiver can treat it as a boolean gate.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  timestamp: number,
  signature: string,
  toleranceSecs = 300,
  nowSecs: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || !signature || !Number.isFinite(timestamp)) return false;
  if (toleranceSecs > 0 && Math.abs(nowSecs - timestamp) > toleranceSecs) return false;
  const expected = computeWebhookSignature(secret, body, timestamp);
  // Lengths must match for timingSafeEqual; compare as bytes.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Exponential backoff schedule (in ms) for delivery attempt N (1-based).
 * attempt 1 → 0 (immediate), 2 → base, 3 → base*factor, 4 → base*factor²…
 * capped at `capMs`, with deterministic full-jitter DISABLED here (jitter is a
 * runtime concern; the schedule itself is pure so it can be asserted).
 */
export function backoffDelayMs(
  attempt: number,
  { baseMs = 1000, factor = 3, capMs = 60_000 }: { baseMs?: number; factor?: number; capMs?: number } = {},
): number {
  if (attempt <= 1) return 0;
  const raw = baseMs * Math.pow(factor, attempt - 2);
  return Math.min(capMs, Math.round(raw));
}

/** Total attempts for a delivery = 1 initial + `maxRetries`. */
export const DEFAULT_MAX_RETRIES = 4;

/**
 * Whether an HTTP status warrants a retry. 2xx = delivered (no retry). 4xx
 * (except 408/429) = permanent client error, do NOT retry — retrying a 400
 * signature-rejected endpoint just hammers it. 408/429/5xx/network(0) = retry.
 */
export function isRetriableStatus(status: number): boolean {
  if (status >= 200 && status < 300) return false;
  if (status === 408 || status === 429) return true;
  if (status >= 400 && status < 500) return false;
  return true; // 5xx, 0 (network error), and anything else transient
}

/** Delivery is successful iff the endpoint returned a 2xx. */
export function isDeliverySuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Event-type filtering: does a hook subscribed to `subscribed` want `eventType`?
 * A hook with an empty subscription list receives NOTHING (explicit opt-in —
 * an accidental empty select must not silently fan every event out). A hook may
 * subscribe to the wildcard `'*'` to receive every subscribable event.
 */
export function hookWantsEvent(subscribed: readonly string[] | undefined, eventType: string): boolean {
  if (!subscribed || subscribed.length === 0) return false;
  if (subscribed.includes('*')) return true;
  return subscribed.includes(eventType);
}

/**
 * Given the full set of registered hooks for a tenant, return the ones that
 * should receive `eventType` — enabled AND subscribed. Pure; the emitter feeds
 * it the loaded registrations.
 */
export function selectHooksForEvent<T extends { enabled?: boolean; events: readonly string[] }>(
  hooks: readonly T[],
  eventType: string,
): T[] {
  return hooks.filter((h) => h.enabled !== false && hookWantsEvent(h.events, eventType));
}
