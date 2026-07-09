import { describe, it, expect } from 'vitest';
import {
  computeWebhookSignature,
  verifyWebhookSignature,
  backoffDelayMs,
  isRetriableStatus,
  isDeliverySuccess,
  hookWantsEvent,
  selectHooksForEvent,
  DEFAULT_MAX_RETRIES,
} from '../webhook-signing';

/**
 * BR-WEBHOOK — pure delivery logic. These are the security-critical + policy
 * functions (HMAC signing/verify, retry policy, event filtering) so they are
 * exhaustively unit-tested in isolation (no fetch, no Cosmos).
 */

describe('HMAC-SHA256 signing / verify', () => {
  const secret = 'super-secret-key';
  const body = JSON.stringify({ type: 'item.created', id: 'abc' });
  const ts = 1_800_000_000;

  it('produces a stable sha256=<hex> signature', () => {
    const sig = computeWebhookSignature(secret, body, ts);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    // deterministic
    expect(computeWebhookSignature(secret, body, ts)).toBe(sig);
  });

  it('binds the timestamp into the signature (replay resistance)', () => {
    const a = computeWebhookSignature(secret, body, ts);
    const b = computeWebhookSignature(secret, body, ts + 1);
    expect(a).not.toBe(b);
  });

  it('verifies a correct signature within the tolerance window', () => {
    const sig = computeWebhookSignature(secret, body, ts);
    expect(verifyWebhookSignature(secret, body, ts, sig, 300, ts + 10)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = computeWebhookSignature(secret, body, ts);
    expect(verifyWebhookSignature(secret, body + 'x', ts, sig, 300, ts)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const sig = computeWebhookSignature(secret, body, ts);
    expect(verifyWebhookSignature('other', body, ts, sig, 300, ts)).toBe(false);
  });

  it('rejects a stale timestamp outside the replay window', () => {
    const sig = computeWebhookSignature(secret, body, ts);
    expect(verifyWebhookSignature(secret, body, ts, sig, 300, ts + 10_000)).toBe(false);
  });

  it('skips the freshness check when tolerance is 0', () => {
    const sig = computeWebhookSignature(secret, body, ts);
    expect(verifyWebhookSignature(secret, body, ts, sig, 0, ts + 10_000)).toBe(true);
  });

  it('returns false on malformed input rather than throwing', () => {
    expect(verifyWebhookSignature('', body, ts, 'sha256=x')).toBe(false);
    expect(verifyWebhookSignature(secret, body, NaN, 'sha256=x')).toBe(false);
    expect(verifyWebhookSignature(secret, body, ts, 'wrong-length')).toBe(false);
  });
});

describe('exponential backoff schedule', () => {
  it('attempt 1 is immediate (0ms)', () => {
    expect(backoffDelayMs(1)).toBe(0);
  });
  it('grows by the factor each attempt', () => {
    expect(backoffDelayMs(2, { baseMs: 1000, factor: 3 })).toBe(1000);
    expect(backoffDelayMs(3, { baseMs: 1000, factor: 3 })).toBe(3000);
    expect(backoffDelayMs(4, { baseMs: 1000, factor: 3 })).toBe(9000);
  });
  it('caps at capMs', () => {
    expect(backoffDelayMs(10, { baseMs: 1000, factor: 3, capMs: 60_000 })).toBe(60_000);
  });
});

describe('retry + success status policy', () => {
  it('2xx = success, not retriable', () => {
    for (const s of [200, 201, 202, 204]) {
      expect(isDeliverySuccess(s)).toBe(true);
      expect(isRetriableStatus(s)).toBe(false);
    }
  });
  it('4xx (except 408/429) = permanent, do not retry', () => {
    for (const s of [400, 401, 403, 404, 422]) expect(isRetriableStatus(s)).toBe(false);
  });
  it('408 / 429 / 5xx / network(0) = retriable', () => {
    for (const s of [408, 429, 500, 502, 503, 0]) expect(isRetriableStatus(s)).toBe(true);
  });
  it('exposes the default retry count', () => {
    expect(DEFAULT_MAX_RETRIES).toBe(4);
  });
});

describe('event-type filtering', () => {
  it('empty subscription list receives nothing (explicit opt-in)', () => {
    expect(hookWantsEvent([], 'item.created')).toBe(false);
    expect(hookWantsEvent(undefined, 'item.created')).toBe(false);
  });
  it('matches an exact subscribed type', () => {
    expect(hookWantsEvent(['item.created', 'workspace.deleted'], 'item.created')).toBe(true);
    expect(hookWantsEvent(['item.created'], 'item.deleted')).toBe(false);
  });
  it('wildcard receives every event', () => {
    expect(hookWantsEvent(['*'], 'marketplace.sla.breached')).toBe(true);
  });
  it('selectHooksForEvent filters by enabled AND subscription', () => {
    const hooks = [
      { id: 'a', enabled: true, events: ['item.created'] },
      { id: 'b', enabled: false, events: ['item.created'] }, // disabled
      { id: 'c', enabled: true, events: ['*'] },
      { id: 'd', enabled: true, events: ['workspace.created'] }, // not subscribed
      { id: 'e', events: ['item.created'] }, // enabled undefined = on
    ];
    const got = selectHooksForEvent(hooks, 'item.created').map((h) => h.id);
    expect(got).toEqual(['a', 'c', 'e']);
  });
});
