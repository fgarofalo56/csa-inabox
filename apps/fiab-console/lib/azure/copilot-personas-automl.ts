/**
 * copilot-personas-automl.ts — AutoML / ML Experiment inline Copilot builder
 * config (G1). NL → a structured Azure Machine Learning AutoML configuration
 * (task / target column / primary metric / trial budget), grounded on the
 * current draft config in item.state.
 *
 * Azure-native (no-fabric-dependency.md): CSA Loom AutoML runs on Azure Machine
 * Learning (aml-automl-client) — no Microsoft Fabric. This builder edits a
 * Loom-native config draft (item.state.copilotAutomlConfig) with checkpoint/
 * restore; the AutoML wizard / experiment editor loads it to pre-fill the
 * submit form, and Submit calls the real AML job API.
 */

import type { BuilderOp, CopilotBuilderConfig } from '@/app/api/items/_lib/copilot-builder-route';

type AutoMlTask = 'Classification' | 'Regression' | 'Forecasting';

const TASKS: AutoMlTask[] = ['Classification', 'Regression', 'Forecasting'];
const PRIMARY_METRICS: Record<AutoMlTask, string[]> = {
  Classification: ['AUCWeighted', 'Accuracy', 'NormMacroRecall', 'AveragePrecisionScoreWeighted', 'PrecisionScoreWeighted'],
  Regression: ['NormalizedRootMeanSquaredError', 'R2Score', 'NormalizedMeanAbsoluteError', 'SpearmanCorrelation'],
  Forecasting: ['NormalizedRootMeanSquaredError', 'R2Score', 'NormalizedMeanAbsoluteError', 'SpearmanCorrelation'],
};

export interface AutoMlConfigDoc {
  task?: AutoMlTask;
  targetColumn?: string;
  primaryMetric?: string;
  maxTrials?: number;
  experimentTimeoutMinutes?: number;
}

function readDoc(state: Record<string, unknown>): AutoMlConfigDoc {
  const raw = (state.copilotAutomlConfig && typeof state.copilotAutomlConfig === 'object'
    ? state.copilotAutomlConfig : {}) as Record<string, any>;
  return {
    task: TASKS.includes(raw.task) ? raw.task : undefined,
    targetColumn: typeof raw.targetColumn === 'string' ? raw.targetColumn : undefined,
    primaryMetric: typeof raw.primaryMetric === 'string' ? raw.primaryMetric : undefined,
    maxTrials: Number.isFinite(raw.maxTrials) ? Number(raw.maxTrials) : undefined,
    experimentTimeoutMinutes: Number.isFinite(raw.experimentTimeoutMinutes) ? Number(raw.experimentTimeoutMinutes) : undefined,
  };
}

function computeStats(doc: AutoMlConfigDoc): Record<string, number> {
  const set = [doc.task, doc.targetColumn, doc.primaryMetric, doc.maxTrials, doc.experimentTimeoutMinutes].filter((v) => v !== undefined).length;
  return { 'fields set': set };
}

function groundingText(doc: AutoMlConfigDoc): string {
  const lines: string[] = [];
  lines.push(`CURRENT DRAFT CONFIG:`);
  lines.push(`  task: ${doc.task ?? '(unset)'}`);
  lines.push(`  targetColumn: ${doc.targetColumn ?? '(unset)'}`);
  lines.push(`  primaryMetric: ${doc.primaryMetric ?? '(unset)'}`);
  lines.push(`  maxTrials: ${doc.maxTrials ?? '(unset)'}`);
  lines.push(`  experimentTimeoutMinutes: ${doc.experimentTimeoutMinutes ?? '(unset)'}`);
  lines.push(`VALID PRIMARY METRICS per task: ${JSON.stringify(PRIMARY_METRICS)}`);
  return lines.join('\n');
}

const SYSTEM_PROMPT = `You translate a natural-language request into a STRUCTURED Azure Machine Learning AutoML configuration for CSA Loom.
CSA Loom is its OWN Azure product (Azure Machine Learning) — NOT Microsoft Fabric. Never mention Microsoft Fabric.
Respond with a JSON object ONLY: { "summary": "...", "ops": [ ... ] }. No prose, no code fence.
Each op is ONE of:
  { "kind": "set-task", "task": "Classification|Regression|Forecasting" }
  { "kind": "set-target-column", "column": "<column name>" }
  { "kind": "set-primary-metric", "metric": "<one of the VALID PRIMARY METRICS for the chosen/current task>" }
  { "kind": "set-max-trials", "value": <integer 1..1000> }
  { "kind": "set-experiment-timeout", "minutes": <integer 5..10080> }
RULES:
 - Only emit set-primary-metric with a metric valid for the task (see the VALID PRIMARY METRICS map). If the task is changing, emit set-task first.
 - Emit only the ops the request actually asks for; do not reset unrelated fields.
 - If nothing valid can be done, return { "summary": "...", "ops": [] } explaining why.`;

function normalizeOps(rawOps: unknown[], doc: AutoMlConfigDoc): BuilderOp[] {
  const ops: BuilderOp[] = [];
  // Track the "effective" task as ops accumulate so metric validation follows a task change in the same plan.
  let effectiveTask: AutoMlTask | undefined = doc.task;
  for (const o of rawOps as any[]) {
    const kind = String(o?.kind || '').trim();
    if (kind === 'set-task') {
      const task = String(o?.task || '').trim();
      if (!TASKS.includes(task as AutoMlTask)) continue;
      effectiveTask = task as AutoMlTask;
      ops.push({ kind, task, badge: 'Task', badgeColor: 'brand', describe: `Set task to ${task}` });
    } else if (kind === 'set-target-column') {
      const column = String(o?.column || '').trim();
      if (!column) continue;
      ops.push({ kind, column, badge: 'Target', badgeColor: 'informative', describe: `Set target column to “${column}”` });
    } else if (kind === 'set-primary-metric') {
      const metric = String(o?.metric || '').trim();
      const valid = effectiveTask ? PRIMARY_METRICS[effectiveTask] : ([] as string[]).concat(...Object.values(PRIMARY_METRICS));
      if (!metric || !valid.includes(metric)) continue;
      ops.push({ kind, metric, badge: 'Metric', badgeColor: 'informative', describe: `Set primary metric to ${metric}` });
    } else if (kind === 'set-max-trials') {
      const value = Math.round(Number(o?.value));
      if (!Number.isFinite(value) || value < 1 || value > 1000) continue;
      ops.push({ kind, value, badge: 'Trials', badgeColor: 'success', describe: `Set max trials to ${value}` });
    } else if (kind === 'set-experiment-timeout') {
      const minutes = Math.round(Number(o?.minutes));
      if (!Number.isFinite(minutes) || minutes < 5 || minutes > 10080) continue;
      ops.push({ kind, minutes, badge: 'Timeout', badgeColor: 'success', describe: `Set experiment timeout to ${minutes} min` });
    }
  }
  return ops;
}

function applyOps(doc: AutoMlConfigDoc, ops: BuilderOp[]) {
  const next: AutoMlConfigDoc = { ...doc };
  const applied: string[] = [];
  for (const op of ops) {
    if (op.kind === 'set-task') { next.task = op.task as AutoMlTask; applied.push(`Task = ${op.task}`); }
    else if (op.kind === 'set-target-column') { next.targetColumn = String(op.column); applied.push(`Target column = ${op.column}`); }
    else if (op.kind === 'set-primary-metric') { next.primaryMetric = String(op.metric); applied.push(`Primary metric = ${op.metric}`); }
    else if (op.kind === 'set-max-trials') { next.maxTrials = Number(op.value); applied.push(`Max trials = ${op.value}`); }
    else if (op.kind === 'set-experiment-timeout') { next.experimentTimeoutMinutes = Number(op.minutes); applied.push(`Experiment timeout = ${op.minutes} min`); }
  }
  // If the task changed and the primary metric is now invalid for it, drop it.
  if (next.task && next.primaryMetric && !PRIMARY_METRICS[next.task].includes(next.primaryMetric)) {
    next.primaryMetric = undefined;
  }
  return { patch: { copilotAutomlConfig: next }, applied, skipped: [] as string[] };
}

/** AutoML + ML Experiment share this config; only the item type differs. */
export function makeAutoMlBuilderConfig(itemType: 'automl' | 'ml-experiment'): CopilotBuilderConfig<AutoMlConfigDoc> {
  return {
    itemType,
    docKeys: ['copilotAutomlConfig'],
    checkpointsKey: `${itemType}Checkpoints`,
    readDoc,
    computeStats,
    systemPrompt: SYSTEM_PROMPT,
    groundingText,
    normalizeOps,
    applyOps,
    maxCompletionTokens: 700,
  };
}

export const AUTOML_BUILDER_CONFIG: CopilotBuilderConfig<AutoMlConfigDoc> = makeAutoMlBuilderConfig('automl');
