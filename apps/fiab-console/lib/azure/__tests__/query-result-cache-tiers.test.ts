/**
 * Tests for the PSR-5 additions to query-result-cache: per-backend TTL
 * resolution, the env-token normalizer, and backend inclusion in the cache key.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backendEnvToken,
  ttlMsForBackend,
  resolveBackendTtl,
  buildQueryCacheKey,
  buildScopedCacheKey,
  getOrComputeCached,
  _awaitBackgroundRefreshes,
} from '../query-result-cache';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Unique key per test so the module-global in-process store never cross-contaminates. */
let n = 0;
const uniqueScope = () => `test-scope-${Date.now()}-${n++}`;

const ORIG = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG };
});

describe('backendEnvToken', () => {
  it('uppercases and strips to A-Z0-9_', () => {
    expect(backendEnvToken('serverless')).toBe('SERVERLESS');
    expect(backendEnvToken('analysis-services')).toBe('ANALYSIS_SERVICES');
    expect(backendEnvToken('loom native!')).toBe('LOOM_NATIVE');
  });
  it('returns empty for undefined', () => {
    expect(backendEnvToken(undefined)).toBe('');
  });
});

describe('ttlMsForBackend', () => {
  it('prefers the per-backend env override', () => {
    process.env.LOOM_QUERY_CACHE_TTL_MS = '60000';
    process.env.LOOM_QUERY_CACHE_TTL_MS_DEDICATED = '300000';
    expect(ttlMsForBackend('dedicated')).toBe(300000);
  });
  it('falls back to the generic TTL when no per-backend override', () => {
    process.env.LOOM_QUERY_CACHE_TTL_MS = '45000';
    delete process.env.LOOM_QUERY_CACHE_TTL_MS_SERVERLESS;
    expect(ttlMsForBackend('serverless')).toBe(45000);
  });
  it('defaults to 60s when nothing is set', () => {
    delete process.env.LOOM_QUERY_CACHE_TTL_MS;
    expect(ttlMsForBackend()).toBe(60000);
  });
});

describe('buildQueryCacheKey backend isolation', () => {
  it('produces different keys for different backends', () => {
    const base = { modelId: 'm1', sql: 'SELECT 1', storageMode: 'x' };
    const a = buildQueryCacheKey({ ...base, backend: 'serverless' });
    const b = buildQueryCacheKey({ ...base, backend: 'accel' });
    expect(a).not.toBe(b);
  });
  it('is stable for identical parts', () => {
    const parts = { modelId: 'm1', sql: 'SELECT 1', storageMode: 'x', backend: 'adx' };
    expect(buildQueryCacheKey(parts)).toBe(buildQueryCacheKey({ ...parts }));
  });
});

describe('resolveBackendTtl', () => {
  it('prefers the per-backend env override over the caller default', () => {
    process.env.LOOM_QUERY_CACHE_TTL_MS_COSTMGMT = '1200000';
    expect(resolveBackendTtl('costmgmt', 60_000)).toBe(1200000);
  });
  it('keeps the caller default when no env override is set', () => {
    delete process.env.LOOM_QUERY_CACHE_TTL_MS_USAGEROLLUP;
    expect(resolveBackendTtl('usagerollup', 300_000)).toBe(300_000);
  });
});

describe('buildScopedCacheKey', () => {
  it('is stable for identical scope + params and varies otherwise', () => {
    const a = buildScopedCacheKey('chargeback', { tf: 'MonthToDate' });
    const b = buildScopedCacheKey('chargeback', { tf: 'MonthToDate' });
    const c = buildScopedCacheKey('chargeback', { tf: 'Last7Days' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('getOrComputeCached — stale-while-revalidate', () => {
  it('computes inline on a miss and returns fresh metadata', async () => {
    const scope = uniqueScope();
    const key = buildScopedCacheKey(scope, {});
    const compute = vi.fn(async () => ({ v: 1 }));
    const { value, meta } = await getOrComputeCached(key, scope, compute, { ttlMs: 10_000 });
    expect(value).toEqual({ v: 1 });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(meta.stale).toBe(false);
    expect(typeof meta.cachedAt).toBe('number');
  });

  it('serves a fresh cached value without recomputing', async () => {
    const scope = uniqueScope();
    const key = buildScopedCacheKey(scope, {});
    const compute = vi.fn(async () => ({ v: 42 }));
    await getOrComputeCached(key, scope, compute, { ttlMs: 10_000 });
    const second = await getOrComputeCached(key, scope, compute, { ttlMs: 10_000 });
    expect(second.value).toEqual({ v: 42 });
    expect(second.meta.stale).toBe(false);
    expect(compute).toHaveBeenCalledTimes(1); // served from cache, not recomputed
  });

  it('serves stale immediately and refreshes exactly once under concurrency', async () => {
    const scope = uniqueScope();
    const key = buildScopedCacheKey(scope, {});
    let counter = 0;
    const compute = vi.fn(async () => {
      counter += 1;
      return { v: counter };
    });

    // 1) Prime the cache with a tiny TTL so it expires immediately.
    const first = await getOrComputeCached(key, scope, compute, { ttlMs: 1 });
    expect(first.value).toEqual({ v: 1 });
    expect(first.meta.stale).toBe(false);
    await sleep(5); // let the 1ms TTL lapse

    // 2) A burst of concurrent SWR reads: every one serves the STALE v:1 instantly,
    //    and together they kick only ONE background recompute.
    const burst = await Promise.all(
      Array.from({ length: 6 }, () =>
        getOrComputeCached(key, scope, compute, { ttlMs: 10_000, staleWhileRevalidate: true }),
      ),
    );
    for (const r of burst) {
      expect(r.value).toEqual({ v: 1 }); // stale value served
      expect(r.meta.stale).toBe(true);
    }
    expect(compute).toHaveBeenCalledTimes(2); // 1 prime + exactly 1 background refresh

    // 3) After the background refresh settles, the next read is fresh (v:2).
    await _awaitBackgroundRefreshes();
    const after = await getOrComputeCached(key, scope, compute, { ttlMs: 10_000, staleWhileRevalidate: true });
    expect(after.value).toEqual({ v: 2 });
    expect(after.meta.stale).toBe(false);
    expect(compute).toHaveBeenCalledTimes(2); // still cached — no extra compute
  });

  it('bypass recomputes and returns fresh even when a cached value exists', async () => {
    const scope = uniqueScope();
    const key = buildScopedCacheKey(scope, {});
    let counter = 0;
    const compute = vi.fn(async () => ({ v: ++counter }));
    await getOrComputeCached(key, scope, compute, { ttlMs: 10_000 });
    const bypassed = await getOrComputeCached(key, scope, compute, { ttlMs: 10_000, bypass: true });
    expect(bypassed.value).toEqual({ v: 2 });
    expect(bypassed.meta.stale).toBe(false);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
