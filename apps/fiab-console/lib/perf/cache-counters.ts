/**
 * cache-counters — process-wide hit/miss counters for the Loom result caches,
 * broken out by backend so the PSR-1 perf surface can report a live cache
 * hit-rate alongside the latency metrics (PSR-5 / PSR-6).
 *
 * WHY a separate module: `perf-metrics.ts` is a pure, browser-importable
 * constants/types file (no runtime state, no Node imports) — the PSR-1 metric
 * REGISTRY. This module holds the RUNTIME numbers the Azure-native clients feed
 * (query-result-cache, kusto-client, tabular-eval-client) and stays Node-side.
 * Keeping them apart preserves perf-metrics' zero-dependency import so it can
 * ship in the browser bundle without pulling a counter singleton along.
 *
 * State lives in module scope → per-ACA-replica, resets with the process. That
 * matches the in-process cache tier: the shared Redis/Cosmos tiers give
 * cross-replica cache COHERENCE, but hit-rate is reported per replica (an
 * operator reads the aggregate from the perf page, which samples one replica).
 *
 * NO Fabric / Power BI dependency — these are Loom-internal counters only.
 */

/** A cache backend a counter is attributed to (the tier that answered). */
export type CacheCounterBackend =
  | 'result-cache' // report / semantic-layer result cache (query-result-cache.ts)
  | 'adx' // ADX server-side results-cache hits (kusto-client.ts)
  | 'tabular'; // AAS / loom-native DAX result cache (tabular-eval-client.ts)

interface Counter {
  hits: number;
  misses: number;
}

const counters: Record<CacheCounterBackend, Counter> = {
  'result-cache': { hits: 0, misses: 0 },
  adx: { hits: 0, misses: 0 },
  tabular: { hits: 0, misses: 0 },
};

/** Record a cache hit for a backend. */
export function recordCacheHit(backend: CacheCounterBackend): void {
  counters[backend].hits++;
}

/** Record a cache miss for a backend. */
export function recordCacheMiss(backend: CacheCounterBackend): void {
  counters[backend].misses++;
}

/** Hit-rate for a single backend (0..1); 0 when it has seen no lookups. */
export function backendHitRate(backend: CacheCounterBackend): number {
  const c = counters[backend];
  const total = c.hits + c.misses;
  return total > 0 ? c.hits / total : 0;
}

export interface CacheCountersSnapshot {
  /** Per-backend hits / misses / hit-rate. */
  byBackend: Record<CacheCounterBackend, Counter & { hitRate: number }>;
  /** Aggregate across every backend. */
  total: Counter & { hitRate: number };
}

/** A point-in-time snapshot of every counter for the perf / diagnostics UI. */
export function cacheCountersSnapshot(): CacheCountersSnapshot {
  const backends = Object.keys(counters) as CacheCounterBackend[];
  const byBackend = {} as CacheCountersSnapshot['byBackend'];
  let hits = 0;
  let misses = 0;
  for (const b of backends) {
    const c = counters[b];
    hits += c.hits;
    misses += c.misses;
    byBackend[b] = { hits: c.hits, misses: c.misses, hitRate: backendHitRate(b) };
  }
  const total = hits + misses;
  return {
    byBackend,
    total: { hits, misses, hitRate: total > 0 ? hits / total : 0 },
  };
}

/** Reset every counter (used by tests + an operator diagnostics reset). */
export function resetCacheCounters(): void {
  for (const b of Object.keys(counters) as CacheCounterBackend[]) {
    counters[b] = { hits: 0, misses: 0 };
  }
}
