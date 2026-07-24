/**
 * N5 — PURE reconciliation decision engine (the brain of `asset-reconciler`).
 *
 * The scheduled worker (an in-VNet ACA Job → `/api/internal/assets/reconcile`)
 * observes REAL signals — Delta commit versions read from `_delta_log` in the
 * customer's own ADLS Gen2, plus eventstream watermarks — and asks this module
 * ONE question per asset: *should I dispatch its materializer right now?*
 *
 * Data-aware scheduling (Dagster's semantics, no Dagster runtime):
 *   • an asset whose UPSTREAM produced a new Delta commit since this asset was
 *     last materialized is triggered — that is the whole point of the asset
 *     plane over a cron;
 *   • an asset past its cadence + grace is triggered (freshness);
 *   • an asset that has never been materialized is triggered once.
 *
 * THRASH GUARDS (all three are hard requirements — a reconciler that can loop
 * is worse than no reconciler):
 *   1. **Cooldown.** Never dispatch twice inside `cooldownMinutes`, derived as
 *      max(floor, cadence/4) — so a 15-minute asset cannot be triggered more
 *      than ~every 10 minutes and a daily asset not more than every 6 hours.
 *   2. **In-flight.** Never dispatch while the previous run is still `running`.
 *   3. **Failure backoff.** After `BACKOFF_AFTER_FAILURES` consecutive
 *      failures, require an exponentially-growing quiet period (capped at
 *      `MAX_BACKOFF_MINUTES`) — a permanently-broken asset settles at one
 *      attempt per day instead of hammering the engine every pass.
 * Plus a per-pass BOUND (`maxTriggers`, default 25): a pass can never dispatch
 * the whole estate at once.
 *
 * PURE — no Cosmos, no Azure, no clock of its own (`now` is always supplied by
 * the caller). Every branch is unit-testable, which is exactly why the worker
 * itself is a thin shell around this module.
 */

import {
  CADENCE_MINUTES,
  type AssetFreshnessPolicy,
  type AssetMaterializerKind,
  type AssetRunOutcome,
} from '@/lib/azure/asset-registry-model';
import { evaluateFreshness, type FreshnessStatus } from './freshness';

/** Floor on the gap between two dispatches of the SAME asset. */
export const MIN_COOLDOWN_MINUTES = 10;
/** Consecutive failures after which the exponential backoff engages. */
export const BACKOFF_AFTER_FAILURES = 3;
/** First backoff step (minutes) once the threshold is crossed. */
export const BASE_BACKOFF_MINUTES = 30;
/** Ceiling on the backoff (24h) so a broken asset still retries daily. */
export const MAX_BACKOFF_MINUTES = 1440;
/** Default per-pass dispatch bound. */
export const DEFAULT_MAX_TRIGGERS = 25;

/** Everything the decision needs about ONE asset. */
export interface ReconcileCandidate {
  assetKey: string;
  policy: AssetFreshnessPolicy;
  materializer: AssetMaterializerKind;
  /** Upstream asset keys, DERIVED from unified-lineage (never hand-authored). */
  deps: string[];
  lastMaterializedAt?: string;
  lastTriggerAt?: string;
  lastRunOutcome?: AssetRunOutcome;
  consecutiveFailures?: number;
  /** Newest observed data version for this asset (Delta commit / watermark). */
  observedVersion?: number;
  /** Version at the last successful materialization. */
  materializedVersion?: number;
}

export type ReconcileReason =
  | 'upstream-changed'
  | 'self-changed'
  | 'overdue'
  | 'never-materialized'
  | 'fresh'
  | 'manual'
  | 'unmanaged'
  | 'no-materializer'
  | 'in-flight'
  | 'cooldown'
  | 'backoff'
  | 'pass-bound';

export interface ReconcileDecision {
  assetKey: string;
  trigger: boolean;
  reason: ReconcileReason;
  /** Human-readable justification recorded on the run + in the audit row. */
  detail: string;
  /** The freshness status observed for this asset in this pass. */
  freshness: FreshnessStatus;
  /** Priority used to order dispatch when the pass bound bites (lower first). */
  priority: number;
}

export interface ReconcilePlanInput {
  candidates: ReconcileCandidate[];
  /**
   * Asset keys whose DATA changed since the last pass — computed by the worker
   * from real Delta commit versions / eventstream watermarks. An asset whose
   * upstream is in this set is data-aware-triggered.
   */
  changed?: Iterable<string>;
  now: Date | string | number;
  maxTriggers?: number;
}

export interface ReconcilePlan {
  decisions: ReconcileDecision[];
  /** The bounded, ordered dispatch list (`decision.trigger === true`). */
  triggers: ReconcileDecision[];
  /** Assets that WOULD have been triggered but were cut by the pass bound. */
  deferred: ReconcileDecision[];
}

/** Minimum quiet period between two dispatches of one asset. */
export function cooldownMinutesFor(policy: AssetFreshnessPolicy): number {
  const cadence = CADENCE_MINUTES[policy.cadence] ?? 0;
  return Math.max(MIN_COOLDOWN_MINUTES, Math.floor(cadence / 4));
}

/** Required quiet period after `failures` consecutive failures (0 = none). */
export function backoffMinutesFor(failures: number): number {
  if (!Number.isFinite(failures) || failures < BACKOFF_AFTER_FAILURES) return 0;
  const steps = failures - BACKOFF_AFTER_FAILURES;
  const raw = BASE_BACKOFF_MINUTES * Math.pow(2, Math.min(steps, 16));
  return Math.min(MAX_BACKOFF_MINUTES, raw);
}

function minutesSince(nowMs: number, iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 60_000));
}

function toMs(now: Date | string | number): number {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  const t = Date.parse(now);
  return Number.isFinite(t) ? t : Date.now();
}

/**
 * Decide ONE asset. Order matters: policy opt-outs first (never even look at
 * signals for a manual asset), then the thrash guards (so a guard always wins
 * over a trigger reason), then the trigger reasons.
 */
export function decideAsset(
  candidate: ReconcileCandidate,
  changed: Set<string>,
  now: Date | string | number,
): ReconcileDecision {
  const nowMs = toMs(now);
  const freshnessEval = evaluateFreshness({
    policy: candidate.policy,
    lastMaterializedAt: candidate.lastMaterializedAt,
    now: nowMs,
  });
  const freshness = freshnessEval.status;
  const no = (reason: ReconcileReason, detail: string, priority = 900): ReconcileDecision => ({
    assetKey: candidate.assetKey, trigger: false, reason, detail, freshness, priority,
  });
  const yes = (reason: ReconcileReason, detail: string, priority: number): ReconcileDecision => ({
    assetKey: candidate.assetKey, trigger: true, reason, detail, freshness, priority,
  });

  if (candidate.policy.mode !== 'auto') {
    return no('manual', 'Materialization mode is Manual — the reconciler observes freshness but never dispatches.');
  }
  if (candidate.materializer === 'none') {
    return no(
      'no-materializer',
      'No materializer is bound. Bind a SQLMesh/dbt project, a Synapse pipeline, or a Databricks job on the asset to enable auto-reconciliation.',
    );
  }

  // ── Thrash guards ────────────────────────────────────────────────────────
  if (candidate.lastRunOutcome === 'running') {
    return no('in-flight', 'The previous materialization is still running — never overlap a run.');
  }
  const sinceTrigger = minutesSince(nowMs, candidate.lastTriggerAt);
  const backoff = backoffMinutesFor(candidate.consecutiveFailures ?? 0);
  if (backoff > 0 && sinceTrigger !== null && sinceTrigger < backoff) {
    return no(
      'backoff',
      `${candidate.consecutiveFailures} consecutive failures — backing off for ${backoff} min (last attempt ${sinceTrigger} min ago).`,
    );
  }
  const cooldown = cooldownMinutesFor(candidate.policy);
  if (sinceTrigger !== null && sinceTrigger < cooldown) {
    return no(
      'cooldown',
      `Dispatched ${sinceTrigger} min ago; the ${cooldown}-min cooldown for this cadence has not elapsed.`,
    );
  }

  // ── Trigger reasons (data-aware first — that is the point of the plane) ──
  const changedUpstreams = candidate.deps.filter((d) => changed.has(d));
  if (changedUpstreams.length > 0) {
    return yes(
      'upstream-changed',
      `${changedUpstreams.length} upstream asset${changedUpstreams.length === 1 ? '' : 's'} committed new data (${changedUpstreams.slice(0, 3).join(', ')}).`,
      0,
    );
  }
  if (
    typeof candidate.observedVersion === 'number' &&
    typeof candidate.materializedVersion === 'number' &&
    candidate.observedVersion > candidate.materializedVersion
  ) {
    return yes(
      'self-changed',
      `Delta version advanced ${candidate.materializedVersion} → ${candidate.observedVersion} since the last materialization.`,
      1,
    );
  }
  if (freshness === 'never') {
    return yes('never-materialized', 'Asset has a cadence but has never been materialized.', 2);
  }
  if (freshness === 'overdue') {
    return yes(
      'overdue',
      `Overdue by ${freshnessEval.overdueByMinutes} min (cadence ${freshnessEval.cadenceMinutes} min + ${freshnessEval.graceMinutes} min grace).`,
      // Later assets sort first: the more overdue, the higher the priority.
      10 - Math.min(9, Math.floor(freshnessEval.overdueByMinutes / 60)),
    );
  }
  if (freshness === 'unmanaged') {
    return no('unmanaged', 'No cadence declared and no upstream change — nothing to reconcile.');
  }
  if (freshness === 'stale') {
    // Past the cadence but inside the grace window. The grace allowance exists
    // exactly so a slightly-late asset does not trigger (or page) — the canvas
    // still badges it Stale.
    return no(
      'fresh',
      `Past cadence (${freshnessEval.ageMinutes} min old) but inside the ${freshnessEval.graceMinutes}-min grace window — no dispatch.`,
    );
  }
  return no('fresh', `Within cadence (${freshnessEval.ageMinutes} min old, cadence ${freshnessEval.cadenceMinutes} min).`);
}

/**
 * Plan a whole pass: decide every candidate, order the triggers by priority,
 * and cut at the pass bound. Deterministic — same inputs, same plan.
 */
export function planReconcile(input: ReconcilePlanInput): ReconcilePlan {
  const changed = new Set<string>([...(input.changed ?? [])]);
  const maxTriggers = Math.max(0, input.maxTriggers ?? DEFAULT_MAX_TRIGGERS);

  const decisions = input.candidates.map((c) => decideAsset(c, changed, input.now));
  const wanted = decisions
    .filter((d) => d.trigger)
    .sort((a, b) => (a.priority === b.priority ? a.assetKey.localeCompare(b.assetKey) : a.priority - b.priority));

  const triggers = wanted.slice(0, maxTriggers);
  const deferred = wanted.slice(maxTriggers).map((d): ReconcileDecision => ({
    ...d,
    trigger: false,
    reason: 'pass-bound',
    detail: `Deferred to the next pass — this pass already dispatched its bound of ${maxTriggers}. Original reason: ${d.reason}.`,
  }));

  // The returned `decisions` reflect the FINAL outcome, so an audited row can
  // never claim a dispatch that the pass bound actually deferred.
  const deferredByKey = new Map(deferred.map((d) => [d.assetKey, d]));
  const finalDecisions = decisions.map((d) => deferredByKey.get(d.assetKey) ?? d);

  return { decisions: finalDecisions, triggers, deferred };
}
