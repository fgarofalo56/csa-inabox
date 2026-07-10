/**
 * Tests for the PSR-5/PSR-6 cache hit/miss counters + snapshot aggregation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  recordCacheHit,
  recordCacheMiss,
  backendHitRate,
  cacheCountersSnapshot,
  resetCacheCounters,
} from '../cache-counters';

beforeEach(() => resetCacheCounters());

describe('cache-counters', () => {
  it('starts at zero hit-rate with no lookups', () => {
    expect(backendHitRate('result-cache')).toBe(0);
    expect(cacheCountersSnapshot().total.hitRate).toBe(0);
  });

  it('computes per-backend hit-rate', () => {
    recordCacheHit('adx');
    recordCacheHit('adx');
    recordCacheMiss('adx');
    expect(backendHitRate('adx')).toBeCloseTo(2 / 3, 5);
  });

  it('aggregates a total across backends', () => {
    recordCacheHit('result-cache');
    recordCacheMiss('result-cache');
    recordCacheHit('tabular');
    const snap = cacheCountersSnapshot();
    expect(snap.byBackend['result-cache']).toEqual({ hits: 1, misses: 1, hitRate: 0.5 });
    expect(snap.byBackend.tabular.hits).toBe(1);
    expect(snap.total).toEqual({ hits: 2, misses: 1, hitRate: 2 / 3 });
  });

  it('reset clears every counter', () => {
    recordCacheHit('adx');
    resetCacheCounters();
    expect(cacheCountersSnapshot().total).toEqual({ hits: 0, misses: 0, hitRate: 0 });
  });
});
