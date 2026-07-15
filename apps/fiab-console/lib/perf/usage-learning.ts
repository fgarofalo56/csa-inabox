/**
 * PERF-4.4 — usage-based learning engine (pure, browser-safe, unit-tested).
 *
 * Learns WHEN each Spark pool group is actually used from real session-start /
 * acquisition events (recorded by `usage-store.ts` off the warm-pool acquire
 * path) and turns that into a warm SCHEDULE: an EWMA-weighted hour-of-week
 * histogram → predicted busy windows → a per-hour warm target the existing
 * pre-warm loop (`spark-session-pool.ts` refill/sweep) consults so the pool
 * warms AHEAD of predicted demand and sleeps in dead hours.
 *
 * Pure math only — no I/O, no env, no clock reads (callers pass timestamps) —
 * so every prediction rule here is deterministic and vitest-covered. The Cosmos
 * persistence lives in `usage-store.ts`; the sync bridge the pool reads lives
 * in `learning-cache.ts`.
 *
 * Defaults are ON with CONSERVATIVE sensitivity (default-on / opt-out): with no
 * data (or too little) the learned target equals the admin-configured pool
 * `min` — behaviour is exactly today's until enough real usage is observed.
 * NO Fabric dependency — this schedules the Azure-native Synapse/Databricks
 * warm pool only (no-fabric-dependency.md).
 */

export const HOURS_PER_WEEK = 168;

/** Bucket index for a timestamp: UTC day-of-week (0=Sun) * 24 + UTC hour. */
export function hourOfWeek(atMs: number): number {
  const d = new Date(atMs);
  return d.getUTCDay() * 24 + d.getUTCHours();
}

/** A fresh all-zero hour-of-week histogram. */
export function emptyHistogram(): number[] {
  return new Array<number>(HOURS_PER_WEEK).fill(0);
}

/**
 * Apply exponential decay to every bucket for `elapsedWeeks` of wall time —
 * weight halves every `halfLifeWeeks`. Applied LAZILY at merge time (the stored
 * doc carries its last-updated timestamp) so no background job is needed.
 */
export function decayHistogram(w: readonly number[], elapsedWeeks: number, halfLifeWeeks: number): number[] {
  if (!(elapsedWeeks > 0) || !(halfLifeWeeks > 0)) return [...w];
  const f = Math.pow(0.5, elapsedWeeks / halfLifeWeeks);
  return w.map((x) => x * f);
}

/** Add one usage event (weight 1) at `atMs` into the histogram (returns a copy). */
export function addEvent(w: readonly number[], atMs: number): number[] {
  const next = [...w];
  next[hourOfWeek(atMs)] += 1;
  return next;
}

/** Add a map of {hourOfWeek: count} pending events into the histogram. */
export function addCounts(w: readonly number[], counts: Readonly<Record<number, number>>): number[] {
  const next = [...w];
  for (const [k, v] of Object.entries(counts)) {
    const h = Number(k);
    if (Number.isInteger(h) && h >= 0 && h < HOURS_PER_WEEK && Number.isFinite(v) && v > 0) next[h] += v;
  }
  return next;
}

/** Element-wise sum of histograms (per-workspace → group aggregate). */
export function sumHistograms(hs: ReadonlyArray<readonly number[]>): number[] {
  const out = emptyHistogram();
  for (const w of hs) for (let i = 0; i < HOURS_PER_WEEK && i < w.length; i++) out[i] += w[i];
  return out;
}

/** Total accumulated weight (the "how much have we actually seen" gate). */
export function totalWeight(w: readonly number[]): number {
  return w.reduce((a, b) => a + b, 0);
}

// ── Manual schedule overrides ────────────────────────────────────────────────

/** An admin-set manual window that beats the learned prediction. */
export interface ScheduleOverride {
  /** UTC days-of-week (0=Sun … 6=Sat); absent/empty = every day. */
  days?: number[];
  /** Inclusive start hour (0-23, UTC). */
  startHour: number;
  /** EXCLUSIVE end hour (1-24, UTC). start=8,end=18 covers 08:00-17:59. */
  endHour: number;
  /** 'warm' forces the pool warm in the window; 'sleep' forces it to sleep. */
  mode: 'warm' | 'sleep';
}

/** Resolve the override in effect for an hour-of-week bucket ('warm' wins over 'sleep'). */
export function overrideForHour(overrides: readonly ScheduleOverride[] | undefined, how: number): 'warm' | 'sleep' | null {
  if (!overrides?.length) return null;
  const day = Math.floor(how / 24);
  const hour = how % 24;
  let found: 'warm' | 'sleep' | null = null;
  for (const o of overrides) {
    if (o.days && o.days.length > 0 && !o.days.includes(day)) continue;
    if (!(hour >= o.startHour && hour < o.endHour)) continue;
    if (o.mode === 'warm') return 'warm'; // warm beats sleep on overlap
    found = 'sleep';
  }
  return found;
}

// ── Learning config ──────────────────────────────────────────────────────────

export interface LearningConfig {
  /** Master switch — DEFAULT ON (default-on / opt-out principle). */
  enabled: boolean;
  /**
   * 0..1. Higher = more hours count as "busy" (warms more aggressively) AND the
   * sleep rule stays conservative. The busy threshold is `1 - sensitivity` of
   * the peak hour's weight. Default 0.35 (conservative — only hours at ≥65% of
   * peak demand get boosted above the base min).
   */
  sensitivity: number;
  /** EWMA half-life in weeks (how fast old usage fades). Default 2. */
  halfLifeWeeks: number;
  /**
   * Minimum total histogram weight before predictions apply at all. Below this
   * the learned target is exactly the admin base `min` (no boost, NO sleep).
   * Default 12 (≈ two weeks of daily use).
   */
  minDataWeight: number;
  /** Warm this many hours AHEAD of a predicted busy window. Default 1. */
  lookAheadHours: number;
  /** Per-workspace opt-out: workspaceId → false excludes it from learning. */
  workspaces: Record<string, boolean>;
  /** Manual schedule overrides (beat the learned prediction). */
  overrides: ScheduleOverride[];
}

export function defaultLearningConfig(): LearningConfig {
  return {
    enabled: true,
    sensitivity: 0.35,
    halfLifeWeeks: 2,
    minDataWeight: 12,
    lookAheadHours: 1,
    workspaces: {},
    overrides: [],
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Clamp/repair an untrusted partial into a valid LearningConfig. */
export function sanitizeLearningConfig(p: Partial<LearningConfig> | undefined): LearningConfig {
  const d = defaultLearningConfig();
  if (!p) return d;
  const overrides = Array.isArray(p.overrides)
    ? p.overrides
        .filter(
          (o): o is ScheduleOverride =>
            !!o &&
            (o.mode === 'warm' || o.mode === 'sleep') &&
            Number.isInteger(o.startHour) &&
            Number.isInteger(o.endHour) &&
            o.startHour >= 0 &&
            o.startHour < 24 &&
            o.endHour > o.startHour &&
            o.endHour <= 24,
        )
        .map((o) => ({
          ...(Array.isArray(o.days) && o.days.length > 0
            ? { days: o.days.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6) }
            : {}),
          startHour: o.startHour,
          endHour: o.endHour,
          mode: o.mode,
        }))
        .slice(0, 50)
    : d.overrides;
  const workspaces: Record<string, boolean> = {};
  if (p.workspaces && typeof p.workspaces === 'object') {
    for (const [k, v] of Object.entries(p.workspaces)) {
      if (typeof v === 'boolean' && k.length <= 128) workspaces[k] = v;
    }
  }
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : d.enabled,
    sensitivity: Number.isFinite(p.sensitivity) ? clamp(Number(p.sensitivity), 0, 1) : d.sensitivity,
    halfLifeWeeks: Number.isFinite(p.halfLifeWeeks) ? clamp(Number(p.halfLifeWeeks), 0.5, 12) : d.halfLifeWeeks,
    minDataWeight: Number.isFinite(p.minDataWeight) ? clamp(Number(p.minDataWeight), 1, 1000) : d.minDataWeight,
    lookAheadHours: Number.isInteger(p.lookAheadHours) ? clamp(Number(p.lookAheadHours), 0, 6) : d.lookAheadHours,
    workspaces,
    overrides,
  };
}

// ── Prediction ───────────────────────────────────────────────────────────────

/** Score below which an hour is considered DEAD (relative to the peak hour). */
export const DEAD_SCORE = 0.02;

/** Busy threshold from sensitivity: an hour is busy at ≥ (1 - sensitivity) of peak. */
export function busyThreshold(sensitivity: number): number {
  return clamp(1 - sensitivity, 0.05, 0.95);
}

/**
 * Demand score (0..1, relative to the peak hour) at `how`, looking ahead
 * `lookAheadHours` so the pool warms BEFORE the busy window starts.
 */
export function demandScore(w: readonly number[], how: number, lookAheadHours: number): number {
  const maxW = Math.max(...w);
  if (!(maxW > 0)) return 0;
  let s = 0;
  for (let i = 0; i <= lookAheadHours; i++) s = Math.max(s, w[(how + i) % HOURS_PER_WEEK] ?? 0);
  return s / maxW;
}

export interface LearnedDecision {
  /** The warm target for this hour (sessions to keep warm). */
  target: number;
  /** Why: which rule fired. */
  rule: 'disabled' | 'insufficient-data' | 'override-warm' | 'override-sleep' | 'busy' | 'dead' | 'base';
  /** Relative demand score (0..1) at this hour (with look-ahead). */
  score: number;
}

/**
 * The learned warm target for one pool group at hour-of-week `how`.
 *
 *   • learning off / not enough data → `baseMin` (today's behaviour, unchanged)
 *   • manual 'warm' override          → at least max(1, baseMin)
 *   • manual 'sleep' override         → 0 (pool sleeps; next run cold-starts)
 *   • predicted busy (score ≥ 1-sensitivity, incl. look-ahead)
 *                                     → scale toward `boundMax` with demand
 *   • predicted dead (score ≤ DEAD_SCORE with enough data) → 0
 *   • otherwise                       → `baseMin`
 *
 * `boundMax` is the admin pool `max` — the learned boost can never exceed the
 * bound the admin already set.
 */
export function learnedTarget(
  w: readonly number[],
  how: number,
  cfg: LearningConfig,
  baseMin: number,
  boundMax: number,
): LearnedDecision {
  const base = Math.max(0, Math.floor(baseMin));
  const hi = Math.max(base, Math.floor(boundMax));
  if (!cfg.enabled) return { target: base, rule: 'disabled', score: 0 };
  const ov = overrideForHour(cfg.overrides, how);
  if (ov === 'warm') return { target: clamp(Math.max(1, base), 0, hi), rule: 'override-warm', score: 1 };
  if (ov === 'sleep') return { target: 0, rule: 'override-sleep', score: 0 };
  if (totalWeight(w) < cfg.minDataWeight) return { target: base, rule: 'insufficient-data', score: 0 };
  const score = demandScore(w, how, cfg.lookAheadHours);
  if (score >= busyThreshold(cfg.sensitivity)) {
    // Scale the target with relative demand, never below base, never above the bound.
    return { target: clamp(Math.ceil(score * hi), Math.max(1, base), hi), rule: 'busy', score };
  }
  if (score <= DEAD_SCORE) return { target: 0, rule: 'dead', score };
  return { target: base, rule: 'base', score };
}

/** The full 168-hour learned schedule (for the admin heatmap + schedule preview). */
export function learnedSchedule(
  w: readonly number[],
  cfg: LearningConfig,
  baseMin: number,
  boundMax: number,
): LearnedDecision[] {
  const out: LearnedDecision[] = [];
  for (let h = 0; h < HOURS_PER_WEEK; h++) out.push(learnedTarget(w, h, cfg, baseMin, boundMax));
  return out;
}
