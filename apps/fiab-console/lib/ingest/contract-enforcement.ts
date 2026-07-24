/**
 * N6 — the ENFORCEMENT HOOK the ingestion paths call.
 *
 * The pure decision matrix lives in `./contract-rules`; this module is the
 * side-effecting half that the three real ingestion paths call:
 *
 *   1. **Mirroring engine** — `lib/azure/mirror-engine.ts` calls
 *      {@link enforceBeforeLanding} inside `writeCsvSnapshot` / `writeDeltaCsv`,
 *      i.e. AFTER the source read and BEFORE the Bronze upload. Conforming rows
 *      land in `<basePath>/<schema>.<table>/`; violating rows are quarantined to
 *      `<basePath>/_rejected/<schema>.<table>/rejected-<ts>.jsonl`.
 *   2. **Eventstream** — the `/api/items/eventstream/[id]/events` POST enforces
 *      the same way before the events reach Event Hubs.
 *   3. **Pipeline sinks** — a pipeline's rows move server-side inside Azure
 *      Data Factory, so Loom enforces the sink's SHAPE with
 *      {@link enforceSinkSchema} against the REAL introspected sink columns
 *      before the run is dispatched.
 *
 * DEFAULT (operator-CONFIRMED): enforcement is default-ON in `warn-quarantine`
 * mode — a violation quarantines the offending rows and alerts, it does NOT
 * drop the load. `hard-reject` is a per-contract opt-in.
 *
 * Fail-open by design: if the registry is unreachable, the dead-letter write
 * fails, or the alert leg errors, the caller's REAL WORK still proceeds and the
 * outcome carries an honest note. A guard that takes production down when the
 * guard itself is broken is worse than no guard. The one exception is an
 * explicit `hard-reject` decision — that is the operator's deliberate choice.
 *
 * Azure-native, no Microsoft Fabric: the dead-letter sink is the deployment's
 * own ADLS Gen2 Bronze container; alerting is O1 `dispatchAlert` against the
 * one shared action group. **IL5**: every leg is in-boundary — Cosmos, ADLS,
 * Azure Monitor action group — so enforcement runs fully DISCONNECTED in an
 * air-gapped enclave.
 */

import {
  deadLetterBody,
  deadLetterPath,
  evaluateBatch,
  evaluateSchemaConformance,
  type BatchEvaluation,
  type RowViolation,
  type SchemaConformance,
} from './contract-rules';
import {
  DEFAULT_ENFORCEMENT_MODE,
  type BindingKind,
  type DataContractDoc,
  type EnforcementDecisionKind,
  type EnforcementMode,
  type EnforcementRun,
} from '@/lib/azure/data-contract-model';

/** ADLS Gen2 container the dead-letter path is written under. */
export const DEAD_LETTER_CONTAINER = 'bronze';

/** Injectable seams so the unit tests exercise the REAL orchestration logic
 * against fakes — no live Cosmos / ADLS / Azure Monitor in vitest. */
export interface EnforcementDeps {
  /** Resolve the contracts governing this ingestion target. */
  lookup?: (tenantId: string, kind: BindingKind, targetItemId: string, dataset: string) => Promise<DataContractDoc[]>;
  /** Write the dead-letter file. Returns nothing; throwing is tolerated. */
  writeDeadLetter?: (container: string, path: string, body: string) => Promise<void>;
  /** Fire the O1 alert. */
  alert?: (input: { source: string; severity: 'P1' | 'P2' | 'P3'; title: string; body: string; dedupKey?: string }) => Promise<unknown>;
  /** Append the run to the contract's pass/fail trend. */
  record?: (tenantId: string, itemId: string, run: EnforcementRun) => Promise<void>;
}

export interface EnforceInput {
  /** Owner scope — the Loom tenant partition the contract registry lives in. */
  tenantId: string;
  source: BindingKind;
  /** The mirror / pipeline / eventstream item whose ingestion this is. */
  targetItemId: string;
  /** `schema.table` / sink table / hub name. */
  dataset: string;
  /** Bronze-relative base path the CLEAN data lands under. */
  basePath: string;
  columns?: string[];
  rows: Record<string, unknown>[];
}

export interface EnforceOutcome {
  /** False when NO contract governs this target — rows pass through untouched. */
  enforced: boolean;
  contractItemId?: string;
  contractVersion?: string;
  mode?: EnforcementMode;
  /** What the caller should actually land. */
  rows: Record<string, unknown>[];
  decision?: EnforcementDecisionKind;
  evaluated: number;
  rejected: number;
  /** Bronze-relative path of the quarantined batch, when one was written. */
  deadLetterPath?: string;
  alerted: boolean;
  /** True ONLY in hard-reject: the caller MUST NOT land anything. */
  blocked: boolean;
  /** Honest, user-facing summary of what enforcement did. */
  note?: string;
}

function randomId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function defaultLookup(
  tenantId: string, kind: BindingKind, targetItemId: string, dataset: string,
): Promise<DataContractDoc[]> {
  const { contractsForTarget } = await import('@/lib/azure/data-contract-store');
  return contractsForTarget(tenantId, kind, targetItemId, dataset);
}

async function defaultWriteDeadLetter(container: string, path: string, body: string): Promise<void> {
  const { uploadFile } = await import('@/lib/azure/adls-client');
  await uploadFile(container, path, Buffer.from(body, 'utf-8'), 'application/x-ndjson');
}

async function defaultAlert(input: { source: string; severity: 'P1' | 'P2' | 'P3'; title: string; body: string; dedupKey?: string }): Promise<unknown> {
  const { dispatchAlert } = await import('@/lib/azure/alert-dispatch');
  return dispatchAlert(input);
}

async function defaultRecord(tenantId: string, itemId: string, run: EnforcementRun): Promise<void> {
  const { recordRun } = await import('@/lib/azure/data-contract-store');
  await recordRun(tenantId, itemId, run);
}

/** Honest alert body — what happened, where the rejects went, what to do. */
function alertBody(
  input: EnforceInput, doc: DataContractDoc, evaluation: BatchEvaluation, dlPath: string | undefined,
): string {
  const lines = [
    evaluation.note,
    `Contract: ${doc.displayName} (${doc.odcs.id} v${doc.odcs.version}, ODCS ${doc.odcs.apiVersion})`,
    `Ingestion: ${input.source} → ${input.targetItemId} / ${input.dataset}`,
    `Mode: ${evaluation.mode}${evaluation.mode === DEFAULT_ENFORCEMENT_MODE ? ' (default)' : ' (opt-in)'}`,
  ];
  if (dlPath) lines.push(`Dead letter: abfss ${DEAD_LETTER_CONTAINER}/${dlPath}`);
  if (evaluation.topViolations.length) {
    lines.push('Top violations:');
    for (const v of evaluation.topViolations) {
      lines.push(`  • ${v.rule}${v.column ? ` on '${v.column}'` : ''} × ${v.count}`);
    }
  }
  lines.push('Open Governance → Data contracts to review the trend, fix the producer, or adjust the contract.');
  return lines.join('\n');
}

/**
 * Enforce every contract bound to this ingestion target against one batch.
 *
 * Returns the rows the caller should land. When no contract governs the
 * target, the input rows are returned untouched and `enforced` is false — a
 * deployment with no contracts pays only one single-partition Cosmos read.
 */
export async function enforceBeforeLanding(
  input: EnforceInput,
  deps: EnforcementDeps = {},
): Promise<EnforceOutcome> {
  const lookup = deps.lookup ?? defaultLookup;
  const rows = input.rows || [];

  let docs: DataContractDoc[] = [];
  try {
    docs = await lookup(input.tenantId, input.source, input.targetItemId, input.dataset);
  } catch {
    return {
      enforced: false, rows, evaluated: rows.length, rejected: 0, alerted: false, blocked: false,
      note: 'The data-contract registry could not be read, so this batch landed unenforced (fail-open).',
    };
  }
  if (!docs.length) {
    return { enforced: false, rows, evaluated: rows.length, rejected: 0, alerted: false, blocked: false };
  }

  // The strictest bound contract wins: any hard-reject contract makes the batch
  // hard-reject. Contracts are evaluated in registry order; the first one that
  // rejects rows owns the dead-letter file and the alert.
  const doc = docs.find((d) => d.enforcement?.mode === 'hard-reject') ?? docs[0];
  const mode: EnforcementMode = doc.enforcement?.mode ?? DEFAULT_ENFORCEMENT_MODE;

  const evaluation = evaluateBatch({ odcs: doc.odcs, rows, columns: input.columns, mode });

  let dlPath: string | undefined;
  let noteSuffix = '';
  if (evaluation.rejected.length) {
    const at = new Date();
    dlPath = deadLetterPath(input.basePath, input.dataset, at);
    const body = deadLetterBody(evaluation.rejected, {
      contractId: doc.odcs.id,
      contractVersion: doc.odcs.version,
      dataset: input.dataset,
      source: input.source,
      mode,
      at: at.toISOString(),
    });
    try {
      await (deps.writeDeadLetter ?? defaultWriteDeadLetter)(DEAD_LETTER_CONTAINER, dlPath, body);
    } catch (e) {
      // Fail-open on the SINK, not on the decision: the rows are still kept out
      // of the clean landing zone, and the operator is told the rejects were
      // not persisted.
      dlPath = undefined;
      noteSuffix = ` The dead-letter write failed (${(e as Error)?.message || 'unknown error'}), so the quarantined rows were dropped rather than persisted — fix the Bronze ADLS grant.`;
    }
  }

  let alerted = false;
  if (evaluation.alert) {
    try {
      await (deps.alert ?? defaultAlert)({
        source: 'data-contract',
        severity: evaluation.alertSeverity,
        title: `Data contract ${doc.displayName}: ${evaluation.decision}`,
        body: alertBody(input, doc, evaluation, dlPath),
        dedupKey: `data-contract:${doc.itemId}:${input.dataset}`,
      });
      alerted = true;
    } catch {
      /* alerting is a side channel — never fail the ingestion for it */
    }
  }

  const run: EnforcementRun = {
    id: randomId(),
    at: new Date().toISOString(),
    source: input.source,
    targetItemId: input.targetItemId,
    dataset: input.dataset,
    mode,
    evaluated: evaluation.evaluated,
    accepted: evaluation.accepted.length,
    rejected: evaluation.rejected.length,
    decision: evaluation.decision,
    deadLetterPath: dlPath,
    alerted,
    topViolations: evaluation.topViolations,
  };
  try {
    await (deps.record ?? defaultRecord)(input.tenantId, doc.itemId, run);
  } catch {
    /* trend telemetry never fails the ingestion */
  }

  return {
    enforced: true,
    contractItemId: doc.itemId,
    contractVersion: doc.odcs.version,
    mode,
    rows: evaluation.accepted,
    decision: evaluation.decision,
    evaluated: evaluation.evaluated,
    rejected: evaluation.rejected.length,
    deadLetterPath: dlPath,
    alerted,
    blocked: evaluation.decision === 'rejected-batch',
    note: evaluation.note + noteSuffix,
  };
}

/**
 * Never-throwing wrapper the in-process landing paths (the mirroring engine's
 * two Bronze writers, the eventstream send path) call: returns the rows to land
 * plus whether the batch is blocked, degrading to "landed unenforced" with an
 * honest note if enforcement itself fails. Keeps the enforcement contract in ONE
 * place instead of re-implementing the try/catch at every hook site.
 */
export async function enforceOrPassThrough(
  input: EnforceInput,
  deps: EnforcementDeps = {},
): Promise<{ rows: Record<string, unknown>[]; blocked: boolean; note?: string }> {
  try {
    const outcome = await enforceBeforeLanding(input, deps);
    if (!outcome.enforced) return { rows: input.rows, blocked: false, note: outcome.note };
    return { rows: outcome.rows, blocked: outcome.blocked, note: outcome.note };
  } catch (e) {
    return {
      rows: input.rows,
      blocked: false,
      note: `Data-contract enforcement could not run (${(e as Error)?.message || String(e)}); this batch landed unenforced.`,
    };
  }
}

export interface SinkSchemaInput {
  tenantId: string;
  targetItemId: string;
  dataset: string;
  /** The REAL introspected sink columns (sys.columns / .show table schema). */
  sinkColumns: Array<{ name: string; type?: string }>;
}

export interface SinkSchemaOutcome {
  enforced: boolean;
  blocked: boolean;
  alerted: boolean;
  contractItemId?: string;
  mode?: EnforcementMode;
  violations: RowViolation[];
  note?: string;
}

/**
 * Pipeline-sink pre-flight. Checks the sink's REAL introspected shape against
 * every contract bound to the pipeline; under the default `warn-quarantine`
 * mode a mismatch alerts + records but the run PROCEEDS, under `hard-reject` it
 * blocks the dispatch.
 */
export async function enforceSinkSchema(
  input: SinkSchemaInput,
  deps: EnforcementDeps = {},
): Promise<SinkSchemaOutcome> {
  const lookup = deps.lookup ?? defaultLookup;
  let docs: DataContractDoc[] = [];
  try {
    docs = await lookup(input.tenantId, 'data-pipeline', input.targetItemId, input.dataset);
  } catch {
    return { enforced: false, blocked: false, alerted: false, violations: [], note: 'The data-contract registry could not be read, so this run proceeded unenforced (fail-open).' };
  }
  if (!docs.length) return { enforced: false, blocked: false, alerted: false, violations: [] };

  const doc = docs.find((d) => d.enforcement?.mode === 'hard-reject') ?? docs[0];
  const mode: EnforcementMode = doc.enforcement?.mode ?? DEFAULT_ENFORCEMENT_MODE;
  const result: SchemaConformance = evaluateSchemaConformance(doc.odcs, input.sinkColumns, mode);

  let alerted = false;
  if (result.alert) {
    try {
      await (deps.alert ?? defaultAlert)({
        source: 'data-contract',
        severity: result.alertSeverity,
        title: `Data contract ${doc.displayName}: pipeline sink ${result.ok ? 'drift' : 'mismatch'}`,
        body: [
          result.note,
          `Contract: ${doc.displayName} (${doc.odcs.id} v${doc.odcs.version})`,
          `Pipeline: ${input.targetItemId} → sink ${input.dataset}`,
          ...result.violations.slice(0, 10).map((v) => `  • ${v.rule}: ${v.detail}`),
        ].join('\n'),
        dedupKey: `data-contract:${doc.itemId}:${input.dataset}:schema`,
      });
      alerted = true;
    } catch {
      /* side channel */
    }
  }

  const run: EnforcementRun = {
    id: randomId(),
    at: new Date().toISOString(),
    source: 'data-pipeline',
    targetItemId: input.targetItemId,
    dataset: input.dataset,
    mode,
    evaluated: input.sinkColumns.length,
    accepted: result.ok ? input.sinkColumns.length : 0,
    rejected: result.violations.filter((v) => v.severity === 'error').length,
    decision: result.blocked ? 'rejected-batch' : result.ok ? 'landed' : 'landed-with-quarantine',
    alerted,
    topViolations: result.violations.slice(0, 10).map((v) => ({ rule: v.rule, column: v.column, count: 1 })),
  };
  try {
    await (deps.record ?? defaultRecord)(input.tenantId, doc.itemId, run);
  } catch {
    /* trend telemetry never fails the run */
  }

  return {
    enforced: true,
    blocked: result.blocked,
    alerted,
    contractItemId: doc.itemId,
    mode,
    violations: result.violations,
    note: result.note,
  };
}
