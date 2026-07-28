/**
 * ttl-memo — a single-value, in-process, TTL'd memo with in-flight de-duping.
 *
 * The shape that keeps a near-static ARM read off a hot request path without
 * dragging in the shared cache tiers. `query-result-cache.getOrComputeCached`
 * is the right tool for a per-key, cross-replica, multi-MB result; it is the
 * WRONG tool for "this one low-level client call must not cost 22.9s twice"
 * (issue #2557), because it adds a Redis + Cosmos hop of its own to the very
 * path we are trying to shorten.
 *
 * Semantics (deliberately small):
 *   • fresh hit  → the memoized value, no compute;
 *   • concurrent miss → ONE shared in-flight compute (no stampede);
 *   • rejection  → never memoized (a transient backend blip must not gate the
 *     feature for the whole TTL);
 *   • invalidate() → drop it, so a write through Loom is visible on the very
 *     next read instead of after the TTL. Invalidation also bumps a GENERATION
 *     counter, so a compute that was already in flight when the write landed
 *     resolves WITHOUT writing its now-stale snapshot back into the cache —
 *     otherwise a `create/update/deleteConnection` racing an in-flight GET
 *     would be papered over by the pre-write list for the full TTL.
 *
 * Per-process by design: replicas warm independently, and the value is config
 * that any replica can re-read cheaply.
 */

export interface TtlMemo<T> {
  /** Fresh value, the shared in-flight compute, or a new compute. */
  get(compute: () => Promise<T>, force?: boolean): Promise<T>;
  /** Drop the memoized value and any in-flight sharing. */
  invalidate(): void;
}

/** Build a memo that holds one value for `ttlMs`. */
export function createTtlMemo<T>(ttlMs: number): TtlMemo<T> {
  let cached: { value: T; at: number } | null = null;
  let inFlight: Promise<T> | null = null;
  // Bumped on every invalidate(). A compute stamped with an older generation
  // has been overtaken by a write and must not become the cached value.
  let generation = 0;

  return {
    invalidate() {
      cached = null;
      inFlight = null;
      generation += 1;
    },
    async get(compute: () => Promise<T>, force = false): Promise<T> {
      if (force) {
        cached = null;
        inFlight = null;
        generation += 1;
      }
      if (cached && Date.now() - cached.at < ttlMs) return cached.value;
      if (inFlight) return inFlight;

      const startedAtGeneration = generation;
      const run = (async () => {
        const value = await compute();
        // Only cache when nothing invalidated us mid-flight — the caller still
        // gets this value (it is the freshest thing we have), it just doesn't
        // become the 5-minute answer.
        if (generation === startedAtGeneration) cached = { value, at: Date.now() };
        return value;
      })();
      inFlight = run;
      try {
        return await run;
      } finally {
        // Only the originator clears; a rejection therefore leaves NOTHING
        // cached and the next caller retries for real.
        if (inFlight === run) inFlight = null;
      }
    },
  };
}
