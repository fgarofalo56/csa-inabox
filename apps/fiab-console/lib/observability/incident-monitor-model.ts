/**
 * N17 — observability MONITOR evaluation (PURE, Azure-free, fully unit-testable).
 *
 * The Monte-Carlo-style monitor grades three questions about a table's health,
 * each on the SAME vendor-neutral metric-observation history the run emitter
 * feeds it (no external ML, no SaaS observability service — the whole loop runs
 * DISCONNECTED in an air-gapped IL5 enclave):
 *
 *   • freshness   — is the table's newest data older than its freshness SLA
 *                   (and/or an outlier vs its own typical update cadence)?
 *   • volume      — is the row count a statistical outlier (spike OR drop) vs
 *                   its recent history? Reuses the N7d anomaly detector's
 *                   rolling baseline, but two-sided (a volume DROP is as much a
 *                   regression as a spike).
 *   • schema-drift — did the column set change (added / removed columns) vs the
 *                   most-recent prior observation?
 *
 * Baselines REUSE the N7d {@link computeBaseline} rolling window (task binding:
 * "baselines reuse the N7d anomaly detector if present else a server-side
 * z-score") so freshness/volume share one honest, explainable statistical core
 * with the data-quality anomaly path. This module imports ONLY that pure helper
 * — no cosmos, no runner — so the BFF, the store, and the vitest suite share one
 * source of truth.
 */

import { computeBaseline, type MetricObservation } from '@/lib/azure/dq-anomaly-baseline';

/** The three monitor questions N17 grades per table. */
export type MonitorKind = 'freshness' | 'volume' | 'schema-drift';

/** Severity a tripped monitor emits — mirrors the DqFindingSeverity band so an
 *  incident opened from a monitor or from an N7d finding reads the same. */
export type MonitorSeverity = 'info' | 'warning' | 'error';

/** One observation of a table's health metric at a point in time. */
export interface MonitorObservation {
  /** ISO-8601 timestamp the observation was taken. */
  at: string;
  /**
   * The numeric metric for this kind:
   *   • freshness — minutes since the table's newest data (data age).
   *   • volume    — row count.
   *   • schema-drift — column count (informational; the columns[] carry drift).
   */
  value: number;
  /** Column set at this observation (schema-drift compares these). */
  columns?: string[];
}

/** Tunables for a monitor. All have code defaults — NO env var (FLAG0/code-default). */
export interface MonitorConfig {
  kind: MonitorKind;
  /** freshness — hard SLA in minutes; newer-than this is healthy. Default 1440 (24 h). */
  freshnessSlaMinutes?: number;
  /** Rolling window size for the volume/freshness baseline. Default 20. */
  window?: number;
  /** |z| that counts as a volume outlier once the sample is large enough. Default 3. */
  zThreshold?: number;
  /** Below this many prior samples a z-score is untrustworthy → relative-change path. Default 4. */
  minSamplesForZ?: number;
  /** Relative-change fallback fraction (two-sided) when the sample is sparse. Default 0.5. */
  relThreshold?: number;
  /** Absolute floor so tiny counts don't trip on noise. Default 5. */
  absFloor?: number;
}

const DEFAULTS = {
  freshnessSlaMinutes: 1440,
  window: 20,
  zThreshold: 3,
  minSamplesForZ: 4,
  relThreshold: 0.5,
  absFloor: 5,
};

/** The metric snapshot behind a verdict (shape-compatible with DqFindingMetric). */
export interface MonitorMetric {
  name: string;
  value: number;
  baselineMean?: number;
  baselineStddev?: number;
  zScore?: number | null;
  threshold?: number;
}

/** The evaluation result for one monitor against one current observation. */
export interface MonitorVerdict {
  tripped: boolean;
  kind: MonitorKind;
  severity: MonitorSeverity;
  /** One-line title (incident row). */
  title: string;
  /** Full, receipt-grade explanation (incident detail). */
  detail: string;
  metric?: MonitorMetric;
  /** schema-drift only: the exact columns added / removed vs baseline. */
  schemaChange?: { added: string[]; removed: string[] };
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function toMetricHistory(history: MonitorObservation[]): MetricObservation[] {
  return (history || [])
    .filter((h) => h && Number.isFinite(h.value))
    .map((h) => ({ at: h.at, value: h.value }));
}

/** freshness — SLA hard-check, with the rolling cadence baseline as context. */
function evaluateFreshness(cfg: MonitorConfig, current: MonitorObservation, history: MonitorObservation[]): MonitorVerdict {
  const sla = Math.max(1, Math.floor(cfg.freshnessSlaMinutes ?? DEFAULTS.freshnessSlaMinutes));
  const ageMinutes = Number.isFinite(current.value) ? Math.max(0, current.value) : 0;
  const baseline = computeBaseline(toMetricHistory(history), { window: cfg.window ?? DEFAULTS.window });
  const metric: MonitorMetric = {
    name: 'data-age-minutes',
    value: round(ageMinutes),
    threshold: sla,
    ...(baseline.samples ? { baselineMean: baseline.mean, baselineStddev: baseline.stddev } : {}),
  };
  if (ageMinutes > sla) {
    return {
      tripped: true,
      kind: 'freshness',
      severity: 'error',
      title: `Freshness SLA breached — data is ${round(ageMinutes)} min old (SLA ${sla} min)`,
      detail:
        `The table's newest data is ${round(ageMinutes)} minute(s) old, past its ${sla}-minute freshness SLA` +
        (baseline.samples ? ` (typical update age ${baseline.mean} ± ${baseline.stddev} min over ${baseline.samples} run(s)).` : '.'),
      metric,
    };
  }
  return {
    tripped: false,
    kind: 'freshness',
    severity: 'info',
    title: `Fresh — data is ${round(ageMinutes)} min old (SLA ${sla} min)`,
    detail: `Newest data is ${round(ageMinutes)} minute(s) old, within the ${sla}-minute SLA.`,
    metric,
  };
}

/** volume — two-sided z-score / relative-change outlier (spike OR drop). */
function evaluateVolume(cfg: MonitorConfig, current: MonitorObservation, history: MonitorObservation[]): MonitorVerdict {
  const o = {
    window: cfg.window ?? DEFAULTS.window,
    zThreshold: cfg.zThreshold ?? DEFAULTS.zThreshold,
    minSamplesForZ: cfg.minSamplesForZ ?? DEFAULTS.minSamplesForZ,
    relThreshold: cfg.relThreshold ?? DEFAULTS.relThreshold,
    absFloor: cfg.absFloor ?? DEFAULTS.absFloor,
  };
  const v = Number.isFinite(current.value) ? current.value : 0;
  const baseline = computeBaseline(toMetricHistory(history), { window: o.window });
  let zScore: number | null = null;
  if (baseline.samples >= o.minSamplesForZ && baseline.stddev > 0) {
    zScore = round((v - baseline.mean) / baseline.stddev, 3);
  }
  const relativeChange = baseline.mean > 0 ? round((v - baseline.mean) / baseline.mean, 4) : null;
  const metric: MonitorMetric = {
    name: 'row-count',
    value: v,
    ...(baseline.samples ? { baselineMean: baseline.mean, baselineStddev: baseline.stddev } : {}),
    zScore,
  };

  // No baseline yet — never trip; tracking begins now.
  if (baseline.samples === 0) {
    return volumeHealthy(v, baseline, metric, 'No baseline yet; tracking begins now.');
  }

  // z-score path (two-sided).
  if (zScore !== null) {
    if (Math.abs(zScore) >= o.zThreshold && Math.abs(v - baseline.mean) >= 1) {
      const dir = v > baseline.mean ? 'spike' : 'drop';
      return {
        tripped: true,
        kind: 'volume',
        severity: 'error',
        title: `Volume ${dir} — ${v} rows (z=${zScore} vs ${baseline.mean} ± ${baseline.stddev})`,
        detail:
          `${v} row(s) is a ${dir} at z=${zScore} against a baseline of ${baseline.mean} ± ${baseline.stddev} ` +
          `over ${baseline.samples} run(s) — a statistical outlier (|z| ≥ ${o.zThreshold}).`,
        metric,
      };
    }
    return volumeHealthy(v, baseline, metric);
  }

  // relative-change fallback (two-sided) for sparse / flat history.
  if (
    relativeChange !== null &&
    Math.abs(relativeChange) >= o.relThreshold &&
    Math.abs(v - baseline.mean) >= o.absFloor
  ) {
    const dir = relativeChange > 0 ? 'spike' : 'drop';
    return {
      tripped: true,
      kind: 'volume',
      severity: 'warning',
      title: `Volume ${dir} — ${v} rows (${round(relativeChange * 100, 1)}% vs recent mean ${baseline.mean})`,
      detail:
        `${v} row(s) is ${round(relativeChange * 100, 1)}% off the recent mean of ${baseline.mean} ` +
        `(${baseline.samples} run(s)) and moved by ≥ ${o.absFloor} rows in absolute terms.`,
      metric,
    };
  }

  return volumeHealthy(v, baseline, metric);
}

function volumeHealthy(v: number, baseline: { mean: number; stddev: number; samples: number }, metric: MonitorMetric, note?: string): MonitorVerdict {
  return {
    tripped: false,
    kind: 'volume',
    severity: 'info',
    title: `Volume normal — ${v} rows`,
    detail:
      note ||
      `${v} row(s) is within the normal band (baseline ${baseline.mean} ± ${baseline.stddev}, ${baseline.samples} run(s)).`,
    metric,
  };
}

/** schema-drift — column-set delta vs the most-recent prior observation. */
function evaluateSchemaDrift(current: MonitorObservation, history: MonitorObservation[]): MonitorVerdict {
  const norm = (cols?: string[]) => [...new Set((cols || []).map((c) => String(c).trim()).filter(Boolean))];
  const currentCols = norm(current.columns);
  // The most-recent PRIOR observation that carried a column set is the baseline.
  const prior = [...(history || [])]
    .filter((h) => Array.isArray(h.columns) && h.columns.length)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0];
  const baselineCols = norm(prior?.columns);
  const metric: MonitorMetric = { name: 'column-count', value: currentCols.length };

  // No baseline schema yet (first observation) — record, never trip.
  if (!baselineCols.length) {
    return {
      tripped: false,
      kind: 'schema-drift',
      severity: 'info',
      title: `Schema recorded — ${currentCols.length} column(s)`,
      detail: 'First recorded schema; drift tracking begins now.',
      metric,
      schemaChange: { added: [], removed: [] },
    };
  }

  const baseSet = new Set(baselineCols);
  const curSet = new Set(currentCols);
  const added = currentCols.filter((c) => !baseSet.has(c));
  const removed = baselineCols.filter((c) => !curSet.has(c));

  if (added.length || removed.length) {
    // A removed/renamed column is breaking (error); a pure addition is a warning.
    const severity: MonitorSeverity = removed.length ? 'error' : 'warning';
    const parts: string[] = [];
    if (added.length) parts.push(`+${added.length} added (${added.slice(0, 8).join(', ')})`);
    if (removed.length) parts.push(`-${removed.length} removed (${removed.slice(0, 8).join(', ')})`);
    return {
      tripped: true,
      kind: 'schema-drift',
      severity,
      title: `Schema drift — ${parts.join('; ')}`,
      detail:
        `The column set changed vs the prior observation: ${parts.join('; ')}. ` +
        (removed.length ? 'Removed/renamed columns can break downstream consumers.' : 'New columns may need downstream mapping.'),
      metric,
      schemaChange: { added, removed },
    };
  }

  return {
    tripped: false,
    kind: 'schema-drift',
    severity: 'info',
    title: `Schema stable — ${currentCols.length} column(s)`,
    detail: 'No column additions or removals vs the prior observation.',
    metric,
    schemaChange: { added: [], removed: [] },
  };
}

/**
 * Evaluate one monitor against its current observation + prior history. Pure +
 * deterministic. `history` should be the observations BEFORE `current` (the
 * store passes the doc's rolling window). Returns a verdict the store promotes
 * into an incident when `tripped`.
 */
export function evaluateMonitor(
  cfg: MonitorConfig,
  current: MonitorObservation,
  history: MonitorObservation[],
): MonitorVerdict {
  switch (cfg.kind) {
    case 'freshness':
      return evaluateFreshness(cfg, current, history);
    case 'volume':
      return evaluateVolume(cfg, current, history);
    case 'schema-drift':
      return evaluateSchemaDrift(current, history);
    default:
      return {
        tripped: false,
        kind: cfg.kind,
        severity: 'info',
        title: 'Unknown monitor kind',
        detail: `Monitor kind "${cfg.kind}" is not recognized.`,
      };
  }
}
