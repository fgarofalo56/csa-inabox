import { describe, it, expect } from 'vitest';
import {
  detectAnomalies,
  computeAnomalies,
  normalizeRule,
  DEFAULT_ANOMALY_RULE,
  type DailyPoint,
} from '../cost-anomaly-core';

/** A flat baseline series with one injected spike on the last day. */
function seriesWithSpike(base: number, days: number, spike: number): DailyPoint[] {
  const out: DailyPoint[] = [];
  for (let i = 0; i < days - 1; i += 1) {
    out.push({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, cost: base });
  }
  out.push({ date: `2026-07-${String(days).padStart(2, '0')}`, cost: spike });
  return out;
}

describe('cost-anomaly-core.detectAnomalies', () => {
  it('returns [] for fewer than 3 days (insufficient stats)', () => {
    expect(detectAnomalies([{ date: 'd1', cost: 10 }, { date: 'd2', cost: 500 }])).toEqual([]);
    expect(detectAnomalies([])).toEqual([]);
  });

  it('flags a clear statistical spike as high severity (3sigma default)', () => {
    const daily = seriesWithSpike(100, 15, 1200);
    const out = detectAnomalies(daily);
    expect(out.length).toBeGreaterThanOrEqual(1);
    const spike = out.find((a) => a.date === '2026-07-15');
    expect(spike).toBeDefined();
    expect(spike!.severity).toBe('high');
    // expected == series mean; deviationPct is a large positive number.
    expect(spike!.expected).toBeGreaterThan(0);
    expect(spike!.deviationPct).toBeGreaterThan(100);
  });

  it('does NOT flag a perfectly flat series (zero variance, no jump)', () => {
    const flat: DailyPoint[] = Array.from({ length: 8 }, (_, i) => ({ date: `d${i}`, cost: 50 }));
    expect(detectAnomalies(flat)).toEqual([]);
  });

  it('flags a >50% day-over-day jump that sits above the mean even below 2σ', () => {
    // Gentle upward series then a 60% jump on the last day.
    const daily: DailyPoint[] = [
      { date: 'd1', cost: 90 }, { date: 'd2', cost: 100 }, { date: 'd3', cost: 95 },
      { date: 'd4', cost: 105 }, { date: 'd5', cost: 100 }, { date: 'd6', cost: 168 },
    ];
    const out = detectAnomalies(daily);
    expect(out.some((a) => a.date === 'd6')).toBe(true);
  });

  it('minAbsDelta floor suppresses a tiny-scope percentage outlier', () => {
    // 3× spike but only a $3 absolute delta over the mean → floored out at $10.
    const daily = seriesWithSpike(1, 8, 8);
    expect(detectAnomalies(daily, { scope: 's', method: '3sigma', threshold: 2, minAbsDelta: 10 })).toEqual([]);
    // Same series with no floor DOES flag it.
    expect(detectAnomalies(daily, { scope: 's', method: '3sigma', threshold: 2, minAbsDelta: 0 }).length).toBeGreaterThanOrEqual(1);
  });

  it("'pct' method flags a day exceeding the mean by more than threshold percent", () => {
    // Flat 100 baseline, last day 200 → +~100% over the (mean-shifted) baseline.
    const daily = seriesWithSpike(100, 8, 260);
    const out = detectAnomalies(daily, { scope: 'all', method: 'pct', threshold: 40, minAbsDelta: 0 });
    const spike = out.find((a) => a.date === '2026-07-08');
    expect(spike).toBeDefined();
    // Over 2× the threshold → high severity.
    expect(spike!.severity).toBe('high');
  });

  it('sorts high-severity, costliest-first', () => {
    const daily: DailyPoint[] = [
      { date: 'd1', cost: 100 }, { date: 'd2', cost: 100 }, { date: 'd3', cost: 100 },
      { date: 'd4', cost: 100 }, { date: 'd5', cost: 260 }, { date: 'd6', cost: 900 },
    ];
    const out = detectAnomalies(daily);
    // The $900 day is the most severe/costly and must lead.
    expect(out[0].date).toBe('d6');
  });
});

describe('cost-anomaly-core.normalizeRule', () => {
  it('fills defaults for a partial/empty rule', () => {
    expect(normalizeRule(undefined)).toEqual(DEFAULT_ANOMALY_RULE);
    expect(normalizeRule({})).toEqual(DEFAULT_ANOMALY_RULE);
  });

  it('defaults threshold per method and clamps invalid values', () => {
    expect(normalizeRule({ method: 'pct' }).threshold).toBe(50);
    expect(normalizeRule({ method: '3sigma' }).threshold).toBe(2);
    expect(normalizeRule({ threshold: -5 }).threshold).toBe(2);
    expect(normalizeRule({ minAbsDelta: -1 }).minAbsDelta).toBe(0);
  });
});

describe('cost-anomaly-core.computeAnomalies (back-compat shim)', () => {
  it('reproduces the default-rule detection exactly', () => {
    const daily = seriesWithSpike(100, 10, 1000);
    expect(computeAnomalies(daily)).toEqual(detectAnomalies(daily, DEFAULT_ANOMALY_RULE));
  });
});
