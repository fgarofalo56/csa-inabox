/**
 * forecast — a REAL, pure, dependency-free time-series forecaster for the
 * WS-2.3 AI/BI "Explain this metric" surface (Databricks AI/BI dashboards
 * parity, P1-8). This is the statistical engine behind the one-click Forecast
 * card: it fits an additive **Holt-Winters** (triple exponential smoothing)
 * model when a season length is supplied, or **Holt's linear** (double
 * exponential smoothing) trend otherwise, then projects the series forward with
 * a confidence band that widens with the horizon.
 *
 * no-vaporware.md: there is NO fabricated trend line here — every projected
 * point is the output of the smoothing recurrences over the REAL input series,
 * and the band is derived from the model's in-sample one-step residual standard
 * error (σ·√h·z), exactly as a real forecaster reports uncertainty. Pure +
 * unit-tested (lib/analytics/__tests__/forecast.test.ts): a linear ramp recovers
 * its slope, a repeating seasonal pattern is reproduced, and the band widens
 * monotonically with the horizon.
 *
 * no-fabric-dependency.md: pure client/server-safe math over the caller's rows —
 * no Power BI / Fabric / any network dependency. Runs identically in Commercial
 * and Gov.
 */

/** A single projected point beyond the history. `index` continues the 0-based
 *  position past the last historical point. */
export interface ForecastPoint {
  /** 0-based series position; forecast indices continue past `historyEndIndex`. */
  index: number;
  /** Point forecast (expected value). */
  y: number;
  /** Lower edge of the confidence band. */
  lower: number;
  /** Upper edge of the confidence band. */
  upper: number;
}

/** Which smoothing model produced a forecast. */
export type ForecastMethod = 'holt-winters' | 'holt-linear' | 'mean';

export interface ForecastResult {
  /** The model actually used (falls back gracefully on short / seasonless data). */
  method: ForecastMethod;
  /** Season length used (0 when the linear / mean model ran). */
  seasonLength: number;
  /** Index of the last historical point (values.length - 1). */
  historyEndIndex: number;
  /** In-sample one-step fitted values (same length as the input; NaN where undefined). */
  fitted: number[];
  /** Residual standard error the confidence band is scaled from. */
  sigma: number;
  /** The projected points. */
  points: ForecastPoint[];
}

export interface ForecastOptions {
  /** Points to project forward (clamped 1–120). Default 12. */
  periods?: number;
  /**
   * Season length. 0 / undefined ⇒ Holt's linear (no seasonality). ≥2 with
   * enough history (n ≥ 2·L) ⇒ additive Holt-Winters. Use {@link detectSeasonLength}
   * to auto-pick from the data.
   */
  seasonLength?: number;
  /** Confidence level for the band, 0–99.9 (default 95). */
  confidence?: number;
  /** Level smoothing (0–1, default 0.5). */
  alpha?: number;
  /** Trend smoothing (0–1, default 0.1). */
  beta?: number;
  /** Seasonal smoothing (0–1, default 0.1). */
  gamma?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : Number.NaN;
}

/**
 * Standard-normal quantile (probit) — Acklam's rational approximation. Turns a
 * confidence % into the two-sided ±z band multiplier; |error| < 1.15e-9 over the
 * full range, far tighter than needed to shade a band.
 */
export function normInv(p: number): number {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Two-sided z multiplier for a confidence % (0–99.9); 95 ⇒ ≈1.96. */
export function zForConfidence(confidence: number): number {
  const c = clamp(confidence, 0, 99.9) / 100;
  return normInv((1 + c) / 2);
}

/**
 * Auto-detect a likely season length from a series by ranking candidate lags on
 * sample autocorrelation. Returns 0 when no candidate shows meaningful periodicity
 * (autocorrelation ≤ 0.3), so the caller falls back to the linear model. Pure.
 */
export function detectSeasonLength(
  values: number[],
  candidates: number[] = [7, 12, 4, 24, 30, 52],
): number {
  const v = values.filter((x) => Number.isFinite(x));
  const n = v.length;
  if (n < 8) return 0;
  const m = mean(v);
  let denom = 0;
  for (let i = 0; i < n; i++) denom += (v[i] - m) ** 2;
  if (denom === 0) return 0;
  let best = 0;
  let bestAc = 0.3; // threshold — below this we treat the series as non-seasonal
  for (const L of candidates) {
    if (L < 2 || n < 2 * L) continue;
    let num = 0;
    for (let i = L; i < n; i++) num += (v[i] - m) * (v[i - L] - m);
    const ac = num / denom;
    if (ac > bestAc) { bestAc = ac; best = L; }
  }
  return best;
}

/**
 * Forecast a numeric series forward. NON-finite entries are dropped first (so a
 * result column with a stray null still forecasts). Returns null when there are
 * fewer than 2 usable points (nothing to fit a trend on). Deterministic — fixed
 * default smoothing parameters, no randomness.
 */
export function forecastSeries(values: number[], opts: ForecastOptions = {}): ForecastResult | null {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  const n = v.length;
  if (n < 2) return null;

  const periods = clamp(Math.round(opts.periods ?? 12), 1, 120);
  const confidence = opts.confidence ?? 95;
  const alpha = clamp(opts.alpha ?? 0.5, 0.001, 0.999);
  const beta = clamp(opts.beta ?? 0.1, 0.001, 0.999);
  const gamma = clamp(opts.gamma ?? 0.1, 0.001, 0.999);
  const z = zForConfidence(confidence);

  const reqL = Math.max(0, Math.floor(opts.seasonLength ?? 0));
  const useSeasonal = reqL >= 2 && n >= 2 * reqL;

  const fitted = new Array<number>(n).fill(Number.NaN);
  let points: ForecastPoint[];
  let method: ForecastMethod;
  let seasonLength = 0;

  if (useSeasonal) {
    method = 'holt-winters';
    seasonLength = reqL;
    const L = reqL;

    // Initialise level/trend from the first two seasons; seasonal from season 1.
    const firstSeason = v.slice(0, L);
    const secondSeason = v.slice(L, 2 * L);
    let level = mean(firstSeason);
    let trend = (mean(secondSeason) - mean(firstSeason)) / L;
    const seasonal = new Array<number>(n).fill(0);
    for (let i = 0; i < L; i++) seasonal[i] = v[i] - level;

    for (let t = L; t < n; t++) {
      const prevLevel = level;
      const prevTrend = trend;
      const sPrev = seasonal[t - L];
      fitted[t] = prevLevel + prevTrend + sPrev; // one-step-ahead forecast for t
      level = alpha * (v[t] - sPrev) + (1 - alpha) * (prevLevel + prevTrend);
      trend = beta * (level - prevLevel) + (1 - beta) * prevTrend;
      seasonal[t] = gamma * (v[t] - level) + (1 - gamma) * sPrev;
    }

    // Seasonal indices to reuse for the projection = the final full season.
    const lastSeason = seasonal.slice(n - L, n);
    points = [];
    for (let h = 1; h <= periods; h++) {
      const s = lastSeason[(h - 1) % L];
      const y = level + h * trend + s;
      points.push({ index: (n - 1) + h, y, lower: 0, upper: 0 });
    }
  } else {
    method = 'holt-linear';
    let level = v[0];
    let trend = v[1] - v[0];
    fitted[0] = v[0];
    for (let t = 1; t < n; t++) {
      const prevLevel = level;
      const prevTrend = trend;
      fitted[t] = prevLevel + prevTrend; // one-step-ahead forecast for t
      level = alpha * v[t] + (1 - alpha) * (prevLevel + prevTrend);
      trend = beta * (level - prevLevel) + (1 - beta) * prevTrend;
    }
    points = [];
    for (let h = 1; h <= periods; h++) {
      const y = level + h * trend;
      points.push({ index: (n - 1) + h, y, lower: 0, upper: 0 });
    }
  }

  // Residual standard error from the in-sample one-step residuals.
  let ss = 0;
  let cnt = 0;
  for (let t = 0; t < n; t++) {
    if (!Number.isFinite(fitted[t])) continue;
    ss += (v[t] - fitted[t]) ** 2;
    cnt++;
  }
  const sigma = cnt > 1 ? Math.sqrt(ss / (cnt - 1)) : 0;

  // Band widens with the horizon: ±z·σ·√h.
  for (let i = 0; i < points.length; i++) {
    const band = z * sigma * Math.sqrt(i + 1);
    points[i].lower = points[i].y - band;
    points[i].upper = points[i].y + band;
  }

  return { method, seasonLength, historyEndIndex: n - 1, fitted, sigma, points };
}
