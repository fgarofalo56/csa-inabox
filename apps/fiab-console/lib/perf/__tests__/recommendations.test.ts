/**
 * PERF-4.1 — recommendation derivation from synthetic measured signals +
 * apply-change validation/clamping (the route + auto-tune both call these).
 */
import { describe, expect, it } from 'vitest';
import {
  deriveRecommendations,
  validateApplyChange,
  MISS_RATE_THRESHOLD,
  type PerfSignals,
} from '../recommendations';
import { defaultTunables } from '../perf-tunables';

/** A healthy baseline snapshot — no rule should fire. */
function healthySignals(): PerfSignals {
  return {
    pool: {
      enabled: true,
      backendConfigured: true,
      min: 1,
      max: 3,
      idleTtlSecs: 900,
      reapEnabled: true,
      warm: 1,
      warming: 0,
    },
    poolAcquires: { hits: 10, misses: 0, missRate: 0 },
    livyQueue: { queued: 0, total: 2 },
    cache: { enabled: true, hits: 80, misses: 20, hitRate: 0.8, ttlMs: 60_000, size: 40, maxEntries: 500 },
    slo: [{ id: 'copilot-full-turn', met: true, burn: 0.2, sampled: 50, budgetMs: 30_000 }],
    trend: [
      { metric: 'spark-attach', p95: 5000, barMs: 7000 },
      { metric: 'adx-query', p95: 900, barMs: 5000 },
      { metric: 'warehouse-query-dedicated', p95: 700, barMs: 1000 },
    ],
    adx: { autoscaleEnabled: false, capacity: 2 },
    warehouse: { state: 'Online', sku: 'DW100c' },
  };
}

describe('deriveRecommendations', () => {
  it('is empty when every signal is inside its bars', () => {
    expect(deriveRecommendations(healthySignals(), defaultTunables())).toEqual([]);
  });

  it('recommends re-enabling a disabled pool when runs cold-start', () => {
    const s = healthySignals();
    s.pool.enabled = false;
    s.poolAcquires = { hits: 0, misses: 4, missRate: 1 };
    const recs = deriveRecommendations(s, defaultTunables());
    const rec = recs.find((r) => r.id === 'pool-disabled');
    expect(rec).toBeDefined();
    expect(rec!.apply).toEqual({ kind: 'spark-pool-config', patch: { enabled: true } });
    expect(rec!.severity).toBe('high');
    // Every card must carry measured evidence.
    expect(rec!.evidence.length).toBeGreaterThan(0);
  });

  it('raises the warm target on high miss rate, bounded by the admin max', () => {
    const s = healthySignals();
    s.poolAcquires = { hits: 2, misses: 4, missRate: 4 / 6 };
    const recs = deriveRecommendations(s, defaultTunables());
    const rec = recs.find((r) => r.id === 'pool-raise-min');
    expect(rec).toBeDefined();
    expect(rec!.apply).toMatchObject({ kind: 'spark-pool-config', patch: { min: 2 } });

    // At the admin bound (min == bounds.max) the rule must NOT fire.
    const bounded = healthySignals();
    bounded.poolAcquires = { hits: 2, misses: 4, missRate: 4 / 6 };
    bounded.pool.min = 3; // == default bounds.max
    expect(deriveRecommendations(bounded, defaultTunables()).find((r) => r.id === 'pool-raise-min')).toBeUndefined();
  });

  it('needs a minimum sample size before the miss-rate rule fires', () => {
    const s = healthySignals();
    s.poolAcquires = { hits: 0, misses: 2, missRate: 1 }; // only 2 acquires
    expect(deriveRecommendations(s, defaultTunables()).find((r) => r.id === 'pool-raise-min')).toBeUndefined();
  });

  it('extends the idle TTL on moderate miss rate within the admin bound', () => {
    const s = healthySignals();
    s.poolAcquires = { hits: 6, misses: 3, missRate: 3 / 9 };
    s.pool.idleTtlSecs = 900;
    const recs = deriveRecommendations(s, defaultTunables());
    const rec = recs.find((r) => r.id === 'pool-extend-ttl');
    expect(rec).toBeDefined();
    expect(rec!.apply).toMatchObject({ kind: 'spark-pool-config', patch: { idleTtlSecs: 1800 } });
    expect(s.poolAcquires.missRate).toBeGreaterThan(MISS_RATE_THRESHOLD / 2);
  });

  it('flags a deep Livy queue: enable-reaper when off, informational when on', () => {
    const s = healthySignals();
    s.livyQueue = { queued: 25, total: 30 };
    s.pool.reapEnabled = false;
    const withOff = deriveRecommendations(s, defaultTunables());
    expect(withOff.find((r) => r.id === 'pool-enable-reaper')?.apply).toEqual({
      kind: 'spark-pool-config',
      patch: { reapEnabled: true },
    });

    s.pool.reapEnabled = true;
    const withOn = deriveRecommendations(s, defaultTunables());
    const info = withOn.find((r) => r.id === 'pool-queue-depth');
    expect(info).toBeDefined();
    expect(info!.apply.kind).toBe('none');
  });

  it('recommends enabling the cache when disabled with real miss volume', () => {
    const s = healthySignals();
    s.cache = { ...s.cache, enabled: false, hits: 0, misses: 40, hitRate: 0 };
    const rec = deriveRecommendations(s, defaultTunables()).find((r) => r.id === 'cache-enable');
    expect(rec).toBeDefined();
    expect(rec!.apply).toEqual({ kind: 'cache-override', patch: { enabled: true } });
  });

  it('raises the cache TTL when hit-rate is under target, clamped to the bound', () => {
    const s = healthySignals();
    s.cache = { ...s.cache, hits: 10, misses: 40, hitRate: 0.2, ttlMs: 60_000 };
    const rec = deriveRecommendations(s, defaultTunables()).find((r) => r.id === 'cache-raise-ttl');
    expect(rec).toBeDefined();
    expect(rec!.apply).toMatchObject({ kind: 'cache-override', patch: { ttlMs: 120_000 } });

    // Already at the bound (900s default) → no rec.
    s.cache.ttlMs = 900_000;
    expect(deriveRecommendations(s, defaultTunables()).find((r) => r.id === 'cache-raise-ttl')).toBeUndefined();
  });

  it('surfaces a Copilot SLO breach as informational (no fabricated fix)', () => {
    const s = healthySignals();
    s.slo = [{ id: 'copilot-full-turn', met: false, burn: 2.4, sampled: 40, budgetMs: 30_000 }];
    const rec = deriveRecommendations(s, defaultTunables()).find((r) => r.id === 'slo-breach-copilot-full-turn');
    expect(rec).toBeDefined();
    expect(rec!.apply.kind).toBe('none');
  });

  it('recommends ADX optimized autoscale on p95 breach with autoscale off', () => {
    const s = healthySignals();
    s.trend = s.trend.map((t) => (t.metric === 'adx-query' ? { ...t, p95: 9000 } : t));
    const rec = deriveRecommendations(s, defaultTunables()).find((r) => r.id === 'adx-enable-autoscale');
    expect(rec).toBeDefined();
    expect(rec!.apply).toMatchObject({ kind: 'adx-autoscale', isEnabled: true, minimum: 2, maximum: 3 });

    // Autoscale already on → no rec.
    s.adx = { autoscaleEnabled: true, capacity: 2 };
    expect(deriveRecommendations(s, defaultTunables()).find((r) => r.id === 'adx-enable-autoscale')).toBeUndefined();
    // ADX unconfigured (null) → no rec.
    s.adx = null;
    expect(deriveRecommendations(s, defaultTunables()).find((r) => r.id === 'adx-enable-autoscale')).toBeUndefined();
  });

  it('recommends a one-step DWU scale-up within the ladder bound', () => {
    const s = healthySignals();
    s.trend = s.trend.map((t) => (t.metric === 'warehouse-query-dedicated' ? { ...t, p95: 4000 } : t));
    const rec = deriveRecommendations(s, defaultTunables()).find((r) => r.id === 'warehouse-scale-up');
    expect(rec).toBeDefined();
    expect(rec!.apply).toEqual({ kind: 'warehouse-scale', sku: 'DW200c' });

    // Next step above the admin ladder bound (default max index 1 = DW200c) → no rec.
    s.warehouse = { state: 'Online', sku: 'DW200c' }; // next would be DW300c (index 2 > 1)
    expect(deriveRecommendations(s, defaultTunables()).find((r) => r.id === 'warehouse-scale-up')).toBeUndefined();
    // Paused pool → no rec.
    s.warehouse = { state: 'Paused', sku: 'DW100c' };
    expect(deriveRecommendations(s, defaultTunables()).find((r) => r.id === 'warehouse-scale-up')).toBeUndefined();
  });

  it('flags ≥3 slow page-TTI surfaces as informational', () => {
    const s = healthySignals();
    s.trend.push(
      { metric: 'page-tti:home', p95: 5000, barMs: 2000 },
      { metric: 'page-tti:catalog', p95: 6000, barMs: 2000 },
      { metric: 'page-tti:monitor', p95: 4500, barMs: 2000 },
    );
    const rec = deriveRecommendations(s, defaultTunables()).find((r) => r.id === 'slow-bff-routes');
    expect(rec).toBeDefined();
    expect(rec!.apply.kind).toBe('none');
    expect(rec!.evidence.length).toBe(3);
  });

  it('ignores gated trend rows (never advises off an unmeasured backend)', () => {
    const s = healthySignals();
    s.trend = [{ metric: 'adx-query', p95: null, barMs: 5000, gated: true }];
    expect(deriveRecommendations(s, defaultTunables()).find((r) => r.id === 'adx-enable-autoscale')).toBeUndefined();
  });
});

describe('validateApplyChange', () => {
  const t = defaultTunables();

  it('rejects garbage', () => {
    expect(validateApplyChange(undefined, t).ok).toBe(false);
    expect(validateApplyChange({}, t).ok).toBe(false);
    expect(validateApplyChange({ kind: 'rm -rf' }, t).ok).toBe(false);
    expect(validateApplyChange({ kind: 'none' }, t).ok).toBe(false);
    expect(validateApplyChange({ kind: 'spark-pool-config', patch: {} }, t).ok).toBe(false);
  });

  it('clamps pool numbers into the admin bounds', () => {
    const v = validateApplyChange({ kind: 'spark-pool-config', patch: { min: 99, idleTtlSecs: 999_999 } }, t);
    expect(v.ok).toBe(true);
    expect(v.change).toEqual({
      kind: 'spark-pool-config',
      patch: { min: 3, idleTtlSecs: 3600 }, // clamped to default bounds
    });
  });

  it('passes booleans through and keeps valid numbers', () => {
    const v = validateApplyChange({ kind: 'spark-pool-config', patch: { enabled: true, min: 2 } }, t);
    expect(v.change).toEqual({ kind: 'spark-pool-config', patch: { enabled: true, min: 2 } });
  });

  it('clamps cache override values', () => {
    const v = validateApplyChange({ kind: 'cache-override', patch: { ttlMs: 10, maxEntries: 1 } }, t);
    expect(v.ok).toBe(true);
    expect(v.change).toEqual({ kind: 'cache-override', patch: { ttlMs: 60_000, maxEntries: 50 } });
  });

  it('clamps the ADX autoscale window and orders min ≤ max', () => {
    const v = validateApplyChange({ kind: 'adx-autoscale', isEnabled: true, minimum: 100, maximum: 1 }, t);
    expect(v.ok).toBe(true);
    expect(v.change).toEqual({ kind: 'adx-autoscale', isEnabled: true, minimum: 3, maximum: 3 });
    expect(validateApplyChange({ kind: 'adx-autoscale', minimum: 2, maximum: 3 }, t).ok).toBe(false); // no isEnabled
  });

  it('rejects out-of-ladder and out-of-bound warehouse SKUs', () => {
    expect(validateApplyChange({ kind: 'warehouse-scale', sku: 'DW6000c' }, t).ok).toBe(false);
    expect(validateApplyChange({ kind: 'warehouse-scale', sku: 'DW300c' }, t).ok).toBe(false); // index 2 > default bound 1
    const v = validateApplyChange({ kind: 'warehouse-scale', sku: 'DW200c' }, t);
    expect(v.ok).toBe(true);
    expect(v.change).toEqual({ kind: 'warehouse-scale', sku: 'DW200c' });
  });
});
