/**
 * Unit tests for `createConcurrencyLimiter` — the FIFO concurrency limiter that
 * funnels every Microsoft.CostManagement/query round-trip so the chargeback /
 * cost report never exceeds the Cost Management QPU ceiling (the root cause of
 * the live self-inflicted 429 storm → retry-backoff → whole-report hang).
 *
 * Locks the two invariants the perf fix depends on: (1) never more than `max`
 * tasks run concurrently, and (2) every scheduled task still resolves/rejects
 * with its own result, in FIFO start order.
 */
import { describe, it, expect } from 'vitest';
import { createConcurrencyLimiter } from '../cost-client';

/** A deferred promise + a manual resolver, for deterministic concurrency control. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createConcurrencyLimiter', () => {
  it('never runs more than `max` tasks at once', async () => {
    const max = 3;
    const schedule = createConcurrencyLimiter(max);
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 10 }, () => deferred<void>());

    const runs = gates.map((g, i) =>
      schedule(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await g.promise;
        active -= 1;
        return i;
      }),
    );

    // Let the limiter start the first wave.
    await Promise.resolve();
    await Promise.resolve();
    expect(active).toBeLessThanOrEqual(max);

    // Release gates one at a time; the peak must never exceed `max`.
    for (const g of gates) {
      g.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(active).toBeLessThanOrEqual(max);
    }

    const results = await Promise.all(runs);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBeLessThanOrEqual(max);
    expect(peak).toBe(max); // the wave actually saturates the limit
  });

  it('resolves each task with its own value and propagates rejections', async () => {
    const schedule = createConcurrencyLimiter(2);
    const ok = await Promise.all([
      schedule(async () => 'a'),
      schedule(async () => 'b'),
      schedule(async () => 'c'),
    ]);
    expect(ok).toEqual(['a', 'b', 'c']);

    await expect(schedule(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // A rejection must free its slot — subsequent work still runs.
    await expect(schedule(async () => 'after')).resolves.toBe('after');
  });

  it('treats a non-positive / NaN max as a serial (1-at-a-time) limiter', async () => {
    for (const bad of [0, -5, Number.NaN]) {
      const schedule = createConcurrencyLimiter(bad as number);
      let active = 0;
      let peak = 0;
      const g = Array.from({ length: 4 }, () => deferred<void>());
      const runs = g.map((d, i) =>
        schedule(async () => { active += 1; peak = Math.max(peak, active); await d.promise; active -= 1; return i; }),
      );
      await Promise.resolve(); await Promise.resolve();
      for (const d of g) { d.resolve(); await Promise.resolve(); await Promise.resolve(); }
      await Promise.all(runs);
      expect(peak).toBe(1);
    }
  });
});
