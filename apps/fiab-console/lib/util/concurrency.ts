/**
 * mapWithConcurrency — run an async mapper over items with a bounded number of
 * in-flight tasks, preserving input order in the returned results.
 *
 * PSR-7 uses this to FAN OUT a Real-Time Dashboard's tile queries: each tile
 * runs its own ADX round-trip so fast tiles render the instant they resolve
 * (progressive render + per-tile skeletons), while the concurrency cap keeps a
 * 20-tile board from firing 20 simultaneous queries that trip the query
 * rate-limiter. Pure (no I/O of its own) and unit-tested.
 */

/**
 * @param items  the inputs to map.
 * @param limit  max concurrent in-flight tasks (floored to >= 1).
 * @param fn     async mapper; receives the item + its original index.
 * @returns      results in the SAME order as `items` (not completion order).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  if (n === 0) return results;
  const cap = Math.max(1, Math.floor(limit) || 1);

  let next = 0;
  async function worker(): Promise<void> {
    // Each worker pulls the next index until the queue is drained. `next++` is
    // atomic within the single-threaded event loop, so no two workers share one.
    while (true) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(cap, n) }, () => worker());
  await Promise.all(workers);
  return results;
}
