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
 * for the AML data plane — the ARM token (the sovereign-cloud ARM `.default`
 * scope from cloud-endpoints) minted from the Console UAMI via
 * ChainedTokenCredential. This matches how
 * foundry-client.ts authenticates `*.api.azureml.ms` calls.
 *
 * Honest infra-gate: when the workspace/region cannot be resolved from env,
 * `mlflowConfig()` throws `MlflowNotConfiguredError` carrying the exact env
 * vars to set. Routes surface that as a Fluent MessageBar; the editor surface
 * still renders fully.
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armScope, amlDataPlaneHost } from './cloud-endpoints';

const ARM_SCOPE = armScope();

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
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
    // In a sovereign boundary (GCC-High / IL5) the commercial
    // `*.api.azureml.ms` tracking host is not the right data plane, and
    // Microsoft does not publicly document a stable alternate hostname. The
    // only supported path there is an explicit tracking URI — name it.
    if (missing.includes('LOOM_MLFLOW_TRACKING_URI')) {
      this.hint =
        `Set LOOM_MLFLOW_TRACKING_URI to the Azure Machine Learning workspace ` +
        `MLflow tracking URI for this boundary — obtain it with ` +
        `\`az ml workspace show --query mlflow_tracking_uri -o tsv\` against the ` +
        `target IL5 / GCC-High workspace — then grant the Console UAMI the ` +
        `AzureML Data Scientist role on that workspace. In Commercial / GCC you ` +
        `may instead set LOOM_AML_WORKSPACE + LOOM_AML_REGION + ` +
        `LOOM_SUBSCRIPTION_ID and the tracking URI is constructed automatically.`;
    } else {
      this.hint =
        `Set ${missing.join(' + ')} to a deployed Azure Machine Learning workspace, ` +
        `then grant the Console UAMI the AzureML Data Scientist role on it. ` +
        `LOOM_AML_WORKSPACE / LOOM_AML_REGION fall back to LOOM_FOUNDRY_NAME / ` +
        `LOOM_FOUNDRY_REGION when those are set. Alternatively set ` +
        `LOOM_MLFLOW_TRACKING_URI directly (required in IL5 / GCC-High).`;
    }
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
/**
 * Resolve the MLflow tracking base URI from env.
 *
 * Priority:
 *   1. LOOM_MLFLOW_TRACKING_URI — an explicit AML MLflow tracking URI. Useful
 *      for private-link workspaces or boundary-specific shapes that auto-
 *      construction cannot express; it is exactly what `az ml workspace show
 *      --query mlflow_tracking_uri` returns. The bearer ARM token authenticates
 *      the derived https data-plane host.
 *   2. LOOM_AML_WORKSPACE + LOOM_AML_REGION + LOOM_SUBSCRIPTION_ID — auto-
 *      construction with a sovereign-aware data-plane host (api.azureml.ms in
 *      Commercial / GCC, api.ml.azure.us in GCC-High / IL5, resolved by
 *      `amlDataPlaneHost`). Workspace + region honor the task's dedicated vars
 *      first, then fall back to the Foundry hub env so an already-configured
 *      Loom keeps working without new vars.
 *
 * `workspaceOverride` lets a caller target a *bound* AML workspace (the model
 * registry / stage operations run against the workspace the Loom item is bound
 * to, not just the env hub). The region + resource group still come from env —
 * for the default Loom deployment every workspace lives in the same admin
 * plane; set `LOOM_AML_REGION` / `LOOM_AML_RG` when a bound workspace differs.
 */
export function mlflowConfig(workspaceOverride?: string): MlflowConfig {
  // 1. Explicit tracking URI override (private-link / boundary-specific shapes).
  const explicit = process.env.LOOM_MLFLOW_TRACKING_URI?.trim();
  if (explicit) {
    // `azureml://...` tracking URIs map 1:1 to the https data-plane host; the
    // bearer ARM token authenticates both. Normalize + strip a trailing
    // `/mlflow/...` suffix duplication / trailing slashes, then derive the
    // ids from the path for the MlflowConfig shape (best-effort).
    let base = explicit.replace(/^azureml:\/\//, 'https://').replace(/\/+$/, '');
    const subMatch = base.match(/subscriptions\/([^/]+)/i);
    const rgMatch = base.match(/resourceGroups\/([^/]+)/i);
    const wsMatch = base.match(/workspaces\/([^/]+)/i);
    return {
      region: process.env.LOOM_AML_REGION || process.env.LOOM_FOUNDRY_REGION || 'unknown',
      subscriptionId: subMatch?.[1] || process.env.LOOM_SUBSCRIPTION_ID || '',
      resourceGroup: rgMatch?.[1] || process.env.LOOM_AML_RG || process.env.LOOM_FOUNDRY_RG || '',
      workspace:
        (workspaceOverride && workspaceOverride.trim()) ||
        wsMatch?.[1] ||
        process.env.LOOM_AML_WORKSPACE ||
        process.env.LOOM_FOUNDRY_NAME ||
        '',
      base,
    };
  }

  // 2. Auto-construction with a sovereign-aware data-plane host.

  const missing: string[] = [];
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID;
  if (!subscriptionId) missing.push('LOOM_SUBSCRIPTION_ID');

  const workspace =
    (workspaceOverride && workspaceOverride.trim()) ||
    process.env.LOOM_AML_WORKSPACE ||
    process.env.LOOM_FOUNDRY_NAME;
  if (!workspace) missing.push('LOOM_AML_WORKSPACE');

  const region =
    process.env.LOOM_AML_REGION || process.env.LOOM_FOUNDRY_REGION;
  if (!region) missing.push('LOOM_AML_REGION');

  if (missing.length) throw new MlflowNotConfiguredError(missing);

  const resourceGroup =
    process.env.LOOM_AML_RG ||
    process.env.LOOM_FOUNDRY_RG ||
    'rg-csa-loom-admin-eastus2';

  // Sovereign-cloud aware host: api.azureml.ms (Commercial/GCC) vs
  // api.ml.azure.us (GCC-High / IL5). Never hard-code the Commercial host.
  const base =
    `https://${amlDataPlaneHost(region!)}/mlflow/v1.0` +
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
  init: RequestInit & { query?: Record<string, string | string[]>; workspace?: string } = {},
): Promise<Response> {
  const { query, workspace, ...rest } = init;
  const cfg = mlflowConfig(workspace);
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
  return fetchWithTimeout(url, {
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

// ---------------- Artifacts ----------------

export interface MlflowArtifact {
  /** Path relative to the run's artifact root (e.g. `model/MLmodel`). */
  path: string;
  /** True for a directory (expandable in the artifact tree). */
  isDir: boolean;
  /** File size in bytes (absent / undefined for directories). */
  fileSize?: number;
}

/**
 * GET <base>/api/2.0/mlflow/artifacts/list?run_id=...&path=...
 * https://mlflow.org/docs/latest/rest-api.html#list-artifacts
 * Lists the artifacts logged under a run (one directory level at `path`). The
 * studio "Outputs + logs" tree is built by recursing into `isDir` entries.
 * Returns [] on 404 (run has no artifacts / path doesn't exist).
 */
export async function listArtifacts(runId: string, path?: string): Promise<MlflowArtifact[]> {
  const query: Record<string, string> = { run_id: runId };
  if (path) query.path = path;
  const res = await mlflowFetch('/artifacts/list', { method: 'GET', query });
  if (res.status === 404) return [];
  const j = await readMlflowJson<{ files?: any[] }>(res);
  return (j.files || []).map((f) => ({
    path: f.path,
    isDir: f.is_dir ?? f.isDir ?? false,
    fileSize: numOrUndef(f.file_size ?? f.fileSize),
  }));
}

// ---------------- Model Registry (stages live HERE, not in ARM) ----------------

/**
 * MLflow model-version — the registry view that carries `current_stage`
 * (None | Staging | Production | Archived) and the source `run_id` (lineage).
 *
 * IMPORTANT: stages are an MLflow-layer concept. Per Microsoft Learn
 * ("how-to-manage-models-mlflow"): "You can access stages only by using the
 * MLflow SDK. They aren't visible in the Azure Machine Learning studio. You
 * can't retrieve stages by using the Azure Machine Learning SDK, the CLI, or
 * the REST API." The ARM model-version object (foundry-client FoundryModelVersion)
 * has no stage — it lives here on the MLflow REST surface AML hosts.
 */
export interface MlflowModelVersion {
  name: string;
  version: string;
  /** None | Staging | Production | Archived. */
  currentStage?: string;
  description?: string;
  creationTimestamp?: number;
  lastUpdatedTimestamp?: number;
  /** Artifact source URI (azureml://…). */
  source?: string;
  /** Source run id — the lineage link back to the training run. */
  runId?: string;
  runLink?: string;
  /** READY | PENDING_REGISTRATION | FAILED_REGISTRATION. */
  status?: string;
  statusMessage?: string;
  tags?: Record<string, string>;
}

/** Valid MLflow model stages (the transition-stage target values). */
export const MLFLOW_MODEL_STAGES = ['None', 'Staging', 'Production', 'Archived'] as const;
export type MlflowModelStage = (typeof MLFLOW_MODEL_STAGES)[number];

export function isMlflowModelStage(v: unknown): v is MlflowModelStage {
  return typeof v === 'string' && (MLFLOW_MODEL_STAGES as readonly string[]).includes(v);
}

function shapeModelVersion(raw: any): MlflowModelVersion {
  const tags = Array.isArray(raw?.tags)
    ? Object.fromEntries((raw.tags as any[]).map((t) => [t.key, t.value]))
    : undefined;
  return {
    name: raw?.name,
    version: String(raw?.version ?? ''),
    currentStage: raw?.current_stage || raw?.currentStage,
    description: raw?.description,
    creationTimestamp: numOrUndef(raw?.creation_timestamp ?? raw?.creationTimestamp),
    lastUpdatedTimestamp: numOrUndef(raw?.last_updated_timestamp ?? raw?.lastUpdatedTimestamp),
    source: raw?.source,
    runId: raw?.run_id || raw?.runId,
    runLink: raw?.run_link || raw?.runLink,
    status: raw?.status,
    statusMessage: raw?.status_message || raw?.statusMessage,
    tags,
  };
}

/**
 * GET <base>/api/2.0/mlflow/model-versions/get?name=...&version=...
 * https://mlflow.org/docs/latest/rest-api.html#get-modelversion
 * Returns null on 404. Carries `current_stage` + `run_id` (lineage).
 */
export async function getMlflowModelVersion(
  name: string,
  version: string,
  workspace?: string,
): Promise<MlflowModelVersion | null> {
  const res = await mlflowFetch('/model-versions/get', {
    method: 'GET',
    query: { name, version: String(version) },
    workspace,
  });
  if (res.status === 404) return null;
  const j = await readMlflowJson<{ model_version?: any }>(res);
  return j.model_version ? shapeModelVersion(j.model_version) : null;
}

/**
 * POST <base>/api/2.0/mlflow/model-versions/search
 * https://mlflow.org/docs/latest/rest-api.html#search-modelversions
 * All versions of a registered model, each with its `current_stage`. This is
 * how the editor decorates the (ARM-sourced) version table with stages.
 */
export async function searchMlflowModelVersions(
  name: string,
  workspace?: string,
): Promise<MlflowModelVersion[]> {
  const out: MlflowModelVersion[] = [];
  let pageToken: string | undefined;
  const filter = `name='${name.replace(/'/g, "\\'")}'`;
  do {
    const body: any = { filter, max_results: 200 };
    if (pageToken) body.page_token = pageToken;
    const res = await mlflowFetch('/model-versions/search', { method: 'POST', body: JSON.stringify(body), workspace });
    if (res.status === 404) return out;
    const j = await readMlflowJson<{ model_versions?: any[]; next_page_token?: string }>(res);
    for (const m of j.model_versions || []) out.push(shapeModelVersion(m));
    pageToken = j.next_page_token;
  } while (pageToken && out.length < 2000);
  return out;
}

/**
 * POST <base>/api/2.0/mlflow/model-versions/transition-stage
 * https://mlflow.org/docs/latest/rest-api.html#transition-modelversion-stage
 * Body: { name, version, stage, archive_existing_versions }.
 * Returns the updated model_version (current_stage reflects the change) — this
 * IS the registry receipt the acceptance test wants.
 */
export async function transitionModelVersionStage(
  name: string,
  version: string,
  stage: MlflowModelStage,
  opts: { archiveExisting?: boolean; workspace?: string } = {},
): Promise<MlflowModelVersion> {
  const body = {
    name,
    version: String(version),
    stage,
    archive_existing_versions: !!opts.archiveExisting,
  };
  const res = await mlflowFetch('/model-versions/transition-stage', {
    method: 'POST',
    body: JSON.stringify(body),
    workspace: opts.workspace,
  });
  const j = await readMlflowJson<{ model_version?: any }>(res);
  if (!j.model_version) {
    throw new MlflowError(res.status, j, 'transition-stage returned no model_version');
  }
  return shapeModelVersion(j.model_version);
}

/**
 * POST <base>/api/2.0/mlflow/model-versions/create
 * https://mlflow.org/docs/latest/rest-api.html#create-modelversion
 * The register-FROM-RUN path: supplying `run_id` records lineage so the new
 * version's `run_id` field points back at the training run (visible via
 * getMlflowModelVersion). The ARM PUT path (foundry-client.registerModelVersion)
 * cannot carry run lineage; this can.
 */
export async function createMlflowModelVersion(
  name: string,
  body: { source: string; runId?: string; description?: string; tags?: Record<string, string> },
  workspace?: string,
): Promise<MlflowModelVersion> {
  const payload: any = { name, source: body.source };
  if (body.runId) payload.run_id = body.runId;
  if (body.description) payload.description = body.description;
  if (body.tags) payload.tags = Object.entries(body.tags).map(([key, value]) => ({ key, value }));
  const res = await mlflowFetch('/model-versions/create', { method: 'POST', body: JSON.stringify(payload), workspace });
  const j = await readMlflowJson<{ model_version?: any }>(res);
  if (!j.model_version) {
    throw new MlflowError(res.status, j, 'model-versions/create returned no model_version');
  }
  return shapeModelVersion(j.model_version);
}
