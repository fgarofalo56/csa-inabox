/**
 * key-drivers — a REAL, pure, dependency-free driver / feature-importance
 * ranker for the WS-2.3 AI/BI "Explain this metric" surface (Databricks AI/BI
 * dashboards parity, P1-8). This is the statistics engine behind the Key drivers
 * card: given a result set (columns + rows) and a chosen numeric METRIC, it ranks
 * every OTHER column by how strongly it relates to the metric.
 *
 * The relationship measure is chosen by the driver column's type:
 *   • numeric driver → **Pearson correlation** r with the metric, plus the
 *     standardized univariate regression coefficient (which equals r for a single
 *     standardized predictor). `direction` is the sign of r.
 *   • categorical driver → the **correlation ratio η** (eta), the square root of
 *     between-group variance over total variance of the metric grouped by the
 *     category — a real 0–1 association strength — plus the top category (the
 *     group with the highest mean metric).
 * Drivers are ranked by |importance| descending.
 *
 * no-vaporware.md: every number is a REAL statistic computed over the caller's
 * rows — no random importances, no fabricated ranking. Pure + unit-tested
 * (lib/analytics/__tests__/key-drivers.test.ts): a perfectly correlated column
 * ranks first with r≈1, a negatively correlated column reports direction
 * 'negative', a strong driver outranks a weak one, and a cleanly class-separated
 * categorical column yields a high η.
 *
 * no-fabric-dependency.md: pure client/server-safe math — no Power BI "Key
 * influencers" service, no Fabric, no network. Runs identically in Commercial and
 * Gov.
 */

/** How a driver's association to the metric was measured. */
export type DriverKind = 'numeric' | 'categorical';

export interface KeyDriver {
  /** Driver column name. */
  name: string;
  /** Which statistic was used. */
  kind: DriverKind;
  /** 0–1 association strength the ranking is sorted by (|r| or η). */
  importance: number;
  /** Numeric drivers: Pearson correlation r (−1..1). Undefined for categorical. */
  correlation?: number;
  /**
   * Numeric drivers: standardized univariate regression coefficient (= r for one
   * standardized predictor) — the metric change in σ per +1σ of the driver.
   */
  coefficient?: number;
  /** Direction of influence for numeric drivers. Null when not signed (categorical). */
  direction: 'positive' | 'negative' | null;
  /** Categorical drivers: the category with the highest mean metric. */
  topCategory?: string;
  /** Number of usable (both-finite / non-null) observations behind the stat. */
  sampleSize: number;
}

export interface KeyDriverResult {
  /** The analyzed metric column. */
  metric: string;
  /** Human label for the method used (surfaced honestly in the UI). */
  method: string;
  /** Drivers ranked by importance (desc). Columns with no signal are dropped. */
  drivers: KeyDriver[];
  /** Rows considered (after metric parsing). */
  rows: number;
}

export interface KeyDriverInput {
  columns: string[];
  /** Row-major matrix aligned to `columns`. */
  rows: unknown[][];
  /** The metric column name (must be numeric). */
  metric: string;
  /** Cap on how many drivers to return (default 12). */
  limit?: number;
  /** Max distinct categories for a column to be treated categorical (default 50). */
  maxCategories?: number;
}

function toNum(x: unknown): number | null {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x))) return Number(x);
  return null;
}

/** A column is numeric when every non-null cell parses as a finite number. */
function columnIsNumeric(rows: unknown[][], idx: number): boolean {
  let seen = 0;
  for (const r of rows) {
    const v = r[idx];
    if (v == null || v === '') continue;
    if (toNum(v) == null) return false;
    seen++;
  }
  return seen > 0;
}

/** Pearson correlation over paired finite samples; null when a side has no variance. */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  return Math.max(-1, Math.min(1, r));
}

/**
 * Correlation ratio η (eta): sqrt(SS_between / SS_total) of `metric` grouped by
 * `labels`. 0 ⇒ the category explains none of the metric's variance; 1 ⇒ it
 * explains all of it. Returns { eta, topCategory } or null when there's no
 * usable signal (single group, zero total variance).
 */
export function correlationRatio(
  labels: string[],
  metric: number[],
): { eta: number; topCategory: string } | null {
  const n = Math.min(labels.length, metric.length);
  if (n < 2) return null;
  const groups = new Map<string, number[]>();
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += metric[i];
    const g = groups.get(labels[i]);
    if (g) g.push(metric[i]); else groups.set(labels[i], [metric[i]]);
  }
  if (groups.size < 2) return null;
  const grand = total / n;
  let ssBetween = 0;
  let ssTotal = 0;
  for (let i = 0; i < n; i++) ssTotal += (metric[i] - grand) ** 2;
  if (ssTotal === 0) return null;
  let topCategory = '';
  let topMean = Number.NEGATIVE_INFINITY;
  for (const [cat, vals] of groups) {
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    ssBetween += vals.length * (m - grand) ** 2;
    if (m > topMean) { topMean = m; topCategory = cat; }
  }
  const eta = Math.sqrt(Math.max(0, Math.min(1, ssBetween / ssTotal)));
  return { eta, topCategory };
}

/**
 * Rank the drivers of `metric` across the other columns of a result set. Pure —
 * no mutation of the input, deterministic ordering. Columns that yield no signal
 * (constant, all-null, single-category) are dropped rather than shown at a bogus
 * rank (no-vaporware: never a ghost driver).
 */
export function rankKeyDrivers(input: KeyDriverInput): KeyDriverResult | null {
  const { columns, rows, metric } = input;
  const limit = Math.max(1, Math.floor(input.limit ?? 12));
  const maxCategories = Math.max(2, Math.floor(input.maxCategories ?? 50));
  const metricIdx = columns.indexOf(metric);
  if (metricIdx < 0) return null;
  if (!columnIsNumeric(rows, metricIdx)) return null;

  const drivers: KeyDriver[] = [];
  for (let c = 0; c < columns.length; c++) {
    if (c === metricIdx) continue;
    const name = columns[c];

    if (columnIsNumeric(rows, c)) {
      // Paired finite samples of (driver, metric).
      const xs: number[] = [];
      const ys: number[] = [];
      for (const r of rows) {
        const x = toNum(r[c]);
        const y = toNum(r[metricIdx]);
        if (x == null || y == null) continue;
        xs.push(x); ys.push(y);
      }
      const r = pearson(xs, ys);
      if (r == null) continue;
      drivers.push({
        name,
        kind: 'numeric',
        importance: Math.abs(r),
        correlation: r,
        coefficient: r, // standardized univariate slope == correlation
        direction: r >= 0 ? 'positive' : 'negative',
        sampleSize: xs.length,
      });
    } else {
      // Categorical: correlation ratio of the metric grouped by this column.
      const labels: string[] = [];
      const ys: number[] = [];
      const distinct = new Set<string>();
      for (const r of rows) {
        const y = toNum(r[metricIdx]);
        const raw = r[c];
        if (y == null || raw == null || raw === '') continue;
        const lbl = String(raw);
        labels.push(lbl); ys.push(y); distinct.add(lbl);
      }
      if (distinct.size < 2 || distinct.size > maxCategories) continue;
      const cr = correlationRatio(labels, ys);
      if (cr == null) continue;
      drivers.push({
        name,
        kind: 'categorical',
        importance: cr.eta,
        direction: null,
        topCategory: cr.topCategory,
        sampleSize: ys.length,
      });
    }
  }

  drivers.sort((a, b) => b.importance - a.importance);
  return {
    metric,
    method: 'Pearson correlation (numeric) + correlation ratio η (categorical), ranked by strength',
    drivers: drivers.slice(0, limit),
    rows: rows.length,
  };
}
