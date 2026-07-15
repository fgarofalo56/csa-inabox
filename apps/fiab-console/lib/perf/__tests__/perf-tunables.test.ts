/**
 * PERF-4.2 — tunables defaults + sanitizer clamps, and pool-counters math.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_ADJUST_CLASSES,
  AUTO_ADJUST_META,
  defaultTunables,
  sanitizeTunables,
  nextDwu,
  DWU_LADDER,
} from '../perf-tunables';
import { recordPoolAcquire, poolCountersSnapshot, _resetPoolCounters } from '../pool-counters';

describe('perf-tunables defaults', () => {
  it('every auto-adjust class defaults ON (default-on / opt-out)', () => {
    const d = defaultTunables();
    for (const cls of AUTO_ADJUST_CLASSES) {
      expect(d.autoAdjust[cls].enabled).toBe(true);
      expect(d.autoAdjust[cls].min).toBeLessThanOrEqual(d.autoAdjust[cls].max);
    }
    expect(d.learning.enabled).toBe(true);
  });
});

describe('sanitizeTunables', () => {
  it('clamps bounds into the per-class hard range and orders min ≤ max', () => {
    const t = sanitizeTunables({
      autoAdjust: {
        'spark-pool-size': { enabled: false, min: -5, max: 9999 },
        'cache-ttl': { enabled: true, min: 500, max: 2 }, // max < min → raised to min
      } as never,
    });
    expect(t.autoAdjust['spark-pool-size']).toEqual({
      enabled: false,
      min: AUTO_ADJUST_META['spark-pool-size'].hardMin,
      max: AUTO_ADJUST_META['spark-pool-size'].hardMax,
    });
    expect(t.autoAdjust['cache-ttl'].max).toBeGreaterThanOrEqual(t.autoAdjust['cache-ttl'].min);
    // Untouched classes keep defaults.
    expect(t.autoAdjust['adx-autoscale']).toEqual(defaultTunables().autoAdjust['adx-autoscale']);
  });

  it('clamps the cache override and drops junk fields', () => {
    const t = sanitizeTunables({
      cacheOverride: { enabled: true, ttlMs: 5, maxEntries: 10_000_000 } as never,
    });
    expect(t.cacheOverride.enabled).toBe(true);
    expect(t.cacheOverride.ttlMs).toBe(15_000);
    expect(t.cacheOverride.maxEntries).toBe(20_000);
    const empty = sanitizeTunables({ cacheOverride: { ttlMs: 'lots' } as never });
    expect(empty.cacheOverride.ttlMs).toBeUndefined();
  });
});

describe('nextDwu ladder', () => {
  it('steps one DWU up and stops at the top', () => {
    expect(nextDwu('DW100c')).toBe('DW200c');
    expect(nextDwu(DWU_LADDER[DWU_LADDER.length - 1])).toBeNull();
    expect(nextDwu('DW9999c')).toBeNull();
  });
});

describe('pool-counters', () => {
  beforeEach(() => _resetPoolCounters());

  it('tracks hit/miss rate and hit-acquire p50', () => {
    recordPoolAcquire(true, 800);
    recordPoolAcquire(true, 1200);
    recordPoolAcquire(false);
    const s = poolCountersSnapshot();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.missRate).toBeCloseTo(1 / 3, 5);
    expect(s.hitAcquireP50Ms).toBe(800);
    expect(s.lastMissAt).not.toBeNull();
  });

  it('starts empty with 0 miss rate', () => {
    const s = poolCountersSnapshot();
    expect(s.total).toBe(0);
    expect(s.missRate).toBe(0);
    expect(s.hitAcquireP50Ms).toBeNull();
  });
});
