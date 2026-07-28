/**
 * N7d — data-quality anomaly baseline (PURE, fully unit-testable, Azure-free).
 *
 * A hard data-quality RULE answers a fixed question ("is null-rate ≤ 2%?").
 * An anomaly BASELINE answers a different one: "is *today's* value out of line
 * with this check's own recent history?" — a null-rate that jumps from 0.1% to
 * 1.8% is still under a 2% rule threshold, yet it is a real regression the
 * baseline should trip. N7d runs the SAME rule-builder checks on the N4
 * transform runner and, alongside the pass/fail verdict, tracks each check's
 * numeric metric (violation count) across runs and flags a statistical outlier.
 *
 * Method (deliberately simple + explainable, no ML dependency so it runs in an
 * air-gapped IL5 enclave): a rolling window of the most-recent prior values →
 * population mean + population standard deviation → a z-score for the current
 * value. When the sample is too small for a z-score to be meaningful we fall
 * back to a relative-change test against the window mean. Both signals are
 * bounded and honest — every field the detector returns is derived, never faked.
 *
 * This module imports NOTHING (no cosmos, no runner) so the BFF, the store, and
 * the vitest suite all share one source of truth.
 */

/** One historical observation of a check's metric (any order — we sort by `at`). */
export interface MetricObservation {
  /** ISO-8601 timestamp of the run that produced this value. */
  at: string;
  /** The numeric metric — for a DQ check this is the violation-row count (≥ 0). */
  value: number;
}

/** The rolling baseline computed from a check's recent history. */
export interface MetricBaseline {
  /** Number of prior samples that fed the baseline. */
  samples: number;
  mean: number;
  /** Population standard deviation of the window. */
  stddev: number;
  /** Smallest value seen in the window. */
  min: number;
  /** Largest value seen in the window. */
  max: number;
}

/** Tunables for the detector. All have code defaults — NO env var (FLAG0/code-default). */
export interface AnomalyOptions {
  /** How many most-recent prior samples define "normal". Default 20. */
  window?: number;
  /** z-score magnitude that counts as an anomaly once the sample is large enough. Default 3. */
  zThreshold?: number;
  /** Below this many prior samples a z-score is untrustworthy → relative-change path. Default 4. */
  minSamplesForZ?: number;
  /**
   * Relative-change fallback: with too few samples, flag when the current value
   * exceeds the window mean by more than this fraction AND by an absolute floor.
   * Default 0.5 (a 50% jump).
   */
  relThreshold?: number;
  /**
   * Absolute floor so tiny counts don't trip on noise (e.g. 0 → 1 is not an
   * "anomaly" worth paging on). Default 5.
   */
  absFloor?: number;
}

/** The detector verdict for one check on one run. */
export interface AnomalyVerdict {
  isAnomaly: boolean;
  /** The current value that was scored. */
  value: number;
  baseline: MetricBaseline;
  /** z-score of `value` vs the baseline (null when stddev is 0 / too few samples). */
  zScore: number | null;
  /** Signed fractional change vs the baseline mean (null when mean is 0). */
  relativeChange: number | null;
  /** Which rule fired (or 'none'): drives the finding copy. */
  reason: 'z-score' | 'relative-change' | 'first-observation-spike' | 'none';
  /** Human-readable, receipt-grade explanation. */
  detail: string;
}

const DEFAULTS: Required<AnomalyOptions> = {
  window: 20,
  zThreshold: 3,
  minSamplesForZ: 4,
  relThreshold: 0.5,
  absFloor: 5,
};

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Compute the rolling baseline from a history. Takes the most-recent `window`
 * observations (by timestamp, newest-last), which the caller should supply
 * WITHOUT the current run. Returns a zeroed baseline with `samples: 0` when the
 * history is empty.
 */
export function computeBaseline(history: MetricObservation[], opts: AnomalyOptions = {}): MetricBaseline {
  const window = Math.max(1, Math.floor(opts.window ?? DEFAULTS.window));
  const clean = (history || [])
    .filter((h) => h && Number.isFinite(h.value))
    .slice()
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const win = clean.slice(-window);
  const samples = win.length;
  if (samples === 0) {
    return { samples: 0, mean: 0, stddev: 0, min: 0, max: 0 };
  }
  const values = win.map((w) => w.value);
  const mean = values.reduce((a, b) => a + b, 0) / samples;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / samples; // population
  const stddev = Math.sqrt(variance);
  return {
    samples,
    mean: round(mean, 4),
    stddev: round(stddev, 4),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * Score a current metric value against a baseline built from its own history.
 * Pure + deterministic. The two-path design keeps it honest with sparse data:
 *
 *   • ≥ minSamplesForZ samples and stddev > 0 → z-score path (|z| ≥ zThreshold).
 *   • otherwise → relative-change path (jump ≥ relThreshold AND ≥ absFloor).
 *
 * A brand-new check with no history never trips (samples 0 → not an anomaly),
 * unless the very first value is itself a large absolute spike above absFloor,
 * which is surfaced as `first-observation-spike` (a soft, non-anomaly note).
 */
export function detectAnomaly(
  value: number,
  history: MetricObservation[],
  opts: AnomalyOptions = {},
): AnomalyVerdict {
  const o: Required<AnomalyOptions> = { ...DEFAULTS, ...opts };
  const baseline = computeBaseline(history, o);
  const v = Number.isFinite(value) ? value : 0;

  const relativeChange = baseline.mean > 0 ? round((v - baseline.mean) / baseline.mean, 4) : null;
  let zScore: number | null = null;
  if (baseline.samples >= o.minSamplesForZ && baseline.stddev > 0) {
    zScore = round((v - baseline.mean) / baseline.stddev, 3);
  }

  // No history at all: only a large absolute value is worth a (soft) note.
  if (baseline.samples === 0) {
    if (v >= o.absFloor) {
      return {
        isAnomaly: false,
        value: v,
        baseline,
        zScore: null,
        relativeChange: null,
        reason: 'first-observation-spike',
        detail: `First recorded run — ${v} violation(s). No baseline yet; tracking begins now.`,
      };
    }
    return anomalyNone(v, baseline);
  }

  // z-score path (enough samples, real spread).
  if (zScore !== null) {
    if (Math.abs(zScore) >= o.zThreshold && v > baseline.mean && v - baseline.mean >= 1) {
      return {
        isAnomaly: true,
        value: v,
        baseline,
        zScore,
        relativeChange,
        reason: 'z-score',
        detail:
          `${v} violation(s) is z=${zScore} vs a baseline of ${baseline.mean} ± ${baseline.stddev} `
          + `over ${baseline.samples} run(s) — a statistical outlier (|z| ≥ ${o.zThreshold}).`,
      };
    }
    return anomalyNone(v, baseline, zScore, relativeChange);
  }

  // relative-change fallback (sparse or flat history).
  if (
    relativeChange !== null
    && relativeChange >= o.relThreshold
    && v - baseline.mean >= o.absFloor
  ) {
    return {
      isAnomaly: true,
      value: v,
      baseline,
      zScore,
      relativeChange,
      reason: 'relative-change',
      detail:
        `${v} violation(s) is +${round(relativeChange * 100, 1)}% above the recent mean of ${baseline.mean} `
        + `(${baseline.samples} run(s)) and up by ≥ ${o.absFloor} in absolute terms.`,
    };
  }

  return anomalyNone(v, baseline, zScore, relativeChange);
}

function anomalyNone(
  value: number,
  baseline: MetricBaseline,
  zScore: number | null = null,
  relativeChange: number | null = null,
): AnomalyVerdict {
  return {
    isAnomaly: false,
    value,
    baseline,
    zScore,
    relativeChange,
    reason: 'none',
    detail:
      baseline.samples === 0
        ? `${value} violation(s); no baseline yet.`
        : `${value} violation(s) is within the normal band (baseline ${baseline.mean} ± ${baseline.stddev}, ${baseline.samples} run(s)).`,
  };
}
