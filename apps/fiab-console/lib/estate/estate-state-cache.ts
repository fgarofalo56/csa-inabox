/**
 * Single-flight + short-TTL cache around the estate STATE verdict.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * Every GET of the state route fans out to ARM (one tag read per manifest
 * entry while RUNNING, one power read per snapshot entry while transitioning,
 * plus probes while RESUMING). Several readers poll the same tenant with the
 * same managed identity and share ONE ARM read quota: each open admin tab, the
 * `estate-power` Actions lane (every 30 s) and the idle-autopause lane. Without
 * a shared cache the reads multiply by the number of readers.
 *
 * ── WHAT IT GUARANTEES ─────────────────────────────────────────────────────
 *   - concurrent readers inside the TTL share ONE fan-out (single-flight);
 *   - a mutation (pause / resume) CLEARS the entry, which also DETACHES any read
 *     already in flight: it finishes into an entry no longer in the map, so its
 *     pre-action verdict cannot be served after the action;
 *   - only successful READ verdicts are stored. A gate error (503) is never
 *     cached and a mutation result is never cached (callers do not pass one);
 *   - a rejected read is not cached.
 *
 * TTL: `LOOM_ESTATE_STATE_CACHE_TTL_MS`, default 10 000 ms, clamped to
 * [0, 60 000]; 0 disables caching (single-flight still collapses truly
 * concurrent reads). The cache is per console instance (module memory): with N
 * replicas the worst case is N fan-outs per TTL, never N x readers.
 */

export const STATE_CACHE_TTL_ENV = 'LOOM_ESTATE_STATE_CACHE_TTL_MS';
export const DEFAULT_STATE_CACHE_TTL_MS = 10_000;
const MAX_STATE_CACHE_TTL_MS = 60_000;

export function stateCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[STATE_CACHE_TTL_ENV] ?? '').trim();
  if (raw === '') return DEFAULT_STATE_CACHE_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_STATE_CACHE_TTL_MS;
  return Math.min(Math.round(n), MAX_STATE_CACHE_TTL_MS);
}

interface Entry {
  value?: unknown;
  expiresAt: number;
  inflight?: Promise<unknown>;
}

const entries = new Map<string, Entry>();

/** Test seam: the clock. */
let now: () => number = () => Date.now();
export function __setStateCacheClock(fn: (() => number) | null): void {
  now = fn ?? (() => Date.now());
}

/** Drop every cached verdict and detach every in-flight read (called on any action). */
export function clearStateCache(key?: string): void {
  if (key === undefined) entries.clear();
  else entries.delete(key);
}

export async function cachedStateRead<T>(
  key: string,
  read: () => Promise<{ cacheable: boolean; value: T }>,
  ttlMs: number = stateCacheTtlMs(),
): Promise<T> {
  const hit = entries.get(key);
  if (hit) {
    if (hit.inflight) return (await hit.inflight) as T;
    if (hit.value !== undefined && hit.expiresAt > now()) return hit.value as T;
  }
  const entry: Entry = { expiresAt: 0 };
  const p = (async () => {
    const r = await read();
    if (r.cacheable && ttlMs > 0) {
      entry.value = r.value;
      entry.expiresAt = now() + ttlMs;
    }
    return r.value;
  })();
  entry.inflight = p;
  entries.set(key, entry);
  try {
    return await p;
  } finally {
    // Single-flight ends here; the stored value (if any) stays until expiry.
    delete entry.inflight;
    if (entry.value === undefined && entries.get(key) === entry) entries.delete(key);
  }
}
