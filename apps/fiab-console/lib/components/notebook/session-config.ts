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
  /**
   * Curated spark.* properties for this session (from a preset and/or the
   * structured key/value builder). Sent verbatim as the Livy session `conf`.
   * Structured key/value pairs only — NEVER a freeform JSON textarea.
   */
  sparkConf?: Record<string, string>;
  /** Id of the SPARK_PRESETS profile this config was seeded from (display only). */
  presetId?: string;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  numExecutors: 2,
  executorMemoryGb: 4,
  timeoutMinutes: 60,
  sparkConf: {},
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
  // Keep only string/string conf entries (drop blank keys/values).
  const conf: Record<string, string> = {};
  const raw = c?.sparkConf;
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const key = String(k).trim();
      if (key) conf[key] = v == null ? '' : String(v);
    }
  }
  return {
    numExecutors: clamp(c?.numExecutors, EXEC_MIN, EXEC_MAX, DEFAULT_SESSION_CONFIG.numExecutors),
    executorMemoryGb: clamp(c?.executorMemoryGb, MEM_MIN, MEM_MAX, DEFAULT_SESSION_CONFIG.executorMemoryGb),
    timeoutMinutes: clamp(c?.timeoutMinutes, TIMEOUT_MIN, TIMEOUT_MAX, DEFAULT_SESSION_CONFIG.timeoutMinutes),
    sparkConf: conf,
    presetId: c?.presetId ? String(c.presetId) : undefined,
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
  /** Spark.* properties for the Livy session `conf` (preset + builder). */
  conf?: Record<string, string>;
}

export function toConfigureOptions(cfg: SessionConfig): LivyConfigureOptions {
  const c = normalizeSessionConfig(cfg);
  const opts: LivyConfigureOptions = {
    numExecutors: c.numExecutors,
    executorMemory: `${c.executorMemoryGb}g`,
    driverMemory: `${c.executorMemoryGb}g`,
    heartbeatTimeoutInSecond: c.timeoutMinutes * 60,
  };
  if (c.sparkConf && Object.keys(c.sparkConf).length) opts.conf = c.sparkConf;
  return opts;
}

/** Stable string form of a conf map for equality (order-independent). */
function confKey(conf: Record<string, string> | undefined): string {
  if (!conf) return '';
  return Object.keys(conf).sort().map((k) => `${k}=${conf[k]}`).join('\n');
}

/** True when two configs are equal after normalization. */
export function sessionConfigEquals(a: SessionConfig, b: SessionConfig): boolean {
  const x = normalizeSessionConfig(a), y = normalizeSessionConfig(b);
  return x.numExecutors === y.numExecutors
    && x.executorMemoryGb === y.executorMemoryGb
    && x.timeoutMinutes === y.timeoutMinutes
    && confKey(x.sparkConf) === confKey(y.sparkConf);
}
