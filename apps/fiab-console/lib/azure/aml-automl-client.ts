/**
 * aml-automl-client — Azure Machine Learning AutoML (Automated ML) control-plane
 * REST client. Submits, lists, polls, and cancels AutoML jobs against the
 * standalone AML workspace resolved by `resolve-aml-target.ts`.
 *
 * Parity target: the Azure ML Studio "Automated ML" experience (Fabric Build
 * 2026 #37 — there is no Fabric "AutoML" item, so this is the Azure-native
 * surface, which is the DEFAULT and only path; no Fabric / Power BI dependency,
 * works with LOOM_DEFAULT_FABRIC_WORKSPACE unset, per no-fabric-dependency.md).
 *
 * Real backend: pure ARM, same workspace child resource as every other AML
 * object (Microsoft.MachineLearningServices/workspaces/<ws>/jobs):
 *
 *   PUT  <ws>/jobs/{name}   body { properties: { jobType:'AutoML', taskDetails, computeId, experimentName } }
 *        https://learn.microsoft.com/javascript/api/@azure/arm-machinelearning/automljob
 *   GET  <ws>/jobs          (filter jobType eq 'AutoML')      — run monitoring list
 *   GET  <ws>/jobs/{name}                                     — single run status
 *   POST <ws>/jobs/{name}/cancel                              — cancel a running job
 *
 * Task types (the wizard's "task picker"): Classification, Regression,
 * Forecasting (Classification multi-class is the same Classification task —
 * AutoML detects multiclass automatically; surfaced as a wizard hint).
 *
 * The training data is an MLTable URI (abfss:// to a folder containing an
 * MLTable definition), which is how AutoML v2 ingests tabular data. The wizard
 * sources the dataset from the workspace's datastores (listDatastores in
 * aml-client.ts builds the abfss:// path) so the user picks from a dropdown
 * rather than typing a raw URI.
 *
 * Auth + cloud routing + token credential mirror aml-client.ts and resolve
 * against the same `resolve-aml-target.ts`. The Console UAMI must hold "AzureML
 * Data Scientist" on the workspace (ml-workspace.bicep already grants it — no
 * new role needed).
 *
 * NO mocks, NO `return []` placeholders. Real ARM REST only. Honest config gate
 * via `automlConfigGate()` when env is unset.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';
import {
  resolveAmlTarget,
  amlWorkspaceArmPath,
  AmlNotConfiguredError,
  type AmlTarget,
} from './resolve-aml-target';

/** Stable GA api-version for Microsoft.MachineLearningServices control plane. */
const ML_API = '2024-10-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Non-404 AutoML control-plane REST failure. */
export class AutoMlError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Azure ML AutoML call failed (${status})`);
    this.name = 'AutoMlError';
    this.status = status;
    this.body = body;
  }
}

// ============================================================
// Config gate (re-exported so routes import everything from one module)
// ============================================================

export { AmlNotConfiguredError };

/** Honest config gate: the exact missing env var, or null when resolvable. */
export function automlConfigGate(): { missing: string } | null {
  try {
    resolveAmlTarget();
    return null;
  } catch (e) {
    if (e instanceof AmlNotConfiguredError) return { missing: e.missing.join(' + ') };
    throw e;
  }
}

// ============================================================
// Fetch foundation (mirrors aml-client.amlFetch, request-time cloud routing)
// ============================================================

async function automlFetch(
  path: string,
  init: RequestInit & { query?: Record<string, string>; target?: AmlTarget } = {},
): Promise<Response> {
  const token = await credential.getToken(armScope());
  if (!token?.token) throw new AutoMlError(401, undefined, 'Failed to acquire ARM token for Azure ML AutoML');
  const { query, target, ...rest } = init;
  const wsPath = amlWorkspaceArmPath(target ?? resolveAmlTarget());
  const extra = query ? '&' + new URLSearchParams(query).toString() : '';
  const url = `${armBase()}${wsPath}${path}?api-version=${ML_API}${extra}`;
  return fetchWithTimeout(url, {
    ...rest,
    headers: {
      ...(rest.headers || {}),
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  });
}

async function readJson<T>(res: Response, label: string): Promise<T | null> {
  if (res.status === 404) return null;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg =
      (parsed as any)?.error?.message ||
      (typeof parsed === 'string' ? parsed : `Azure ML AutoML ${res.status}`);
    throw new AutoMlError(res.status, parsed, `${label} failed ${res.status}: ${String(msg).slice(0, 300)}`);
  }
  return (parsed as T) ?? ({} as T);
}

// ============================================================
// Task taxonomy (the wizard's task picker)
// ============================================================

/** AutoML task verticals supported by the wizard (tabular). */
export type AutoMlTaskType = 'Classification' | 'Regression' | 'Forecasting';

/** ARM TaskType discriminator value per wizard task. */
const TASK_ARM: Record<AutoMlTaskType, string> = {
  Classification: 'Classification',
  Regression: 'Regression',
  Forecasting: 'Forecasting',
};

/** Primary metric options per task (the values AutoML optimizes for). */
export const PRIMARY_METRICS: Record<AutoMlTaskType, string[]> = {
  Classification: [
    'AUCWeighted',
    'Accuracy',
    'NormMacroRecall',
    'AveragePrecisionScoreWeighted',
    'PrecisionScoreWeighted',
  ],
  Regression: [
    'NormalizedRootMeanSquaredError',
    'R2Score',
    'NormalizedMeanAbsoluteError',
    'SpearmanCorrelation',
  ],
  Forecasting: [
    'NormalizedRootMeanSquaredError',
    'R2Score',
    'NormalizedMeanAbsoluteError',
    'SpearmanCorrelation',
  ],
};

/** Default primary metric per task. */
export function defaultPrimaryMetric(task: AutoMlTaskType): string {
  return PRIMARY_METRICS[task][0];
}

export interface AutoMlTaskDescriptor {
  task: AutoMlTaskType;
  /** Human title for the wizard task picker tile. */
  title: string;
  /** One-line description for the tile. */
  description: string;
  /** Whether this task supports multi-class (Classification does, auto-detected). */
  multiClass: boolean;
}

/** The wizard's task picker catalog. Classification covers binary + multi-class. */
export const AUTOML_TASKS: readonly AutoMlTaskDescriptor[] = [
  {
    task: 'Classification',
    title: 'Classification',
    description:
      'Predict a category. Binary (two classes) and multi-class (3+ classes) are both handled — AutoML detects the class count from the label column.',
    multiClass: true,
  },
  {
    task: 'Regression',
    title: 'Regression',
    description: 'Predict a continuous numeric value (price, demand, score).',
    multiClass: false,
  },
  {
    task: 'Forecasting',
    title: 'Forecasting',
    description:
      'Predict future time-series values from history. Requires a time column and (optionally) time-series ID columns.',
    multiClass: false,
  },
];

// ============================================================
// Submit an AutoML job
// ============================================================

export interface ForecastingSettingsInput {
  /** The datetime column that defines the time axis. */
  timeColumnName: string;
  /** How far ahead to forecast (number of time periods). */
  forecastHorizon?: number;
  /** Columns that identify a single time-series within the dataset. */
  timeSeriesIdColumnNames?: string[];
}

export interface SubmitAutoMlInput {
  /** The wizard task picker selection. */
  task: AutoMlTaskType;
  /** abfss:// (or azureml://) URI to a folder containing an MLTable definition. */
  trainingDataUri: string;
  /** The label / target column to predict. */
  targetColumnName: string;
  /** Compute cluster (AmlCompute) name to run the sweep on. */
  computeName: string;
  /** Metric AutoML optimizes for; defaults per-task when omitted. */
  primaryMetric?: string;
  /** Wall-clock cap for the whole sweep, in minutes. */
  experimentTimeoutMinutes?: number;
  /** Max number of candidate models to try (trials). */
  maxTrials?: number;
  /** Max concurrent trials (≤ cluster max nodes). */
  maxConcurrentTrials?: number;
  /** Cross-validation folds when no validation split is given. */
  nCrossValidations?: number;
  /** Friendly display name for the run. */
  displayName?: string;
  /** Experiment to group the run under. */
  experimentName?: string;
  /** Forecasting-only settings (required when task === 'Forecasting'). */
  forecastingSettings?: ForecastingSettingsInput;
}

export interface AutoMlJob {
  id?: string;
  name: string;
  displayName?: string;
  experimentName?: string;
  taskType?: string;
  status?: string;
  primaryMetric?: string;
  computeId?: string;
  createdAt?: string;
  startTimeUtc?: string;
  endTimeUtc?: string;
  studioUrl?: string;
  tags?: Record<string, string>;
}

function shapeAutoMlJob(raw: any): AutoMlJob {
  const p = raw?.properties || {};
  const td = p.taskDetails || {};
  const services = p.services || {};
  return {
    id: raw?.id,
    name: raw?.name,
    displayName: p.displayName,
    experimentName: p.experimentName,
    taskType: td.taskType,
    status: p.status,
    primaryMetric: td.primaryMetric,
    computeId: p.computeId,
    createdAt: p.creationContext?.createdAt || raw?.systemData?.createdAt,
    startTimeUtc: p.startTimeUtc,
    endTimeUtc: p.endTimeUtc,
    studioUrl: services?.Studio?.endpoint,
    tags: p.tags,
  };
}

function computeArmId(t: AmlTarget, computeName: string): string {
  return (
    `/subscriptions/${t.subscriptionId}/resourceGroups/${t.resourceGroup}` +
    `/providers/Microsoft.MachineLearningServices/workspaces/${t.workspace}/computes/${computeName}`
  );
}

/**
 * Submit a real AutoML job. PUT <ws>/jobs/{name}. Returns the shaped job so the
 * caller can poll getAutoMlJob() / list for run monitoring.
 */
export async function submitAutoMlJob(input: SubmitAutoMlInput): Promise<AutoMlJob> {
  if (!input.trainingDataUri) throw new AutoMlError(400, undefined, 'trainingDataUri is required');
  if (!input.targetColumnName) throw new AutoMlError(400, undefined, 'targetColumnName is required');
  if (!input.computeName) throw new AutoMlError(400, undefined, 'computeName is required');
  if (input.task === 'Forecasting' && !input.forecastingSettings?.timeColumnName) {
    throw new AutoMlError(400, undefined, 'forecastingSettings.timeColumnName is required for a forecasting task');
  }

  const t = resolveAmlTarget();
  const name = `loom-automl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const primaryMetric = input.primaryMetric || defaultPrimaryMetric(input.task);

  const limitSettings: Record<string, unknown> = {};
  if (input.experimentTimeoutMinutes != null) limitSettings.timeout = `PT${Math.max(15, Math.floor(input.experimentTimeoutMinutes))}M`;
  if (input.maxTrials != null) limitSettings.maxTrials = Math.max(1, Math.floor(input.maxTrials));
  if (input.maxConcurrentTrials != null) limitSettings.maxConcurrentTrials = Math.max(1, Math.floor(input.maxConcurrentTrials));

  const taskDetails: Record<string, unknown> = {
    taskType: TASK_ARM[input.task],
    primaryMetric,
    targetColumnName: input.targetColumnName,
    trainingData: {
      jobInputType: 'mltable',
      uri: input.trainingDataUri,
    },
    limitSettings: Object.keys(limitSettings).length ? limitSettings : undefined,
  };
  if (input.nCrossValidations != null) {
    taskDetails.nCrossValidations = { mode: 'Custom', value: Math.max(2, Math.floor(input.nCrossValidations)) };
  }
  if (input.task === 'Forecasting' && input.forecastingSettings) {
    const fs = input.forecastingSettings;
    taskDetails.forecastingSettings = {
      timeColumnName: fs.timeColumnName,
      forecastHorizon: fs.forecastHorizon != null
        ? { mode: 'Custom', value: Math.max(1, Math.floor(fs.forecastHorizon)) }
        : { mode: 'Auto' },
      timeSeriesIdColumnNames:
        fs.timeSeriesIdColumnNames && fs.timeSeriesIdColumnNames.length
          ? fs.timeSeriesIdColumnNames
          : undefined,
    };
  }

  const armBody = {
    properties: {
      jobType: 'AutoML',
      displayName: input.displayName || `AutoML ${input.task} run`,
      experimentName: input.experimentName || 'loom-automl',
      computeId: computeArmId(t, input.computeName),
      taskDetails,
    },
  };

  const res = await automlFetch(`/jobs/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(armBody),
  });
  const j = await readJson<any>(res, 'submitAutoMlJob');
  // readJson() returns null ONLY on a 404 — for a PUT that means the parent
  // workspace or the referenced compute cluster doesn't exist. NEVER fabricate
  // a synthetic {status:'NotStarted'} success over that null effect
  // (no-vaporware.md): throw so the route surfaces an honest error / gate.
  if (!j) {
    throw new AutoMlError(
      404,
      undefined,
      `AutoML job submit failed (404): the Azure ML workspace or the compute cluster ` +
      `'${input.computeName}' was not found. Verify LOOM_AML_WORKSPACE points at a real ` +
      `Azure ML workspace (resolved: ${resolveAmlTarget().workspace}) and that an AmlCompute ` +
      `cluster named '${input.computeName}' exists in it.`,
    );
  }
  return shapeAutoMlJob(j);
}

// ============================================================
// List + poll + cancel (run monitoring)
// ============================================================

/** List AutoML jobs in the workspace (run-monitoring table). Newest first. */
export async function listAutoMlJobs(opts: { maxResults?: number } = {}): Promise<AutoMlJob[]> {
  const cap = opts.maxResults ?? 200;
  const out: AutoMlJob[] = [];
  let res = await automlFetch('/jobs', { query: { $filter: "jobType eq 'AutoML'" } });
  let j = await readJson<{ value?: any[]; nextLink?: string }>(res, 'listAutoMlJobs');
  while (j) {
    if (Array.isArray(j.value)) {
      for (const r of j.value) {
        // The $filter on jobType is honored by ARM, but guard client-side too.
        if ((r?.properties?.jobType || '') === 'AutoML') out.push(shapeAutoMlJob(r));
      }
    }
    if (!j.nextLink || out.length >= cap) break;
    const token = await credential.getToken(armScope());
    res = await fetchWithTimeout(j.nextLink, { headers: { authorization: `Bearer ${token!.token}` } });
    j = await readJson<{ value?: any[]; nextLink?: string }>(res, 'listAutoMlJobs');
  }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out.slice(0, cap);
}

/** Read a single AutoML job (status poll). Null on 404. */
export async function getAutoMlJob(name: string): Promise<AutoMlJob | null> {
  const res = await automlFetch(`/jobs/${encodeURIComponent(name)}`);
  const j = await readJson<any>(res, 'getAutoMlJob');
  return j ? shapeAutoMlJob(j) : null;
}

/** Cancel a running AutoML job. POST <ws>/jobs/{name}/cancel → 202. */
export async function cancelAutoMlJob(name: string): Promise<void> {
  const res = await automlFetch(`/jobs/${encodeURIComponent(name)}/cancel`, { method: 'POST' });
  if (res.ok || res.status === 202 || res.status === 204) return;
  const t = await res.text().catch(() => '');
  // A job that's already terminal can't be canceled — treat as success.
  if (res.status === 409 || /terminal|completed|failed|canceled|not.*running/i.test(t)) return;
  throw new AutoMlError(res.status, t, `AutoML job cancel failed: ${t.slice(0, 240)}`);
}

/** AutoML terminal job states. */
const TERMINAL = ['Completed', 'Failed', 'Canceled', 'NotResponding'];
export function autoMlJobIsTerminal(status?: string): boolean {
  return TERMINAL.includes(status || '');
}
