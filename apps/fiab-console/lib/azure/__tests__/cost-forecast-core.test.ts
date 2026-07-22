/**
 * C2 — unit tests for the pure FinOps forecast math (cost-forecast-core.ts):
 * least-squares linear projection, the 7-day weekday-profile seasonal
 * projection, the ±1σ residual band, the run-rate period-end fallback
 * (verbatim semantics of the former in-line stub), the Forecast API response
 * fold (grounded on the Learn sample response shape), and the multi-sub merge.
 */
import { describe, it, expect } from 'vitest';
import {
  addDaysIso,
  bandApiSeries,
  daysInMonthOf,
  fitLeastSquares,
  mergeForecastRows,
  parseForecastRows,
  periodEndProjection,
  pickComputedMethod,
  projectDaily,
  residualSigma,
  runRatePeriodEnd,
  weekdayOf,
  weekdayProfile,
  type DailyCost,
} from '../cost-forecast-core';

/** Build a date-ascending daily series starting at `startIso`. */
function series(startIso: string, costs: number[]): DailyCost[] {
  return costs.map((cost, i) => ({ date: addDaysIso(startIso, i), cost }));
}

describe('fitLeastSquares + residualSigma', () => {
  it('recovers slope/intercept exactly on a clean ramp (σ = 0)', () => {
    const values = [10, 12, 14, 16, 18]; // y = 10 + 2t
    const fit = fitLeastSquares(values);
    expect(fit.slope).toBeCloseTo(2, 10);
    expect(fit.intercept).toBeCloseTo(10, 10);
    const predicted = values.map((_, t) => fit.intercept + fit.slope * t);
    expect(residualSigma(values, predicted)).toBeCloseTo(0, 10);
  });

  it('is flat for constant series and safe for tiny inputs', () => {
    expect(fitLeastSquares([5, 5, 5]).slope).toBeCloseTo(0, 10);
    expect(fitLeastSquares([7])).toEqual({ slope: 0, intercept: 7 });
    expect(fitLeastSquares([])).toEqual({ slope: 0, intercept: 0 });
  });
});

describe('projectDaily — linear', () => {
  it('continues a clean ramp with a collapsed band (σ = 0)', () => {
    const daily = series('2026-07-01', [10, 12, 14, 16, 18]);
    const { points, sigma, method } = projectDaily(daily, 3, 'linear');
    expect(method).toBe('linear');
    expect(sigma).toBeCloseTo(0, 8);
    expect(points.map((p) => p.date)).toEqual(['2026-07-06', '2026-07-07', '2026-07-08']);
    expect(points[0].cost).toBeCloseTo(20, 6);
    expect(points[2].cost).toBeCloseTo(24, 6);
    // Collapsed band on a perfect fit — honest, not fabricated width.
    expect(points[0].lowerBound).toBeCloseTo(points[0].cost, 6);
    expect(points[0].upperBound).toBeCloseTo(points[0].cost, 6);
  });

  it('carries a ±1σ band on a noisy series and clamps at ≥ 0', () => {
    const daily = series('2026-07-01', [10, 14, 9, 15, 8, 16, 10, 15]);
    const { points, sigma } = projectDaily(daily, 2, 'linear');
    expect(sigma).toBeGreaterThan(0);
    for (const p of points) {
      expect(p.upperBound).toBeCloseTo(p.cost + sigma, 1);
      expect(p.lowerBound).toBeGreaterThanOrEqual(0);
      expect(p.lowerBound).toBeLessThanOrEqual(p.cost);
      expect(p.costStatus).toBe('Forecast');
    }
    // A declining/no-spend series never projects negative cost.
    const declining = series('2026-07-01', [5, 4, 3, 2, 1]);
    const proj = projectDaily(declining, 10, 'linear');
    for (const p of proj.points) expect(p.cost).toBeGreaterThanOrEqual(0);
  });
});

describe('weekdayProfile + projectDaily — seasonal', () => {
  // 2026-07-06 is a Monday (UTC). Weekdays $100, weekends $20 — the classic
  // dev-estate burn shape.
  const weekdayCost = (dateIso: string) => (weekdayOf(dateIso) === 0 || weekdayOf(dateIso) === 6 ? 20 : 100);
  const twoWeeks = Array.from({ length: 14 }, (_, i) => {
    const date = addDaysIso('2026-07-06', i);
    return { date, cost: weekdayCost(date) };
  });

  it('learns weekend dips (factor < 1) and weekday peaks (factor > 1)', () => {
    const factors = weekdayProfile(twoWeeks);
    expect(factors[0]).toBeLessThan(0.5);  // Sunday
    expect(factors[6]).toBeLessThan(0.5);  // Saturday
    expect(factors[1]).toBeGreaterThan(1); // Monday
    expect(factors[3]).toBeGreaterThan(1); // Wednesday
  });

  it('reproduces the weekly SHAPE in the projection (weekends clearly below weekdays)', () => {
    // Note: the least-squares trend over a phase-shifted weekly pattern is not
    // perfectly flat (weekends trail each week), so exact point equality is not
    // the contract — the multiplicative weekday SHAPE is: projected weekend
    // days must sit clearly below every projected weekday, and the in-sample
    // residual σ must be > 0 (the band honestly reflects the model error).
    const { points, method, sigma } = projectDaily(twoWeeks, 7, 'seasonal');
    expect(method).toBe('seasonal');
    expect(sigma).toBeGreaterThan(0);
    const weekdayPts = points.filter((p) => weekdayOf(p.date) >= 1 && weekdayOf(p.date) <= 5);
    const weekendPts = points.filter((p) => weekdayOf(p.date) === 0 || weekdayOf(p.date) === 6);
    expect(weekdayPts.length).toBe(5);
    expect(weekendPts.length).toBe(2);
    const minWeekday = Math.min(...weekdayPts.map((p) => p.cost));
    const maxWeekend = Math.max(...weekendPts.map((p) => p.cost));
    expect(maxWeekend).toBeLessThan(minWeekday / 2); // 20-vs-100 profile survives
  });

  it('projects a FLAT series with weekday factors exactly (zero-slope case)', () => {
    // A flat series has an exactly-zero LS slope and factor 1 everywhere —
    // the seasonal projection must reproduce it verbatim with σ = 0.
    const flat = series('2026-07-06', Array.from({ length: 14 }, () => 42));
    const { points, sigma } = projectDaily(flat, 7, 'seasonal');
    expect(sigma).toBeCloseTo(0, 8);
    for (const p of points) expect(p.cost).toBeCloseTo(42, 6);
  });

  it('degrades to factor 1 on empty/zero series', () => {
    expect(weekdayProfile([])).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(weekdayProfile(series('2026-07-01', [0, 0, 0]))).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});

describe('pickComputedMethod', () => {
  const d14 = series('2026-07-01', Array.from({ length: 14 }, () => 10));
  const d5 = series('2026-07-01', [10, 10, 10, 10, 10]);
  it("auto → seasonal at ≥ 14 days of history, linear below", () => {
    expect(pickComputedMethod(d14, 'auto')).toBe('seasonal');
    expect(pickComputedMethod(d5, 'auto')).toBe('linear');
  });
  it('forced prefs honored; forced seasonal degrades honestly on tiny series', () => {
    expect(pickComputedMethod(d14, 'linear')).toBe('linear');
    expect(pickComputedMethod(d14, 'seasonal')).toBe('seasonal');
    expect(pickComputedMethod(d5, 'seasonal')).toBe('linear');
  });
});

describe('runRatePeriodEnd (the former in-line stub, verbatim semantics)', () => {
  it('projects (total / daysElapsed) × daysInMonth for MTD', () => {
    const daily = series('2026-07-01', Array.from({ length: 10 }, () => 50));
    // total 500 over 10 days of a 31-day July → 1550.
    expect(runRatePeriodEnd(500, daily, 'MonthToDate')).toBeCloseTo((500 / 10) * 31, 6);
  });
  it('returns the total for fixed windows and 0 for a zero-total MTD', () => {
    const daily = series('2026-07-01', [1, 2, 3]);
    expect(runRatePeriodEnd(123.45, daily, 'Last30Days')).toBe(123.45);
    expect(runRatePeriodEnd(0, daily, 'MonthToDate')).toBe(0);
  });
});

describe('periodEndProjection — seasonal', () => {
  it('adds the seasonal remainder for the rest of the month to the actual total', () => {
    // 14 flat $10 days ending 2026-07-14 → 17 remaining July days at ~$10.
    const daily = series('2026-07-01', Array.from({ length: 14 }, () => 10));
    const total = 140;
    const projected = periodEndProjection(total, daily, 'MonthToDate', 'seasonal');
    expect(projected).toBeGreaterThan(total);
    expect(projected).toBeCloseTo(140 + 17 * 10, -1); // within ~$5
  });
  it('linear delegates to the run-rate; fixed windows pass through', () => {
    const daily = series('2026-07-01', Array.from({ length: 10 }, () => 50));
    expect(periodEndProjection(500, daily, 'MonthToDate', 'linear')).toBeCloseTo((500 / 10) * 31, 6);
    expect(periodEndProjection(999, daily, 'Last7Days', 'seasonal')).toBe(999);
  });
});

describe('parseForecastRows (grounded on the Learn 2025-03-01 sample shape)', () => {
  const resp = {
    properties: {
      columns: [
        { name: 'PreTaxCost', type: 'Number' },
        { name: 'UsageDate', type: 'Number' },
        { name: 'CostStatus', type: 'String' },
        { name: 'Currency', type: 'String' },
      ],
      rows: [
        [12.5, 20260720, 'Actual', 'USD'],
        [2.1, 20260721, 'Forecast', 'USD'],
        [3.4, 20260721, 'Forecast', 'USD'], // same date+status → summed
        [4.0, 20260722, 'Forecast', 'USD'],
      ],
    },
  };

  it('folds rows, converts yyyymmdd dates, sums same-date rows, detects currency', () => {
    const { rows, currency } = parseForecastRows(resp);
    expect(currency).toBe('USD');
    expect(rows).toEqual([
      { date: '2026-07-20', cost: 12.5, costStatus: 'Actual' },
      { date: '2026-07-21', cost: expect.closeTo(5.5, 6), costStatus: 'Forecast' },
      { date: '2026-07-22', cost: 4.0, costStatus: 'Forecast' },
    ]);
  });

  it('handles the CostUSD column name and empty/malformed responses', () => {
    const usd = {
      properties: {
        columns: [{ name: 'CostUSD' }, { name: 'UsageDate' }, { name: 'CostStatus' }],
        rows: [[7, 20260801, 'Forecast']],
      },
    };
    expect(parseForecastRows(usd).rows).toEqual([{ date: '2026-08-01', cost: 7, costStatus: 'Forecast' }]);
    expect(parseForecastRows(null).rows).toEqual([]);
    expect(parseForecastRows({ properties: { columns: [{ name: 'Nope' }], rows: [[1]] } }).rows).toEqual([]);
  });
});

describe('mergeForecastRows + bandApiSeries (multi-sub Loom scope)', () => {
  it('sums per date; a mixed Actual/Forecast date is honestly Forecast', () => {
    const merged = mergeForecastRows([
      [
        { date: '2026-07-20', cost: 10, costStatus: 'Actual' },
        { date: '2026-07-21', cost: 5, costStatus: 'Forecast' },
      ],
      [
        { date: '2026-07-20', cost: 3, costStatus: 'Actual' },
        { date: '2026-07-21', cost: 2, costStatus: 'Actual' }, // other sub still actual
      ],
    ]);
    expect(merged).toEqual([
      { date: '2026-07-20', cost: 13, costStatus: 'Actual' },
      { date: '2026-07-21', cost: 7, costStatus: 'Forecast' },
    ]);
  });

  it('bands only Forecast rows, from the actuals’ residual σ', () => {
    const rows = [
      ...series('2026-07-01', [10, 14, 9, 15, 8, 16]).map((d) => ({ ...d, costStatus: 'Actual' as const })),
      { date: '2026-07-07', cost: 12, costStatus: 'Forecast' as const },
    ];
    const banded = bandApiSeries(rows);
    const actual = banded[0];
    expect(actual.lowerBound).toBe(actual.cost);
    expect(actual.upperBound).toBe(actual.cost);
    const fc = banded[banded.length - 1];
    expect(fc.costStatus).toBe('Forecast');
    expect(fc.upperBound).toBeGreaterThan(fc.cost);
    expect(fc.lowerBound).toBeLessThan(fc.cost);
    expect(fc.lowerBound).toBeGreaterThanOrEqual(0);
  });
});

describe('date helpers', () => {
  it('addDaysIso crosses month/year boundaries in UTC', () => {
    expect(addDaysIso('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('daysInMonthOf knows July has 31 and Feb-2028 has 29', () => {
    expect(daysInMonthOf('2026-07-15')).toBe(31);
    expect(daysInMonthOf('2028-02-01')).toBe(29);
  });
});
