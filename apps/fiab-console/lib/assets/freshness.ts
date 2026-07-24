/**
 * N5 — PURE freshness-policy evaluation.
 *
 * Dagster's freshness semantics, adopted natively: an asset carries a declared
 * cadence (how often it is expected to be materialized) plus a grace allowance
 * (how long past the cadence is tolerated before it is an incident). This
 * module turns (policy, lastMaterializedAt, now) into ONE status the canvas
 * chip, the /api/assets/status rollup, and the reconciler all read — so the
 * badge a user sees and the decision the worker makes can never disagree.
 *
 * Boundary contract (closed-open, so a status can never be ambiguous):
 *   cadence 'none'                          → 'unmanaged'  (no expectation)
 *   no lastMaterializedAt                   → 'never'      (guided, NOT red —
 *                                              a freshly derived asset opens clean)
 *   age <= cadence                          → 'fresh'
 *   cadence < age <= cadence + grace        → 'stale'
 *   age > cadence + grace                   → 'overdue'
 *
 * PURE — no Cosmos, no Azure, no React. Imported by the BFF, the reconciler,
 * the canvas, and the tests alike.
 */

import {
  CADENCE_MINUTES,
  GRACE_MINUTES,
  type AssetFreshnessPolicy,
} from '@/lib/azure/asset-registry-model';

/** The one freshness vocabulary the whole asset plane speaks. */
export type FreshnessStatus = 'fresh' | 'stale' | 'overdue' | 'never' | 'unmanaged';

export interface FreshnessEvaluation {
  status: FreshnessStatus;
  /** Minutes since the last successful materialization (null when never). */
  ageMinutes: number | null;
  /** The cadence period in minutes (0 when unmanaged). */
  cadenceMinutes: number;
  /** The grace allowance in minutes. */
  graceMinutes: number;
  /** ISO timestamp the asset is next due (null when unmanaged / never). */
  dueAt: string | null;
  /** Minutes past (cadence + grace); 0 unless the status is 'overdue'. */
  overdueByMinutes: number;
}

const MS_PER_MINUTE = 60_000;

function parseTs(value: string | undefined | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Evaluate one asset's freshness. `now` defaults to the wall clock; every
 * caller in a decision path passes an explicit `now` so a single reconciler
 * pass evaluates every asset against the SAME instant (and so tests are
 * deterministic).
 */
export function evaluateFreshness(input: {
  policy: AssetFreshnessPolicy;
  lastMaterializedAt?: string | null;
  now?: Date | string | number;
}): FreshnessEvaluation {
  const cadenceMinutes = CADENCE_MINUTES[input.policy.cadence] ?? 0;
  const graceMinutes = GRACE_MINUTES[input.policy.grace] ?? 0;
  const nowMs =
    input.now === undefined
      ? Date.now()
      : input.now instanceof Date
        ? input.now.getTime()
        : typeof input.now === 'number'
          ? input.now
          : (parseTs(input.now) ?? Date.now());

  const base: Omit<FreshnessEvaluation, 'status'> = {
    ageMinutes: null,
    cadenceMinutes,
    graceMinutes,
    dueAt: null,
    overdueByMinutes: 0,
  };

  if (cadenceMinutes <= 0) {
    // Unmanaged: no expectation was declared, so nothing can be late. The age
    // is still reported when known, purely as information for the inspector.
    const lastMs = parseTs(input.lastMaterializedAt);
    return {
      ...base,
      status: 'unmanaged',
      ageMinutes: lastMs === null ? null : Math.max(0, Math.floor((nowMs - lastMs) / MS_PER_MINUTE)),
    };
  }

  const lastMs = parseTs(input.lastMaterializedAt);
  if (lastMs === null) {
    // Never materialized. This is a GUIDED state, not an error — a freshly
    // derived asset must open clean (ux-baseline: no red on first open).
    return { ...base, status: 'never' };
  }

  const ageMinutes = Math.max(0, Math.floor((nowMs - lastMs) / MS_PER_MINUTE));
  const dueAt = new Date(lastMs + cadenceMinutes * MS_PER_MINUTE).toISOString();
  const limit = cadenceMinutes + graceMinutes;

  if (ageMinutes <= cadenceMinutes) {
    return { ...base, status: 'fresh', ageMinutes, dueAt };
  }
  if (ageMinutes <= limit) {
    return { ...base, status: 'stale', ageMinutes, dueAt };
  }
  return {
    ...base,
    status: 'overdue',
    ageMinutes,
    dueAt,
    overdueByMinutes: ageMinutes - limit,
  };
}

/** Severity ordering used for sorting + the estate rollup headline. */
export const FRESHNESS_RANK: Record<FreshnessStatus, number> = {
  overdue: 0,
  stale: 1,
  never: 2,
  fresh: 3,
  unmanaged: 4,
};

export interface FreshnessRollup {
  total: number;
  fresh: number;
  stale: number;
  overdue: number;
  never: number;
  unmanaged: number;
  /** The worst status present — what the KPI tile headlines. */
  worst: FreshnessStatus;
}

/** Aggregate many evaluations into the estate rollup the status route returns. */
export function rollupFreshness(statuses: FreshnessStatus[]): FreshnessRollup {
  const counts: Record<FreshnessStatus, number> = {
    fresh: 0, stale: 0, overdue: 0, never: 0, unmanaged: 0,
  };
  for (const s of statuses) counts[s] = (counts[s] ?? 0) + 1;
  let worst: FreshnessStatus = 'unmanaged';
  for (const s of statuses) {
    if (FRESHNESS_RANK[s] < FRESHNESS_RANK[worst]) worst = s;
  }
  return { total: statuses.length, ...counts, worst };
}

/** Canvas chip label for a status (single source so badge + tooltip agree). */
export const FRESHNESS_LABEL: Record<FreshnessStatus, string> = {
  fresh: 'Fresh',
  stale: 'Stale',
  overdue: 'Overdue',
  never: 'Not materialized',
  unmanaged: 'Unmanaged',
};
