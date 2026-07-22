/**
 * cost-forecast-core — C2 (loom-next-level): the PURE math behind the FinOps
 * forecast. Zero imports from the live cost clients (no barrel/module cycle —
 * cost-client.ts imports THIS module for its linear-run-rate fallback while
 * cost-forecast.ts imports cost-client for the live fan-out).
 *
 * Three projection methods, each honestly labeled on every result so the UI
 * can say exactly what produced the number (`ux-baseline` honesty bar):
 *
 *   'api'      — the real Cost Management Forecast API
 *                (POST {scope}/providers/Microsoft.CostManagement/forecast,
 *                 parsed here by {@link parseForecastRows}; the live caller
 *                 lives in cost-forecast.ts).
 *   'linear'   — least-squares straight-line fit over the REAL daily series
 *                (the former in-line MTD run-rate stays available as
 *                 {@link runRatePeriodEnd} — it IS the linear fallback path).
 *   'seasonal' — a 7-day weekday profile (weekday mean ÷ overall mean)
 *                multiplied onto the least-squares trend — matches the weekly
 *                burn shape of dev/prod estates (weekend dips).
 *
 * Confidence bands: the Forecast API returns point forecasts only (grounded:
 * response columns are Cost/UsageDate/CostStatus/Currency — no bounds), so for
 * EVERY method the band is ±1σ of the in-sample daily residuals (spec C2),
 * clamped at ≥ 0. σ = 0 (perfect fit / too-short series) collapses the band
 * onto the point forecast — honest, not fabricated.
 *
 * Unit-tested in __tests__/cost-forecast-core.test.ts (fixture series).
 */

export type CostForecastMethod = 'api' | 'linear' | 'seasonal';

/** Operator preference (LOOM_COST_FORECAST_METHOD): 'auto' tries the real API
 * first and falls back to the computed projection; the rest force a method. */
export type CostForecastMethodPref = 'auto' | CostForecastMethod;

export interface DailyCost {
  /** ISO date (yyyy-mm-dd, UTC). */
  date: string;
  cost: number;
}

export interface CostForecastPoint {
  date: string;
  cost: number;
  lowerBound: number;
  upperBound: number;
  /** 'Actual' rows anchor the chart; 'Forecast' rows carry the band. */
  costStatus: 'Actual' | 'Forecast';
}

// ── date helpers (UTC, yyyy-mm-dd strings) ──────────────────────────────────

export function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 (Sun) … 6 (Sat) for a yyyy-mm-dd date, UTC. */
export function weekdayOf(dateIso: string): number {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay();
}

/** Days in the calendar month containing the given date (UTC). */
export function daysInMonthOf(dateIso: string): number {
  const d = new Date(`${dateIso.slice(0, 7)}-01T00:00:00Z`);
  return new Date(d.getUTCFullYear(), d.getUTCMonth() + 1, 0).getUTCDate();
}

// ── least-squares fit + residual σ ──────────────────────────────────────────

export interface LinearFit { slope: number; intercept: number; }

/** Ordinary least-squares y = intercept + slope·t over t = 0…n-1. n=1 → flat. */
export function fitLeastSquares(values: number[]): LinearFit {
  const n = values.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  if (n === 1) return { slope: 0, intercept: values[0] };
  let sumT = 0; let sumY = 0; let sumTT = 0; let sumTY = 0;
  for (let t = 0; t < n; t += 1) {
    sumT += t; sumY += values[t]; sumTT += t * t; sumTY += t * values[t];
  }
  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumTY - sumT * sumY) / denom;
  const intercept = (sumY - slope * sumT) / n;
  return { slope, intercept };
}

/** Sample standard deviation of (value − predicted) residuals (n-1 divisor). */
export function residualSigma(values: number[], predicted: number[]): number {
  const n = Math.min(values.length, predicted.length);
  if (n < 2) return 0;
  let ss = 0;
  for (let i = 0; i < n; i += 1) ss += (values[i] - predicted[i]) ** 2;
  return Math.sqrt(ss / (n - 1));
}

// ── weekday profile (seasonal) ──────────────────────────────────────────────

/**
 * 7-entry multiplicative weekday profile: factor[weekday] = mean(cost on that
 * weekday) ÷ overall mean. Weekdays with no samples (or a zero overall mean)
 * get factor 1 so the seasonal method degrades to the plain trend.
 */
export function weekdayProfile(daily: DailyCost[]): number[] {
  const factors = new Array<number>(7).fill(1);
  if (daily.length === 0) return factors;
  const overall = daily.reduce((a, d) => a + d.cost, 0) / daily.length;
  if (!(overall > 0)) return factors;
  const sums = new Array<number>(7).fill(0);
  const counts = new Array<number>(7).fill(0);
  for (const d of daily) {
    const w = weekdayOf(d.date);
    sums[w] += d.cost;
    counts[w] += 1;
  }
  for (let w = 0; w < 7; w += 1) {
    if (counts[w] > 0) factors[w] = sums[w] / counts[w] / overall;
  }
  return factors;
}

// ── projections ─────────────────────────────────────────────────────────────

const clamp0 = (n: number) => (n > 0 ? n : 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ProjectionResult {
  method: 'linear' | 'seasonal';
  /** Forward daily points (Forecast status) with the ±1σ band. */
  points: CostForecastPoint[];
  /** In-sample residual standard deviation the band is built from. */
  sigma: number;
}

/**
 * Project the daily series `horizonDays` forward with a least-squares straight
 * line ('linear') or the trend × weekday profile ('seasonal'). Series must be
 * date-ascending (the cost-client daily fold already sorts). < 2 points fits a
 * flat line at the single observed value (or 0), honestly σ = 0.
 */
export function projectDaily(
  daily: DailyCost[],
  horizonDays: number,
  method: 'linear' | 'seasonal',
): ProjectionResult {
  const h = Math.max(1, Math.floor(horizonDays));
  const values = daily.map((d) => d.cost);
  const fit = fitLeastSquares(values);
  const trendAt = (t: number) => clamp0(fit.intercept + fit.slope * t);
  const factors = method === 'seasonal' ? weekdayProfile(daily) : null;
  const lastDate = daily.length ? daily[daily.length - 1].date : new Date().toISOString().slice(0, 10);

  const predictAt = (t: number, dateIso: string): number => {
    const base = trendAt(t);
    return factors ? base * factors[weekdayOf(dateIso)] : base;
  };

  // In-sample predictions → residual σ (the ±1σ band per the C2 spec).
  const inSample = daily.map((d, t) => predictAt(t, d.date));
  const sigma = residualSigma(values, inSample);

  const points: CostForecastPoint[] = [];
  for (let i = 1; i <= h; i += 1) {
    const date = addDaysIso(lastDate, i);
    const y = predictAt(daily.length - 1 + i, date);
    points.push({
      date,
      cost: r2(clamp0(y)),
      lowerBound: r2(clamp0(y - sigma)),
      upperBound: r2(clamp0(y + sigma)),
      costStatus: 'Forecast',
    });
  }
  return { method, points, sigma };
}

/**
 * Which computed method 'auto' resolves to: 'seasonal' needs at least two full
 * weeks of history to have a meaningful weekday profile; otherwise 'linear'.
 * A forced 'seasonal' with < 8 points also degrades to 'linear' (honest: a
 * profile over < 2 samples per weekday is noise, not seasonality).
 */
export function pickComputedMethod(
  daily: DailyCost[],
  pref: CostForecastMethodPref,
): 'linear' | 'seasonal' {
  if (pref === 'linear') return 'linear';
  if (pref === 'seasonal') return daily.length >= 8 ? 'seasonal' : 'linear';
  return daily.length >= 14 ? 'seasonal' : 'linear';
}

// ── period-end scalars (the Cost tab / chargeback KPI) ──────────────────────

/**
 * The C1-era linear RUN-RATE period-end projection, verbatim semantics of the
 * former in-line stub in cost-client.ts (C2 keeps it as THE linear fallback):
 * (total ÷ daysElapsed) × daysInMonth for MTD timeframes; the period total
 * itself for fixed windows.
 */
export function runRatePeriodEnd(total: number, daily: DailyCost[], timeframe: string): number {
  if ((timeframe !== 'MonthToDate' && timeframe !== 'BillingMonthToDate') || daily.length === 0) {
    return total;
  }
  const daysElapsed = Math.max(1, daily.length);
  const ref = daily[daily.length - 1].date;
  const daysInMonth = daysInMonthOf(ref);
  return total > 0 ? (total / daysElapsed) * daysInMonth : 0;
}

/**
 * Period-end projection for the summary KPI by computed method:
 *   'linear'   → {@link runRatePeriodEnd} (the exact former stub).
 *   'seasonal' → actual-to-date + Σ seasonal projections over the REMAINING
 *                days of the month the series ends in.
 */
export function periodEndProjection(
  total: number,
  daily: DailyCost[],
  timeframe: string,
  method: 'linear' | 'seasonal',
): number {
  if (method === 'linear') return runRatePeriodEnd(total, daily, timeframe);
  if ((timeframe !== 'MonthToDate' && timeframe !== 'BillingMonthToDate') || daily.length === 0) {
    return total;
  }
  const ref = daily[daily.length - 1].date;
  const remaining = daysInMonthOf(ref) - Number(ref.slice(8, 10));
  if (remaining <= 0) return total;
  const proj = projectDaily(daily, remaining, 'seasonal');
  return total + proj.points.reduce((a, p) => a + p.cost, 0);
}

// ── Forecast API response fold ──────────────────────────────────────────────

const COST_COL_NAMES = new Set(['cost', 'costusd', 'pretaxcost', 'pretaxcostusd']);

export interface ParsedForecastRow {
  date: string;
  cost: number;
  costStatus: 'Actual' | 'Forecast';
}

/**
 * Pure fold of one Cost Management Forecast response
 * (`properties.columns` / `properties.rows`) into date-ascending rows. Robust
 * to the cost column being named Cost / CostUSD / PreTaxCost / PreTaxCostUSD
 * (varies by aggregation + offer) and to UsageDate arriving as the numeric
 * yyyymmdd the API emits. Rows for the same date+status are summed (grain
 * safety). Returns the detected currency ('' when absent).
 */
export function parseForecastRows(resp: any): { rows: ParsedForecastRow[]; currency: string } {
  const cols: any[] = resp?.properties?.columns || [];
  const rows: any[][] = resp?.properties?.rows || [];
  const lower = cols.map((c) => String(c?.name || '').toLowerCase());
  const iCost = lower.findIndex((n) => COST_COL_NAMES.has(n));
  const iDate = lower.indexOf('usagedate');
  const iStatus = lower.indexOf('coststatus');
  const iCur = lower.indexOf('currency');
  if (iCost < 0 || iDate < 0) return { rows: [], currency: '' };
  let currency = '';
  const byKey = new Map<string, ParsedForecastRow>();
  for (const r of rows) {
    const raw = String(r[iDate] ?? '');
    const date = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw.slice(0, 10);
    if (!date) continue;
    const costStatus: ParsedForecastRow['costStatus'] =
      iStatus >= 0 && String(r[iStatus] ?? '').toLowerCase() === 'actual' ? 'Actual' : 'Forecast';
    if (iCur >= 0 && !currency && r[iCur]) currency = String(r[iCur]);
    const key = `${date}|${costStatus}`;
    const prev = byKey.get(key);
    const cost = Number(r[iCost]) || 0;
    if (prev) prev.cost += cost;
    else byKey.set(key, { date, cost, costStatus });
  }
  return {
    rows: Array.from(byKey.values()).sort((a, b) => a.date.localeCompare(b.date) || a.costStatus.localeCompare(b.costStatus)),
    currency,
  };
}

/**
 * Sum several per-scope forecast row sets into one series (the multi-sub Loom
 * scope): costs summed per date; a date is 'Actual' only when EVERY
 * contributing scope reported it actual (a mixed date is honestly 'Forecast').
 */
export function mergeForecastRows(series: ParsedForecastRow[][]): ParsedForecastRow[] {
  const byDate = new Map<string, { cost: number; allActual: boolean }>();
  for (const rows of series) {
    for (const row of rows) {
      const prev = byDate.get(row.date) || { cost: 0, allActual: true };
      prev.cost += row.cost;
      prev.allActual = prev.allActual && row.costStatus === 'Actual';
      byDate.set(row.date, prev);
    }
  }
  return Array.from(byDate.entries())
    .map(([date, v]): ParsedForecastRow => ({ date, cost: v.cost, costStatus: v.allActual ? 'Actual' : 'Forecast' }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Attach the ±1σ band to a merged API series: 'Actual' rows carry a collapsed
 * band (they are observations, not estimates); 'Forecast' rows get ±1σ of the
 * actual rows' residuals against their own least-squares trend — the C2 rule
 * ("bands from the API when present; else ±1σ of the daily residuals" — the
 * API returns point forecasts only, so the residual band always applies).
 */
export function bandApiSeries(rows: ParsedForecastRow[]): CostForecastPoint[] {
  const actuals = rows.filter((p) => p.costStatus === 'Actual');
  const values = actuals.map((p) => p.cost);
  const fit = fitLeastSquares(values);
  const predicted = values.map((_, t) => clamp0(fit.intercept + fit.slope * t));
  const sigma = residualSigma(values, predicted);
  return rows.map((p): CostForecastPoint => ({
    date: p.date,
    cost: r2(p.cost),
    lowerBound: p.costStatus === 'Actual' ? r2(p.cost) : r2(clamp0(p.cost - sigma)),
    upperBound: p.costStatus === 'Actual' ? r2(p.cost) : r2(clamp0(p.cost + sigma)),
    costStatus: p.costStatus,
  }));
}
