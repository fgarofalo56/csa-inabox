/**
 * PURE core for Spark job definitions (no `vscode` import) — the request shaping
 * and run/state normalization behind the Phase 5 SJD commands, unit-testable in
 * isolation against the real route contracts.
 *
 * The extension drives the REAL, dedicated Synapse-Livy **batch** API the Console
 * already ships (per `no-vaporware.md` / `no-fabric-dependency.md`):
 *   PUT  /api/items/spark-job-definition/[id]            (persist state.spec — J1)
 *   POST /api/items/spark-job-definition/[id]/files      (upload main/ref → ADLS — J2)
 *   POST /api/items/spark-job-definition/[id]/submit      (real Livy batch — J5)
 *   GET  /api/items/spark-job-definition/[id]/runs        (batch history — J4)
 *   POST /api/items/spark-job-definition/[id]/runs/[b]/cancel (cancel a run)
 *
 * These are the SAME routes the Console's SJD editor calls (Azure-native Synapse
 * Spark, never OneLake). No fake kernel; when the pool/main-file is unset the
 * submit route returns an honest 400/502 the command surfaces verbatim.
 */

/** Spark language, matching the Console spec + Fabric's four-language surface. */
export type SparkLanguage = 'PySpark' | 'Spark' | 'SparkR';

/** The `state.spec` a Spark job definition item carries (mirrors the submit route). */
export interface SparkJobSpec {
  pool?: string;
  file?: string;
  language?: SparkLanguage;
  className?: string;
  args?: string[];
  jars?: string[];
  pyFiles?: string[];
  files?: string[];
  conf?: Record<string, string>;
  environmentId?: string;
  driverMemory?: string;
  driverCores?: number;
  executorMemory?: string;
  executorCores?: number;
  numExecutors?: number;
}

/** A one-off submit override (each field overrides the persisted spec). */
export interface SparkSubmitOverride {
  pool?: string;
  file?: string;
  name?: string;
  args?: string[];
}

/**
 * A Livy batch job as `submit` / `runs` return it (`SparkBatchJob` in
 * `synapse-dev-client.ts`). Only the fields the extension renders are modelled;
 * the run-detail route intentionally returns a *safe projection* for batches an
 * item did not submit, so every field here is optional.
 */
export interface SparkBatchJob {
  id: number;
  name?: string;
  state?: string;
  appId?: string | null;
  result?: 'Uncertain' | 'Succeeded' | 'Failed' | 'Cancelled';
  livyInfo?: { currentState?: string; jobCreationRequest?: unknown };
  submittedAt?: string;
  sparkPoolName?: string;
  log?: string[];
}

/**
 * Shape the `PUT …/[id]` body that persists a guided spec change WITHOUT
 * clobbering the rest of `state`. The route REPLACES `state`, so we merge the
 * new spec fields into the existing state + spec first (empty overrides dropped).
 */
export function buildSpecUpdate(
  existingState: Record<string, unknown> | undefined,
  patch: Partial<SparkJobSpec>,
): { state: Record<string, unknown> } {
  const prevState = existingState && typeof existingState === 'object' ? existingState : {};
  const prevSpec =
    (prevState as { spec?: unknown }).spec && typeof (prevState as { spec?: unknown }).spec === 'object'
      ? ((prevState as { spec?: Record<string, unknown> }).spec as Record<string, unknown>)
      : {};
  const mergedSpec: Record<string, unknown> = { ...prevSpec };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    mergedSpec[k] = v;
  }
  return { state: { ...prevState, spec: mergedSpec } };
}

/**
 * Shape the `POST …/submit` body. An empty override submits the persisted spec
 * as-is (the common "Run" case); provided fields override for a one-off run.
 * Empty / whitespace values are dropped so they never null out a persisted spec.
 */
export function buildSubmitBody(override: SparkSubmitOverride = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const put = (k: string, v: string | undefined) => {
    if (typeof v === 'string' && v.trim() !== '') body[k] = v.trim();
  };
  put('pool', override.pool);
  put('file', override.file);
  put('name', override.name);
  const args = (override.args ?? []).map((a) => a.trim()).filter(Boolean);
  if (args.length) body.args = args;
  return body;
}

/** Read the persisted spec out of an item's `state` (undefined-safe). */
export function specFromState(state: unknown): SparkJobSpec {
  if (!state || typeof state !== 'object') return {};
  const spec = (state as { spec?: unknown }).spec;
  return spec && typeof spec === 'object' ? (spec as SparkJobSpec) : {};
}

/** Livy terminal-run results (a run in one of these is done). */
const TERMINAL_RESULTS = new Set(['Succeeded', 'Failed', 'Cancelled']);
const TERMINAL_STATES = new Set(['success', 'error', 'dead', 'killed', 'cancelled', 'cancelling']);

/** The live state of a run, preferring Livy's `livyInfo.currentState`. */
export function runState(job: SparkBatchJob): string {
  return String(job.livyInfo?.currentState || job.state || 'unknown');
}

/** True when the run has reached a terminal state/result. */
export function isTerminalRun(job: SparkBatchJob): boolean {
  if (job.result && job.result !== 'Uncertain' && TERMINAL_RESULTS.has(job.result)) return true;
  return TERMINAL_STATES.has(runState(job).toLowerCase());
}

/** A codicon id for a run's outcome/state (for the quick-pick + run list). */
export function runIcon(job: SparkBatchJob): string {
  switch (job.result) {
    case 'Succeeded':
      return 'pass';
    case 'Failed':
      return 'error';
    case 'Cancelled':
      return 'circle-slash';
    default:
      break;
  }
  return isTerminalRun(job) ? 'pass' : 'sync~spin';
}

export interface RunSummary {
  id: number;
  label: string;
  state: string;
  result: string;
  icon: string;
  appId: string;
}

/** Normalize a batch into a display row (used by the runs quick-pick — J4). */
export function summarizeRun(job: SparkBatchJob): RunSummary {
  const state = runState(job);
  const result = job.result && job.result !== 'Uncertain' ? job.result : '';
  return {
    id: job.id,
    label: job.name ? job.name : `batch ${job.id}`,
    state,
    result,
    icon: runIcon(job),
    appId: job.appId || '',
  };
}

/** Extract the `sessions[]` batch array from a `runs` response (undefined-safe). */
export function runsFromResponse(res: { sessions?: unknown } | undefined): SparkBatchJob[] {
  const arr = res && Array.isArray(res.sessions) ? res.sessions : [];
  return arr.filter(
    (r): r is SparkBatchJob => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'number',
  );
}
