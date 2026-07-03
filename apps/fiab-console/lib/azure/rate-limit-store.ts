/**
 * Durable, cross-replica tier for the rate limiter (rel-T16 / blocker B16).
 *
 * Realizes the "Redis seam" documented in rate-limiter.ts on the lightest real
 * cross-replica store already deployed — Cosmos — rather than standing up Redis.
 * Two primitives, both best-effort + bounded (per-call AbortController budget) +
 * fail-open (return null on any error so tier-1 stays the guarantee):
 *
 *   incrementWindow(key, limit) — a FIXED-WINDOW counter. One doc per
 *     (key, windowStart) with a per-item TTL = windowSec (+ buffer), so expired
 *     windows self-evict and the container never grows unbounded. Cosmos Patch
 *     `incr` is a single atomic round-trip; a first-write 404 creates the doc,
 *     and a create race (409) retries the patch. Fixed-window is intentionally
 *     approximate (a burst can straddle a boundary) — fine for coarse abuse
 *     protection; the tier-1 token bucket smooths the per-second burst.
 *
 *   seenRecently(hash, ttlSec) — an idempotency/dedupe check. Point-reads a
 *     `dup:<hash>` doc; if present the payload was seen inside the TTL window
 *     (returns true). Otherwise it writes the marker (TTL = ttlSec) and returns
 *     false. Used by /api/feedback to drop identical anonymous auto-error
 *     reports for 24h so a crash loop can't spam the upstream issue tracker.
 *
 * Storage: the `rate-limits` Cosmos container (PK /key, defaultTtl=-1 so
 * per-item ttl is honored), created lazily by cosmos-client's ensure().
 */

import { rateLimitsContainer } from './cosmos-client';

/** windowSec + max requests per window per key. */
export interface WindowLimit {
  windowSec: number;
  max: number;
}

/** Per-call Cosmos budget (ms). A slow/blipping store must never stall a route. */
const PROBE_MS = Math.max(150, Number(process.env.LOOM_RATE_LIMIT_STORE_BUDGET_MS) || 600);

/**
 * Whether the durable tier is engaged. Off when LOOM_RATE_LIMIT_BACKEND=memory
 * (or =off), or when Cosmos isn't configured in this deployment (no endpoint) —
 * in which case tier-1 (in-memory) is the sole enforcer and the limiter still
 * works, just per-replica.
 */
export function durableEnabled(): boolean {
  const backend = (process.env.LOOM_RATE_LIMIT_BACKEND ?? '').toLowerCase();
  if (backend === 'memory' || backend === 'off') return false;
  return !!process.env.LOOM_COSMOS_ENDPOINT;
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_MS);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Atomically increment (and lazily create) the fixed-window counter for `key`.
 * Returns { count, max } after this request, or null when the durable tier is
 * disabled/unavailable (caller falls open to tier-1). `count > max` means the
 * caller is over budget for the current window.
 */
export async function incrementWindow(
  key: string,
  limit: WindowLimit,
): Promise<{ count: number; max: number } | null> {
  if (!durableEnabled()) return null;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % limit.windowSec);
  const id = `cnt:${key}:${windowStart}`;
  const ttl = limit.windowSec + 10; // self-evict shortly after the window closes
  try {
    const c = await rateLimitsContainer();
    const count = await withTimeout(async (signal) => {
      try {
        const { resource } = await c.item(id, key).patch(
          [{ op: 'incr', path: '/count', value: 1 }],
          { abortSignal: signal },
        );
        return Number((resource as { count?: number })?.count ?? 1);
      } catch (e) {
        if ((e as { code?: number }).code === 404) {
          try {
            await c.items.create({ id, key, count: 1, windowStart, ttl }, { abortSignal: signal });
            return 1;
          } catch (e2) {
            if ((e2 as { code?: number }).code === 409) {
              // Lost the create race with another replica — the doc now exists.
              const { resource } = await c.item(id, key).patch(
                [{ op: 'incr', path: '/count', value: 1 }],
                { abortSignal: signal },
              );
              return Number((resource as { count?: number })?.count ?? 1);
            }
            throw e2;
          }
        }
        throw e;
      }
    });
    return { count, max: limit.max };
  } catch {
    return null; // fail open — tier-1 already enforced the per-replica burst cap
  }
}

/**
 * Idempotency check keyed by a payload hash. Returns true if the hash was seen
 * within `ttlSec` (a duplicate), false if this is the first sighting (and the
 * marker is written), or null when the durable tier is disabled/unavailable.
 */
export async function seenRecently(hash: string, ttlSec: number): Promise<boolean | null> {
  if (!durableEnabled()) return null;
  const id = `dup:${hash}`;
  try {
    const c = await rateLimitsContainer();
    return await withTimeout(async (signal) => {
      try {
        await c.item(id, id).read({ abortSignal: signal });
        return true; // marker present → duplicate within the TTL window
      } catch (e) {
        if ((e as { code?: number }).code === 404) {
          try {
            await c.items.create({ id, key: id, ttl: ttlSec }, { abortSignal: signal });
          } catch {
            /* create race — another replica just wrote it; treat this one as first */
          }
          return false;
        }
        throw e;
      }
    });
  } catch {
    return null; // fail open
  }
}
