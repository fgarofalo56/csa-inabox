/**
 * N7d — run rule-builder data-quality checks on the **N4 transform runner** with
 * anomaly baselines, and turn the results into findings for N17.
 *
 * Flow (all real, no mocks):
 *   1. {@link compileChecks} → a dbt project (ephemeral pass-through model per
 *      table + one singular test per check).
 *   2. {@link runnerRun} on the on-main N4 runner (`dbt deps && dbt test`) — the
 *      runner returns per-test `results[]`.
 *   3. {@link parseCheckOutcomes} → pass/fail/error + violation count per check.
 *   4. {@link detectAnomaly} against each check's own violation history (a
 *      creeping regression under the hard threshold still trips).
 *   5. {@link buildDqFinding} → findings for hard failures AND anomalies; the BFF
 *      persists them via the finding store for N17 to consume.
 *
 * SCOPE BOUNDARY: this produces findings only. **N17 owns the incident UX.**
 *
 * Azure-native/no-Fabric (Synapse/Databricks/DuckDB engines); IL5 disconnected
 * on the DuckDB-over-ADLS path.
 */

import { runnerRun, transformRunnerConfigGate, type RunnerResponse } from '@/lib/transform/transform-runner-client';
import {
  compileChecks,
  parseCheckOutcomes,
  type CheckOutcome,
  type DqCheck,
  type DqCheckTarget,
  type RunnerTestResult,
} from './dq-check-compile';
import { detectAnomaly, type AnomalyOptions, type AnomalyVerdict, type MetricObservation } from './dq-anomaly-baseline';
import { buildDqFinding, severityForRule, type DqFindingDoc } from './dq-finding-model';

export { transformRunnerConfigGate };

/** Prior violation history for one check (keyed by check id) — from item state. */
export type CheckHistory = Record<string, MetricObservation[]>;

export interface RunChecksInput {
  checks: DqCheck[];
  target: DqCheckTarget;
  /** Per-check violation-count history (excluding this run). */
  history?: CheckHistory;
  anomalyOptions?: AnomalyOptions;
  /** For finding provenance. */
  context: {
    tenantId: string;
    itemId: string;
    itemType: string;
    workspaceId?: string;
    createdBy: string;
  };
  /** Runner knobs. */
  runner?: { environment?: string; gateway?: string };
}

/** The per-check result the UI + store consume. */
export interface CheckRunItem extends CheckOutcome {
  severity: 'error' | 'warning';
  column?: string;
  rule: string;
  anomaly: AnomalyVerdict | null;
}

export interface RunChecksResult {
  runId: string;
  ranAt: string;
  engine: string;
  /** The runner's raw log (receipt material, truncated by the runner). */
  log?: string;
  items: CheckRunItem[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
    skipped: number;
    anomalies: number;
  };
  /** Findings ready to persist for N17 (deterministic ids → idempotent). */
  findings: DqFindingDoc[];
  /** The observation to append to each check's history (checkId → value). */
  observations: Record<string, MetricObservation>;
}

function ruleMap(checks: DqCheck[]): Map<string, DqCheck> {
  return new Map(checks.map((c) => [c.id, c]));
}

/**
 * Compile + run the checks on the N4 runner and assemble outcomes, anomaly
 * verdicts, and findings. Throws when the runner is not configured (the caller
 * turns that into an honest 503 + Fix-it) — never a fabricated pass.
 */
export async function runTransformChecks(input: RunChecksInput): Promise<RunChecksResult> {
  const gate = transformRunnerConfigGate();
  if (gate) {
    const err = new Error(`The transform runner is not configured: set ${gate.missing}.`) as Error & { code?: string; missing?: string };
    err.code = 'not_configured';
    err.missing = gate.missing;
    throw err;
  }

  const ranAt = new Date().toISOString();
  const runId = `dqrun_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const compiled = compileChecks(input.checks, input.target);
  const rules = ruleMap(input.checks);

  let resp: RunnerResponse;
  if (compiled.compiled.length === 0) {
    // Nothing compiled (all skipped / no tables) — do not call the runner.
    resp = { ok: true, results: [] };
  } else {
    resp = await runnerRun({
      files: compiled.files,
      backend: 'dbt',
      environment: input.runner?.environment,
      gateway: input.runner?.gateway,
      commands: compiled.commands,
      env: {},
    });
  }

  const results = (resp.results || []) as RunnerTestResult[];
  const outcomes = parseCheckOutcomes(compiled, results);

  const history = input.history || {};
  const items: CheckRunItem[] = [];
  const findings: DqFindingDoc[] = [];
  const observations: Record<string, MetricObservation> = {};
  let anomalyCount = 0;

  for (const outcome of outcomes) {
    const rule = rules.get(outcome.checkId);
    const severity: 'error' | 'warning' = rule?.severity === 'warning' ? 'warning' : 'error';

    // Anomaly baseline runs on the violation count (only when we have a number).
    let anomaly: AnomalyVerdict | null = null;
    if (outcome.violations != null) {
      observations[outcome.checkId] = { at: ranAt, value: outcome.violations };
      anomaly = detectAnomaly(outcome.violations, history[outcome.checkId] || [], input.anomalyOptions);
      if (anomaly.isAnomaly) anomalyCount++;
    }

    items.push({
      ...outcome,
      severity,
      column: rule?.column,
      rule: rule?.rule || outcome.status,
      anomaly,
    });

    const target = {
      engine: input.target.engine,
      table: outcome.table || rule?.table,
      column: rule?.column,
    };

    // Finding 1 — a hard rule failure.
    if (outcome.status === 'fail') {
      findings.push(
        buildDqFinding({
          tenantId: input.context.tenantId,
          itemId: input.context.itemId,
          itemType: input.context.itemType,
          workspaceId: input.context.workspaceId,
          runId,
          source: 'rule-check',
          severity: severityForRule(severity),
          checkKey: outcome.checkId,
          target,
          title: `Data-quality check failed: ${rule?.rule || 'check'} on ${target.table || 'table'}${rule?.column ? `.${rule.column}` : ''}`,
          detail: `${outcome.violations ?? 'some'} row(s) violate the ${rule?.rule || 'check'} rule. Runner: ${outcome.message}`,
          metric: { name: 'violation-rows', value: outcome.violations ?? 0, threshold: 0 },
          createdBy: input.context.createdBy,
          at: ranAt,
        }),
      );
    }

    // Finding 2 — an anomaly-baseline outlier (distinct signal; may fire even
    // when the hard rule still passes because the value is under threshold).
    if (anomaly?.isAnomaly) {
      findings.push(
        buildDqFinding({
          tenantId: input.context.tenantId,
          itemId: input.context.itemId,
          itemType: input.context.itemType,
          workspaceId: input.context.workspaceId,
          runId,
          source: 'anomaly',
          severity: severity === 'error' ? 'warning' : 'info',
          checkKey: `${outcome.checkId}:anomaly`,
          target,
          title: `Anomaly: ${rule?.rule || 'check'} on ${target.table || 'table'} spiked vs its baseline`,
          detail: anomaly.detail,
          metric: {
            name: 'violation-rows',
            value: anomaly.value,
            baselineMean: anomaly.baseline.mean,
            baselineStddev: anomaly.baseline.stddev,
            zScore: anomaly.zScore,
          },
          createdBy: input.context.createdBy,
          at: ranAt,
        }),
      );
    }
  }

  const summary = {
    total: outcomes.length,
    passed: outcomes.filter((o) => o.status === 'pass').length,
    failed: outcomes.filter((o) => o.status === 'fail').length,
    errored: outcomes.filter((o) => o.status === 'error').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
    anomalies: anomalyCount,
  };

  return {
    runId,
    ranAt,
    engine: input.target.engine,
    log: typeof resp.log === 'string' ? resp.log.slice(0, 8000) : undefined,
    items,
    summary,
    findings,
    observations,
  };
}

/**
 * Append a run's observations to a rolling per-check history, capped so the item
 * state stays bounded. PURE helper the BFF uses before persisting item.state.
 */
export function mergeCheckHistory(
  prev: CheckHistory | undefined,
  observations: Record<string, MetricObservation>,
  cap = 50,
): CheckHistory {
  const out: CheckHistory = {};
  const base = prev || {};
  const keys = new Set([...Object.keys(base), ...Object.keys(observations)]);
  for (const k of keys) {
    const list = [...(base[k] || [])];
    if (observations[k]) list.push(observations[k]);
    list.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    out[k] = list.slice(-cap);
  }
  return out;
}
