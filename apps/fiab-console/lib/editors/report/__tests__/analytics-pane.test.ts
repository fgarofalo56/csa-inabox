/**
 * A7 — analytics-pane depth: golden numeric harness for the report analytics
 * compute layer.
 *
 * Ground truth (FRESH0, 2026-07-23): the full Power BI analytics line set
 * (trend / constant / min / max / average / median / percentile), error bars
 * (field / percent / value), forecast (linear + seasonal + widening band),
 * symmetry shading, and anomaly detection ALREADY ship — config UI
 * (AnalyticsPane), compute (this module) and render (LoomChart RefLines* /
 * AnomalyOverlay / error-bar whiskers). The real gap A7 closes is that the
 * compute layer had ZERO tests. This harness pins each statistic to an exact
 * numeric result over seeded data (grade rubric: A = B + Vitest covered) and
 * proves the anomaly band flags a real injected outlier — the A7 acceptance.
 */
import { describe, it, expect } from 'vitest';
import {
  computeReferenceLines,
  computeErrorBars,
  computeForecast,
  computeSymmetry,
  computeAnomalies,
  numericSeriesFromRows,
  seriesNamesFromRows,
  type ReportAnalytics,
  type AnalyticsLine,
  type AnalyticsLineKind,
} from '../analytics-pane';

// Seeded, perfectly-linear series: min 10, max 50, mean 30, median 30, and a
// clean y=10+10i trend so every statistic has a hand-checkable golden value.
const ROWS = [
  { Month: 'Jan', Revenue: 10 },
  { Month: 'Feb', Revenue: 20 },
  { Month: 'Mar', Revenue: 30 },
  { Month: 'Apr', Revenue: 40 },
  { Month: 'May', Revenue: 50 },
];

const line = (kind: AnalyticsLineKind, over: Partial<AnalyticsLine> = {}): AnalyticsLine => ({
  id: `l-${kind}`, kind, color: 'c', style: 'solid', showLabel: false, ...over,
});
const analytics = (lines: AnalyticsLine[]): ReportAnalytics => ({ lines });

describe('numericSeriesFromRows — series extraction', () => {
  it('splits the label column from the numeric series', () => {
    const s = numericSeriesFromRows(ROWS);
    expect(s).toHaveLength(1);
    expect(s[0].name).toBe('Revenue');
    expect(s[0].values).toEqual([10, 20, 30, 40, 50]);
    expect(seriesNamesFromRows(ROWS)).toEqual(['Revenue']);
  });
});

describe('computeReferenceLines — every PBI line kind, exact golden value', () => {
  const yOf = (kind: AnalyticsLineKind, over: Partial<AnalyticsLine> = {}) =>
    computeReferenceLines(ROWS, analytics([line(kind, over)]))[0];

  it('min / max / average / median', () => {
    expect(yOf('min').y).toBe(10);
    expect(yOf('max').y).toBe(50);
    expect(yOf('average').y).toBe(30);
    expect(yOf('median').y).toBe(30);
  });

  it('median of an even-count series is the mid-pair average', () => {
    const evenRows = ROWS.slice(0, 4); // 10,20,30,40 → (20+30)/2 = 25
    expect(computeReferenceLines(evenRows, analytics([line('median')]))[0].y).toBe(25);
  });

  it('percentile (type-7 linear interpolation): p25=20, p50=30, p90=46', () => {
    expect(yOf('percentile', { percentile: 25 }).y).toBe(20);
    expect(yOf('percentile', { percentile: 50 }).y).toBe(30);
    expect(yOf('percentile', { percentile: 90 }).y).toBeCloseTo(46, 10);
  });

  it('trend: least-squares endpoints of a perfect line = [10, 50]', () => {
    const t = yOf('trend');
    expect(t.y).toBeCloseTo(10, 10);
    expect(t.y2).toBeCloseTo(50, 10);
  });

  it('constant: the typed value flows straight through (no series needed)', () => {
    expect(yOf('constant', { value: 25 }).y).toBe(25);
  });

  it('constant on the category axis is marked vertical (orientation:v)', () => {
    expect(yOf('constant', { value: 2, axis: 'x' }).orientation).toBe('v');
  });

  it('a non-finite constant is skipped (honest: nothing to draw)', () => {
    expect(computeReferenceLines(ROWS, analytics([line('constant')]))).toHaveLength(0);
  });

  it('showLabel renders a "<name> · <value>" label', () => {
    const l = yOf('average', { showLabel: true });
    expect(l.label).toContain('30');
  });
});

describe('computeErrorBars — all three derivation modes', () => {
  it('percent mode: ±10% of each center value', () => {
    const eb = computeErrorBars(ROWS, {
      lines: [], errorBars: [{ id: 'e', mode: 'percent', percent: 10, color: 'c', showLabel: false }],
    })[0];
    // center 30 (index 2) → 27..33
    const p = eb.points[2];
    expect(p.center).toBe(30);
    expect(p.low).toBeCloseTo(27, 10);
    expect(p.high).toBeCloseTo(33, 10);
  });

  it('value mode: ± a fixed absolute amount', () => {
    const eb = computeErrorBars(ROWS, {
      lines: [], errorBars: [{ id: 'e', mode: 'value', value: 5, color: 'c', showLabel: false }],
    })[0];
    expect(eb.points[0]).toMatchObject({ center: 10, low: 5, high: 15 });
  });

  it('field mode: picked upper/lower series are the absolute bounds', () => {
    const rows = [
      { Month: 'Jan', Revenue: 10, Lo: 8, Hi: 13 },
      { Month: 'Feb', Revenue: 20, Lo: 17, Hi: 24 },
    ];
    const eb = computeErrorBars(rows, {
      lines: [],
      errorBars: [{ id: 'e', mode: 'field', measure: 'Revenue', upperField: 'Hi', lowerField: 'Lo', color: 'c', showLabel: false }],
    })[0];
    expect(eb.points[0]).toMatchObject({ center: 10, low: 8, high: 13 });
    expect(eb.points[1]).toMatchObject({ center: 20, low: 17, high: 24 });
  });
});

describe('computeForecast — linear projection + confidence band', () => {
  it('perfect linear history projects exactly, zero band (residuals=0)', () => {
    const fc = computeForecast(ROWS, { id: 'f', periods: 2, confidence: 95 })!;
    expect(fc.historyEndIndex).toBe(4);
    expect(fc.points).toHaveLength(2);
    // slope 10, intercept 10 → k=5 ⇒ 60, k=6 ⇒ 70; perfect fit ⇒ band 0
    expect(fc.points[0]).toMatchObject({ index: 5 });
    expect(fc.points[0].y).toBeCloseTo(60, 6);
    expect(fc.points[1].y).toBeCloseTo(70, 6);
    expect(fc.points[0].upper - fc.points[0].y).toBeCloseTo(0, 6);
  });

  it('imperfect history widens the band with the forecast horizon (√h)', () => {
    const noisy = [10, 12, 11, 15, 14, 20, 19, 25].map((Revenue, i) => ({ Month: `p${i}`, Revenue }));
    const fc = computeForecast(noisy, { id: 'f', periods: 3, confidence: 95 })!;
    const b1 = fc.points[0].upper - fc.points[0].y;
    const b2 = fc.points[1].upper - fc.points[1].y;
    const b3 = fc.points[2].upper - fc.points[2].y;
    expect(b1).toBeGreaterThan(0);
    expect(b2).toBeGreaterThan(b1);
    expect(b3).toBeGreaterThan(b2);
  });

  it('returns null with < 2 points of history (nothing to fit)', () => {
    expect(computeForecast([{ Month: 'Jan', Revenue: 10 }], { id: 'f', periods: 2 })).toBeNull();
  });
});

describe('computeSymmetry — scatter parity diagonal', () => {
  it('enabled ⇒ the y=x extent spans the combined numeric range', () => {
    // A leading label column so BOTH X and Y count as numeric series.
    const rows = [{ Pt: 'a', X: 1, Y: 9 }, { Pt: 'b', X: 4, Y: 2 }];
    const sym = computeSymmetry(rows, { lines: [], symmetry: { id: 's', enabled: true, color: 'c' } })!;
    expect(sym.min).toBe(1);
    expect(sym.max).toBe(9);
  });

  it('disabled ⇒ null (no ghost overlay)', () => {
    const rows = [{ Pt: 'a', X: 1, Y: 9 }];
    expect(computeSymmetry(rows, { lines: [], symmetry: { id: 's', enabled: false, color: 'c' } })).toBeNull();
  });
});

describe('computeAnomalies — flags a real injected outlier', () => {
  // n=64 ⇒ trailing window = clamp(round(64/8),3,24) = 8, large enough that a
  // single spike does not dominate its own window statistics.
  const flat = Array.from({ length: 64 }, (_, i) => ({ T: `t${i}`, V: 100 }));
  const spiked = flat.map((r, i) => (i === 40 ? { ...r, V: 1000 } : r));

  it('a clear spike is flagged at high sensitivity, with an expected band', () => {
    const res = computeAnomalies(spiked, {
      lines: [], anomalies: [{ id: 'a', sensitivity: 100, color: 'c' }],
    });
    expect(res).toHaveLength(1);
    expect(res[0].points).toHaveLength(64);
    expect(res[0].band.length).toBeGreaterThan(0);
    const flaggedCount = res[0].points.filter((p) => p.isAnomaly).length;
    expect(flaggedCount).toBeGreaterThanOrEqual(1);
    expect(res[0].points[40].value).toBe(1000);
    expect(res[0].points[40].isAnomaly).toBe(true);
  });

  it('a perfectly flat series produces no overlay (dropped, no ghost band)', () => {
    const res = computeAnomalies(flat, {
      lines: [], anomalies: [{ id: 'a', sensitivity: 100, color: 'c' }],
    });
    expect(res).toHaveLength(0);
  });
});
