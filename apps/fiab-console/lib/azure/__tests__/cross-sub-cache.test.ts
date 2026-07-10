/**
 * Unit tests for the cross-sub discovery SWR memo (lib/azure/cross-sub-cache).
 * Covers the fresh/stale/pending state machine, the await-cold-miss helper, oid
 * isolation, the default-ON disable switch, and the "failures are not cached"
 * contract that keeps the retry loop honest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { swr, swrAwait, bustCrossSubCache, crossSubCacheEnabled } from '../cross-sub-cache';

const OID = 'oid-a';

beforeEach(() => {
  bustCrossSubCache();
  delete process.env.LOOM_SETUP_DISCOVERY_CACHE_DISABLED;
});

afterEach(() => {
  bustCrossSubCache();
  vi.restoreAllMocks();
});

describe('cross-sub-cache', () => {
  it('is enabled by default and disabled only by the explicit env flag', () => {
    expect(crossSubCacheEnabled()).toBe(true);
    process.env.LOOM_SETUP_DISCOVERY_CACHE_DISABLED = '1';
    expect(crossSubCacheEnabled()).toBe(false);
  });

  it('a cold key returns pending (value null) then serves fresh once resolved', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return ['row'];
    };
    const first = await swr(OID, 'k', { ttlMs: 60_000 }, fn);
    expect(first.state).toBe('pending');
    expect(first.value).toBeNull();
    // The revalidate the cold read kicked resolves on the next tick.
    await new Promise((r) => setTimeout(r, 5));
    const second = await swr(OID, 'k', { ttlMs: 60_000 }, fn);
    expect(second.state).toBe('fresh');
    expect(second.value).toEqual(['row']);
    expect(calls).toBe(1); // second read served from cache, not a re-run
  });

  it('swrAwait blocks on a cold miss and returns the resolved value', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return 42;
    };
    const r = await swrAwait(OID, 'k', { ttlMs: 60_000 }, fn);
    expect(r.value).toBe(42);
    expect(calls).toBe(1);
    // A second await is a warm hit (fresh) — no re-run.
    const r2 = await swrAwait(OID, 'k', { ttlMs: 60_000 }, fn);
    expect(r2.value).toBe(42);
    expect(calls).toBe(1);
  });

  it('serves stale past ttl and kicks a single background revalidate', async () => {
    let value = 1;
    const fn = async () => value;
    await swrAwait(OID, 'k', { ttlMs: 10, staleMs: 10_000 }, fn);
    // Age the entry past ttl.
    await new Promise((r) => setTimeout(r, 20));
    value = 2;
    const stale = await swr(OID, 'k', { ttlMs: 10, staleMs: 10_000 }, fn);
    expect(stale.state).toBe('stale');
    expect(stale.value).toBe(1); // served the old value immediately
    // Background revalidate updates the slot.
    await new Promise((r) => setTimeout(r, 0));
    const refreshed = await swr(OID, 'k', { ttlMs: 10, staleMs: 10_000 }, fn);
    expect(refreshed.value).toBe(2);
  });

  it('isolates entries per oid — one user never reads another’s rows', async () => {
    await swrAwait('oid-a', 'k', { ttlMs: 60_000 }, async () => 'A');
    const bColdKick = await swr('oid-b', 'k', { ttlMs: 60_000 }, async () => 'B');
    expect(bColdKick.state).toBe('pending'); // b's key is cold despite a's hit
    const b = await swrAwait('oid-b', 'k', { ttlMs: 60_000 }, async () => 'B');
    expect(b.value).toBe('B');
    const a = await swr('oid-a', 'k', { ttlMs: 60_000 }, async () => 'A2');
    expect(a.value).toBe('A'); // a's original cached value, untouched by b
  });

  it('passes through (awaits fn) when the cache is disabled', async () => {
    process.env.LOOM_SETUP_DISCOVERY_CACHE_DISABLED = '1';
    let calls = 0;
    const fn = async () => {
      calls++;
      return 'live';
    };
    const r1 = await swr(OID, 'k', { ttlMs: 60_000 }, fn);
    const r2 = await swr(OID, 'k', { ttlMs: 60_000 }, fn);
    expect(r1.value).toBe('live');
    expect(r2.value).toBe('live');
    expect(calls).toBe(2); // no memoization while disabled
  });

  it('does not cache a failed revalidate — a later read stays cold and retries', async () => {
    let attempt = 0;
    const fn = async () => {
      attempt++;
      if (attempt === 1) throw new Error('cold fail');
      return 'ok';
    };
    // Cold read kicks a revalidate that FAILS; the failure evicts the slot.
    const r1 = await swr(OID, 'k', { ttlMs: 60_000 }, fn);
    expect(r1.state).toBe('pending');
    await new Promise((r) => setTimeout(r, 5));
    // Still cold (a failure is never cached) → a second read is pending again and
    // kicks a fresh attempt, rather than serving a stuck/negative value.
    const r2 = await swr(OID, 'k', { ttlMs: 60_000 }, fn);
    expect(r2.state).toBe('pending');
    await new Promise((r) => setTimeout(r, 5));
    const r3 = await swr(OID, 'k', { ttlMs: 60_000 }, fn);
    expect(r3.state).toBe('fresh');
    expect(r3.value).toBe('ok');
    expect(attempt).toBe(2);
  });
});
