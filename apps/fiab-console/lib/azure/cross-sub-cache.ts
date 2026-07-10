/**
 * cross-sub-cache — a tiny stale-while-revalidate (SWR) memo for the HEAVY
 * cross-subscription discovery + pre-flight reads the Setup / Add-landing-zone
 * wizard fires (ARM subscription list, Resource Graph DLZ scan, the cross-sub
 * deploy permission + RP-registration pre-flight).
 *
 * ## Why this exists (the 6s cliff)
 *
 * Those reads fan out across EVERY subscription the caller can see and can take
 * many seconds on a large tenant / a cold cross-sub. The wizard calls them
 * through `clientFetch`, whose default browser→BFF ceiling is 6s — so the very
 * first attach against a fresh subscription surfaced
 * "The request took longer than 6s and timed out … heavier across multiple
 * subscriptions — retry, or narrow the window." and the operator was stuck.
 *
 * SWR fixes the retry loop: the FIRST caller kicks the real work and (until it
 * resolves) sees a `pending` state; every subsequent poll/retry is served from
 * the in-process cache INSTANTLY, and once a value is cached a later expiry is
 * served STALE while a single background revalidate refreshes it. Combined with
 * the wizard's larger cross-sub `clientFetch` budget and the async pre-flight
 * poll, a retry is never a fresh multi-second round-trip.
 *
 * ## Semantics
 *
 *   • `fresh`   — a cached value within `ttlMs`. Returned as-is.
 *   • `stale`   — a cached value past `ttlMs` but within `ttlMs+staleMs`. Returned
 *                 immediately AND a single background revalidate is kicked.
 *   • `pending` — nothing cached yet (or the value fully aged out) AND a
 *                 revalidate is in flight. `value` is null; the caller returns an
 *                 honest "still checking — poll again" state the UI long-polls.
 *
 * Failures are NOT cached: a rejected revalidate clears the in-flight slot so the
 * next call retries the real work (matches the monitor-client `cached()` memo).
 * Keys are ALWAYS oid-prefixed so one user can never read another's cached rows.
 *
 * In-process only (per-replica), zero infra, default-ON — a latency optimization,
 * never a correctness or availability dependency. No Fabric / OneLake / Power BI
 * host knowledge here (no-fabric-dependency); it only memoizes rows the
 * Azure-native ARM/Resource-Graph reads already produced (no-vaporware).
 */

/** One cached entry: the resolved value + when it was stored. */
interface Entry<T> {
  value: T;
  storedAt: number;
}

/** The state a {@link swr} read resolves to. */
export type SwrState = 'fresh' | 'stale' | 'pending';

export interface SwrResult<T> {
  /** The cached value, or null when `pending` (nothing cached yet). */
  value: T | null;
  state: SwrState;
  /** Age of the cached value in ms (0 when pending). */
  ageMs: number;
}

export interface SwrOptions {
  /** Freshness window (ms). Within it, a cached value is served without revalidating. */
  ttlMs: number;
  /**
   * Extra window (ms) past `ttlMs` during which a cached value is still served
   * STALE (with a background revalidate). Beyond `ttlMs+staleMs` the entry is
   * treated as absent (`pending`). Default: 10× `ttlMs`.
   */
  staleMs?: number;
}

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const MAX_ENTRIES = 500;

/** Master off-switch (default ON — needs no infra). */
export function crossSubCacheEnabled(): boolean {
  return process.env.LOOM_SETUP_DISCOVERY_CACHE_DISABLED !== '1';
}

/** Insertion-order LRU trim so the map can't grow unbounded. */
function trim(): void {
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Start (or reuse) a single background revalidate for `key`. Failures evict the slot. */
function revalidate<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = (async () => {
    try {
      const value = await fn();
      store.set(key, { value, storedAt: Date.now() });
      trim();
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * Stale-while-revalidate read. Returns synchronously-resolvable cache state:
 * a `fresh`/`stale` cached value is returned immediately (stale also kicks a
 * background refresh); a cold key returns `pending` with `value:null` after
 * kicking the real work, so the route replies "still checking" and the client
 * polls. Passthrough (always runs `fn` and awaits it) when the cache is disabled.
 *
 * The returned promise resolves as soon as the STATE is known — it does NOT wait
 * for a `pending` revalidate to finish (that's the whole point: the caller polls).
 */
export async function swr<T>(
  oid: string,
  key: string,
  opts: SwrOptions,
  fn: () => Promise<T>,
): Promise<SwrResult<T>> {
  const staleMs = opts.staleMs ?? opts.ttlMs * 10;
  // Cache disabled or no oid to scope by → honest passthrough (await the work).
  if (!crossSubCacheEnabled() || !oid) {
    return { value: await fn(), state: 'fresh', ageMs: 0 };
  }
  const k = `${oid}::${key}`;
  const now = Date.now();
  const hit = store.get(k) as Entry<T> | undefined;
  if (hit) {
    const age = now - hit.storedAt;
    if (age <= opts.ttlMs) return { value: hit.value, state: 'fresh', ageMs: age };
    if (age <= opts.ttlMs + staleMs) {
      // Serve stale, refresh in the background (fire-and-forget; failures evict).
      void revalidate(k, fn).catch(() => {});
      return { value: hit.value, state: 'stale', ageMs: age };
    }
    // Fully aged out — drop it and fall through to pending.
    store.delete(k);
  }
  // Cold key: kick the real work and report pending so the client long-polls.
  void revalidate(k, fn).catch(() => {});
  return { value: null, state: 'pending', ageMs: 0 };
}

/**
 * Await a cold key to completion instead of returning `pending`. Used by callers
 * that CANNOT poll (e.g. the deploy route's own defense-in-depth pre-flight):
 * they still benefit from an already-warm cache (instant), and only block on a
 * genuine cold miss. `fresh`/`stale` are returned exactly like {@link swr}.
 */
export async function swrAwait<T>(
  oid: string,
  key: string,
  opts: SwrOptions,
  fn: () => Promise<T>,
): Promise<{ value: T; state: SwrState }> {
  const staleMs = opts.staleMs ?? opts.ttlMs * 10;
  // Cache disabled or no oid to scope by → honest passthrough (await the work).
  if (!crossSubCacheEnabled() || !oid) {
    return { value: await fn(), state: 'fresh' };
  }
  const k = `${oid}::${key}`;
  const now = Date.now();
  const hit = store.get(k) as Entry<T> | undefined;
  if (hit) {
    const age = now - hit.storedAt;
    if (age <= opts.ttlMs) return { value: hit.value, state: 'fresh' };
    if (age <= opts.ttlMs + staleMs) {
      // Serve stale immediately (a background revalidate refreshes it).
      void revalidate(k, fn).catch(() => {});
      return { value: hit.value, state: 'stale' };
    }
    store.delete(k);
  }
  // Cold miss — kick AND await the SAME in-flight revalidate atomically (no await
  // boundary between the kick and the await, so a fast `fn` can't settle+evict
  // the slot before we grab it and force a wasteful second run). A rejected
  // revalidate propagates here (the caller surfaces it) and is NOT cached, so the
  // next call retries the real work.
  const value = await revalidate(k, fn);
  return { value, state: 'fresh' };
}

/** Drop cached entries: a single key (oid+key) or every entry for an oid, or all. */
export function bustCrossSubCache(oid?: string, key?: string): void {
  if (oid && key) {
    store.delete(`${oid}::${key}`);
    return;
  }
  if (oid) {
    const prefix = `${oid}::`;
    for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    return;
  }
  store.clear();
  inflight.clear();
}
