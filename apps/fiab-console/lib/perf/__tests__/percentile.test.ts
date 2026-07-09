import { describe, it, expect } from 'vitest';
import { percentile, mean, median, summarize, roundMs } from '../percentile';

describe('perf/percentile', () => {
  it('computes nearest-rank percentiles', () => {
    const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(100);
    expect(percentile(s, 99)).toBe(100);
    expect(percentile(s, 0)).toBe(10);
    expect(percentile(s, 100)).toBe(100);
  });

  it('handles empty + single-element arrays', () => {
    expect(Number.isNaN(percentile([], 50))).toBe(true);
    expect(percentile([42], 95)).toBe(42);
    expect(median([7])).toBe(7);
  });

  it('ignores non-finite samples', () => {
    expect(percentile([1, NaN, 3, Infinity, 5], 50)).toBe(3);
    expect(mean([2, NaN, 4])).toBe(3);
  });

  it('summarizes cold vs warm', () => {
    // First sample (cold) is the slow one; the rest are warm.
    const s = summarize([500, 100, 110, 90, 105]);
    expect(s.n).toBe(5);
    expect(s.coldMs).toBe(500);
    // warm median of [100,110,90,105] → sorted [90,100,105,110], nearest-rank p50 = 100
    expect(s.warmMs).toBe(100);
    expect(s.min).toBe(90);
    expect(s.max).toBe(500);
    expect(s.p50).toBeGreaterThan(0);
  });

  it('summary of empty series is all-null/NaN safe', () => {
    const s = summarize([]);
    expect(s.n).toBe(0);
    expect(s.coldMs).toBeNull();
    expect(s.warmMs).toBeNull();
  });

  it('roundMs rounds and preserves null', () => {
    expect(roundMs(12.6)).toBe(13);
    expect(roundMs(null)).toBeNull();
    expect(roundMs(NaN)).toBeNull();
  });
});
