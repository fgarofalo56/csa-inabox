/** PSR-7 — mapWithConcurrency: order preservation + bounded concurrency. */
import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../concurrency';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('returns results in INPUT order regardless of completion order', async () => {
    const items = [30, 10, 20, 5];
    // Slower items resolve later, but results must still line up with inputs.
    const out = await mapWithConcurrency(items, 2, async (ms) => { await tick(ms); return ms * 2; });
    expect(out).toEqual([60, 20, 40, 10]);
  });

  it('never runs more than `limit` tasks at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(5);
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBe(3); // saturates the cap with 12 items
  });

  it('processes every item exactly once', async () => {
    const seen: number[] = [];
    const items = [0, 1, 2, 3, 4];
    const out = await mapWithConcurrency(items, 2, async (i) => { seen.push(i); return i; });
    expect(out).toEqual(items);
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it('handles an empty list and floors a bad limit to 1', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
    const out = await mapWithConcurrency([1, 2, 3], 0, async (x) => x * 10);
    expect(out).toEqual([10, 20, 30]);
  });
});
