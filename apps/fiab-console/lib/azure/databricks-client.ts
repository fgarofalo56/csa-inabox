/**
 * Databricks REST client for SQL Warehouses + Statement execution.
 *
 * Auth: AAD token for resource `2ff814a6-3304-4ab8-85cb-cd0e6f879c1d`
 * (Azure Databricks). Container App MI must be a Workspace user/admin
 * (granted via SCIM bootstrap — see deployment notes). For ARM-level
 * operations (resource provider) we use management.azure.com scope.
 *
 * Hostname comes from env LOOM_DATABRICKS_HOSTNAME, e.g.
 *   adb-7405613013893759.19.azuredatabricks.net
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

const DBX_SCOPE = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

function host(): string {
  const h = process.env.LOOM_DATABRICKS_HOSTNAME;
  if (!h) throw new Error('LOOM_DATABRICKS_HOSTNAME not configured');
  return h.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

async function dbxToken(): Promise<string> {
  const t = await credential.getToken(DBX_SCOPE);
  if (!t?.token) throw new Error('Failed to acquire Databricks AAD token');
  return t.token;
}

async function dbxFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await dbxToken();
  return fetch(`https://${host()}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
}

// ------------------------------------------------------------
// Warehouse management
// ------------------------------------------------------------

export interface Warehouse {
  id: string;
  name: string;
  state:
    | 'STARTING'
    | 'RUNNING'
    | 'STOPPING'
    | 'STOPPED'
    | 'DELETING'
    | 'DELETED'
    | string;
  cluster_size?: string;
  warehouse_type?: string;
  enable_serverless_compute?: boolean;
}

export async function listWarehouses(): Promise<Warehouse[]> {
  const res = await dbxFetch('/api/2.0/sql/warehouses');
  if (!res.ok) {
    throw new Error(`listWarehouses failed ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { warehouses?: Warehouse[] };
  return body.warehouses || [];
}

export async function getWarehouse(id: string): Promise<Warehouse> {
  const res = await dbxFetch(`/api/2.0/sql/warehouses/${encodeURIComponent(id)}`);
  if (!res.ok) {
    throw new Error(`getWarehouse failed ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as Warehouse;
}

export async function startWarehouse(id: string): Promise<void> {
  const res = await dbxFetch(`/api/2.0/sql/warehouses/${encodeURIComponent(id)}/start`, {
    method: 'POST',
  });
  if (!res.ok && res.status !== 200) {
    throw new Error(`startWarehouse failed ${res.status}: ${await res.text()}`);
  }
}

export async function stopWarehouse(id: string): Promise<void> {
  const res = await dbxFetch(`/api/2.0/sql/warehouses/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
  });
  if (!res.ok && res.status !== 200) {
    throw new Error(`stopWarehouse failed ${res.status}: ${await res.text()}`);
  }
}

export interface WarehouseScaleSpec {
  cluster_size?: string;          // '2X-Small' | 'X-Small' | 'Small' | 'Medium' | 'Large' | ... | '4X-Large'
  min_num_clusters?: number;      // 1-30
  max_num_clusters?: number;      // 1-30
  auto_stop_mins?: number;
  warehouse_type?: 'CLASSIC' | 'PRO';
  enable_serverless_compute?: boolean;
}

/**
 * Edit a SQL Warehouse via Databricks REST API. POST /api/2.0/sql/warehouses/{id}/edit
 * with the new cluster_size + scaling fields. Databricks requires the
 * warehouse to already exist (no upsert semantics) and will return 400
 * if cluster_size is outside the allowed enum.
 */
export async function editWarehouse(id: string, spec: WarehouseScaleSpec): Promise<void> {
  // Read existing to preserve required fields (name + warehouse_type) the
  // edit endpoint requires even when not changing them.
  const existing = await getWarehouse(id);
  const payload: Record<string, unknown> = {
    name: existing.name,
    warehouse_type: spec.warehouse_type ?? existing.warehouse_type ?? 'PRO',
    cluster_size: spec.cluster_size ?? existing.cluster_size,
  };
  if (typeof spec.min_num_clusters === 'number') payload.min_num_clusters = spec.min_num_clusters;
  if (typeof spec.max_num_clusters === 'number') payload.max_num_clusters = spec.max_num_clusters;
  if (typeof spec.auto_stop_mins === 'number') payload.auto_stop_mins = spec.auto_stop_mins;
  if (typeof spec.enable_serverless_compute === 'boolean') payload.enable_serverless_compute = spec.enable_serverless_compute;

  const res = await dbxFetch(`/api/2.0/sql/warehouses/${encodeURIComponent(id)}/edit`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`editWarehouse failed ${res.status}: ${await res.text()}`);
  }
}

// ------------------------------------------------------------
// Query history (SQL warehouse statement history)
// ------------------------------------------------------------

export interface DbxQueryHistoryEntry {
  query_id: string;
  status: string;
  query_text?: string;
  query_start_time_ms?: number;
  query_end_time_ms?: number;
  duration?: number;       // ms
  warehouse_id?: string;
  user_name?: string;
  user_id?: number;
  executed_as_user_name?: string;
  rows_produced?: number;
  error_message?: string;
}

export async function listQueryHistory(
  opts: {
    warehouseId?: string;
    maxResults?: number;
    pageToken?: string;
    includeMetrics?: boolean;
  } = {},
): Promise<{ entries: DbxQueryHistoryEntry[]; nextPageToken?: string }> {
  const max = Math.max(1, Math.min(opts.maxResults ?? 50, 1000));
  const params = new URLSearchParams();
  params.set('max_results', String(max));
  if (opts.pageToken) params.set('page_token', opts.pageToken);
  if (opts.includeMetrics) params.set('include_metrics', 'true');
  if (opts.warehouseId) {
    params.set('filter_by.warehouse_ids', opts.warehouseId);
  }
  const res = await dbxFetch(`/api/2.0/sql/history/queries?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`listQueryHistory failed ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { res?: any[]; next_page_token?: string };
  const entries: DbxQueryHistoryEntry[] = (body.res || []).map((r) => ({
    query_id: r.query_id,
    status: r.status,
    query_text: r.query_text,
    query_start_time_ms: r.query_start_time_ms,
    query_end_time_ms: r.query_end_time_ms,
    duration: r.duration,
    warehouse_id: r.warehouse_id,
    user_name: r.user_name,
    user_id: r.user_id,
    executed_as_user_name: r.executed_as_user_name,
    rows_produced: r.rows_produced,
    error_message: r.error_message,
  }));
  return { entries, nextPageToken: body.next_page_token };
}

// ------------------------------------------------------------
// Statement execution
// ------------------------------------------------------------

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionMs: number;
  truncated: boolean;
}

interface StatementResponse {
  statement_id: string;
  status: { state: string; error?: { message?: string; error_code?: string } };
  manifest?: {
    schema?: { columns?: { name: string; type_name?: string; position?: number }[] };
    total_row_count?: number;
    truncated?: boolean;
  };
  result?: {
    data_array?: unknown[][];
    chunk_index?: number;
  };
}

const MAX_ROWS = 5_000;
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 120_000;

export async function executeStatement(
  warehouseId: string,
  sql: string,
  catalog?: string,
  schema?: string,
): Promise<QueryResult> {
  const t0 = Date.now();
  const payload: Record<string, unknown> = {
    warehouse_id: warehouseId,
    statement: sql,
    wait_timeout: '30s',
    on_wait_timeout: 'CONTINUE',
    disposition: 'INLINE',
    format: 'JSON_ARRAY',
    row_limit: MAX_ROWS,
  };
  if (catalog) payload.catalog = catalog;
  if (schema) payload.schema = schema;

  const res = await dbxFetch('/api/2.0/sql/statements', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`executeStatement submit failed ${res.status}: ${await res.text()}`);
  }
  let body = (await res.json()) as StatementResponse;

  // Poll until terminal (SUCCEEDED / FAILED / CANCELED / CLOSED).
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (
    (body.status?.state === 'PENDING' || body.status?.state === 'RUNNING') &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const r2 = await dbxFetch(`/api/2.0/sql/statements/${encodeURIComponent(body.statement_id)}`);
    if (!r2.ok) {
      throw new Error(`executeStatement poll failed ${r2.status}: ${await r2.text()}`);
    }
    body = (await r2.json()) as StatementResponse;
  }

  if (body.status?.state !== 'SUCCEEDED') {
    const msg =
      body.status?.error?.message ||
      `Statement ${body.status?.state || 'unknown'} (no error message)`;
    const err: Error & { code?: string } = new Error(msg);
    if (body.status?.error?.error_code) err.code = body.status.error.error_code;
    throw err;
  }

  const cols = (body.manifest?.schema?.columns || [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((c) => c.name);
  const rows = body.result?.data_array || [];
  return {
    columns: cols,
    rows,
    rowCount: body.manifest?.total_row_count ?? rows.length,
    executionMs: Date.now() - t0,
    truncated: !!body.manifest?.truncated,
  };
}

// ============================================================
// Helpers — uniform error surfacing
// ============================================================
async function asJsonOrThrow<T>(res: Response, op: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    const err: Error & { status?: number; body?: string } = new Error(
      `${op} failed ${res.status}: ${text || res.statusText}`,
    );
    err.status = res.status;
    err.body = text;
    throw err;
  }
  // Some endpoints (start/restart/delete) return empty body on success.
  const text = await res.text();
  return (text ? JSON.parse(text) : ({} as T)) as T;
}

// ============================================================
// Workspace / Notebooks  (api/2.0/workspace, api/2.1/jobs/runs)
// ============================================================
export interface WorkspaceObject {
  object_type: 'NOTEBOOK' | 'DIRECTORY' | 'LIBRARY' | 'FILE' | 'REPO' | string;
  path: string;
  language?: 'PYTHON' | 'SQL' | 'SCALA' | 'R' | string;
  object_id?: number;
  created_at?: number;
  modified_at?: number;
}

export async function listWorkspace(path = '/Workspace'): Promise<WorkspaceObject[]> {
  const res = await dbxFetch(
    `/api/2.0/workspace/list?path=${encodeURIComponent(path)}`,
  );
  // workspace/list returns 404 RESOURCE_DOES_NOT_EXIST on empty/missing path — bubble as []
  if (res.status === 404) return [];
  const body = await asJsonOrThrow<{ objects?: WorkspaceObject[] }>(res, 'listWorkspace');
  return body.objects || [];
}

export interface NotebookContent {
  path: string;
  language: string;
  content: string; // decoded source (UTF-8)
}

export async function getNotebook(path: string): Promise<NotebookContent> {
  const res = await dbxFetch(
    `/api/2.0/workspace/export?path=${encodeURIComponent(path)}&format=SOURCE&direct_download=false`,
  );
  const body = await asJsonOrThrow<{ content: string; file_type?: string }>(res, 'getNotebook');
  const buf = Buffer.from(body.content || '', 'base64');
  // Best-effort language detection from extension/header
  const lower = path.toLowerCase();
  const language = lower.endsWith('.py')
    ? 'PYTHON'
    : lower.endsWith('.sql')
      ? 'SQL'
      : lower.endsWith('.scala')
        ? 'SCALA'
        : lower.endsWith('.r')
          ? 'R'
          : (body.file_type || 'PYTHON').toUpperCase();
  return { path, language, content: buf.toString('utf-8') };
}

export async function importNotebook(
  path: string,
  language: 'PYTHON' | 'SQL' | 'SCALA' | 'R',
  source: string,
  overwrite = true,
): Promise<void> {
  const res = await dbxFetch('/api/2.0/workspace/import', {
    method: 'POST',
    body: JSON.stringify({
      path,
      format: 'SOURCE',
      language,
      content: Buffer.from(source, 'utf-8').toString('base64'),
      overwrite,
    }),
  });
  await asJsonOrThrow<unknown>(res, 'importNotebook');
}

export async function deleteWorkspaceObject(path: string, recursive = false): Promise<void> {
  const res = await dbxFetch('/api/2.0/workspace/delete', {
    method: 'POST',
    body: JSON.stringify({ path, recursive }),
  });
  await asJsonOrThrow<unknown>(res, 'deleteWorkspaceObject');
}

export async function mkdirsWorkspace(path: string): Promise<void> {
  const res = await dbxFetch('/api/2.0/workspace/mkdirs', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
  // mkdirs is idempotent on the server; a 400 "already exists" is fine.
  if (!res.ok && res.status !== 400) {
    throw new Error(`mkdirsWorkspace failed ${res.status}: ${await res.text()}`);
  }
}

export interface SubmittedRun {
  run_id: number;
  number_in_job?: number;
}

export async function runNotebook(
  path: string,
  clusterId: string,
  baseParameters?: Record<string, string>,
  runName?: string,
): Promise<SubmittedRun> {
  const payload: Record<string, unknown> = {
    run_name: runName || `loom-notebook-${Date.now()}`,
    tasks: [
      {
        task_key: 'notebook',
        existing_cluster_id: clusterId,
        notebook_task: {
          notebook_path: path,
          base_parameters: baseParameters || {},
        },
      },
    ],
  };
  const res = await dbxFetch('/api/2.1/jobs/runs/submit', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return asJsonOrThrow<SubmittedRun>(res, 'runNotebook');
}

export interface JobRun {
  run_id: number;
  job_id?: number;
  run_name?: string;
  state?: {
    life_cycle_state?: string;
    result_state?: string;
    state_message?: string;
  };
  start_time?: number;
  end_time?: number;
  setup_duration?: number;
  execution_duration?: number;
  cleanup_duration?: number;
  trigger?: string;
  creator_user_name?: string;
}

export async function listJobRuns(jobId?: number, limit = 25): Promise<JobRun[]> {
  const params = new URLSearchParams();
  if (jobId) params.set('job_id', String(jobId));
  params.set('limit', String(limit));
  params.set('expand_tasks', 'false');
  const res = await dbxFetch(`/api/2.1/jobs/runs/list?${params.toString()}`);
  const body = await asJsonOrThrow<{ runs?: JobRun[] }>(res, 'listJobRuns');
  return body.runs || [];
}

export async function getJobRun(runId: number): Promise<JobRun> {
  const res = await dbxFetch(`/api/2.1/jobs/runs/get?run_id=${runId}`);
  return asJsonOrThrow<JobRun>(res, 'getJobRun');
}

export interface RunOutput {
  notebook_output?: { result?: string; truncated?: boolean };
  logs?: string;
  logs_truncated?: boolean;
  error?: string;
  error_trace?: string;
  metadata?: JobRun;
}

export async function getRunOutput(runId: number): Promise<RunOutput> {
  const res = await dbxFetch(`/api/2.1/jobs/runs/get-output?run_id=${runId}`);
  return asJsonOrThrow<RunOutput>(res, 'getRunOutput');
}

// ============================================================
// Jobs  (api/2.1/jobs)
// ============================================================
export interface JobSpec {
  name?: string;
  tasks?: unknown[];
  schedule?: { quartz_cron_expression?: string; timezone_id?: string; pause_status?: string };
  max_concurrent_runs?: number;
  email_notifications?: unknown;
  [k: string]: unknown;
}

export interface Job {
  job_id: number;
  creator_user_name?: string;
  created_time?: number;
  settings?: JobSpec;
}

export async function listJobs(limit = 50): Promise<Job[]> {
  const res = await dbxFetch(
    `/api/2.1/jobs/list?limit=${limit}&expand_tasks=false`,
  );
  const body = await asJsonOrThrow<{ jobs?: Job[] }>(res, 'listJobs');
  return body.jobs || [];
}

export async function getJob(jobId: number): Promise<Job> {
  const res = await dbxFetch(`/api/2.1/jobs/get?job_id=${jobId}`);
  return asJsonOrThrow<Job>(res, 'getJob');
}

export async function createJob(spec: JobSpec): Promise<{ job_id: number }> {
  const res = await dbxFetch('/api/2.1/jobs/create', {
    method: 'POST',
    body: JSON.stringify(spec),
  });
  return asJsonOrThrow<{ job_id: number }>(res, 'createJob');
}

export async function updateJob(jobId: number, newSettings: JobSpec): Promise<void> {
  const res = await dbxFetch('/api/2.1/jobs/reset', {
    method: 'POST',
    body: JSON.stringify({ job_id: jobId, new_settings: newSettings }),
  });
  await asJsonOrThrow<unknown>(res, 'updateJob');
}

export async function deleteJob(jobId: number): Promise<void> {
  const res = await dbxFetch('/api/2.1/jobs/delete', {
    method: 'POST',
    body: JSON.stringify({ job_id: jobId }),
  });
  await asJsonOrThrow<unknown>(res, 'deleteJob');
}

export async function runJob(
  jobId: number,
  notebookParams?: Record<string, string>,
): Promise<SubmittedRun> {
  const payload: Record<string, unknown> = { job_id: jobId };
  if (notebookParams) payload.notebook_params = notebookParams;
  const res = await dbxFetch('/api/2.1/jobs/run-now', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return asJsonOrThrow<SubmittedRun>(res, 'runJob');
}

// ============================================================
// Clusters  (api/2.0/clusters)
// ============================================================
export interface Cluster {
  cluster_id: string;
  cluster_name?: string;
  state?: string;
  state_message?: string;
  spark_version?: string;
  node_type_id?: string;
  driver_node_type_id?: string;
  num_workers?: number;
  autoscale?: { min_workers?: number; max_workers?: number };
  autotermination_minutes?: number;
  creator_user_name?: string;
  start_time?: number;
  terminated_time?: number;
  custom_tags?: Record<string, string>;
  spark_conf?: Record<string, string>;
  data_security_mode?: string;
}

export interface ClusterSpec {
  cluster_name: string;
  spark_version: string;
  node_type_id: string;
  num_workers?: number;
  autoscale?: { min_workers: number; max_workers: number };
  autotermination_minutes?: number;
  data_security_mode?: string;
  spark_conf?: Record<string, string>;
  custom_tags?: Record<string, string>;
  driver_node_type_id?: string;
}

export async function listClusters(): Promise<Cluster[]> {
  const res = await dbxFetch('/api/2.0/clusters/list');
  const body = await asJsonOrThrow<{ clusters?: Cluster[] }>(res, 'listClusters');
  return body.clusters || [];
}

export async function getCluster(clusterId: string): Promise<Cluster> {
  const res = await dbxFetch(
    `/api/2.0/clusters/get?cluster_id=${encodeURIComponent(clusterId)}`,
  );
  return asJsonOrThrow<Cluster>(res, 'getCluster');
}

export async function createCluster(spec: ClusterSpec): Promise<{ cluster_id: string }> {
  const res = await dbxFetch('/api/2.0/clusters/create', {
    method: 'POST',
    body: JSON.stringify(spec),
  });
  return asJsonOrThrow<{ cluster_id: string }>(res, 'createCluster');
}

export async function editCluster(clusterId: string, spec: ClusterSpec): Promise<void> {
  const res = await dbxFetch('/api/2.0/clusters/edit', {
    method: 'POST',
    body: JSON.stringify({ cluster_id: clusterId, ...spec }),
  });
  await asJsonOrThrow<unknown>(res, 'editCluster');
}

export async function startCluster(clusterId: string): Promise<void> {
  const res = await dbxFetch('/api/2.0/clusters/start', {
    method: 'POST',
    body: JSON.stringify({ cluster_id: clusterId }),
  });
  // Already-running returns 400 INVALID_STATE — ignore that case to make UI idempotent
  if (res.status === 400) {
    const text = await res.text();
    if (/already/i.test(text)) return;
    throw new Error(`startCluster failed 400: ${text}`);
  }
  await asJsonOrThrow<unknown>(res, 'startCluster');
}

export async function restartCluster(clusterId: string): Promise<void> {
  const res = await dbxFetch('/api/2.0/clusters/restart', {
    method: 'POST',
    body: JSON.stringify({ cluster_id: clusterId }),
  });
  await asJsonOrThrow<unknown>(res, 'restartCluster');
}

export async function terminateCluster(clusterId: string): Promise<void> {
  const res = await dbxFetch('/api/2.0/clusters/delete', {
    method: 'POST',
    body: JSON.stringify({ cluster_id: clusterId }),
  });
  await asJsonOrThrow<unknown>(res, 'terminateCluster');
}

export async function permanentDeleteCluster(clusterId: string): Promise<void> {
  const res = await dbxFetch('/api/2.0/clusters/permanent-delete', {
    method: 'POST',
    body: JSON.stringify({ cluster_id: clusterId }),
  });
  await asJsonOrThrow<unknown>(res, 'permanentDeleteCluster');
}

export interface NodeType {
  node_type_id: string;
  memory_mb?: number;
  num_cores?: number;
  description?: string;
  category?: string;
  instance_type_id?: string;
}

export async function listNodeTypes(): Promise<NodeType[]> {
  const res = await dbxFetch('/api/2.0/clusters/list-node-types');
  const body = await asJsonOrThrow<{ node_types?: NodeType[] }>(res, 'listNodeTypes');
  return body.node_types || [];
}

export interface SparkVersion {
  key: string;
  name: string;
}

export async function listSparkVersions(): Promise<SparkVersion[]> {
  const res = await dbxFetch('/api/2.0/clusters/spark-versions');
  const body = await asJsonOrThrow<{ versions?: SparkVersion[] }>(res, 'listSparkVersions');
  return body.versions || [];
}

export interface ClusterEvent {
  cluster_id: string;
  timestamp?: number;
  type?: string;
  details?: Record<string, unknown>;
}

export async function listClusterEvents(
  clusterId: string,
  limit = 50,
): Promise<ClusterEvent[]> {
  const res = await dbxFetch('/api/2.0/clusters/events', {
    method: 'POST',
    body: JSON.stringify({
      cluster_id: clusterId,
      limit,
      order: 'DESC',
    }),
  });
  const body = await asJsonOrThrow<{ events?: ClusterEvent[] }>(res, 'listClusterEvents');
  return body.events || [];
}

// v3.4 — Libraries tab. Databricks /api/2.0/libraries/cluster-status returns
// install state for every library attached to the cluster (pypi, maven, jar,
// whl, etc.) plus per-status messages. The editor renders this read-only;
// install/uninstall lives in the Databricks UI for now since it touches
// per-library credentials (Azure DevOps PATs, private PyPI tokens, etc.).
export interface LibraryStatus {
  status?: string;
  is_library_for_all_clusters?: boolean;
  messages?: string[];
  library?: {
    pypi?: { package?: string; repo?: string };
    maven?: { coordinates?: string; repo?: string };
    cran?: { package?: string };
    jar?: string;
    egg?: string;
    whl?: string;
    requirements?: string;
  };
}

export async function listClusterLibraries(clusterId: string): Promise<LibraryStatus[]> {
  const res = await dbxFetch(
    `/api/2.0/libraries/cluster-status?cluster_id=${encodeURIComponent(clusterId)}`,
  );
  const body = await asJsonOrThrow<{ library_statuses?: LibraryStatus[] }>(res, 'listClusterLibraries');
  return body.library_statuses || [];
}

// ============================================================
// One-time notebook run — imports inline code as a notebook in
// /Shared/loom-runs/<ts>, then submits as a one-time job. Used
// by /api/items/notebook/[id]/run when compute is databricks.
// ============================================================

export async function runOneTimeNotebook(args: {
  clusterId: string;
  code: string;
  lang?: 'PYTHON' | 'SQL' | 'SCALA' | 'R';
  jobName?: string;
}): Promise<{ run_id: number; run_page_url?: string }> {
  const { clusterId, code, lang = 'PYTHON', jobName } = args;
  const ts = Date.now();
  const nbPath = `/Shared/loom-runs/${ts}-${jobName || 'notebook'}`;

  // 1) Ensure parent dir
  await dbxFetch('/api/2.0/workspace/mkdirs', {
    method: 'POST',
    body: JSON.stringify({ path: '/Shared/loom-runs' }),
  }).catch(() => { /* dir may exist */ });

  // 2) Import the notebook source
  await importNotebook(nbPath, lang, code, true);

  // 3) Submit as one-time run
  const submitRes = await dbxFetch('/api/2.1/jobs/runs/submit', {
    method: 'POST',
    body: JSON.stringify({
      run_name: jobName || `loom-${ts}`,
      existing_cluster_id: clusterId,
      notebook_task: { notebook_path: nbPath },
    }),
  });
  return asJsonOrThrow<{ run_id: number; run_page_url?: string }>(submitRes, 'runOneTimeNotebook');
}

// ============================================================
// Command Execution API (api/1.2) — per-cell notebook execution
//
// This is the REST surface that backs an interactive Databricks notebook:
// the UI creates an execution context bound to a cluster + language REPL,
// then runs each cell's source as a command against that context and polls
// for the command's result. Variables persist across commands in the same
// context (same REPL), exactly like a real notebook attached to a cluster.
//
// Flow:
//   1. POST /api/1.2/contexts/create   { clusterId, language }      -> { id }
//   2. POST /api/1.2/commands/execute  { clusterId, contextId,
//                                        language, command }        -> { id }
//   3. GET  /api/1.2/commands/status?clusterId&contextId&commandId -> result
//   4. POST /api/1.2/contexts/destroy  { clusterId, contextId }    (cleanup)
//
// Languages: 'python' | 'sql' | 'scala' | 'r'. Markdown cells are rendered
// client-side and never sent here.
// ============================================================

export type CommandLanguage = 'python' | 'sql' | 'scala' | 'r';

export interface ExecutionContext {
  id: string;
}

/**
 * Create an execution context (a language REPL) bound to a cluster. The
 * returned context id is reused across cell executions so notebook state
 * (variables, imports, temp views) persists between cells.
 */
export async function createExecutionContext(
  clusterId: string,
  language: CommandLanguage,
): Promise<ExecutionContext> {
  const res = await dbxFetch('/api/1.2/contexts/create', {
    method: 'POST',
    body: JSON.stringify({ clusterId, language }),
  });
  return asJsonOrThrow<ExecutionContext>(res, 'createExecutionContext');
}

export interface ContextStatus {
  id: string;
  status?: 'Pending' | 'Running' | 'Error' | string;
}

export async function getExecutionContextStatus(
  clusterId: string,
  contextId: string,
): Promise<ContextStatus> {
  const params = new URLSearchParams({ clusterId, contextId });
  const res = await dbxFetch(`/api/1.2/contexts/status?${params.toString()}`);
  return asJsonOrThrow<ContextStatus>(res, 'getExecutionContextStatus');
}

export async function destroyExecutionContext(
  clusterId: string,
  contextId: string,
): Promise<void> {
  const res = await dbxFetch('/api/1.2/contexts/destroy', {
    method: 'POST',
    body: JSON.stringify({ clusterId, contextId }),
  });
  // destroy is best-effort — a stale context returns 404/400; don't throw.
  if (!res.ok && res.status !== 404 && res.status !== 400) {
    throw new Error(`destroyExecutionContext failed ${res.status}: ${await res.text()}`);
  }
}

export interface SubmittedCommand {
  id: string;
}

export async function runCommand(
  clusterId: string,
  contextId: string,
  language: CommandLanguage,
  command: string,
): Promise<SubmittedCommand> {
  const res = await dbxFetch('/api/1.2/commands/execute', {
    method: 'POST',
    body: JSON.stringify({ clusterId, contextId, language, command }),
  });
  return asJsonOrThrow<SubmittedCommand>(res, 'runCommand');
}

// Databricks command result shape (api/1.2). `resultType` is 'text' for
// stdout, 'table' for tabular results (with schema + data), 'image' for
// inline plots, and 'error' with summary/cause for failures.
export interface CommandResult {
  id: string;
  status?: 'Queued' | 'Running' | 'Cancelling' | 'Finished' | 'Cancelled' | 'Error' | string;
  results?: {
    resultType?: 'text' | 'table' | 'image' | 'error' | string;
    data?: unknown;
    schema?: Array<{ name?: string; type?: string }>;
    cause?: string;
    summary?: string;
    fileName?: string;
    truncated?: boolean;
  };
}

export async function getCommandStatus(
  clusterId: string,
  contextId: string,
  commandId: string,
): Promise<CommandResult> {
  const params = new URLSearchParams({ clusterId, contextId, commandId });
  const res = await dbxFetch(`/api/1.2/commands/status?${params.toString()}`);
  return asJsonOrThrow<CommandResult>(res, 'getCommandStatus');
}

export async function cancelCommand(
  clusterId: string,
  contextId: string,
  commandId: string,
): Promise<void> {
  const res = await dbxFetch('/api/1.2/commands/cancel', {
    method: 'POST',
    body: JSON.stringify({ clusterId, contextId, commandId }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`cancelCommand failed ${res.status}: ${await res.text()}`);
  }
}

const CMD_POLL_INTERVAL_MS = 1_000;
const CMD_POLL_TIMEOUT_MS = 600_000; // 10 min — long enough for Spark jobs.

/**
 * Execute a single cell end-to-end against an existing context and poll to
 * completion. Returns the terminal CommandResult. The caller owns the
 * context lifecycle (create once, reuse across cells, destroy on close).
 */
export async function executeCommand(
  clusterId: string,
  contextId: string,
  language: CommandLanguage,
  command: string,
): Promise<CommandResult> {
  const submitted = await runCommand(clusterId, contextId, language, command);
  const deadline = Date.now() + CMD_POLL_TIMEOUT_MS;
  let body = await getCommandStatus(clusterId, contextId, submitted.id);
  while (
    (body.status === 'Queued' || body.status === 'Running' || body.status === 'Cancelling') &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, CMD_POLL_INTERVAL_MS));
    body = await getCommandStatus(clusterId, contextId, submitted.id);
  }
  return body;
}

// ============================================================
// Unity Catalog — catalogs, schemas, tables
// Backs the MirroredDatabricksEditor (Fabric MirroredAzureDatabricksCatalog).
// Auth path is the same Bearer flow; UC API lives under /api/2.1/unity-catalog.
// ============================================================

export interface UcCatalog {
  name: string;
  comment?: string;
  owner?: string;
  metastore_id?: string;
  catalog_type?: string;
  created_at?: number;
  updated_at?: number;
}

export interface UcSchema {
  name: string;
  catalog_name: string;
  full_name?: string;
  comment?: string;
  owner?: string;
  created_at?: number;
  updated_at?: number;
}

export interface UcTable {
  name: string;
  catalog_name: string;
  schema_name: string;
  full_name?: string;
  table_type?: 'MANAGED' | 'EXTERNAL' | 'VIEW' | 'MATERIALIZED_VIEW' | string;
  data_source_format?: string;
  comment?: string;
  owner?: string;
  storage_location?: string;
  columns?: Array<{ name: string; type_name?: string; type_text?: string; nullable?: boolean; comment?: string }>;
  created_at?: number;
  updated_at?: number;
}

export async function listUcCatalogs(): Promise<UcCatalog[]> {
  const res = await dbxFetch('/api/2.1/unity-catalog/catalogs');
  const body = await asJsonOrThrow<{ catalogs?: UcCatalog[] }>(res, 'listUcCatalogs');
  return body.catalogs || [];
}

export async function listUcSchemas(catalogName: string): Promise<UcSchema[]> {
  const params = new URLSearchParams({ catalog_name: catalogName });
  const res = await dbxFetch(`/api/2.1/unity-catalog/schemas?${params.toString()}`);
  const body = await asJsonOrThrow<{ schemas?: UcSchema[] }>(res, `listUcSchemas(${catalogName})`);
  return body.schemas || [];
}

export async function listUcTables(catalogName: string, schemaName: string): Promise<UcTable[]> {
  const params = new URLSearchParams({ catalog_name: catalogName, schema_name: schemaName });
  const res = await dbxFetch(`/api/2.1/unity-catalog/tables?${params.toString()}`);
  const body = await asJsonOrThrow<{ tables?: UcTable[] }>(res, `listUcTables(${catalogName}.${schemaName})`);
  return body.tables || [];
}

