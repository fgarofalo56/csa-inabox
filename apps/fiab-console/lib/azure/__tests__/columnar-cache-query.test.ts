/**
 * columnar-cache-query.test.ts — WS-3.3 Direct Lake substitute.
 *
 * Proves the three properties that make this a REAL perf path (not a PBI-Desktop
 * deferral), with zero Azure — the framing + cache-key + routing logic is fully
 * dependency-injected:
 *
 *   1. A repeat query is a CACHE HIT — the Serverless DirectQuery runs ONCE and
 *      the second call answers from cache (import-like latency, sub-ms).
 *   2. A Delta VERSION BUMP invalidates the frame — the frame token rotates so the
 *      next query is a miss and re-reads live (framing, not a stale answer).
 *   3. Framing is METADATA-ONLY — resolveFrame is consulted every call, but it
 *      never scans/copies data; only a cache miss touches runQuery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  columnarCacheQuery,
  columnarCacheBackendSelected,
  frameToken,
  resolveFrame,
  invalidateFrameCache,
  frameTtlMs,
  COLUMNAR_CACHE_BACKEND_VALUE,
  type DeltaFrame,
} from '../columnar-cache-query';
import type { CachedQueryResult } from '../query-result-cache';

// A tiny in-memory cache mirroring getCachedResult / setCachedResult semantics.
function makeCache() {
  const store = new Map<string, CachedQueryResult>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, _modelId: string, value: CachedQueryResult) => {
      store.set(key, value);
    }),
  };
}

function frameAt(version: number | null): DeltaFrame {
  return {
    token: frameToken({ deltaVersion: version, via: 'directlake-service', sourceKind: 'delta' }),
    deltaVersion: version,
    framedAt: 0,
    via: 'directlake-service',
    sourceKind: 'delta',
  };
}

const ROWS: CachedQueryResult = { rows: [{ n: 42 }], columns: ['n'], rowCount: 1, producedBy: 'serverless' };

const ORIG_BACKEND = process.env.LOOM_SEMANTIC_BACKEND;
const ORIG_DISABLED = process.env.LOOM_QUERY_CACHE_DISABLED;
beforeEach(() => {
  delete process.env.LOOM_QUERY_CACHE_DISABLED; // cache on
  invalidateFrameCache();
});
afterEach(() => {
  if (ORIG_BACKEND === undefined) delete process.env.LOOM_SEMANTIC_BACKEND;
  else process.env.LOOM_SEMANTIC_BACKEND = ORIG_BACKEND;
  if (ORIG_DISABLED === undefined) delete process.env.LOOM_QUERY_CACHE_DISABLED;
  else process.env.LOOM_QUERY_CACHE_DISABLED = ORIG_DISABLED;
  invalidateFrameCache();
});

describe('columnarCacheBackendSelected', () => {
  it('true only for loom-columnar-cache', () => {
    process.env.LOOM_SEMANTIC_BACKEND = COLUMNAR_CACHE_BACKEND_VALUE;
    expect(columnarCacheBackendSelected()).toBe(true);
    process.env.LOOM_SEMANTIC_BACKEND = 'loom-native';
    expect(columnarCacheBackendSelected()).toBe(false);
    delete process.env.LOOM_SEMANTIC_BACKEND;
    expect(columnarCacheBackendSelected()).toBe(false);
  });
});

describe('frameToken — the invalidation contract', () => {
  it('rotates when the Delta version changes', () => {
    const a = frameToken({ deltaVersion: 7, via: 'directlake-service', sourceKind: 'delta' });
    const b = frameToken({ deltaVersion: 8, via: 'directlake-service', sourceKind: 'delta' });
    expect(a).not.toBe(b);
    expect(a).toBe(frameToken({ deltaVersion: 7, via: 'directlake-service', sourceKind: 'delta' }));
  });
  it('falls back to a hint proxy when no real version exists', () => {
    const h = frameToken({ deltaVersion: null, via: 'hint', hint: '2026-07-20T00:00:00Z' });
    expect(h).toContain('dl:h:');
    expect(h).not.toBe(frameToken({ deltaVersion: null, via: 'hint', hint: 'other' }));
  });
});

describe('columnarCacheQuery — cache hit answers at import-like latency', () => {
  it('runs Serverless ONCE, second call is a cache hit', async () => {
    const cache = makeCache();
    const runQuery = vi.fn(async () => ROWS);
    const resolveFrameFn = vi.fn(async () => frameAt(1));

    const first = await columnarCacheQuery(
      { modelId: 'm1', sql: 'SELECT 1', source: 'abfss://gold@a.dfs/fact' },
      { resolveFrame: resolveFrameFn, runQuery, cacheGet: cache.get, cacheSet: cache.set },
    );
    expect(first.servingFrom).toBe('serverless-direct');
    expect(first.cached).toBe(false);
    expect(first.rows).toEqual(ROWS.rows);

    const second = await columnarCacheQuery(
      { modelId: 'm1', sql: 'SELECT 1', source: 'abfss://gold@a.dfs/fact' },
      { resolveFrame: resolveFrameFn, runQuery, cacheGet: cache.get, cacheSet: cache.set },
    );
    expect(second.servingFrom).toBe('columnar-cache');
    expect(second.cached).toBe(true);
    expect(second.rows).toEqual(ROWS.rows);

    // The real (slow) backend was hit exactly once — the repeat was import-like.
    expect(runQuery).toHaveBeenCalledTimes(1);
    // Framing was consulted every call (metadata-only), never scanning data.
    expect(resolveFrameFn).toHaveBeenCalledTimes(2);
  });
});

describe('columnarCacheQuery — a Delta version bump invalidates the frame', () => {
  it('re-reads live after the version advances', async () => {
    const cache = makeCache();
    const runQuery = vi.fn(async () => ROWS);
    let version = 1;
    const resolveFrameFn = vi.fn(async () => frameAt(version));

    const q = { modelId: 'm1', sql: 'SELECT 1', source: 'abfss://gold@a.dfs/fact' };
    const deps = { resolveFrame: resolveFrameFn, runQuery, cacheGet: cache.get, cacheSet: cache.set };

    await columnarCacheQuery(q, deps); // miss → cache under v1
    const hit = await columnarCacheQuery(q, deps); // hit v1
    expect(hit.cached).toBe(true);
    expect(runQuery).toHaveBeenCalledTimes(1);

    // New Delta rows land → version advances → frame rotates.
    version = 2;
    const afterBump = await columnarCacheQuery(q, deps);
    expect(afterBump.servingFrom).toBe('serverless-direct');
    expect(afterBump.cached).toBe(false);
    expect(afterBump.frame.deltaVersion).toBe(2);
    expect(runQuery).toHaveBeenCalledTimes(2); // re-read live once

    // The v2 frame now caches too.
    const hitV2 = await columnarCacheQuery(q, deps);
    expect(hitV2.cached).toBe(true);
    expect(runQuery).toHaveBeenCalledTimes(2);
  });
});

describe('columnarCacheQuery — cache disabled degrades to a live read', () => {
  it('never caches when the cache is off', async () => {
    process.env.LOOM_QUERY_CACHE_DISABLED = '1';
    const cache = makeCache();
    const runQuery = vi.fn(async () => ROWS);
    const deps = { resolveFrame: async () => frameAt(1), runQuery, cacheGet: cache.get, cacheSet: cache.set };
    const q = { modelId: 'm1', sql: 'SELECT 1', source: 'abfss://gold@a.dfs/fact' };
    await columnarCacheQuery(q, deps);
    await columnarCacheQuery(q, deps);
    expect(runQuery).toHaveBeenCalledTimes(2); // no caching → every call is live
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('resolveFrame — framing cadence + fallbacks', () => {
  it('pins the real Delta version from the service and reuses it within the TTL', async () => {
    const fetchVersion = vi.fn(async () => ({ deltaVersion: 5, sourceKind: 'delta' }));
    const f1 = await resolveFrame('abfss://gold@a.dfs/fact', { fetchVersion });
    const f2 = await resolveFrame('abfss://gold@a.dfs/fact', { fetchVersion });
    expect(f1.deltaVersion).toBe(5);
    expect(f1.via).toBe('directlake-service');
    expect(f1.token).toBe(f2.token);
    // Within the frame TTL the version is reused (framing cadence), not re-fetched.
    expect(fetchVersion).toHaveBeenCalledTimes(1);
  });

  it('re-frames after an explicit invalidate and picks up the new version', async () => {
    let v = 5;
    const fetchVersion = vi.fn(async () => ({ deltaVersion: v, sourceKind: 'delta' }));
    const f1 = await resolveFrame('src', { fetchVersion });
    v = 6;
    invalidateFrameCache('src');
    const f2 = await resolveFrame('src', { fetchVersion });
    expect(f1.deltaVersion).toBe(5);
    expect(f2.deltaVersion).toBe(6);
    expect(f1.token).not.toBe(f2.token);
    expect(fetchVersion).toHaveBeenCalledTimes(2);
  });

  it('falls back to a hint proxy when the service resolves no version (no Fabric gate)', async () => {
    const fetchVersion = vi.fn(async () => null);
    const f = await resolveFrame('src', { fetchVersion, hint: 'ts-123' });
    expect(f.via).toBe('hint');
    expect(f.deltaVersion).toBeNull();
    expect(f.token).toContain('dl:h:ts-123');
  });

  it('defaults to a 30s framing TTL', () => {
    const orig = process.env.LOOM_DL_FRAME_TTL_SECONDS;
    delete process.env.LOOM_DL_FRAME_TTL_SECONDS;
    expect(frameTtlMs()).toBe(30_000);
    if (orig !== undefined) process.env.LOOM_DL_FRAME_TTL_SECONDS = orig;
  });
});
