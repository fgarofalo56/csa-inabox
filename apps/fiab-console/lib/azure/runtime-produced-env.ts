/**
 * Pure, dependency-free store for env values the CONSOLE ITSELF PRODUCED at
 * runtime — the sync half of `auto-bind-by-default.md` §5 ("the value must be
 * produced by the platform, never a terminal 'set LOOM_X'").
 *
 * WHY THIS EXISTS. The readiness / gate surfaces (`lib/admin/env-checks` →
 * `lib/gates/registry` → `/admin/readiness`, `/admin/gates`, HonestGate) are
 * SYNCHRONOUS env-presence evaluations. A value the console produces by calling
 * a backend (e.g. the Databricks SQL warehouse id it ensure-creates, #3744) can
 * never appear in `process.env`, so without this store the gate kept reading
 * "Missing: LOOM_DATABRICKS_SQL_WAREHOUSE_ID" while every consumer ran fine —
 * the health surface and the runtime disagreeing about the same variable.
 *
 * The async resolver PUBLISHES here (a value on success, a classified failure
 * on failure); `evalEnv` READS here for vars a spec lists in `runtimeProduced`.
 *
 * ZERO imports on purpose (same contract as `unreachable-url.ts`): this is
 * pulled into `lib/admin/env-checks/core.ts`, which ships in client bundles.
 * In a browser the store is simply empty.
 *
 * Held on `globalThis` so every server bundle in the process (Next.js may load
 * a module once per route chunk) sees the SAME store — a per-module-instance
 * map would let the resolver publish into one copy while the readiness route
 * reads another, i.e. a gate that could never turn green.
 */

export interface RuntimeProducedValue {
  /** The produced value (e.g. a warehouse id). */
  value: string;
  /** Which resolution step produced it, e.g. 'persisted' | 'listed' | 'created'. */
  source: string;
  /** Human-readable account of how it was produced (surfaced as the check detail). */
  detail: string;
  /** Epoch ms of publication. */
  at: number;
}

export interface RuntimeProducedFailure {
  /** Classified cause — 'permission' | 'network' | 'quota' | 'unknown' | … */
  kind: string;
  /** What the failed call actually returned (never a cause it did not establish). */
  message: string;
  /** The concrete remediation for THIS cause. */
  remediation: string;
  /**
   * ADMIN-ONLY detail the producer measured (e.g. what SCIM Me says about the
   * Console identity: display name, application id, entitlements, groups).
   * NEVER merged into `message`: `evalEnv` reads `message` into check detail,
   * and that detail reaches non-admin readers (GET /api/admin/self-audit, the
   * Copilot self-audit tool). Only admin-capability routes read this field,
   * via `gateAdminDiagnostic` in lib/gates/registry (#4776).
   */
  diagnostic?: string;
  /** Epoch ms of publication. */
  at: number;
}

interface Store {
  values: Map<string, RuntimeProducedValue>;
  failures: Map<string, RuntimeProducedFailure>;
}

const KEY = '__loomRuntimeProducedEnv';

function store(): Store {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { values: new Map(), failures: new Map() };
    g[KEY] = s;
  }
  return s;
}

/** Record a successfully produced value; clears any earlier failure for the var. */
export function publishRuntimeValue(envVar: string, v: Omit<RuntimeProducedValue, 'at'>): void {
  const s = store();
  s.values.set(envVar, { ...v, at: Date.now() });
  s.failures.delete(envVar);
}

/** Record a classified failure; clears any earlier value for the var (it is no longer known-good). */
export function publishRuntimeFailure(envVar: string, f: Omit<RuntimeProducedFailure, 'at'>): void {
  const s = store();
  s.failures.set(envVar, { ...f, at: Date.now() });
  s.values.delete(envVar);
}

export function readRuntimeValue(envVar: string): RuntimeProducedValue | undefined {
  return store().values.get(envVar);
}

export function readRuntimeFailure(envVar: string): RuntimeProducedFailure | undefined {
  return store().failures.get(envVar);
}

/** Forget everything recorded for a var (tests; a stale id discovered on use). */
export function clearRuntimeProduced(envVar: string): void {
  const s = store();
  s.values.delete(envVar);
  s.failures.delete(envVar);
}
