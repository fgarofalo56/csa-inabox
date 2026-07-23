/**
 * C3 (loom-next-level ws-copilot-cost.md) — the PURE cost-anomaly detection core.
 *
 * Extracted (extract-once, import-both) from the inline `computeAnomalies` that
 * used to live in `cost-client.ts`, so the SAME detection runs in two places:
 *   - the console (cost-client `computeLoomCostSummary` → the /monitor Cost tab
 *     + /admin/finops anomaly feed), and
 *   - the scheduled cost-anomaly monitor (an IN-VNET ACA Job that POSTs
 *     /api/internal/cost-anomaly/run — the route imports THIS module so the
 *     firing logic is byte-identical to what the UI shows; per the estate
 *     constraint the runner is a Container App Job, NOT a Y1 Function).
 *
 * ZERO Azure-SDK / server-only imports — pure math + types, unit-tested in
 * `__tests__/cost-anomaly-core.test.ts`, safe to import from anywhere.
 *
 * `detectAnomalies(daily, rule)` generalizes the original 3σ heuristic with a
 * per-scope threshold config (`AnomalyRuleConfig`): a `'3sigma'` statistical
 * method (the historical default — a day above mean+threshold·σ, or a >50%
 * day-over-day jump that also sits above the mean) OR a `'pct'` method (a day
 * whose spend exceeds the series mean by more than `threshold` percent), both
 * floored by `minAbsDelta` so a trivially-small absolute jump on a tiny scope
 * never pages anyone. `computeAnomalies(daily)` is the back-compat shim that
 * reproduces the original output EXACTLY (default rule).
 */

/** A single day of spend in one scope. */
export interface DailyPoint {
  date: string;
  cost: number;
}

/** How a rule decides a day is anomalous. */
export type AnomalyMethod = '3sigma' | 'pct';

/**
 * Per-scope anomaly rule. `scope` is the cost scope the daily series was pulled
 * for — a subscription id, a resource-group / tag scope, or `'all'` for the
 * whole Loom estate (the default, estate-wide series `computeLoomCostSummary`
 * already produces).
 */
export interface AnomalyRuleConfig {
  /** Cost scope this rule watches ('all' = the whole Loom estate). */
  scope: string;
  /** Detection method (default '3sigma'). */
  method: AnomalyMethod;
  /**
   * '3sigma' → the σ multiple a day must clear over the mean (default 2; a day
   *   over mean+3σ is 'high'). 'pct' → the percent over the series mean a day
   *   must exceed (e.g. 50 = +50%; over 2× the threshold is 'high').
   */
  threshold: number;
  /**
   * Absolute spend floor (billing currency): a flagged day's cost-minus-mean
   * must be at least this, so a percentage/σ outlier on a near-zero scope is
   * suppressed. Default 0 (no floor).
   */
  minAbsDelta: number;
}

/** A daily-spend outlier — the shape both the UI and the alert path consume. */
export interface CostAnomaly {
  date: string;
  cost: number;
  /** The series mean the day is compared against (the "expected" run-rate). */
  expected: number;
  /** Signed % deviation of `cost` from `expected`. */
  deviationPct: number;
  severity: 'high' | 'medium';
}

/** The back-compat default rule — reproduces the original `computeAnomalies`. */
export const DEFAULT_ANOMALY_RULE: AnomalyRuleConfig = {
  scope: 'all',
  method: '3sigma',
  threshold: 2,
  minAbsDelta: 0,
};

/** Fill any missing rule fields with the defaults (rules read from Cosmos may
 * be partial / older-schema). Clamps threshold/minAbsDelta to sane floors. */
export function normalizeRule(rule: Partial<AnomalyRuleConfig> | undefined | null): AnomalyRuleConfig {
  const method: AnomalyMethod = rule?.method === 'pct' ? 'pct' : '3sigma';
  const rawThreshold = Number(rule?.threshold);
  const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0
    ? rawThreshold
    : method === 'pct' ? 50 : 2;
  const rawMin = Number(rule?.minAbsDelta);
  const minAbsDelta = Number.isFinite(rawMin) && rawMin > 0 ? rawMin : 0;
  return { scope: String(rule?.scope || 'all'), method, threshold, minAbsDelta };
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

interface SeriesStats {
  mean: number;
  stddev: number;
}

function stats(costs: number[]): SeriesStats {
  const n = costs.length;
  const mean = costs.reduce((a, b) => a + b, 0) / n;
  const variance = costs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Detect daily-spend anomalies in one scope's series against `rule`. Needs at
 * least 3 days for a meaningful mean/σ; otherwise returns []. Never throws.
 *
 * Most-severe / costliest first (the order the UI + the alert summary use).
 */
export function detectAnomalies(
  daily: DailyPoint[],
  rule: Partial<AnomalyRuleConfig> | AnomalyRuleConfig = DEFAULT_ANOMALY_RULE,
): CostAnomaly[] {
  if (!Array.isArray(daily) || daily.length < 3) return [];
  const r = normalizeRule(rule);
  const costs = daily.map((d) => Number(d.cost) || 0);
  const { mean, stddev } = stats(costs);
  const out: CostAnomaly[] = [];

  for (let i = 0; i < daily.length; i += 1) {
    const date = daily[i].date;
    const cost = costs[i];
    const prev = i > 0 ? costs[i - 1] : null;
    const dod = prev != null && prev > 0 ? ((cost - prev) / prev) * 100 : null;
    // Absolute floor: the over-mean delta must clear minAbsDelta (default 0).
    if (cost - mean < r.minAbsDelta) continue;

    let flagged = false;
    let high = false;
    if (r.method === 'pct') {
      const devPct = mean > 0 ? ((cost - mean) / mean) * 100 : 0;
      const pctOutlier = mean > 0 && devPct > r.threshold;
      const dodOutlier = dod != null && dod > 50 && cost > mean;
      flagged = pctOutlier || dodOutlier;
      high = mean > 0 && devPct > 2 * r.threshold;
    } else {
      // '3sigma' — the historical default (threshold = σ multiple, default 2).
      const sigmaOutlier = stddev > 0 && cost > mean + r.threshold * stddev;
      const dodOutlier = dod != null && dod > 50 && cost > mean;
      flagged = sigmaOutlier || dodOutlier;
      high = stddev > 0 && cost > mean + 3 * stddev;
    }
    if (!flagged) continue;

    out.push({
      date,
      cost: round2(cost),
      expected: round2(mean),
      deviationPct: mean > 0 ? Math.round(((cost - mean) / mean) * 1000) / 10 : 0,
      severity: high ? 'high' : 'medium',
    });
  }

  return out.sort((a, b) => (a.severity === b.severity ? b.cost - a.cost : a.severity === 'high' ? -1 : 1));
}

/**
 * Back-compat shim — the original estate-wide `computeAnomalies(daily)` with the
 * exact same output as before the C3 extraction (default 3σ rule). Re-exported
 * by cost-client.ts so its callers are unchanged.
 */
export function computeAnomalies(daily: DailyPoint[]): CostAnomaly[] {
  return detectAnomalies(daily, DEFAULT_ANOMALY_RULE);
}
