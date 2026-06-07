/**
 * Azure Data Factory ARM REST client.
 *
 * Talks to the ADF management plane (everything is ARM — pipelines,
 * datasets, triggers, linked services, pipeline runs are all child
 * resources of Microsoft.DataFactory/factories).
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential). The UAMI
 * `uami-loom-console-eastus2` (principalId e61f3eb3-...) has the
 * "Data Factory Contributor" role on adf-loom-default-eastus2 so every
 * call below succeeds.
 *
 * No mocks. Real ARM REST only (sovereign-cloud aware via cloud-endpoints).
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { armBase, armScope, armHost } from './cloud-endpoints';

const API = '2018-06-01';

// ARM endpoint + scope + bare host come from cloud-endpoints (the single
// sovereign-cloud source of truth — Commercial / GCC-High / IL5, honoring
// LOOM_ARM_ENDPOINT and AZURE_CLOUD).
const ARM_BASE = armBase();
const ARM_SCOPE = armScope();
// Bare ARM host (no scheme) for the few call sites that build their own URL.
const ARM_HOST = armHost();

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

function sub(): string { return required('LOOM_SUBSCRIPTION_ID'); }
function rg():  string { return required('LOOM_DLZ_RG'); }
function adfName(): string { return required('LOOM_ADF_NAME'); }

function base(): string {
  return `${ARM_BASE}/subscriptions/${sub()}/resourceGroups/${rg()}/providers/Microsoft.DataFactory/factories/${adfName()}`;
}

/**
 * Honest config gate for the factory-level Manage routes (linked services,
 * datasets, integration runtimes). Returns the exact missing env var so the
 * BFF can 503 with a precise MessageBar instead of a generic 500. Returns null
 * when fully configured.
 */
export function adfConfigGate(): { missing: string } | null {
  for (const k of ['LOOM_SUBSCRIPTION_ID', 'LOOM_DLZ_RG', 'LOOM_ADF_NAME']) {
    if (!process.env[k]) return { missing: k };
  }
  return null;
}

async function call(url: string, init?: RequestInit): Promise<Response> {
  const tok = await credential.getToken(ARM_SCOPE);
  if (!tok?.token) throw new Error('Failed to acquire ARM token');
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${tok.token}`,
      'content-type': 'application/json',
    },
  });
}

async function jsonOrThrow<T>(r: Response, label: string): Promise<T> {
  if (!r.ok && r.status !== 202) {
    throw new Error(`${label} failed ${r.status}: ${await r.text()}`);
  }
  const text = await r.text();
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { return {} as T; }
}

// ============================================================
// Pipelines
// ============================================================

export interface AdfPipeline {
  id?: string;
  name: string;
  type?: string;
  etag?: string;
  properties: {
    description?: string;
    activities?: unknown[];
    parameters?: Record<string, { type: string; defaultValue?: unknown }>;
    variables?: Record<string, { type: string; defaultValue?: unknown }>;
    annotations?: unknown[];
    folder?: { name: string };
    concurrency?: number;
    policy?: unknown;
  };
}

export async function listPipelines(): Promise<AdfPipeline[]> {
  const r = await call(`${base()}/pipelines?api-version=${API}`);
  const body = await jsonOrThrow<{ value: AdfPipeline[] }>(r, 'listPipelines');
  return body.value || [];
}

export async function getPipeline(name: string): Promise<AdfPipeline> {
  const r = await call(`${base()}/pipelines/${encodeURIComponent(name)}?api-version=${API}`);
  return jsonOrThrow<AdfPipeline>(r, `getPipeline(${name})`);
}

export async function upsertPipeline(name: string, spec: AdfPipeline): Promise<AdfPipeline> {
  const body = { name: spec.name || name, properties: spec.properties || { activities: [] } };
  const r = await call(`${base()}/pipelines/${encodeURIComponent(name)}?api-version=${API}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return jsonOrThrow<AdfPipeline>(r, `upsertPipeline(${name})`);
}

export async function deletePipeline(name: string): Promise<void> {
  const r = await call(`${base()}/pipelines/${encodeURIComponent(name)}?api-version=${API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 204) {
    throw new Error(`deletePipeline failed ${r.status}: ${await r.text()}`);
  }
}

export interface PipelineRunResponse { runId: string; }

export async function runPipeline(
  name: string,
  params?: Record<string, unknown>,
): Promise<PipelineRunResponse> {
  const r = await call(
    `${base()}/pipelines/${encodeURIComponent(name)}/createRun?api-version=${API}`,
    { method: 'POST', body: JSON.stringify(params || {}) },
  );
  return jsonOrThrow<PipelineRunResponse>(r, `runPipeline(${name})`);
}

/**
 * Debug a pipeline run — ADF supports `isRecovery=true&referencePipelineRunId=`
 * for re-runs from a known runId. When `referencePipelineRunId` is omitted,
 * `isRecovery` is forced false so ADF treats it as a normal createRun.
 *
 * The Fabric Debug button in the editor maps to this — same wire format as
 * Run but with a distinct invokedByType so the run shows up in the Output
 * pane under "Debug" instead of "Manual".
 */
export async function debugPipeline(
  name: string,
  params?: Record<string, unknown>,
  opts?: { referencePipelineRunId?: string; startActivityName?: string },
): Promise<PipelineRunResponse> {
  const qs = new URLSearchParams({ 'api-version': API });
  if (opts?.referencePipelineRunId) {
    qs.set('isRecovery', 'true');
    qs.set('referencePipelineRunId', opts.referencePipelineRunId);
  } else {
    qs.set('isRecovery', 'false');
  }
  if (opts?.startActivityName) qs.set('startActivityName', opts.startActivityName);
  const r = await call(
    `${base()}/pipelines/${encodeURIComponent(name)}/createRun?${qs.toString()}`,
    { method: 'POST', body: JSON.stringify(params || {}) },
  );
  return jsonOrThrow<PipelineRunResponse>(r, `debugPipeline(${name})`);
}

/**
 * Validate a pipeline JSON against ADF's syntactic + reference checker.
 *
 * ADF exposes two flavours of validation:
 *   1. POST factories/{f}/pipelines/{name}/validate — validate persisted pipeline
 *   2. POST factories/{f}/validatePipeline?api-version=... — validate by value
 *
 * Pass `spec` to validate an in-memory payload; pass nothing to validate the
 * persisted version. Returns the raw ADF response inside `body` plus status
 * so callers can surface ADF's structured error message verbatim.
 */
export interface AdfValidateResponse {
  activities?: Array<{ name?: string; type?: string }>;
  parameters?: unknown;
  variables?: unknown;
  error?: { code?: string; message?: string };
}

export async function validatePipeline(
  name: string,
  spec?: AdfPipeline,
): Promise<{ ok: boolean; status: number; body: AdfValidateResponse; errorText?: string }> {
  if (!spec) {
    const r = await call(
      `${base()}/pipelines/${encodeURIComponent(name)}/validate?api-version=${API}`,
      { method: 'POST' },
    );
    const text = await r.text();
    let body: AdfValidateResponse = {};
    try { body = text ? (JSON.parse(text) as AdfValidateResponse) : {}; } catch { /* empty */ }
    return { ok: r.ok, status: r.status, body, errorText: r.ok ? undefined : text };
  }
  const r = await call(
    `${base()}/validatePipeline?api-version=${API}`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: spec.name || name,
        properties: spec.properties || { activities: [] },
      }),
    },
  );
  const text = await r.text();
  let body: AdfValidateResponse = {};
  try { body = text ? (JSON.parse(text) as AdfValidateResponse) : {}; } catch { /* empty */ }
  return { ok: r.ok, status: r.status, body, errorText: r.ok ? undefined : text };
}

export interface AdfActivityRun {
  activityRunId: string;
  activityName: string;
  activityType: string;
  pipelineName?: string;
  pipelineRunId?: string;
  status?: 'Queued' | 'InProgress' | 'Succeeded' | 'Failed' | 'Cancelled' | 'Skipped';
  activityRunStart?: string;
  activityRunEnd?: string;
  durationInMs?: number;
  input?: unknown;
  output?: unknown;
  error?: { errorCode?: string; message?: string; failureType?: string };
}

/**
 * List per-activity output for a single pipeline run. Backs the Output
 * pane in the data pipeline editor.
 */
export async function listActivityRuns(
  runId: string,
  windowDays = 1,
): Promise<AdfActivityRun[]> {
  const now = new Date();
  const start = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const r = await call(
    `${base()}/pipelineruns/${encodeURIComponent(runId)}/queryActivityruns?api-version=${API}`,
    {
      method: 'POST',
      body: JSON.stringify({
        lastUpdatedAfter: start.toISOString(),
        lastUpdatedBefore: now.toISOString(),
      }),
    },
  );
  const body = await jsonOrThrow<{ value: AdfActivityRun[] }>(r, `listActivityRuns(${runId})`);
  return body.value || [];
}

export interface AdfPipelineRun {
  runId: string;
  pipelineName: string;
  parameters?: Record<string, unknown>;
  invokedBy?: { id?: string; name?: string; invokedByType?: string };
  runStart?: string;
  runEnd?: string;
  durationInMs?: number;
  status?: 'Queued' | 'InProgress' | 'Succeeded' | 'Failed' | 'Cancelling' | 'Cancelled';
  message?: string;
  lastUpdated?: string;
  annotations?: string[];
  runGroupId?: string;
  isLatest?: boolean;
}

export async function listPipelineRuns(
  pipelineName?: string,
  windowDays = 7,
): Promise<AdfPipelineRun[]> {
  const now = new Date();
  const start = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const body: any = {
    lastUpdatedAfter: start.toISOString(),
    lastUpdatedBefore: now.toISOString(),
    orderBy: [{ orderBy: 'RunStart', order: 'DESC' }],
  };
  if (pipelineName) {
    body.filters = [{ operand: 'PipelineName', operator: 'Equals', values: [pipelineName] }];
  }
  const r = await call(`${base()}/queryPipelineRuns?api-version=${API}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const j = await jsonOrThrow<{ value: AdfPipelineRun[] }>(r, 'listPipelineRuns');
  return (j.value || []).slice(0, 50);
}

// ============================================================
// Log Analytics fallback — queries the typed ADFPipelineRun /
// ADFActivityRun tables when LOOM_ADF_LOG_ANALYTICS_WORKSPACE is set.
//
// ADF's native monitoring API (queryPipelineRuns / queryActivityruns,
// used above) enforces a 45-day maximum retention window — a run older
// than that returns ZERO rows even though it happened. Log Analytics keeps
// the diagnostic logs for the full workspace retention (90 days default,
// up to 730), so this is the Output-pane fallback for "where did my older
// runs go?".
//
// The query endpoint is cloud-aware via LOOM_LOG_ANALYTICS_ENDPOINT:
//   Commercial / GCC: https://api.loganalytics.azure.com  (default)
//   GCC-High / IL5  : https://api.loganalytics.us         (Azure Government)
// (Note: ods.opinsights.azure.us is the *ingestion* host — the query API
//  is api.loganalytics.us.) Same credential chain as the ARM calls above.
//
// Requires adf.bicep's diagnosticSettings to run in Dedicated
// (logAnalyticsDestinationType: 'Dedicated') mode so logs land in the typed
// tables rather than the legacy AzureDiagnostics catch-all.
// ============================================================

const LA_ENDPOINT_ADF =
  process.env.LOOM_LOG_ANALYTICS_ENDPOINT || 'https://api.loganalytics.azure.com';
const LA_SCOPE_ADF = `${LA_ENDPOINT_ADF}/.default`;

/**
 * Honest config gate for the LA fallback. Returns the workspace GUID when
 * LOOM_ADF_LOG_ANALYTICS_WORKSPACE is set, or null so the route can skip the
 * fallback (and the native ADF result — possibly empty — stands) instead of
 * erroring.
 */
export function adfLogAnalyticsWorkspace(): string | null {
  const v = process.env.LOOM_ADF_LOG_ANALYTICS_WORKSPACE;
  return v && v.trim() ? v.trim() : null;
}

interface LaTable {
  name?: string;
  columns?: Array<{ name: string; type?: string }>;
  rows?: unknown[][];
}
interface LaQueryResponse { tables?: LaTable[]; error?: { message?: string } }

/** Escape a single-quoted KQL string literal (double the quote). */
function kqlStr(v: string): string {
  return v.replace(/'/g, "''");
}

async function laQuery(workspaceGuid: string, kql: string): Promise<LaQueryResponse> {
  const tok = await credential.getToken(LA_SCOPE_ADF);
  if (!tok?.token) throw new Error('Failed to acquire Log Analytics token');
  const url = `${LA_ENDPOINT_ADF}/v1/workspaces/${encodeURIComponent(workspaceGuid)}/query`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tok.token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      prefer: 'wait=60',
    },
    body: JSON.stringify({ query: kql }),
  });
  const text = await r.text();
  let json: LaQueryResponse | null = null;
  try { json = text ? (JSON.parse(text) as LaQueryResponse) : null; } catch { /* non-JSON */ }
  if (!r.ok) {
    throw new Error(`Log Analytics query failed ${r.status}: ${json?.error?.message || text}`);
  }
  return json || {};
}

/** Build a {columnName -> rowIndex} accessor from the first table. */
function laAccessor(json: LaQueryResponse): { rows: unknown[][]; idx: (name: string) => number } {
  const table = (json.tables || [])[0];
  const cols = (table?.columns || []).map((c) => c.name);
  return {
    rows: table?.rows || [],
    idx: (name: string) => cols.indexOf(name),
  };
}

/**
 * List recent pipeline runs from Log Analytics (ADFPipelineRun table).
 * Backs the Output-pane fallback when ADF's native 45-day window is empty.
 */
export async function listPipelineRunsFromLA(
  workspaceGuid: string,
  pipelineName: string,
): Promise<AdfPipelineRun[]> {
  const kql = `
ADFPipelineRun
| where PipelineName == '${kqlStr(pipelineName)}'
| summarize arg_max(TimeGenerated, *) by RunId
| order by Start desc
| take 50
| project RunId, PipelineName, Status, Start, End, ErrorCode, ErrorMessage, Parameters
`.trim();
  const json = await laQuery(workspaceGuid, kql);
  const { rows, idx } = laAccessor(json);
  return rows.map((row) => {
    const startStr = (row[idx('Start')] as string | null) || undefined;
    const endStr = (row[idx('End')] as string | null) || undefined;
    const startMs = startStr ? new Date(startStr).getTime() : 0;
    const endMs = endStr ? new Date(endStr).getTime() : 0;
    const errMsg = (row[idx('ErrorMessage')] as string | null) || undefined;
    return {
      runId: row[idx('RunId')] as string,
      pipelineName: row[idx('PipelineName')] as string,
      status: (row[idx('Status')] || undefined) as AdfPipelineRun['status'],
      runStart: startStr,
      runEnd: endStr,
      durationInMs: startMs && endMs ? endMs - startMs : undefined,
      message: errMsg,
      // invokedBy is not exposed in the resource-specific ADFPipelineRun table.
      invokedBy: undefined,
    } as AdfPipelineRun;
  });
}

/**
 * List per-activity output for a single run from Log Analytics
 * (ADFActivityRun table). Backs the Output-pane drill-down fallback for
 * runs older than ADF's 45-day native window.
 */
export async function listActivityRunsFromLA(
  workspaceGuid: string,
  runId: string,
): Promise<AdfActivityRun[]> {
  const kql = `
ADFActivityRun
| where PipelineRunId == '${kqlStr(runId)}'
| summarize arg_max(TimeGenerated, *) by ActivityRunId
| order by Start desc
| project ActivityRunId, ActivityName, ActivityType, Status, Start, End, ErrorCode, ErrorMessage, Input, Output
`.trim();
  const json = await laQuery(workspaceGuid, kql);
  const { rows, idx } = laAccessor(json);
  const parseJson = (v: unknown): unknown => {
    if (!v || typeof v !== 'string') return undefined;
    try { return JSON.parse(v); } catch { return v; }
  };
  return rows.map((row) => {
    const startStr = (row[idx('Start')] as string | null) || undefined;
    const endStr = (row[idx('End')] as string | null) || undefined;
    const startMs = startStr ? new Date(startStr).getTime() : 0;
    const endMs = endStr ? new Date(endStr).getTime() : 0;
    const errCode = (row[idx('ErrorCode')] as string | null) || undefined;
    const errMsg = (row[idx('ErrorMessage')] as string | null) || undefined;
    return {
      activityRunId: row[idx('ActivityRunId')] as string,
      activityName: row[idx('ActivityName')] as string,
      activityType: row[idx('ActivityType')] as string,
      pipelineRunId: runId,
      status: (row[idx('Status')] || undefined) as AdfActivityRun['status'],
      activityRunStart: startStr,
      activityRunEnd: endStr,
      durationInMs: startMs && endMs ? endMs - startMs : undefined,
      input: parseJson(row[idx('Input')]),
      output: parseJson(row[idx('Output')]),
      error: errCode || errMsg ? { errorCode: errCode, message: errMsg } : undefined,
    } as AdfActivityRun;
  });
}

// ============================================================
// Datasets
// ============================================================

export interface AdfDataset {
  id?: string;
  name: string;
  type?: string;
  etag?: string;
  properties: {
    type: string;
    description?: string;
    linkedServiceName?: { referenceName: string; type: 'LinkedServiceReference'; parameters?: Record<string, unknown> };
    schema?: unknown[];
    structure?: unknown[];
    parameters?: Record<string, { type: string; defaultValue?: unknown }>;
    annotations?: unknown[];
    folder?: { name: string };
    typeProperties?: Record<string, unknown>;
  };
}

export async function listDatasets(): Promise<AdfDataset[]> {
  const r = await call(`${base()}/datasets?api-version=${API}`);
  const body = await jsonOrThrow<{ value: AdfDataset[] }>(r, 'listDatasets');
  return body.value || [];
}

export async function getDataset(name: string): Promise<AdfDataset> {
  const r = await call(`${base()}/datasets/${encodeURIComponent(name)}?api-version=${API}`);
  return jsonOrThrow<AdfDataset>(r, `getDataset(${name})`);
}

export async function upsertDataset(name: string, spec: AdfDataset): Promise<AdfDataset> {
  const body = { name: spec.name || name, properties: spec.properties };
  const r = await call(`${base()}/datasets/${encodeURIComponent(name)}?api-version=${API}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return jsonOrThrow<AdfDataset>(r, `upsertDataset(${name})`);
}

export async function deleteDataset(name: string): Promise<void> {
  const r = await call(`${base()}/datasets/${encodeURIComponent(name)}?api-version=${API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 204) {
    throw new Error(`deleteDataset failed ${r.status}: ${await r.text()}`);
  }
}

// ============================================================
// Data flows (ADF Mapping Data Flows)
//
// A data flow is a visually-designed, Spark-executed transformation that a
// pipeline invokes via an ExecuteDataFlow activity. It is a child resource of
// the factory (Microsoft.DataFactory/factories/dataflows). Its `properties`
// carries a `type` ("MappingDataFlow" | "Flowlet" | "WranglingDataFlow") and a
// `typeProperties` with sources/sinks/transformations/script. We list/create/
// delete via real ARM REST; the create payload is the structured data-flow
// definition the caller supplies (or a minimal empty MappingDataFlow).
// ============================================================

export interface AdfDataFlow {
  id?: string;
  name: string;
  type?: string;
  etag?: string;
  properties: {
    type: 'MappingDataFlow' | 'Flowlet' | 'WranglingDataFlow' | string;
    description?: string;
    annotations?: unknown[];
    folder?: { name: string };
    typeProperties?: Record<string, unknown>;
  };
}

export async function listDataFlows(): Promise<AdfDataFlow[]> {
  const r = await call(`${base()}/dataflows?api-version=${API}`);
  const body = await jsonOrThrow<{ value: AdfDataFlow[] }>(r, 'listDataFlows');
  return body.value || [];
}

export async function getDataFlow(name: string): Promise<AdfDataFlow> {
  const r = await call(`${base()}/dataflows/${encodeURIComponent(name)}?api-version=${API}`);
  return jsonOrThrow<AdfDataFlow>(r, `getDataFlow(${name})`);
}

export async function upsertDataFlow(name: string, spec: AdfDataFlow): Promise<AdfDataFlow> {
  const body = { name: spec.name || name, properties: spec.properties };
  const r = await call(`${base()}/dataflows/${encodeURIComponent(name)}?api-version=${API}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return jsonOrThrow<AdfDataFlow>(r, `upsertDataFlow(${name})`);
}

export async function deleteDataFlow(name: string): Promise<void> {
  const r = await call(`${base()}/dataflows/${encodeURIComponent(name)}?api-version=${API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 204) {
    throw new Error(`deleteDataFlow failed ${r.status}: ${await r.text()}`);
  }
}

// ============================================================
// Power Query (Wrangling) Data Flows — the Azure-native backend for
// Dataflow Gen2 (Power Query Online). The Fabric "RefreshDataflow"
// activity does not exist in ADF's ARM schema; ADF instead models a
// Power Query mashup as a `WranglingDataFlow` resource that a pipeline
// invokes via an `ExecuteWranglingDataflow` activity. ADF compiles the
// M script to a Data Flow script and runs it on the Spark IR. This is
// what backs the no-Fabric Dataflow Gen2 editor.
//
// Refs (grounded in @azure/arm-datafactory + Microsoft Learn):
//   - WranglingDataFlow.typeProperties = { sources[], script, documentLocale }
//   - ExecuteWranglingDataflowActivity.typeProperties = {
//       dataFlow, integrationRuntime, compute, sinks{}, queries[] }
//   - PowerQuerySinkMapping = { queryName, dataflowSinks[] }
// ============================================================

/** A Power Query source binding (maps a query name to a dataset). */
export interface WranglingSource {
  /** Query name in the M script that reads from this source. */
  name: string;
  /** ADF dataset the query reads from (omit for inline/literal sources). */
  datasetName?: string;
}

/** A Power Query sink binding (maps an output query name to a dataset). */
export interface WranglingSink {
  /** The output query whose result is written. */
  queryName: string;
  /** Unique sink name within the activity. */
  sinkName: string;
  /** ADF dataset the result is written to (ADLS Parquet/CSV or Azure SQL). */
  datasetName: string;
}

/**
 * Idempotently publish a `WranglingDataFlow` resource carrying the authored
 * Power Query (M) mashup. `sources` binds query names to datasets when the M
 * reads from a connector; an inline `#table(...)` query needs no source.
 */
export async function upsertWranglingDataFlow(
  name: string,
  mScript: string,
  sources: WranglingSource[] = [],
): Promise<AdfDataFlow> {
  return upsertDataFlow(name, {
    name,
    properties: {
      type: 'WranglingDataFlow',
      typeProperties: {
        sources: sources.map((s) => ({
          name: s.name,
          ...(s.datasetName
            ? { dataset: { referenceName: s.datasetName, type: 'DatasetReference' } }
            : {}),
        })),
        script: mScript,
        documentLocale: 'en-US',
      },
    },
  });
}

/**
 * Run a published `WranglingDataFlow` by materialising a single-activity
 * wrapper pipeline (`loom-pq-run-<df>`) with one `ExecuteWranglingDataflow`
 * activity, then triggering it. The output query → sink dataset mapping is
 * carried on the activity's `queries[]`/`sinks{}` so the same pipeline can be
 * reused on every run. Returns the runId + the wrapper pipeline name.
 */
export async function runWranglingDataFlow(
  dataFlowName: string,
  sinks: WranglingSink[] = [],
  opts?: { computeType?: string; coreCount?: number },
): Promise<{ runId: string; pipelineName: string }> {
  const pipelineName = `loom-pq-run-${dataFlowName}`;
  const sinkRef = (s: WranglingSink) => ({
    name: s.sinkName,
    dataset: { referenceName: s.datasetName, type: 'DatasetReference' },
  });
  const activity = {
    name: 'RunDataflow',
    type: 'ExecuteWranglingDataflow',
    dependsOn: [],
    typeProperties: {
      dataFlow: { referenceName: dataFlowName, type: 'DataFlowReference' },
      integrationRuntime: {
        referenceName: 'AutoResolveIntegrationRuntime',
        type: 'IntegrationRuntimeReference',
      },
      compute: { computeType: opts?.computeType || 'General', coreCount: opts?.coreCount ?? 8 },
      ...(sinks.length
        ? {
            sinks: Object.fromEntries(sinks.map((s) => [s.sinkName, sinkRef(s)])),
            queries: sinks.map((s) => ({
              queryName: s.queryName,
              dataflowSinks: [sinkRef(s)],
            })),
          }
        : {}),
    },
  };
  await upsertPipeline(pipelineName, {
    name: pipelineName,
    properties: {
      description: `Loom Power Query (Dataflow Gen2) run for ${dataFlowName}`,
      activities: [activity],
      annotations: ['loom', 'dataflow-gen2'],
    },
  });
  const run = await runPipeline(pipelineName);
  return { runId: run.runId, pipelineName };
}

// ============================================================
// Triggers
// ============================================================

export interface AdfTrigger {
  id?: string;
  name: string;
  type?: string;
  etag?: string;
  properties: {
    type: 'ScheduleTrigger' | 'TumblingWindowTrigger' | 'BlobEventsTrigger' | 'CustomEventsTrigger' | string;
    description?: string;
    runtimeState?: 'Started' | 'Stopped' | 'Disabled';
    pipelines?: Array<{
      pipelineReference: { referenceName: string; type: 'PipelineReference' };
      parameters?: Record<string, unknown>;
    }>;
    // Tumbling-window triggers reference a SINGLE pipeline (singular `pipeline`)
    // rather than the `pipelines[]` array used by schedule/event triggers.
    pipeline?: {
      pipelineReference: { referenceName: string; type: 'PipelineReference' };
      parameters?: Record<string, unknown>;
    };
    annotations?: unknown[];
    typeProperties?: Record<string, unknown>;
  };
}

export async function listTriggers(): Promise<AdfTrigger[]> {
  const r = await call(`${base()}/triggers?api-version=${API}`);
  const body = await jsonOrThrow<{ value: AdfTrigger[] }>(r, 'listTriggers');
  return body.value || [];
}

export async function getTrigger(name: string): Promise<AdfTrigger> {
  const r = await call(`${base()}/triggers/${encodeURIComponent(name)}?api-version=${API}`);
  return jsonOrThrow<AdfTrigger>(r, `getTrigger(${name})`);
}

export async function upsertTrigger(name: string, spec: AdfTrigger): Promise<AdfTrigger> {
  const body = { name: spec.name || name, properties: spec.properties };
  const r = await call(`${base()}/triggers/${encodeURIComponent(name)}?api-version=${API}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return jsonOrThrow<AdfTrigger>(r, `upsertTrigger(${name})`);
}

export async function deleteTrigger(name: string): Promise<void> {
  const r = await call(`${base()}/triggers/${encodeURIComponent(name)}?api-version=${API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 204) {
    throw new Error(`deleteTrigger failed ${r.status}: ${await r.text()}`);
  }
}

export async function startTrigger(name: string): Promise<void> {
  const r = await call(`${base()}/triggers/${encodeURIComponent(name)}/start?api-version=${API}`, { method: 'POST' });
  if (!r.ok && r.status !== 200 && r.status !== 202) {
    throw new Error(`startTrigger failed ${r.status}: ${await r.text()}`);
  }
}

export async function stopTrigger(name: string): Promise<void> {
  const r = await call(`${base()}/triggers/${encodeURIComponent(name)}/stop?api-version=${API}`, { method: 'POST' });
  if (!r.ok && r.status !== 200 && r.status !== 202) {
    throw new Error(`stopTrigger failed ${r.status}: ${await r.text()}`);
  }
}

// ============================================================
// Linked services (for editor dropdowns)
// ============================================================

export interface AdfLinkedService {
  id?: string;
  name: string;
  type?: string;
  properties: {
    type: string;
    description?: string;
    annotations?: unknown[];
    parameters?: Record<string, { type: string; defaultValue?: unknown }>;
    typeProperties?: Record<string, unknown>;
  };
}

export async function listLinkedServices(): Promise<AdfLinkedService[]> {
  const r = await call(`${base()}/linkedservices?api-version=${API}`);
  const body = await jsonOrThrow<{ value: AdfLinkedService[] }>(r, 'listLinkedServices');
  return body.value || [];
}

export async function getLinkedService(name: string): Promise<AdfLinkedService> {
  const r = await call(`${base()}/linkedservices/${encodeURIComponent(name)}?api-version=${API}`);
  return jsonOrThrow<AdfLinkedService>(r, `getLinkedService(${name})`);
}

export async function upsertLinkedService(name: string, spec: AdfLinkedService): Promise<AdfLinkedService> {
  const body = { name: spec.name || name, properties: spec.properties };
  const r = await call(`${base()}/linkedservices/${encodeURIComponent(name)}?api-version=${API}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return jsonOrThrow<AdfLinkedService>(r, `upsertLinkedService(${name})`);
}

export async function deleteLinkedService(name: string): Promise<void> {
  const r = await call(`${base()}/linkedservices/${encodeURIComponent(name)}?api-version=${API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 204) {
    throw new Error(`deleteLinkedService failed ${r.status}: ${await r.text()}`);
  }
}

// ============================================================
// Integration runtimes
//
// IRs are the compute that backs activities (Managed = Azure-hosted, the
// AutoResolveIntegrationRuntime is one; SelfHosted = an on-prem/VM gateway).
// The Manage hub lists them, shows status, can create Managed/SelfHosted, and
// start/stop a SelfHosted node set. All real ARM REST.
// ============================================================

export interface AdfIntegrationRuntime {
  id?: string;
  name: string;
  type?: string;
  etag?: string;
  properties: {
    type: 'Managed' | 'SelfHosted' | string;
    description?: string;
    typeProperties?: Record<string, unknown>;
  };
}

export interface AdfIntegrationRuntimeStatus {
  name?: string;
  properties?: {
    type?: string;
    state?: 'Initial' | 'Stopped' | 'Started' | 'Starting' | 'Stopping' | 'NeedRegistration' | 'Online' | 'Limited' | 'Offline' | 'AccessDenied' | string;
    dataFactoryName?: string;
    typeProperties?: Record<string, unknown>;
  };
}

export async function listIntegrationRuntimes(): Promise<AdfIntegrationRuntime[]> {
  const r = await call(`${base()}/integrationruntimes?api-version=${API}`);
  const body = await jsonOrThrow<{ value: AdfIntegrationRuntime[] }>(r, 'listIntegrationRuntimes');
  return body.value || [];
}

export async function getIntegrationRuntime(name: string): Promise<AdfIntegrationRuntime> {
  const r = await call(`${base()}/integrationruntimes/${encodeURIComponent(name)}?api-version=${API}`);
  return jsonOrThrow<AdfIntegrationRuntime>(r, `getIntegrationRuntime(${name})`);
}

export async function getIntegrationRuntimeStatus(name: string): Promise<AdfIntegrationRuntimeStatus> {
  const r = await call(`${base()}/integrationruntimes/${encodeURIComponent(name)}/getStatus?api-version=${API}`, { method: 'POST' });
  return jsonOrThrow<AdfIntegrationRuntimeStatus>(r, `getIntegrationRuntimeStatus(${name})`);
}

export async function upsertIntegrationRuntime(name: string, spec: AdfIntegrationRuntime): Promise<AdfIntegrationRuntime> {
  const body = { name: spec.name || name, properties: spec.properties };
  const r = await call(`${base()}/integrationruntimes/${encodeURIComponent(name)}?api-version=${API}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return jsonOrThrow<AdfIntegrationRuntime>(r, `upsertIntegrationRuntime(${name})`);
}

export async function startIntegrationRuntime(name: string): Promise<void> {
  const r = await call(`${base()}/integrationruntimes/${encodeURIComponent(name)}/start?api-version=${API}`, { method: 'POST' });
  if (!r.ok && r.status !== 200 && r.status !== 202) {
    throw new Error(`startIntegrationRuntime failed ${r.status}: ${await r.text()}`);
  }
}

export async function stopIntegrationRuntime(name: string): Promise<void> {
  const r = await call(`${base()}/integrationruntimes/${encodeURIComponent(name)}/stop?api-version=${API}`, { method: 'POST' });
  if (!r.ok && r.status !== 200 && r.status !== 202) {
    throw new Error(`stopIntegrationRuntime failed ${r.status}: ${await r.text()}`);
  }
}

export async function deleteIntegrationRuntime(name: string): Promise<void> {
  const r = await call(`${base()}/integrationruntimes/${encodeURIComponent(name)}?api-version=${API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 204) {
    throw new Error(`deleteIntegrationRuntime failed ${r.status}: ${await r.text()}`);
  }
}

// ============================================================
// Cross-factory helpers — back the MountedDataFactory editor which
// targets an externally-referenced ADF by (subscriptionId, resourceGroup,
// factoryName) rather than the env-pinned default factory above.
//
// All calls go through the same UAMI ARM token. The UAMI must hold
// "Data Factory Contributor" (or read-only) on the referenced factory.
// ============================================================

function externalBase(subscriptionId: string, resourceGroup: string, factoryName: string): string {
  return `https://${ARM_HOST}/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.DataFactory/factories/${encodeURIComponent(factoryName)}`;
}

export interface MountedFactoryRef {
  subscriptionId: string;
  resourceGroup: string;
  factoryName: string;
}

export async function getMountedFactory(ref: MountedFactoryRef): Promise<{ id?: string; name?: string; location?: string; properties?: any }> {
  const r = await call(`${externalBase(ref.subscriptionId, ref.resourceGroup, ref.factoryName)}?api-version=${API}`);
  return jsonOrThrow<any>(r, `getMountedFactory(${ref.factoryName})`);
}

export async function listMountedFactoryPipelines(ref: MountedFactoryRef): Promise<AdfPipeline[]> {
  const r = await call(`${externalBase(ref.subscriptionId, ref.resourceGroup, ref.factoryName)}/pipelines?api-version=${API}`);
  const body = await jsonOrThrow<{ value: AdfPipeline[] }>(r, `listMountedFactoryPipelines(${ref.factoryName})`);
  return body.value || [];
}

export async function listMountedFactoryTriggers(ref: MountedFactoryRef): Promise<AdfTrigger[]> {
  const r = await call(`${externalBase(ref.subscriptionId, ref.resourceGroup, ref.factoryName)}/triggers?api-version=${API}`);
  const body = await jsonOrThrow<{ value: AdfTrigger[] }>(r, `listMountedFactoryTriggers(${ref.factoryName})`);
  return body.value || [];
}

export async function listMountedFactoryRuns(ref: MountedFactoryRef, windowDays = 7): Promise<AdfPipelineRun[]> {
  const now = new Date();
  const start = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const r = await call(`${externalBase(ref.subscriptionId, ref.resourceGroup, ref.factoryName)}/queryPipelineRuns?api-version=${API}`, {
    method: 'POST',
    body: JSON.stringify({
      lastUpdatedAfter: start.toISOString(),
      lastUpdatedBefore: now.toISOString(),
      orderBy: [{ orderBy: 'RunStart', order: 'DESC' }],
    }),
  });
  const body = await jsonOrThrow<{ value: AdfPipelineRun[] }>(r, `listMountedFactoryRuns(${ref.factoryName})`);
  return (body.value || []).slice(0, 50);
}

export async function runMountedFactoryPipeline(
  ref: MountedFactoryRef,
  pipelineName: string,
  params?: Record<string, unknown>,
): Promise<PipelineRunResponse> {
  const r = await call(
    `${externalBase(ref.subscriptionId, ref.resourceGroup, ref.factoryName)}/pipelines/${encodeURIComponent(pipelineName)}/createRun?api-version=${API}`,
    { method: 'POST', body: JSON.stringify(params || {}) },
  );
  return jsonOrThrow<PipelineRunResponse>(r, `runMountedFactoryPipeline(${pipelineName})`);
}
