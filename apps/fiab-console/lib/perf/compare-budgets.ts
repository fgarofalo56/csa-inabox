/**
 * PSR-2 — perf-gate comparison engine (pure, no I/O).
 *
 * This is the TYPED, unit-tested reference implementation of the regression-budget
 * math used by the CI perf gate. The CI entrypoint lives in
 * `scripts/csa-loom/perf/compare-baseline.mjs` — a self-contained Node ESM script
 * (it reads the `perf-benchmarks` Cosmos container + `perf-budgets.json` and cannot
 * import this TS module at runtime without a build), so the two MUST mirror each
 * other. When you change the algorithm here, mirror it there (there is a test that
 * pins the shape). The future `/admin/performance` page can import this module
 * directly to render the same red/green verdict the gate computes.
 *
 * Contract (PSR-1, built in parallel on feat/psr1-benchmark-harness): a benchmark
 * RUN is a set of rows persisted to the `perf-benchmarks` Cosmos container, one row
 * per (metric, backend):
 *   { runId, gitSha, rev, metric, backend, p50, p95, p99, coldMs, warmMs, ts }
 *
 * Budget file (`perf-budgets.json`, repo root): per-metric p95 ceiling + max allowed
 * regression % vs the trailing-N baseline. See `perf-budgets.md` for the rationale of
 * each number (JSON carries no comments).
 *
 * A metric BREACHES when EITHER:
 *   • its latest p95 exceeds the absolute `p95CeilingMs` (a hard floor on how slow a
 *     surface may ever get, grounded in the Fabric outcome-equivalence bar), OR
 *   • its latest p95 regresses more than `maxRegressionPct` vs the trailing-N
 *     baseline median (catches a slow drift that stays under the ceiling).
 *
 * `overrideLabel` (CI env `OVERRIDE_LABEL`) records a documented, justified
 * regression (e.g. a deliberate cold-start trade): breaches are still COMPUTED and
 * printed, but `breached` is forced false so the gate goes green with the
 * justification attached — never a silent pass.
 */

/** One persisted benchmark row (PSR-1 `perf-benchmarks` doc shape). */
export interface PerfRow {
  runId: string;
  gitSha: string;
  rev?: string;
  metric: string;
  backend: string;
  p50: number;
  p95: number;
  p99: number;
  coldMs?: number;
  warmMs?: number;
  ts: string;
}

/** Per-metric budget (a value in `perf-budgets.json` `metrics`). */
export interface MetricBudget {
  /** Absolute p95 ceiling in ms — latest p95 above this ALWAYS breaches. */
  p95CeilingMs: number;
  /** Max allowed p95 regression vs the trailing-N baseline median, in percent. */
  maxRegressionPct: number;
  /** Optional Fabric outcome-equivalence reference bar (ms) — surfaced, not gated. */
  fabricBarMs?: number;
}

/** The full checked-in budget file. */
export interface PerfBudgets {
  version: number;
  /** How many prior runs form the baseline window. */
  trailingBaselineRuns: number;
  defaults: { maxRegressionPct: number };
  metrics: Record<string, MetricBudget>;
}

/** Per-(metric,backend) verdict. */
export interface MetricEvaluation {
  key: string;
  metric: string;
  backend: string;
  latestP95: number;
  /** Trailing-N baseline median p95, or null when there is no baseline yet. */
  baselineP95: number | null;
  /** Regression vs baseline in percent, or null when no baseline. */
  deltaPct: number | null;
  ceilingMs: number;
  maxRegressionPct: number;
  fabricBarMs: number | null;
  ceilingBreach: boolean;
  regressionBreach: boolean;
  breach: boolean;
  note: string;
}

export interface EvaluationInput {
  /** Rows of the run under test. */
  latest: PerfRow[];
  /** Rows of the trailing-N baseline runs (all runs flattened into one array). */
  baseline: PerfRow[];
  budgets: PerfBudgets;
  /** Documented justification for an accepted regression (CI `OVERRIDE_LABEL`). */
  overrideLabel?: string | null;
}

export interface EvaluationResult {
  evaluations: MetricEvaluation[];
  /** True when at least one metric breaches AND no override is in effect. */
  breached: boolean;
  /** True when breaches exist but an override label suppressed the red gate. */
  overridden: boolean;
  overrideLabel: string | null;
  /** Count of metrics that breached (regardless of override). */
  breachCount: number;
}

/** Stable "metric|backend" key. */
export function rowKey(metric: string, backend: string): string {
  return `${metric}|${backend}`;
}

/** Prefix of the dynamic per-surface page-TTI metric ids (`page-tti:<slug>`). */
export const PAGE_TTI_PREFIX = 'page-tti:';

/**
 * PSR-9 — resolve the budget that gates a metric, with a page-TTI fallback.
 *
 * The perf runner emits one `page-tti:<slug>` metric PER top surface (home,
 * catalog, copilot, …), but `perf-budgets.json` carries a single generic
 * `page-tti` ceiling. Without a fallback the exact-id lookup misses every
 * per-surface row and NONE of the surfaces are gated. This resolves, in order:
 *   1. an exact `page-tti:<slug>` entry (a per-surface override), else
 *   2. the generic `page-tti` entry (the shared TTI budget), else
 *   3. the metric's own exact entry (all non-TTI metrics), else undefined.
 * Pure — unit tested.
 */
export function resolveMetricBudget(budgets: PerfBudgets, metric: string): MetricBudget | undefined {
  const exact = budgets.metrics[metric];
  if (exact) return exact;
  if (metric.startsWith(PAGE_TTI_PREFIX)) return budgets.metrics['page-tti'];
  return undefined;
}

/** Median of a numeric array. Returns null for an empty array. */
export function median(values: number[]): number | null {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

/** Round to one decimal place (percent readability). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Group baseline rows into a trailing-N median p95 per (metric,backend). The
 * caller passes the already-selected trailing-N runs' rows; we simply reduce them
 * to one median per key (a metric can appear across many runs).
 */
export function baselineMedians(baseline: PerfRow[]): Map<string, number> {
  const buckets = new Map<string, number[]>();
  for (const r of baseline) {
    const k = rowKey(r.metric, r.backend);
    const arr = buckets.get(k);
    if (arr) arr.push(r.p95);
    else buckets.set(k, [r.p95]);
  }
  const out = new Map<string, number>();
  for (const [k, arr] of buckets) {
    const m = median(arr);
    if (m !== null) out.set(k, m);
  }
  return out;
}

/**
 * Evaluate a run against the budgets + trailing baseline. Pure — no I/O, no clock,
 * no env reads (the caller passes `overrideLabel`). Rows whose metric has no budget
 * entry are skipped (unbudgeted metrics never fail the gate; add a budget to gate
 * them). Deterministic ordering: breaches first, then by key.
 */
export function evaluateBudgets(input: EvaluationInput): EvaluationResult {
  const { latest, baseline, budgets } = input;
  const overrideLabel = input.overrideLabel && input.overrideLabel.trim() ? input.overrideLabel.trim() : null;
  const base = baselineMedians(baseline);
  const evaluations: MetricEvaluation[] = [];

  for (const row of latest) {
    const budget = resolveMetricBudget(budgets, row.metric);
    if (!budget) continue; // unbudgeted metric — surfaced by PSR-1, not gated here
    const maxReg = typeof budget.maxRegressionPct === 'number' ? budget.maxRegressionPct : budgets.defaults.maxRegressionPct;
    const k = rowKey(row.metric, row.backend);
    const baselineP95 = base.has(k) ? (base.get(k) as number) : null;
    const deltaPct = baselineP95 !== null && baselineP95 > 0 ? round1(((row.p95 - baselineP95) / baselineP95) * 100) : null;

    const ceilingBreach = row.p95 > budget.p95CeilingMs;
    const regressionBreach = deltaPct !== null && deltaPct > maxReg;
    const breach = ceilingBreach || regressionBreach;

    const notes: string[] = [];
    if (ceilingBreach) notes.push(`p95 ${row.p95}ms over ceiling ${budget.p95CeilingMs}ms`);
    if (regressionBreach) notes.push(`+${deltaPct}% vs baseline ${baselineP95}ms (max +${maxReg}%)`);
    if (!breach) {
      if (baselineP95 === null) notes.push('no baseline yet — ceiling-only');
      else notes.push(`ok (${deltaPct}% vs baseline, ceiling ${budget.p95CeilingMs}ms)`);
    }

    evaluations.push({
      key: k,
      metric: row.metric,
      backend: row.backend,
      latestP95: row.p95,
      baselineP95,
      deltaPct,
      ceilingMs: budget.p95CeilingMs,
      maxRegressionPct: maxReg,
      fabricBarMs: typeof budget.fabricBarMs === 'number' ? budget.fabricBarMs : null,
      ceilingBreach,
      regressionBreach,
      breach,
      note: notes.join('; '),
    });
  }

  evaluations.sort((a, b) => {
    if (a.breach !== b.breach) return a.breach ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const breachCount = evaluations.filter((e) => e.breach).length;
  return {
    evaluations,
    breachCount,
    overrideLabel,
    overridden: breachCount > 0 && overrideLabel !== null,
    breached: breachCount > 0 && overrideLabel === null,
  };
}

/** GitHub-flavoured markdown table of the verdict (posted to the roll receipt). */
export function renderMarkdownTable(result: EvaluationResult): string {
  const header =
    '| Metric | Backend | p95 | Baseline | Δ% | Ceiling | Fabric bar | Verdict |\n' +
    '|--------|---------|----:|---------:|---:|--------:|-----------:|:--------|';
  const rows = result.evaluations.map((e) => {
    const verdict = e.breach ? (result.overridden ? '⚠️ override' : '❌ BREACH') : '✅';
    const baseline = e.baselineP95 === null ? '—' : `${e.baselineP95}ms`;
    const delta = e.deltaPct === null ? '—' : `${e.deltaPct > 0 ? '+' : ''}${e.deltaPct}%`;
    const fabric = e.fabricBarMs === null ? '—' : `${e.fabricBarMs}ms`;
    return `| ${e.metric} | ${e.backend} | ${e.latestP95}ms | ${baseline} | ${delta} | ${e.ceilingMs}ms | ${fabric} | ${verdict} |`;
  });
  const summary = result.breached
    ? `\n\n**Perf gate: ❌ RED** — ${result.breachCount} metric(s) breached budget.`
    : result.overridden
      ? `\n\n**Perf gate: ⚠️ OVERRIDDEN** — ${result.breachCount} breach(es) accepted via \`OVERRIDE_LABEL=${result.overrideLabel}\`.`
      : '\n\n**Perf gate: ✅ GREEN** — all budgeted metrics within budget.';
  return `${header}\n${rows.join('\n')}${summary}`;
}
