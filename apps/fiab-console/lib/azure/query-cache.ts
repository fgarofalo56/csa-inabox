/**
 * In-process query cache + concurrency governor — node-only, additive, honest.
 *
 * Two independent helpers used by BFF API routes to take pressure off Azure
 * data-plane backends (ADX, Synapse SQL, ARM listKeys, etc.) WITHOUT changing
 * behavior unless explicitly turned on:
 *
 *   • withQueryCache(oid, key, ttlMs, fn) — per-(oid, key, resourceId) LRU + TTL.
 *     DEFAULT (LOOM_QUERY_CACHE unset/off) = pure passthrough: it just runs fn.
 *     Caching is opt-in via LOOM_QUERY_CACHE=on. The cache key ALWAYS includes
 *     the caller's AAD object id (oid) so one tenant/user can never read another
 *     tenant's cached rows — no cross-tenant bleed.
 *
 *   • runGoverned(fn) — caps the number of concurrent fns at
 *     LOOM_QUERY_MAX_CONCURRENCY (default unlimited) and queues the rest. Lets a
 *     route fan out without flooding a backend or tripping ARM 429s.
 *
 * In-proc only: state lives in module scope and dies with the process. Each ACA
 * replica has its own cache; there is no shared eviction. For multi-replica
 * coherence, back this with Redis later (replace the Map below with a Redis
 * client — keep the oid-prefixed key + TTL semantics identical). Until then,
 * keep TTLs short and treat this as a best-effort hot-path cache.
 *
 * NO middleware/edge use — relies on a long-lived node process; importing this
 * from an edge runtime is unsupported.
 */

function cacheEnabled(): boolean {
  return (process.env.LOOM_QUERY_CACHE ?? '').toLowerCase() === 'on';
}

function maxConcurrency(): number {
  const raw = Number(process.env.LOOM_QUERY_MAX_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0; // 0 = unlimited
}

const MAX_ENTRIES = 500;

interface Entry {
  value: unknown;
  expiresAt: number;
}

// Map preserves insertion order → cheap LRU: delete+set on hit moves to newest,
// evict from the front (oldest) when over capacity.
const store = new Map<string, Entry>();

/** Cache key ALWAYS prefixed by oid → no cross-tenant read. */
function makeKey(oid: string, key: string): string {
  return `${oid}::${key}`;
}

/**
 * Run `fn` once, caching its resolved value per (oid, key) for `ttlMs`.
 * Passthrough (no caching) unless LOOM_QUERY_CACHE=on. The key MUST encode the
 * resourceId/queryHash so distinct queries don't collide; pass that in `key`.
 */
export async function withQueryCache<T>(
  oid: string,
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (!cacheEnabled() || !oid || ttlMs <= 0) {
    return fn();
  }
  const k = makeKey(oid, key);
  const now = Date.now();
  const hit = store.get(k);
  if (hit && hit.expiresAt > now) {
    store.delete(k);
    store.set(k, hit); // mark most-recently-used
    return hit.value as T;
  }
  if (hit) store.delete(k); // expired
  const value = await fn();
  store.set(k, { value, expiresAt: now + ttlMs });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  return value;
}

/**
 * Drop cached entries. With an oid, only that tenant/user's entries are busted;
 * with no oid, the whole in-proc cache is cleared. No-op when cache is off.
 */
export function bustQueryCache(oid?: string): void {
  if (!oid) {
    store.clear();
    return;
  }
  const prefix = `${oid}::`;
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}

let active = 0;
const waiters: Array<() => void> = [];

/**
 * Run `fn` under a global concurrency cap (LOOM_QUERY_MAX_CONCURRENCY). When the
 * cap is reached, callers queue FIFO and resume as slots free. Unset/<=0 ⇒
 * unlimited (immediate passthrough). Always releases the slot on settle.
 */
export async function runGoverned<T>(fn: () => Promise<T>): Promise<T> {
  const cap = maxConcurrency();
  if (cap <= 0) return fn();
  if (active >= cap) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}
