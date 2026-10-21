/**
 * ARM read throttling on the estate STATE path (live defect, 2026-10-20:
 * SubscriptionRequestsThrottled on the AAS read left the panel unable to say
 * what it stopped).
 *
 * These cases run the REAL `createArmActuator` over the REAL `arm-client`
 * (`armGetWithRetry` included) with only the wire (`global.fetch`) and the
 * credential stubbed - so they exercise the retry the actuator actually uses,
 * not a mock of it. Each `it` names the input that breaks it.
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

import { createArmActuator } from '../pause-actuator';
import {
  ESTATE_READ_RETRY,
  holdStateForThrottle,
  isThrottleError,
  shortCircuitedError,
} from '../pause-throttle';
import { cachedStateRead, clearStateCache, stateCacheTtlMs, __setStateCacheClock } from '../estate-state-cache';

const AAS = {
  resourceId: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.AnalysisServices/servers/aasloomx',
  resourceType: 'microsoft.analysisservices/servers',
  name: 'aasloomx',
};
const ADX = {
  resourceId: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Kusto/clusters/adxloomx',
  resourceType: 'microsoft.kusto/clusters',
  name: 'adxloomx',
};

const realFetch = global.fetch;
type Wire = { status: number; body?: unknown; retryAfter?: string };
/** Each call shifts one response; the LAST repeats forever. Returns the recorded URLs. */
function wire(responses: Wire[]) {
  const q = [...responses];
  const urls: string[] = [];
  global.fetch = vi.fn(async (url: unknown) => {
    urls.push(String(url));
    const next = q.length > 1 ? q.shift()! : q[0];
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: {
        'content-type': 'application/json',
        ...(next.retryAfter !== undefined ? { 'retry-after': next.retryAfter } : {}),
      },
    });
  }) as never;
  return urls;
}
const throttle: Wire = {
  status: 429,
  retryAfter: '0',
  body: { error: { code: 'SubscriptionRequestsThrottled', message: 'Number of read requests exceeded' } },
};

beforeEach(() => { vi.clearAllMocks(); clearStateCache(); });
afterEach(() => { global.fetch = realFetch; __setStateCacheClock(null); });

describe('readPower - state-path reads use the 429-aware GET', () => {
  it('a read that 429s TWICE then succeeds returns the state (breaks at 1 call + reading:null if the read is single-shot)', async () => {
    const urls = wire([throttle, throttle, { status: 200, body: { sku: { name: 'S1' }, properties: { state: 'Paused' } } }]);
    const actuator = await createArmActuator();
    const r = await actuator.readPower(AAS);
    expect(urls).toHaveLength(3);
    expect(r.reading).not.toBeNull();
    expect(r.reading?.powerState).toBe('Paused');
    expect(r.throttled).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it('a read that STAYS 429 returns reading:null + throttled:true with an honest throttled error (never a state)', async () => {
    const urls = wire([throttle]);
    const actuator = await createArmActuator();
    const r = await actuator.readPower(AAS);
    // Bounded by the shared budget: breaks (unbounded loop) if maxAttempts is ignored.
    expect(urls).toHaveLength(ESTATE_READ_RETRY.maxAttempts);
    expect(r.reading).toBeNull();
    expect(r.throttled).toBe(true);
    expect(r.error).toMatch(/throttled \(429\)/);
    expect(r.error).toMatch(/Nothing was read/);
  });

  it('a NON-429 failure (503) is not flagged throttled and is not retried (breaks if every error is called a throttle)', async () => {
    const urls = wire([{ status: 503, body: { error: { code: 'ServiceUnavailable' } } }]);
    const actuator = await createArmActuator();
    const r = await actuator.readPower(AAS);
    expect(urls).toHaveLength(1);
    expect(r.reading).toBeNull();
    expect(r.throttled).toBeUndefined();
    expect(r.error).toMatch(/failed 503/);
  });

  it('a Retry-After longer than the 5 s cap fails closed IMMEDIATELY: 1 call, no sleep into a client timeout', async () => {
    const urls = wire([{ status: 429, retryAfter: '10' }]); // the live 429 asked for 10 s
    const actuator = await createArmActuator();
    const t0 = Date.now();
    const r = await actuator.readPower(AAS);
    expect(urls).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.throttled).toBe(true);
    expect(r.error).toMatch(/10s wait/);
  });

  it('once ONE read stays throttled, the next resource in the same poll sends ZERO requests and is flagged throttled', async () => {
    const urls = wire([throttle]);
    const actuator = await createArmActuator();
    await actuator.readPower(AAS);
    const sent = urls.length;
    const second = await actuator.readPower(ADX);
    // Breaks (urls grows by 3) if the breaker is removed: N resources x 3 attempts into a shared quota.
    expect(urls.length).toBe(sent);
    expect(second.reading).toBeNull();
    expect(second.throttled).toBe(true);
    expect(second.error).toMatch(/was NOT sent/);
  });

  it('a FRESH actuator (next request) is not poisoned by the previous one breaker', async () => {
    wire([throttle]);
    await (await createArmActuator()).readPower(AAS);
    const urls = wire([{ status: 200, body: { properties: { state: 'Paused' } } }]);
    const r = await (await createArmActuator()).readPower(AAS);
    expect(urls).toHaveLength(1);
    expect(r.reading?.powerState).toBe('Paused');
  });
});

describe('probeServable - a throttled AAS metadata read is unknown, not a failed probe', () => {
  const entry = {
    ...AAS,
    resourceGroup: 'rg',
    subscriptionId: 's1',
    prePausePowerState: 'Online' as const,
    powerStateSource: 'arm' as const,
    powerStateReadAt: 'T',
    powerStateApiVersion: '2017-08-01',
    ownership: { verdict: 'loom-owned' as const, source: 'ownership-tag' as const, reason: 'tagged' },
  };

  it('the metadata read 429s forever -> servable:false AND throttled:true (breaks if the old bare catch swallows it as "could not be read")', async () => {
    wire([throttle]);
    const actuator = await createArmActuator();
    const probe = await actuator.probeServable(entry as never);
    expect(probe.servable).toBe(false);
    expect(probe.throttled).toBe(true);
  });
});

describe('pause-throttle pure rules', () => {
  it('isThrottleError: the ArmThrottledError name and a bare status 429 are throttles; a 503 and a plain Error are not', () => {
    const named = Object.assign(new Error('x'), { name: 'ArmThrottledError' });
    expect(isThrottleError(named)).toBe(true);
    expect(isThrottleError({ status: 429 })).toBe(true);
    expect(isThrottleError(Object.assign(new Error('x'), { status: 503 }))).toBe(false);
    expect(isThrottleError(new Error('429 appears only in prose'))).toBe(false);
    expect(isThrottleError(null)).toBe(false);
  });

  it('shortCircuitedError is itself classified as a throttle (so a skipped read stays "throttled", not a generic failure)', () => {
    expect(isThrottleError(shortCircuitedError('/p', 'first'))).toBe(true);
  });

  const verdict = (ids: string[]) => ({ state: 'RESUME_FAILED' as const, unconfirmed: ids.map((resourceId) => ({ resourceId })) });
  it.each([
    ['RESUMING', 'RESUMING'],
    ['RESUME_FAILED', 'RESUME_FAILED'],
  ])('holdStateForThrottle: all unconfirmed throttled, stored %s -> %s', (stored, want) => {
    expect(holdStateForThrottle(verdict(['a', 'b']), new Set(['a', 'b']), stored)).toBe(want);
  });
  it('holdStateForThrottle: ONE unconfirmed resource that was not throttled -> null (the failure stands)', () => {
    expect(holdStateForThrottle(verdict(['a', 'b']), new Set(['a']), 'RESUMING')).toBeNull();
  });
  it('holdStateForThrottle: no throttled ids at all -> null; a RUNNING verdict is never touched', () => {
    expect(holdStateForThrottle(verdict(['a']), new Set(), 'RESUMING')).toBeNull();
    expect(holdStateForThrottle({ state: 'RUNNING', unconfirmed: [] }, new Set(['a']), 'RESUMING')).toBeNull();
  });
});

describe('estate state cache', () => {
  it('stateCacheTtlMs: default 10 000; env override honoured; 0 disables; junk and negatives fall back; clamped to 60 000', () => {
    expect(stateCacheTtlMs({} as never)).toBe(10_000);
    expect(stateCacheTtlMs({ LOOM_ESTATE_STATE_CACHE_TTL_MS: '15000' } as never)).toBe(15_000);
    expect(stateCacheTtlMs({ LOOM_ESTATE_STATE_CACHE_TTL_MS: '0' } as never)).toBe(0);
    expect(stateCacheTtlMs({ LOOM_ESTATE_STATE_CACHE_TTL_MS: 'abc' } as never)).toBe(10_000);
    expect(stateCacheTtlMs({ LOOM_ESTATE_STATE_CACHE_TTL_MS: '-5' } as never)).toBe(10_000);
    expect(stateCacheTtlMs({ LOOM_ESTATE_STATE_CACHE_TTL_MS: '999999' } as never)).toBe(60_000);
  });

  it('cacheable:false results are never stored (a gate/mutation-shaped result cannot be replayed)', async () => {
    const read = vi.fn(async () => ({ cacheable: false, value: 'v' }));
    await cachedStateRead('k', read, 10_000);
    await cachedStateRead('k', read, 10_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a REJECTED read is not cached: the next call retries (breaks at 1 call if the failure is stored)', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ cacheable: true, value: 'ok' });
    await expect(cachedStateRead('k2', read, 10_000)).rejects.toThrow('boom');
    expect(await cachedStateRead('k2', read, 10_000)).toBe('ok');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('TTL 0 still collapses truly concurrent reads (single-flight) but stores nothing afterwards', async () => {
    const read = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { cacheable: true, value: 'v' };
    });
    await Promise.all([cachedStateRead('k3', read, 0), cachedStateRead('k3', read, 0), cachedStateRead('k3', read, 0)]);
    expect(read).toHaveBeenCalledTimes(1);
    await cachedStateRead('k3', read, 0);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('different keys (tenants) do not share a verdict', async () => {
    const read = vi.fn(async () => ({ cacheable: true, value: 'v' }));
    await cachedStateRead('tenant-a|std', read, 10_000);
    await cachedStateRead('tenant-b|std', read, 10_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
