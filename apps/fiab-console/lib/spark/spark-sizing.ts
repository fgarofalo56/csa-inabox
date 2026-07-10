/**
 * Canonical Spark (Livy) session sizing — the ONE source of truth shared by the
 * notebook run route and the warm-session pool so a pre-warmed session is
 * actually leasable by a real cell run.
 *
 * Root cause it fixes (R3 #1): the editor always sends the default executor
 * sizing on every run, so the run's `sizingKey` was
 * `{"numExecutors":2,…}` while the pool pre-warmed with `sizingKey=''`
 * (undefined sizing). The keys never matched, so every first cell run
 * cold-started (2-4 min) even though a warm session was standing by.
 *
 * The fix aligns BOTH directions through this module:
 *   • `DEFAULT_LIVY_SIZING` is the exact sizing the editor default maps to
 *     (`toConfigureOptions(DEFAULT_SESSION_CONFIG)` — 2 executors · 4g · 60 min).
 *   • `computeEffectiveSizing(rawCfg)` defaults any missing field from
 *     DEFAULT_LIVY_SIZING and emits a STABLE, sorted-key `sizingKey`, so
 *     "no config", "explicitly the default config", and the warm pool all
 *     normalize to the SAME key — while a genuinely custom config still gets its
 *     own distinct key (and therefore its own correctly-sized session).
 *
 * NO Fabric dependency — this is pure Synapse-Livy (the Azure-native default).
 */
import { synapseLogAnalyticsConf } from '@/lib/spark/config-presets';
import type { LivySessionSizing } from '@/lib/azure/synapse-dev-client';

/**
 * The canonical DEFAULT Livy sizing a notebook run uses when the user has NOT
 * customized the "Configure session" dialog. MUST stay 1:1 with
 * `toConfigureOptions(DEFAULT_SESSION_CONFIG)` in
 * lib/components/notebook/session-config.ts (2 executors · 4g driver+executor ·
 * 3600s heartbeat) so the editor default, the run route, and the warm pool all
 * key on ONE sizing.
 */
export const DEFAULT_LIVY_SIZING: {
  numExecutors: number;
  executorMemory: string;
  driverMemory: string;
  heartbeatTimeoutInSecond: number;
} = {
  numExecutors: 2,
  executorMemory: '4g',
  driverMemory: '4g',
  heartbeatTimeoutInSecond: 3600,
};

export interface EffectiveSizing {
  /** The Livy session-create sizing (always defined — missing fields defaulted). */
  sizing: LivySessionSizing;
  /** Stable fingerprint used to match a warm session to a run (sorted keys). */
  sizingKey: string;
}

/**
 * Deterministic JSON with sorted object keys (recursively) and undefined fields
 * omitted — so two semantically-equal sizings always produce the same string,
 * regardless of key insertion order or a differently-ordered `conf` map.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Compute the effective Livy sizing + a stable `sizingKey` for a notebook run.
 *
 * @param rawCfg the client's `sessionConfig` (the LivyConfigureOptions shape) or
 *   the notebook's saved sizing — or `null`/`undefined` when the user has NOT
 *   customized (the DEFAULT path). Every missing field falls back to
 *   DEFAULT_LIVY_SIZING so "no config" and "the default config" share a key.
 * @param laConf the env-gated Synapse→Log-Analytics diagnostic conf ({} when
 *   diagnostics are off). Merged into the session `conf`; user conf wins on
 *   key conflicts. Defaults to `synapseLogAnalyticsConf()` when omitted.
 */
export function computeEffectiveSizing(
  rawCfg: Partial<LivySessionSizing> | null | undefined,
  laConf?: Record<string, string>,
): EffectiveSizing {
  const la = laConf ?? synapseLogAnalyticsConf();
  const userConf = rawCfg?.conf && typeof rawCfg.conf === 'object' ? rawCfg.conf : {};
  const mergedConf: Record<string, string> = { ...la, ...userConf };
  const sizing: LivySessionSizing = {
    numExecutors: typeof rawCfg?.numExecutors === 'number' ? rawCfg.numExecutors : DEFAULT_LIVY_SIZING.numExecutors,
    executorMemory: typeof rawCfg?.executorMemory === 'string' ? rawCfg.executorMemory : DEFAULT_LIVY_SIZING.executorMemory,
    driverMemory: typeof rawCfg?.driverMemory === 'string' ? rawCfg.driverMemory : DEFAULT_LIVY_SIZING.driverMemory,
    heartbeatTimeoutInSecond:
      typeof rawCfg?.heartbeatTimeoutInSecond === 'number' ? rawCfg.heartbeatTimeoutInSecond : DEFAULT_LIVY_SIZING.heartbeatTimeoutInSecond,
  };
  // Preserve optional core counts only when the caller supplied them (custom
  // sizing) — so a custom config gets a distinct key while the default stays lean.
  if (typeof rawCfg?.executorCores === 'number') sizing.executorCores = rawCfg.executorCores;
  if (typeof rawCfg?.driverCores === 'number') sizing.driverCores = rawCfg.driverCores;
  if (Object.keys(mergedConf).length) sizing.conf = mergedConf;
  return { sizing, sizingKey: stableStringify(sizing) };
}

/**
 * The canonical default sizing + key (no custom config). Used by the warm pool
 * (prewarm / POST-warm / benchmarks) so its warm sessions match a default run.
 */
export function defaultSynapseSizing(): EffectiveSizing {
  return computeEffectiveSizing(null);
}
