/**
 * A12 — Spark session quota / vCore-budget accounting (PURE).
 *
 * The warm pool (`spark-session-pool.ts`) creates real Synapse Livy sessions to
 * kill the cold start. Each session holds driver + executor cores against the
 * workspace's finite Spark vCore quota — the 2026-07-14 loombatch incident was a
 * single wedged session pinning 80 cores for 2 days, starving every OTHER pool
 * so no new session could start. This module is the accounting layer that stops
 * the warm pool from CREATING sessions past a budget, and backs the honest
 * "session quota reached" path (a structured error, never a hang).
 *
 * PURE by design (no Azure / no pool imports → unit-testable, no cycle): the
 * caller (`spark-session-pool.ts`) gathers the live tally (its own getPoolStatus
 * + the PSR-3 cross-replica lease store) and feeds it to these helpers. The pool
 * imports THESE; this file imports only a type.
 *
 * vCore estimate honesty: a Livy session's exact core count is its create-body
 * (driverCores + numExecutors × executorCores). We know that for a session whose
 * sizing we hold (the warm-pool groups); for a cross-replica lease doc we only
 * hold the sizing FINGERPRINT (sizingKey), not the cores, so those are estimated
 * at DEFAULT_SESSION_VCORES. The estimate is documented, never presented as an
 * exact meter. Per no-vaporware.md this is real accounting over the real session
 * census — the estimate is only the per-doc core count we cannot recover.
 *
 * Config (env; safe generous defaults; 0 = unlimited):
 *   LOOM_SPARK_VCORE_BUDGET       max estimated active Spark vCores before the
 *                                 pool refuses to warm a NEW session (default 400).
 *   LOOM_SPARK_TENANT_SESSION_MAX max concurrent active Spark sessions (default 50).
 */

import type { LivySessionSizing } from '@/lib/azure/synapse-dev-client';

/** Estimated vCores for a session whose exact sizing we do NOT hold (cross-replica
 * lease docs carry only the sizing fingerprint). Matches the default sizing:
 * driver 4 + 2 executors × 4 cores = 12. */
export const DEFAULT_SESSION_VCORES = 12;

export interface SparkQuotaConfig {
  /** Max concurrent active Spark sessions (0 = unlimited). */
  sessionMax: number;
  /** Max estimated active Spark vCores (0 = unlimited). */
  vcoreBudget: number;
}

function envInt(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

/** Effective quota config from env (safe defaults; 0 disables that dimension). */
export function sparkQuotaConfig(): SparkQuotaConfig {
  return {
    sessionMax: envInt(process.env.LOOM_SPARK_TENANT_SESSION_MAX, 50),
    vcoreBudget: envInt(process.env.LOOM_SPARK_VCORE_BUDGET, 400),
  };
}

/** True when BOTH dimensions are unlimited (0) — the guard is a no-op. */
export function quotaUnlimited(cfg: SparkQuotaConfig): boolean {
  return cfg.sessionMax <= 0 && cfg.vcoreBudget <= 0;
}

/** Exact vCores a Livy session of this sizing consumes: driver + executors. */
export function vcoresForSizing(sizing?: LivySessionSizing): number {
  const driver = typeof sizing?.driverCores === 'number' && sizing.driverCores > 0 ? sizing.driverCores : 4;
  const execCores = typeof sizing?.executorCores === 'number' && sizing.executorCores > 0 ? sizing.executorCores : 4;
  const numExec = typeof sizing?.numExecutors === 'number' && sizing.numExecutors >= 0 ? sizing.numExecutors : 2;
  return Math.max(1, driver + numExec * execCores);
}

export interface SparkQuotaStatus {
  config: SparkQuotaConfig;
  activeSessions: number;
  /** Estimated active vCores (exact for pool-tracked sessions, estimated for
   * cross-replica lease docs — see the module note). */
  activeVcores: number;
  sessionsExceeded: boolean;
  vcoresExceeded: boolean;
  /** At or over EITHER ceiling — the warm pool refuses to warm a new session. */
  atCapacity: boolean;
  /** Headroom to the ceiling (null = that dimension is unlimited). Mutable so
   * the refill planner can decrement it as it allocates warms across groups. */
  sessionsRemaining: number | null;
  vcoresRemaining: number | null;
}

/** Build a quota status from the current tally. */
export function computeQuotaStatus(
  cfg: SparkQuotaConfig,
  activeSessions: number,
  activeVcores: number,
): SparkQuotaStatus {
  const sessionsExceeded = cfg.sessionMax > 0 && activeSessions >= cfg.sessionMax;
  const vcoresExceeded = cfg.vcoreBudget > 0 && activeVcores >= cfg.vcoreBudget;
  return {
    config: cfg,
    activeSessions,
    activeVcores,
    sessionsExceeded,
    vcoresExceeded,
    atCapacity: sessionsExceeded || vcoresExceeded,
    sessionsRemaining: cfg.sessionMax > 0 ? Math.max(0, cfg.sessionMax - activeSessions) : null,
    vcoresRemaining: cfg.vcoreBudget > 0 ? Math.max(0, cfg.vcoreBudget - activeVcores) : null,
  };
}

/** Would adding ONE more session of `addVcores` breach a ceiling? Returns the
 * honest reason string when it would (for the "session quota reached" error). */
export function wouldExceedQuota(
  cfg: SparkQuotaConfig,
  activeSessions: number,
  activeVcores: number,
  addVcores: number,
): { exceeded: boolean; reason?: string } {
  if (cfg.sessionMax > 0 && activeSessions + 1 > cfg.sessionMax) {
    return {
      exceeded: true,
      reason: `session cap reached (${activeSessions}/${cfg.sessionMax} active Spark sessions)`,
    };
  }
  if (cfg.vcoreBudget > 0 && activeVcores + addVcores > cfg.vcoreBudget) {
    return {
      exceeded: true,
      reason: `vCore budget reached (${activeVcores} + ${addVcores} > ${cfg.vcoreBudget} estimated vCores)`,
    };
  }
  return { exceeded: false };
}

/** Structured error surfaced to the editor MessageBar when a run cannot get a
 * session because the quota is full — an HONEST bounce, never a hang. */
export interface SparkQuotaError {
  code: 'spark_session_quota';
  message: string;
  activeSessions: number;
  activeVcores: number;
  sessionMax: number;
  vcoreBudget: number;
}

/** Build the honest quota error from a status + the reason. */
export function quotaError(status: SparkQuotaStatus, reason: string): SparkQuotaError {
  return {
    code: 'spark_session_quota',
    message:
      `Spark session quota reached — ${reason}. Wait for an in-flight session to release ` +
      `(warm sessions idle past the TTL are reclaimed automatically), or raise LOOM_SPARK_TENANT_SESSION_MAX / ` +
      `LOOM_SPARK_VCORE_BUDGET to match your Synapse workspace vCore quota.`,
    activeSessions: status.activeSessions,
    activeVcores: status.activeVcores,
    sessionMax: status.config.sessionMax,
    vcoreBudget: status.config.vcoreBudget,
  };
}
