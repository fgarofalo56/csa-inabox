/**
 * SLO1 — unified SLO / error-budget rollup (PURE, browser-safe, unit-tested).
 *
 * The loom-next-level program already SHIPS the SLIs but no single place shows
 * objective vs actual vs error-budget burn. This module is the pure rollup the
 * Health & Reliability hub's SLO tab renders; the BFF route (/api/admin/slo)
 * reads the REAL stores and hands the raw inputs here — no Azure calls, no
 * clock, no env in this file (the route resolves those):
 *
 *   • Availability — the V1 synthetic user-journey verdicts (28-day window),
 *     bucketed per day for the error-budget burn-down sparkline.
 *   • Latency      — the Copilot first-token + full-turn SLOs
 *     (lib/perf/copilot-slo evaluateSlo, over the in-process rolling window).
 *   • Efficiency   — the result-cache hit-rate (lib/perf/cache-counters),
 *     an informational SLI (a floor, not an error-budget — never pages).
 *
 * The SLO *program* (RED SLI catalog, multi-window multi-burn-rate alerting)
 * lives in PRPs/active/enterprise-hardening appendix-ops-slo-loadtest §1; this
 * is the in-product SURFACE that feeds it, not a second program.
 *
 * NO Fabric / Power BI dependency — every number comes from Loom-internal
 * Azure-native telemetry (no-vaporware.md, no-fabric-dependency.md).
 * Grounding: Google SRE Workbook error-budget + multi-window burn-rate alerting
 * (https://sre.google/workbook/alerting-on-slos/).
 */

import type { SloEvaluation } from '@/lib/perf/copilot-slo';
import type { SyntheticRunSummary } from '@/lib/admin/synthetic-runs-reader';
import type { CacheCountersSnapshot } from '@/lib/perf/cache-counters';

// ── Objectives (constants, not env — SLO1 adds no env var) ──────────────────

/** Trailing window the availability SLI + burn-down are computed over. */
export const SLO_WINDOW_DAYS = 28;
/** Synthetic-journey availability objective (fraction of journeys that pass). */
export const JOURNEY_AVAILABILITY_OBJECTIVE = 0.99;
/** Result-cache hit-rate floor (efficiency SLI — informational, never pages). */
export const CACHE_HITRATE_OBJECTIVE = 0.5;

/**
 * Fast-burn threshold (burn multiple) at which an availability/latency SLI is
 * treated as an active breach worth a P2 page. burn = actualFailRate ÷
 * allowedFailRate; > 1 means the budget is being spent faster than it refills.
 * 2× (consuming the 28-day budget in ~14 days) is the page line — the
 * SRE-workbook fast-burn posture, single-window (the multi-window refinement
 * is enterprise-hardening §1's job).
 */
export const FAST_BURN_ALERT_THRESHOLD = 2;

/** SLI kind — drives whether an over-burn pages (availability/latency) or not. */
export type SloCategory = 'availability' | 'latency' | 'efficiency';

/** One day-bucket of the availability burn-down series. */
export interface SloDayBucket {
  /** ISO date (YYYY-MM-DD, UTC) of the bucket. */
  day: string;
  /** Journeys sampled that day (pass + fail; skips excluded). */
  sampled: number;
  /** Journeys that passed. */
  good: number;
  /** good / sampled (1 when nothing sampled — no news is good news). */
  attainment: number;
  /**
   * Cumulative fraction of the window's error budget consumed through this day
   * (0..>1). The burn-DOWN line: budget remaining = max(0, 1 - burnedFraction).
   */
  burnedFraction: number;
}

/** One SLI row: objective vs actual vs error-budget burn. */
export interface SloRow {
  id: string;
  label: string;
  category: SloCategory;
  /** Objective as a fraction (0..1) — e.g. 0.99 = "99% of journeys pass". */
  objective: number;
  /** Observed attainment over the window (0..1). */
  attainment: number;
  /** True when attainment >= objective (or no samples yet). */
  met: boolean;
  /**
   * Error-budget burn as a multiple of the allowed fail rate. < 1 healthy;
   * >= FAST_BURN_ALERT_THRESHOLD pages (availability/latency only). 0 when no
   * samples.
   */
  burn: number;
  /** Fraction of the error budget still unspent (0..1). */
  budgetRemaining: number;
  /** Samples observed in the window. */
  sampled: number;
  /** Samples that met the target ("good"). */
  good: number;
  /** False when the feeding store is unwired / has no samples yet. */
  dataAvailable: boolean;
  /** Honest remediation when `dataAvailable` is false (env var / how to fill). */
  unavailableReason?: string;
  /** Human unit for the objective/attainment ('%' for all current SLIs). */
  unit: string;
  learnUrl?: string;
  description: string;
  /** Per-day burn-down series (availability SLI only; [] for point SLIs). */
  series: SloDayBucket[];
}

/** An SLI in fast-burn breach — the route pages one P2 per row via O1. */
export interface SloBurnAlert {
  sliId: string;
  label: string;
  burn: number;
  attainment: number;
  objective: number;
}

/** The full rollup the pane renders + the route may alert on. */
export interface SloRollup {
  generatedAt: string;
  windowDays: number;
  rows: SloRow[];
  /** Availability/latency rows whose burn >= FAST_BURN_ALERT_THRESHOLD. */
  alerts: SloBurnAlert[];
  /** True when at least one SLI has real samples (else the tab is all-empty). */
  anyData: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** UTC YYYY-MM-DD for a timestamp (bucket key). '' for an unparseable ts. */
function dayKey(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Burn from an attainment over a window: how fast the budget is being spent
 * relative to what the objective allows. Mirrors evaluateSlo's definition so
 * the availability SLI and the Copilot latency SLIs use ONE burn semantics.
 */
export function burnFromAttainment(objective: number, attainment: number, sampled: number): number {
  if (sampled <= 0) return 0;
  const allowedFailRate = Math.max(1e-9, 1 - objective);
  const actualFailRate = Math.max(0, 1 - attainment);
  return actualFailRate / allowedFailRate;
}

// ── Availability SLI from synthetic runs ────────────────────────────────────

/**
 * Roll the synthetic-journey runs into the availability SLI + a per-day
 * burn-down series over the trailing `windowDays`. A journey with status
 * 'pass' is good; 'fail' is bad; 'skip'/'vaporware' are excluded from the
 * ratio (a skipped honest-gate is not a breach). `now` is injected (pure).
 */
export function rollupJourneyAvailability(
  runs: readonly SyntheticRunSummary[],
  now: Date,
  windowDays: number = SLO_WINDOW_DAYS,
  objective: number = JOURNEY_AVAILABILITY_OBJECTIVE,
): SloRow {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const perDay = new Map<string, { good: number; sampled: number }>();
  let good = 0;
  let sampled = 0;

  for (const run of runs) {
    const runTs = run.ts || '';
    const t = new Date(runTs).getTime();
    // Runs without a parseable ts (crashed before first verdict) are skipped
    // from the ratio but still visible on the Journeys tab.
    if (Number.isNaN(t) || t < cutoff) continue;
    const key = dayKey(runTs);
    if (!key) continue;
    const bucket = perDay.get(key) ?? { good: 0, sampled: 0 };
    for (const j of run.journeys) {
      if (j.status === 'pass') {
        bucket.good++;
        bucket.sampled++;
        good++;
        sampled++;
      } else if (j.status === 'fail') {
        bucket.sampled++;
        sampled++;
      }
      // skip / vaporware excluded from the availability ratio
    }
    perDay.set(key, bucket);
  }

  const attainment = sampled > 0 ? good / sampled : 1;
  const burn = burnFromAttainment(objective, attainment, sampled);
  const met = sampled === 0 ? true : attainment >= objective;

  // Build the ordered day series + cumulative budget burn-down. The allowed
  // failures over the window = (1 - objective) × sampled; cumulative burned
  // fraction = failuresSoFar / allowedFailures.
  const allowedFailures = Math.max(1e-9, (1 - objective) * sampled);
  const days = [...perDay.keys()].sort();
  let failuresSoFar = 0;
  const series: SloDayBucket[] = days.map((day) => {
    const b = perDay.get(day)!;
    failuresSoFar += b.sampled - b.good;
    return {
      day,
      sampled: b.sampled,
      good: b.good,
      attainment: b.sampled > 0 ? b.good / b.sampled : 1,
      burnedFraction: sampled > 0 ? failuresSoFar / allowedFailures : 0,
    };
  });

  return {
    id: 'journey-availability',
    label: 'Synthetic journey availability',
    category: 'availability',
    objective,
    attainment,
    met,
    burn,
    budgetRemaining: clamp01(1 - burn),
    sampled,
    good,
    dataAvailable: sampled > 0,
    unavailableReason:
      sampled > 0
        ? undefined
        : 'No synthetic-journey verdicts in the window yet — the loom-synthetic-monitor job (modules/admin-plane/synthetic-monitor-job.bicep, default-ON) uploads a run every 15 min; dispatch it once and this SLI fills in.',
    unit: '%',
    learnUrl: 'https://sre.google/workbook/alerting-on-slos/',
    description:
      'Fraction of real end-to-end user journeys (the six V1 synthetic journeys incl. the TRUE MSAL login probe) that passed over the trailing 28 days. The error-budget burn-down shows how fast failed journeys are spending the allowed downtime.',
    series,
  };
}

// ── Latency SLIs from the Copilot SLO evaluations ───────────────────────────

const COPILOT_LEARN: Record<string, string> = {
  'copilot-first-token': 'https://learn.microsoft.com/azure/ai-services/openai/how-to/latency',
  'copilot-full-turn': 'https://sre.google/workbook/alerting-on-slos/',
};

/** Map one Copilot SLO evaluation (copilot-slo.evaluateSlo) into an SLI row. */
export function rollupCopilotLatency(evaluation: SloEvaluation, label: string, description: string): SloRow {
  const { objective, attainment, met, burn, sampled, good } = evaluation;
  return {
    id: evaluation.id,
    label,
    category: 'latency',
    objective,
    attainment,
    met,
    burn,
    budgetRemaining: clamp01(1 - burn),
    sampled,
    good,
    dataAvailable: sampled > 0,
    unavailableReason:
      sampled > 0
        ? undefined
        : 'No Copilot turns measured on this replica yet (the rolling window is per-process). Run a Copilot turn and refresh — the SLO fills from lib/perf/copilot-latency-tracker.',
    unit: '%',
    learnUrl: COPILOT_LEARN[evaluation.id],
    description,
    series: [],
  };
}

// ── Efficiency SLI from the cache counters ──────────────────────────────────

/** Roll the result-cache hit-rate into an informational efficiency SLI. */
export function rollupCacheHitRate(
  cache: CacheCountersSnapshot,
  objective: number = CACHE_HITRATE_OBJECTIVE,
): SloRow {
  const { hits, misses, hitRate } = cache.total;
  const sampled = hits + misses;
  const attainment = sampled > 0 ? hitRate : 0;
  // Efficiency is a FLOOR, not an error budget — express "burn" as the shortfall
  // toward the floor so the row can still show a bar, but it never pages.
  const burn = sampled > 0 ? clamp01((objective - attainment) / Math.max(1e-9, objective)) : 0;
  return {
    id: 'cache-hit-rate',
    label: 'Result-cache hit-rate',
    category: 'efficiency',
    objective,
    attainment,
    met: sampled === 0 ? true : attainment >= objective,
    burn,
    budgetRemaining: clamp01(attainment / Math.max(1e-9, objective)),
    sampled,
    good: hits,
    dataAvailable: sampled > 0,
    unavailableReason:
      sampled > 0
        ? undefined
        : 'No cache lookups recorded on this replica yet (per-process counters). The hit-rate fills once report/ADX/tabular/cost queries run.',
    unit: '%',
    learnUrl: 'https://learn.microsoft.com/azure/architecture/best-practices/caching',
    description:
      'Aggregate hit-rate across the Loom result caches (report / ADX / tabular / Cost Management). An efficiency floor — it never pages, but a collapsing hit-rate explains rising latency and cost.',
    series: [],
  };
}

// ── The assembled rollup + alert decision ───────────────────────────────────

/** Which rows are in fast-burn breach (availability/latency only). */
export function burnAlerts(rows: readonly SloRow[]): SloBurnAlert[] {
  return rows
    .filter((r) => r.category !== 'efficiency' && r.dataAvailable && r.burn >= FAST_BURN_ALERT_THRESHOLD)
    .map((r) => ({ sliId: r.id, label: r.label, burn: r.burn, attainment: r.attainment, objective: r.objective }));
}

/** Inputs the route resolves from the real stores, handed to the pure rollup. */
export interface SloRollupInputs {
  now: Date;
  /** Synthetic-journey runs (already filtered by the reader); [] when unwired. */
  runs: readonly SyntheticRunSummary[];
  /** Copilot SLO evaluations (recentCopilotSloEvaluations()). */
  copilot: readonly SloEvaluation[];
  /** Result-cache counters snapshot. */
  cache: CacheCountersSnapshot;
  windowDays?: number;
}

const COPILOT_LABELS: Record<string, { label: string; description: string }> = {
  'copilot-first-token': {
    label: 'Copilot first-token latency',
    description:
      'Fraction of Copilot turns whose first streamed token arrived under the budget — the "is it thinking?" latency a user feels.',
  },
  'copilot-full-turn': {
    label: 'Copilot full-turn latency',
    description:
      'Fraction of Copilot turns that completed end-to-end (all tokens + tool calls) under the budget.',
  },
};

/** Assemble the full SLO rollup from the resolved store inputs (pure). */
export function buildSloRollup(inputs: SloRollupInputs): SloRollup {
  const windowDays = inputs.windowDays ?? SLO_WINDOW_DAYS;
  const rows: SloRow[] = [];

  rows.push(rollupJourneyAvailability(inputs.runs, inputs.now, windowDays));

  for (const ev of inputs.copilot) {
    const meta = COPILOT_LABELS[ev.id] ?? { label: ev.id, description: '' };
    rows.push(rollupCopilotLatency(ev, meta.label, meta.description));
  }

  rows.push(rollupCacheHitRate(inputs.cache));

  return {
    generatedAt: inputs.now.toISOString(),
    windowDays,
    rows,
    alerts: burnAlerts(rows),
    anyData: rows.some((r) => r.dataAvailable),
  };
}
