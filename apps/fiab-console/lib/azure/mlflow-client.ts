/**
 * Azure Machine Learning — MLflow tracking REST client.
 *
 * AML exposes a fully MLflow-compatible tracking server. The tracking URI is
 *   https://<region>.api.azureml.ms/mlflow/v1.0/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.MachineLearningServices/workspaces/<ws>
 * (verified — Learn "Configure MLflow for Azure Machine Learning" /
 * "how-to-use-mlflow-configure-tracking"). The standard open-source MLflow REST
 * routes hang off that base, e.g. `<base>/api/2.0/mlflow/runs/search`.
 *
 * Endpoints wired (all standard MLflow REST 2.0, served by AML):
 *   POST <base>/api/2.0/mlflow/experiments/search   → searchExperiments()
 *   POST <base>/api/2.0/mlflow/runs/search          → searchRuns()
 *   GET  <base>/api/2.0/mlflow/runs/get             → getRun()
 *   GET  <base>/api/2.0/mlflow/metrics/get-history  → getMetricHistory()
 * The MLflow REST contract is documented at
 *   https://mlflow.org/docs/latest/rest-api.html
 * and AML's hosting of it (and the tracking-URI shape) at
 *   https://learn.microsoft.com/azure/machine-learning/how-to-use-mlflow-configure-tracking
 *   https://learn.microsoft.com/azure/machine-learning/how-to-track-experiments-mlflow
 *
 * Auth: the AML MLflow server accepts the same AAD bearer token used elsewhere
 * for the AML data plane — the ARM token (`https://management.azure.com/.default`)
 * minted from the Console UAMI via ChainedTokenCredential. This matches how
 * foundry-client.ts authenticates `*.api.azureml.ms` calls.
 *
 * Honest infra-gate: when the workspace/region cannot be resolved from env,
 * `mlflowConfig()` throws `MlflowNotConfiguredError` carrying the exact env
 * vars to set. Routes surface that as a Fluent MessageBar; the editor surface
 * still renders fully.
 */
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

const ARM_SCOPE = 'https://management.azure.com/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Raised when the AML workspace/region needed for MLflow isn't configured. */
export class MlflowNotConfiguredError extends Error {
  hint: string;
  missing: string[];
  constructor(missing: string[]) {
    super('Azure ML MLflow tracking is not configured in this deployment');
    this.name = 'MlflowNotConfiguredError';
    this.missing = missing;
    this.hint =
      `Set ${missing.join(' + ')} to a deployed Azure Machine Learning workspace, ` +
      `then grant the Console UAMI the AzureML Data Scientist role on it. ` +
      `LOOM_AML_WORKSPACE / LOOM_AML_REGION fall back to LOOM_FOUNDRY_NAME / ` +
      `LOOM_FOUNDRY_REGION when those are set.`;
  }
}

/** Non-404 MLflow REST failure. */
export class MlflowError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `MLflow tracking call failed (${status})`);
    this.name = 'MlflowError';
    this.status = status;
    this.body = body;
  }
}

interface MlflowConfig {
  region: string;
  subscriptionId: string;
  resourceGroup: string;
  workspace: string;
  base: string;
}

/**
 * Resolve the MLflow tracking base URI from env. Workspace + region honor the
 * task's dedicated vars first, then fall back to the Foundry hub env so an
 * already-configured Loom keeps working without new vars.
 */
export function mlflowConfig(): MlflowConfig {
  const missing: string[] = [];
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID;
  if (!subscriptionId) missing.push('LOOM_SUBSCRIPTION_ID');

  const workspace = process.env.LOOM_AML_WORKSPACE || process.env.LOOM_FOUNDRY_NAME;
  if (!workspace) missing.push('LOOM_AML_WORKSPACE');

  const region =
    process.env.LOOM_AML_REGION || process.env.LOOM_FOUNDRY_REGION;
  if (!region) missing.push('LOOM_AML_REGION');

  if (missing.length) throw new MlflowNotConfiguredError(missing);

  const resourceGroup =
    process.env.LOOM_AML_RG ||
    process.env.LOOM_FOUNDRY_RG ||
    'rg-csa-loom-admin-eastus2';

  const base =
    `https://${region}.api.azureml.ms/mlflow/v1.0` +
    `/subscriptions/${subscriptionId}` +
    `/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.MachineLearningServices/workspaces/${workspace}`;

  return { region: region!, subscriptionId: subscriptionId!, resourceGroup, workspace: workspace!, base };
}

/** True when MLflow can be reached (env is set). Lets callers branch without try/catch. */
export function isMlflowConfigured(): boolean {
  try {
    mlflowConfig();
    return true;
  } catch {
    return false;
  }
}

async function authHeader(): Promise<string> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire token for AML MLflow tracking');
  return `Bearer ${token.token}`;
}

async function mlflowFetch(
  apiPath: string,
  init: RequestInit & { query?: Record<string, string | string[]> } = {},
): Promise<Response> {
  const cfg = mlflowConfig();
  const { query, ...rest } = init;
  let url = `${cfg.base}/api/2.0/mlflow${apiPath}`;
  if (query) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
      else sp.append(k, v);
    }
    const qs = sp.toString();
    if (qs) url += `?${qs}`;
  }
  return fetch(url, {
    ...rest,
    headers: {
      ...(rest.headers || {}),
      authorization: await authHeader(),
      'content-type': 'application/json',
    },
  });
}

async function readMlflowJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg =
      (parsed as any)?.message ||
      (parsed as any)?.error?.message ||
      (typeof parsed === 'string' ? parsed : `MLflow ${res.status}`);
    throw new MlflowError(res.status, parsed, `MLflow tracking ${res.status}: ${String(msg).slice(0, 280)}`);
  }
  return (parsed as T) ?? ({} as T);
}

// ---------------- Shaped entities ----------------

export interface MlflowExperiment {
  experimentId: string;
  name: string;
  artifactLocation?: string;
  lifecycleStage?: string;
  lastUpdateTime?: number;
  creationTime?: number;
  tags?: Record<string, string>;
}

export interface MlflowMetric {
  key: string;
  value: number;
  timestamp?: number;
  step?: number;
}

export interface MlflowParam {
  key: string;
  value: string;
}

export interface MlflowRunTag {
  key: string;
  value: string;
}

export interface MlflowRun {
  runId: string;
  runName?: string;
  experimentId?: string;
  status?: string;        // RUNNING | SCHEDULED | FINISHED | FAILED | KILLED
  startTime?: number;
  endTime?: number;
  artifactUri?: string;
  lifecycleStage?: string;
  /** Latest value per metric key (MLflow run.data.metrics is last-value-only). */
  metrics: MlflowMetric[];
  params: MlflowParam[];
  tags: MlflowRunTag[];
}

function tagsToMap(tags?: MlflowRunTag[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const t of tags || []) if (t?.key != null) m[t.key] = t.value;
  return m;
}

function shapeRun(raw: any): MlflowRun {
  const info = raw?.info || {};
  const data = raw?.data || {};
  const tags: MlflowRunTag[] = Array.isArray(data.tags) ? data.tags : [];
  // MLflow's mlflow.runName tag is the user-facing run name when info.run_name
  // isn't populated by older servers.
  const runNameTag = tags.find((t) => t.key === 'mlflow.runName')?.value;
  return {
    runId: info.run_id || info.runId || info.run_uuid,
    runName: info.run_name || info.runName || runNameTag,
    experimentId: info.experiment_id || info.experimentId,
    status: info.status,
    startTime: numOrUndef(info.start_time ?? info.startTime),
    endTime: numOrUndef(info.end_time ?? info.endTime),
    artifactUri: info.artifact_uri || info.artifactUri,
    lifecycleStage: info.lifecycle_stage || info.lifecycleStage,
    metrics: Array.isArray(data.metrics) ? data.metrics.map(shapeMetric) : [],
    params: Array.isArray(data.params) ? data.params : [],
    tags,
  };
}

function shapeMetric(raw: any): MlflowMetric {
  return {
    key: raw?.key,
    value: typeof raw?.value === 'number' ? raw.value : Number(raw?.value),
    timestamp: numOrUndef(raw?.timestamp),
    step: numOrUndef(raw?.step),
  };
}

function numOrUndef(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function shapeExperiment(raw: any): MlflowExperiment {
  return {
    experimentId: raw?.experiment_id || raw?.experimentId,
    name: raw?.name,
    artifactLocation: raw?.artifact_location || raw?.artifactLocation,
    lifecycleStage: raw?.lifecycle_stage || raw?.lifecycleStage,
    lastUpdateTime: numOrUndef(raw?.last_update_time ?? raw?.lastUpdateTime),
    creationTime: numOrUndef(raw?.creation_time ?? raw?.creationTime),
    tags: Array.isArray(raw?.tags)
      ? Object.fromEntries((raw.tags as any[]).map((t) => [t.key, t.value]))
      : undefined,
  };
}

// ---------------- Experiments ----------------

/**
 * POST <base>/api/2.0/mlflow/experiments/search
 * https://mlflow.org/docs/latest/rest-api.html#search-experiments
 */
export async function searchExperiments(opts: { maxResults?: number; filter?: string } = {}): Promise<MlflowExperiment[]> {
  const out: MlflowExperiment[] = [];
  let pageToken: string | undefined;
  do {
    const body: any = { max_results: opts.maxResults ?? 1000 };
    if (opts.filter) body.filter = opts.filter;
    if (pageToken) body.page_token = pageToken;
    const res = await mlflowFetch('/experiments/search', { method: 'POST', body: JSON.stringify(body) });
    const j = await readMlflowJson<{ experiments?: any[]; next_page_token?: string }>(res);
    for (const e of j.experiments || []) out.push(shapeExperiment(e));
    pageToken = j.next_page_token;
  } while (pageToken && out.length < (opts.maxResults ?? 1000));
  return out;
}

/**
 * GET <base>/api/2.0/mlflow/experiments/get-by-name?experiment_name=...
 * https://mlflow.org/docs/latest/rest-api.html#get-experiment-by-name
 * Returns null when the experiment doesn't exist (MLflow 404 RESOURCE_DOES_NOT_EXIST).
 */
export async function getExperimentByName(name: string): Promise<MlflowExperiment | null> {
  const res = await mlflowFetch('/experiments/get-by-name', { method: 'GET', query: { experiment_name: name } });
  if (res.status === 404) return null;
  const j = await readMlflowJson<{ experiment?: any }>(res);
  return j.experiment ? shapeExperiment(j.experiment) : null;
}

// ---------------- Runs ----------------

/**
 * POST <base>/api/2.0/mlflow/runs/search
 * https://mlflow.org/docs/latest/rest-api.html#search-runs
 * Returns runs (with last-value metrics, params, tags) across the given
 * experiment ids. Default ordering newest-first by start time.
 */
export async function searchRuns(opts: {
  experimentIds: string[];
  filter?: string;
  maxResults?: number;
  orderBy?: string[];
  runViewType?: 'ACTIVE_ONLY' | 'DELETED_ONLY' | 'ALL';
}): Promise<MlflowRun[]> {
  if (!opts.experimentIds?.length) return [];
  const out: MlflowRun[] = [];
  const cap = opts.maxResults ?? 200;
  let pageToken: string | undefined;
  do {
    const body: any = {
      experiment_ids: opts.experimentIds,
      max_results: Math.min(cap, 1000),
      run_view_type: opts.runViewType || 'ACTIVE_ONLY',
      order_by: opts.orderBy || ['attributes.start_time DESC'],
    };
    if (opts.filter) body.filter = opts.filter;
    if (pageToken) body.page_token = pageToken;
    const res = await mlflowFetch('/runs/search', { method: 'POST', body: JSON.stringify(body) });
    const j = await readMlflowJson<{ runs?: any[]; next_page_token?: string }>(res);
    for (const r of j.runs || []) out.push(shapeRun(r));
    pageToken = j.next_page_token;
  } while (pageToken && out.length < cap);
  return out.slice(0, cap);
}

/**
 * Convenience: resolve an experiment by name then search its runs. Returns
 * `{ experiment: null, runs: [] }` when the experiment doesn't exist.
 */
export async function searchRunsByExperimentName(
  experimentName: string,
  opts: { filter?: string; maxResults?: number } = {},
): Promise<{ experiment: MlflowExperiment | null; runs: MlflowRun[] }> {
  const experiment = await getExperimentByName(experimentName);
  if (!experiment) return { experiment: null, runs: [] };
  const runs = await searchRuns({ experimentIds: [experiment.experimentId], ...opts });
  return { experiment, runs };
}

/**
 * GET <base>/api/2.0/mlflow/runs/get?run_id=...
 * https://mlflow.org/docs/latest/rest-api.html#get-run
 * Returns null on 404.
 */
export async function getRun(runId: string): Promise<MlflowRun | null> {
  const res = await mlflowFetch('/runs/get', { method: 'GET', query: { run_id: runId } });
  if (res.status === 404) return null;
  const j = await readMlflowJson<{ run?: any }>(res);
  return j.run ? shapeRun(j.run) : null;
}

/**
 * GET <base>/api/2.0/mlflow/metrics/get-history?run_id=...&metric_key=...
 * https://mlflow.org/docs/latest/rest-api.html#get-metric-history
 * Returns the full step/value/timestamp series for a single metric (the data
 * the studio "Metrics" tab charts). Empty array on 404.
 */
export async function getMetricHistory(runId: string, metricKey: string, maxResults = 5000): Promise<MlflowMetric[]> {
  const out: MlflowMetric[] = [];
  let pageToken: string | undefined;
  do {
    const query: Record<string, string> = { run_id: runId, metric_key: metricKey, max_results: String(Math.min(maxResults, 5000)) };
    if (pageToken) query.page_token = pageToken;
    const res = await mlflowFetch('/metrics/get-history', { method: 'GET', query });
    if (res.status === 404) return out;
    const j = await readMlflowJson<{ metrics?: any[]; next_page_token?: string }>(res);
    for (const m of j.metrics || []) out.push(shapeMetric(m));
    pageToken = j.next_page_token;
  } while (pageToken && out.length < maxResults);
  // Sort by step then timestamp so the chart plots a clean left-to-right series.
  out.sort((a, b) => (a.step ?? 0) - (b.step ?? 0) || (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return out;
}
