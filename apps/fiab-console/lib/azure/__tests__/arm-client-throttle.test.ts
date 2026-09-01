/**
 * #4243 — `armGetWithRetry`: the OPT-IN 429 retry the estate pause path uses.
 *
 * Two properties under test, and they are different properties:
 *
 *   1. The wrapper retries a 429 with a bounded budget, honoring `Retry-After`
 *      when ARM sends one, and FAILS CLOSED as `ArmThrottledError` (whose
 *      message says "throttled") on exhaustion — deploy-integrity R6/R7.
 *   2. The DEFAULT transport (`armGet`) does NOT retry. arm-client is shared
 *      by dozens of consumers with their own pacing; the retry is opt-in by
 *      contract, and this suite pins that contract so it cannot be flipped on
 *      quietly for every caller.
 *
 * Stubs @azure/identity + the ACA MI credential + global.fetch — no live
 * tenant, same pattern as arm-deployments-client.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { AcaManagedIdentityCredential: Cred };
});

import { armGet, armGetWithRetry, ArmThrottledError } from '../arm-client';

const PATH = '/subscriptions/s/resourceGroups/r/providers/Microsoft.Kusto/clusters/adx?api-version=2023-08-15';

const realFetch = global.fetch;
/** Queue of responses; each call shifts one. The LAST repeats forever. */
function queueFetch(responses: Array<{ status: number; body?: unknown; retryAfter?: string }>) {
  const q = [...responses];
  const calls: string[] = [];
  global.fetch = vi.fn(async (url: unknown) => {
    calls.push(String(url));
    const next = q.length > 1 ? q.shift()! : q[0];
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: {
        'content-type': 'application/json',
        ...(next.retryAfter !== undefined ? { 'retry-after': next.retryAfter } : {}),
      },
    });
  }) as never;
  return calls;
}
/** Records sleeps instead of sleeping — the retry schedule is the assertion. */
function sleepRecorder() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => { slept.push(ms); } };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { global.fetch = realFetch; });

describe('armGetWithRetry — bounded 429 retry honoring Retry-After', () => {
  it('a transient 429 with Retry-After: 1 is retried after ~1000ms and then succeeds', async () => {
    const calls = queueFetch([
      { status: 429, retryAfter: '1' },
      { status: 200, body: { tags: { 'loom-estate-id': 'loom:x' } } },
    ]);
    const { slept, sleep } = sleepRecorder();
    const body = await armGetWithRetry<{ tags: Record<string, string> }>(PATH, { sleep });
    expect(body.tags['loom-estate-id']).toBe('loom:x');
    // The retry actually happened, and it honored the header, not a guess.
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([1000]);
  });

  it('a MISSING Retry-After falls back to bounded exponential backoff', async () => {
    const calls = queueFetch([
      { status: 429 },
      { status: 429 },
      { status: 200, body: { ok: true } },
    ]);
    const { slept, sleep } = sleepRecorder();
    await armGetWithRetry(PATH, { sleep });
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([1000, 2000]);
  });

  it('a SUSTAINED 429 fails closed as ArmThrottledError whose message says THROTTLED — never a success, never a different claim', async () => {
    const calls = queueFetch([{ status: 429, retryAfter: '2' }]);
    const { sleep } = sleepRecorder();
    const err = await armGetWithRetry(PATH, { sleep }).catch((e) => e);
    expect(err).toBeInstanceOf(ArmThrottledError);
    expect((err as ArmThrottledError).status).toBe(429);
    expect((err as ArmThrottledError).message).toMatch(/throttled \(429\)/);
    expect((err as ArmThrottledError).message).toMatch(/Nothing was read/);
    expect((err as ArmThrottledError).retryAfterSeconds).toBe(2);
    // Bounded: default 3 attempts, no more.
    expect(calls).toHaveLength(3);
  });

  it('a Retry-After LONGER than the delay budget fails closed IMMEDIATELY instead of sleeping out the penalty', async () => {
    const calls = queueFetch([{ status: 429, retryAfter: '600' }]);
    const { slept, sleep } = sleepRecorder();
    const err = await armGetWithRetry(PATH, { sleep, maxDelayMs: 10_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(ArmThrottledError);
    expect((err as ArmThrottledError).retryAfterSeconds).toBe(600);
    // No sleep, one request: the route budget is not spent waiting on ARM's 600s.
    expect(slept).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('a NON-429 failure behaves exactly like armGet — same error text, no retry', async () => {
    const calls = queueFetch([{ status: 403, body: { error: 'forbidden' } }]);
    const err = await armGetWithRetry(PATH).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ArmThrottledError);
    expect((err as Error).message).toMatch(/^ARM GET .* failed 403/);
    expect(calls).toHaveLength(1);
  });
});

describe('the DEFAULT transport does NOT retry — the opt-in contract (#4243 blast-radius rule)', () => {
  it('armGet throws on the FIRST 429; no second request is ever issued', async () => {
    const calls = queueFetch([
      { status: 429, retryAfter: '1' },
      { status: 200, body: { wouldHaveSucceeded: true } },
    ]);
    const err = await armGet(PATH).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/failed 429/);
    // The load-bearing assertion: exactly ONE request. Making the default
    // path retry would silently multiply call volume for every arm-client
    // consumer — the very ARM-budget pressure that caused #4243.
    expect(calls).toHaveLength(1);
  });
});
