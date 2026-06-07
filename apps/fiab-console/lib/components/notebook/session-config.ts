/**
 * Pure session-sizing logic for the notebook "Configure session" dialog —
 * no React / Fluent imports so it's unit-testable under a node environment and
 * importable from BFF routes if needed. The dialog component
 * (session-config-dialog.tsx) renders these values; the run route maps
 * toConfigureOptions() onto the real Livy session-create body.
 *
 * NO freeform JSON anywhere (per loom-no-freeform-config): the config is three
 * structured fields produced by two sliders + one numeric input.
 *
 * Learn:
 *   https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-development-using-notebooks#magic-commands
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-session
 */

export interface SessionConfig {
  /** Livy numExecutors — number of Spark executors for the session (1–100). */
  numExecutors: number;
  /** Per-executor (and driver) memory in GB (1–8) → serialized as "<n>g". */
  executorMemoryGb: number;
  /** Session idle timeout in minutes (1–1440) → heartbeatTimeoutInSecond. */
  timeoutMinutes: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  numExecutors: 2,
  executorMemoryGb: 4,
  timeoutMinutes: 60,
};

export const EXEC_MIN = 1;
export const EXEC_MAX = 100;
export const MEM_MIN = 1;
export const MEM_MAX = 8;
export const TIMEOUT_MIN = 1;
export const TIMEOUT_MAX = 1440;

/** Clamp + integer-coerce a SessionConfig to the dialog's valid ranges. */
export function normalizeSessionConfig(c: Partial<SessionConfig> | null | undefined): SessionConfig {
  const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    numExecutors: clamp(c?.numExecutors, EXEC_MIN, EXEC_MAX, DEFAULT_SESSION_CONFIG.numExecutors),
    executorMemoryGb: clamp(c?.executorMemoryGb, MEM_MIN, MEM_MAX, DEFAULT_SESSION_CONFIG.executorMemoryGb),
    timeoutMinutes: clamp(c?.timeoutMinutes, TIMEOUT_MIN, TIMEOUT_MAX, DEFAULT_SESSION_CONFIG.timeoutMinutes),
  };
}

/**
 * The real Livy session-create options this config maps to. Sent verbatim to
 * the Spark pool by the run route — this is the "Spark session JSON" the
 * receipt reflects.
 */
export interface LivyConfigureOptions {
  numExecutors: number;
  executorMemory: string;
  driverMemory: string;
  heartbeatTimeoutInSecond: number;
}

export function toConfigureOptions(cfg: SessionConfig): LivyConfigureOptions {
  const c = normalizeSessionConfig(cfg);
  return {
    numExecutors: c.numExecutors,
    executorMemory: `${c.executorMemoryGb}g`,
    driverMemory: `${c.executorMemoryGb}g`,
    heartbeatTimeoutInSecond: c.timeoutMinutes * 60,
  };
}

/** True when two configs are equal after normalization. */
export function sessionConfigEquals(a: SessionConfig, b: SessionConfig): boolean {
  const x = normalizeSessionConfig(a), y = normalizeSessionConfig(b);
  return x.numExecutors === y.numExecutors
    && x.executorMemoryGb === y.executorMemoryGb
    && x.timeoutMinutes === y.timeoutMinutes;
}
