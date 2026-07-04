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

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope, armHost, adfFactoryDeepLinkId, getLogAnalyticsHost, logAnalyticsTokenScope } from './cloud-endpoints';
import { pathToHttpsUrl, KNOWN_CONTAINERS } from './adls-client';
import { executeQuery, serverlessTarget } from './synapse-sql-client';
import { discoverResourceCoordsByName } from './resource-graph-coords';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

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
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

// LOOM_ADF_SUB / LOOM_ADF_RG win for a reused Data Factory in another
// subscription / resource group (BYO wizard); fall back to the deployment sub
// (LOOM_SUBSCRIPTION_ID) and DLZ RG (LOOM_DLZ_RG) when empty so cross-sub reuse
// targets the correct factory instead of the deployment one.
//
// `target` (optional) is the domain-resolved deploy target from
// `lib/azure/topology.ts → resolveDeployTarget`: when a multi-domain publish
// route supplies it, the factory ARM scope follows the OWNING domain's DLZ
// subscription + resource group. Absent → the env default (single-sub
// behaviour every existing deployment has today).
export interface AdfArmTarget { subscriptionId?: string; resourceGroup?: string; }
function sub(t?: AdfArmTarget): string { return (t?.subscriptionId || '').trim() || process.env.LOOM_ADF_SUB || required('LOOM_SUBSCRIPTION_ID'); }
function rg(t?: AdfArmTarget):  string { return (t?.resourceGroup || '').trim() || process.env.LOOM_ADF_RG || required('LOOM_DLZ_RG'); }
function adfName(): string { return required('LOOM_ADF_NAME'); }

function base(t?: AdfArmTarget): string {
  return `${ARM_BASE}/subscriptions/${sub(t)}/resourceGroups/${rg(t)}/providers/Microsoft.DataFactory/factories/${adfName()}`;
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

/**
 * Bare ARM resource ID of the env-pinned default factory (NO management host
 * prefix) — `/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.DataFactory/factories/{name}`.
 * This is the value ADF Studio expects as its `factory=` deep-link query
 * parameter (URL-encoded by the caller). Throws if the factory env vars are
 * unset (callers should run `adfConfigGate()` first).
 */
export function factoryResourceId(): string {
  return adfFactoryDeepLinkId(sub(), rg(), adfName());
}

/** The env-pinned default factory name (for honest-gate MessageBar copy). */
export function defaultFactoryName(): string {
  return adfName();
}

/**
 * GET the env-pinned default factory resource. Used to read
 * `properties.publicNetworkAccess` (so the "Get data" surface can warn that
 * ADF Studio's management plane needs corporate VPN / Bastion when the factory
 * is private) and `location`. Real ARM REST.
 */
export async function getDefaultFactory(): Promise<{
  id?: string; name?: string; location?: string;
  properties?: { publicNetworkAccess?: string; provisioningState?: string };
}> {
  const r = await call(`${base()}?api-version=${API}`);
  return jsonOrThrow(r, 'getDefaultFactory');
}

async function callRaw(url: string, init?: RequestInit): Promise<Response> {
  const tok = await credential.getToken(ARM_SCOPE);
  if (!tok?.token) throw new Error('Failed to acquire ARM token');
  return fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${tok.token}`,
      'content-type': 'application/json',
    },
  });
}

// ---------------------------------------------------------------------------
// DLZ coordinate self-heal (generalized from synapse-pool-arm.ts / PR #1445).
//
// In the multi-sub dlz-attach topology the env resolves the DEFAULT factory
// coords to the ADMIN plane (LOOM_ADF_SUB || LOOM_SUBSCRIPTION_ID + LOOM_ADF_RG
// || LOOM_DLZ_RG), but the factory can actually live in the DLZ sub — so the
// configured ARM URL 404s (or 403s). On a 404/403 (or transport error) for a
// DEFAULT-factory URL we discover the factory's REAL {subscriptionId,
// resourceGroup} by name via Azure Resource Graph, cache it, and retry by
// rewriting the /subscriptions/<sub>/resourceGroups/<rg> segment — a single
// choke-point fix that covers every ARM op without touching its call site.
//
// Scoped to the DEFAULT factory only: URLs that target the configured default
// sub+rg+factory name. Cross-factory `externalBase(...)` URLs and explicit
// domain `target` URLs (which already carry authoritative coords) are NOT
// rewritten — discovery keys on LOOM_ADF_NAME, which is only correct for the
// default factory.
// ---------------------------------------------------------------------------

let resolvedDefaultCoords: { subscriptionId: string; resourceGroup: string } | null = null;

function defaultFactorySegment(coords: { subscriptionId: string; resourceGroup: string }): string {
  return `/subscriptions/${coords.subscriptionId}/resourceGroups/${coords.resourceGroup}/providers/Microsoft.DataFactory/factories/${adfName()}`;
}

/** True when `url` targets the env-configured DEFAULT factory (so self-heal is safe). */
function isDefaultFactoryUrl(url: string): boolean {
  try {
    return url.includes(defaultFactorySegment({ subscriptionId: sub(), resourceGroup: rg() }));
  } catch {
    return false;
  }
}

async function call(url: string, init?: RequestInit): Promise<Response> {
  // Already self-healed this process: rewrite default-factory URLs up front.
  if (resolvedDefaultCoords && isDefaultFactoryUrl(url)) {
    const healed = url.replace(
      defaultFactorySegment({ subscriptionId: sub(), resourceGroup: rg() }),
      defaultFactorySegment(resolvedDefaultCoords),
    );
    return callRaw(healed, init);
  }

  const res = await callRaw(url, init).catch(() => null);
  if (res && res.ok) return res;

  // 404/403 (or transport error) on a DEFAULT-factory URL: the env scope is
  // wrong/insufficient. Discover the factory's real coords and retry once.
  if ((!res || res.status === 404 || res.status === 403) && isDefaultFactoryUrl(url)) {
    const discovered = await discoverResourceCoordsByName({
      resourceType: 'Microsoft.DataFactory/factories',
      name: adfName(),
      credential,
    });
    if (discovered) {
      resolvedDefaultCoords = discovered;
      const healed = url.replace(
        defaultFactorySegment({ subscriptionId: sub(), resourceGroup: rg() }),
        defaultFactorySegment(discovered),
      );
      return callRaw(healed, init);
    }
  }
  // No discovery hit — re-issue (or return) so the real ARM error surfaces.
  return res ?? callRaw(url, init);
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

/**
 * Fetch only the `properties.parameters` block of a pipeline. Used by the
 * geo-pipeline run route to validate which declared parameters a target ADF
 * pipeline exposes before firing createRun — so the run route passes only the
 * parameters the pipeline contract declares (ADF ignores unknown params, but
 * this gives an honest used/skipped receipt). Real ARM REST via getPipeline().
 */
export async function getPipelineParameters(
  name: string,
): Promise<Record<string, { type: string; defaultValue?: unknown }>> {
  const pipeline = await getPipeline(name);
  return pipeline.properties?.parameters ?? {};
}

export async function upsertPipeline(name: string, spec: AdfPipeline, target?: AdfArmTarget): Promise<AdfPipeline> {
  const body = { name: spec.name || name, properties: spec.properties || { activities: [] } };
  const r = await call(`${base(target)}/pipelines/${encodeURIComponent(name)}?api-version=${API}`, {
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

/*
 * NOTE: there is intentionally no `validatePipeline` ARM helper here. The Azure
 * Data Factory MANAGEMENT REST API does NOT expose a public "validate pipeline"
 * action (no `factories/{f}/validatePipeline` or `pipelines/{name}/validate`
 * endpoint — the SDK `Validate()` methods are client-side object validators and
 * Studio's "Validate all" is internal). Pipeline validation is performed
 * server-side by `@/lib/azure/pipeline-validate` (validatePipelineSpec), which
 * the data-pipeline + adf-pipeline /validate BFF routes call. See
 * no-vaporware.md.
 */

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
  process.env.LOOM_LOG_ANALYTICS_ENDPOINT || getLogAnalyticsHost();
// LA token audience (api.loganalytics.io) != query host (api.loganalytics.azure.com).
// Deriving the scope from the host yields AADSTS500011. See logAnalyticsTokenScope().
const LA_SCOPE_ADF = logAnalyticsTokenScope();

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
  return escapeSqlLiteral(v);
}

async function laQuery(workspaceGuid: string, kql: string): Promise<LaQueryResponse> {
  const tok = await credential.getToken(LA_SCOPE_ADF);
  if (!tok?.token) throw new Error('Failed to acquire Log Analytics token');
  const url = `${LA_ENDPOINT_ADF}/v1/workspaces/${encodeURIComponent(workspaceGuid)}/query`;
  const r = await fetchWithTimeout(url, {
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
// Data flow debug sessions — the Azure-native backend for the Mapping Data
// Flow designer's live "Data preview" (the ADF Studio debug toggle). A debug
// session spins up a short-lived Spark cluster on a Managed IR, accepts an
// in-memory data-flow package (the flow + its referenced datasets / linked
// services), and runs preview queries against any stream — the SAME thing
// Fabric's data-flow preview does, but on plain ADF (no Fabric).
//
// Real ARM REST (Microsoft.DataFactory/factories, api-version 2018-06-01),
// grounded in @azure/arm-datafactory DataFlowDebugSessions + the Az.DataFactory
// Start/Add/Invoke/Stop cmdlet sequence:
//   1. createDataFlowDebugSession  → long-running (202) → { sessionId }
//   2. addDataFlowToDebugSession   → { jobVersion }
//   3. executeDataFlowDebugCommand → long-running (202) → { status, data }
//        where `data` is a JSON string { schema, data:[[...]] }
//   4. deleteDataFlowDebugSession  (stop / release the cluster)
//
// createDataFlowDebugSession and executeDataFlowDebugCommand are async ARM
// operations: the initial POST returns 202 with a Location (or
// Azure-AsyncOperation) header that we poll via `pollAdfLro` until the
// operation reaches a terminal state and the final result body is available.
//
// No mocks (per no-vaporware.md): preview rows come straight from the live
// debug session. When the factory env vars are missing the route honest-gates
// via `dataFlowDebugConfigGate()` instead of fabricating rows.
// ============================================================

/**
 * Honest config gate for the data-flow debug path. The debug session lives
 * under the same env-pinned factory as every other ADF op, so it needs exactly
 * the same three env vars — reuse {@link adfConfigGate}. Returns the missing
 * var or null when fully configured.
 */
export function dataFlowDebugConfigGate(): { missing: string } | null {
  return adfConfigGate();
}

/**
 * Follow an ADF long-running 202 response via its Location (or
 * Azure-AsyncOperation) header, polling with GET until the operation reaches a
 * terminal state, then return the final Response carrying the result body.
 * Non-202 responses pass straight through (synchronous completions). Bounded by
 * a max attempt count so a stuck operation surfaces as an honest failure rather
 * than hanging forever. Uses `callRaw` (raw UAMI ARM token, no self-heal — the
 * polling URL ARM hands back is already authoritative).
 */
async function pollAdfLro(res: Response): Promise<Response> {
  let current = res;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (current.status !== 202) return current;
    const pollUrl =
      current.headers.get('location') || current.headers.get('azure-asyncoperation');
    if (!pollUrl) return current;
    const retryAfter = Number(current.headers.get('retry-after'));
    const waitSec = Math.min(
      Math.max(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2, 1),
      15,
    );
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    current = await callRaw(pollUrl, { method: 'GET' });
  }
  return current;
}

/**
 * (1) Start a data-flow debug session — provisions the short-lived Spark
 * cluster. Long-running: POSTs `createDataFlowDebugSession`, follows the 202 to
 * completion, and returns the assigned `sessionId` (used by every later call).
 * Defaults mirror ADF Studio: General compute, 8 cores, 60-minute TTL.
 */
export async function createDataFlowDebugSession(opts?: {
  timeToLiveMinutes?: number;
  coreCount?: number;
  computeType?: string;
}): Promise<{ sessionId: string }> {
  const res = await call(`${base()}/createDataFlowDebugSession?api-version=${API}`, {
    method: 'POST',
    body: JSON.stringify({
      computeType: opts?.computeType || 'General',
      coreCount: opts?.coreCount ?? 8,
      timeToLive: opts?.timeToLiveMinutes ?? 60,
    }),
  });
  const final = await pollAdfLro(res);
  const out = await jsonOrThrow<{ status?: string; sessionId?: string }>(
    final,
    'createDataFlowDebugSession',
  );
  if (!out.sessionId) {
    throw new Error(
      `createDataFlowDebugSession returned no sessionId (status=${out.status ?? 'unknown'}).`,
    );
  }
  return { sessionId: out.sessionId };
}

/**
 * (2) Add the data-flow package to a running debug session — the in-memory
 * flow definition plus every dataset / linked service it references and
 * optional `debugSettings` (source row limits, parameters). Returns the
 * `jobVersion` the session assigns to this package revision.
 */
export async function addDataFlowToDebugSession(req: {
  sessionId: string;
  dataFlow: AdfDataFlow;
  datasets?: AdfDataset[];
  linkedServices?: AdfLinkedService[];
  debugSettings?: unknown;
}): Promise<{ jobVersion?: string }> {
  const body: Record<string, unknown> = {
    sessionId: req.sessionId,
    dataFlow: req.dataFlow,
  };
  if (req.datasets) body.datasets = req.datasets;
  if (req.linkedServices) body.linkedServices = req.linkedServices;
  if (req.debugSettings !== undefined) body.debugSettings = req.debugSettings;
  const res = await call(`${base()}/addDataFlowToDebugSession?api-version=${API}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const final = await pollAdfLro(res);
  return jsonOrThrow<{ jobVersion?: string }>(final, 'addDataFlowToDebugSession');
}

/**
 * (3) Execute a debug command against an added package — defaults to
 * `executePreviewQuery`, which returns a data preview for `streamName` (a
 * transform/source/sink name in the flow) capped at `rowLimits` (default 100,
 * ADF Studio's preview cap). Long-running: follows the 202, then JSON-parses
 * the command result's `data` string into `{ schema, data:[[...]] }` and maps
 * it to `{ schema, rows }`. Real preview rows from the live session — never a
 * mock. Some api-versions nest the payload under an `output` key; both shapes
 * are normalized.
 */
export async function executeDataFlowDebugCommand(req: {
  sessionId: string;
  command?: string;
  streamName: string;
  rowLimits?: number;
}): Promise<{ schema?: string; rows: unknown[][] }> {
  const res = await call(`${base()}/executeDataFlowDebugCommand?api-version=${API}`, {
    method: 'POST',
    body: JSON.stringify({
      sessionId: req.sessionId,
      command: req.command || 'executePreviewQuery',
      commandPayload: {
        streamName: req.streamName,
        rowLimits: req.rowLimits ?? 100,
      },
    }),
  });
  const final = await pollAdfLro(res);
  const out = await jsonOrThrow<{ status?: string; data?: string }>(
    final,
    'executeDataFlowDebugCommand',
  );
  let schema: string | undefined;
  let rows: unknown[][] = [];
  if (out.data) {
    try {
      let parsed = JSON.parse(out.data) as { output?: unknown; schema?: unknown; data?: unknown };
      // Az.DataFactory's cmdlet output nests the payload under `output`; the raw
      // REST shape carries { schema, data } at the top level. Unwrap when present.
      if (parsed && typeof parsed === 'object' && parsed.output && typeof parsed.output === 'object') {
        parsed = parsed.output as typeof parsed;
      }
      schema = typeof parsed.schema === 'string' ? parsed.schema : undefined;
      rows = Array.isArray(parsed.data) ? (parsed.data as unknown[][]) : [];
    } catch {
      // Non-JSON `data` payload — return no rows rather than fabricate any.
      rows = [];
    }
  }
  return { schema, rows };
}

/**
 * (4) Stop a data-flow debug session — releases the Spark cluster. Idempotent /
 * best-effort: a 200/202/204 (or an already-gone session) is success.
 */
export async function deleteDataFlowDebugSession(sessionId: string): Promise<void> {
  const r = await call(`${base()}/deleteDataFlowDebugSession?api-version=${API}`, {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
  if (!r.ok && r.status !== 200 && r.status !== 202 && r.status !== 204) {
    throw new Error(`deleteDataFlowDebugSession failed ${r.status}: ${await r.text()}`);
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
  opts?: { computeType?: string; coreCount?: number; integrationRuntimeName?: string },
): Promise<{ runId: string; pipelineName: string }> {
  const pipelineName = `loom-pq-run-${dataFlowName}`;
  const integrationRuntimeName = opts?.integrationRuntimeName || 'AutoResolveIntegrationRuntime';
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
        referenceName: integrationRuntimeName,
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
    /** Integration-runtime binding (SHIR / managed VNet IR) for the linked service. */
    connectVia?: { referenceName: string; type: string; parameters?: Record<string, unknown> };
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

/**
 * Validate a linked-service spec against the REAL factory before the user
 * commits it. ADF has no synchronous "test connectivity" REST for an UNSAVED
 * linked service (connectivity tests run through an IR data-plane endpoint), so
 * this does the honest next best thing: it PUTs a transient linked service
 * under a temp name and immediately deletes it. The PUT is a real ARM call that
 * rejects a malformed `typeProperties` shape, an unknown connector `type`, or a
 * spec the factory can't accept — surfacing those as a real error — and the
 * round-trip also proves the factory is reachable with the Console identity's
 * token. Returns `{ ok: true }` on a clean accept; throws with the ARM error
 * text otherwise. No mocks (per no-vaporware.md).
 */
export async function testLinkedService(spec: AdfLinkedService): Promise<{ ok: true }> {
  const tempName = `loom_test_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    await upsertLinkedService(tempName, { name: tempName, properties: spec.properties });
  } finally {
    // Best-effort cleanup — never let a failed delete mask the validation result.
    try { await deleteLinkedService(tempName); } catch { /* leave no-op */ }
  }
  return { ok: true };
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

/**
 * Resolve a Managed Azure IR usable for a Power Query / Wrangling Data Flow run.
 * The built-in `AutoResolveIntegrationRuntime` does NOT resolve in every factory
 * (some ARM-provisioned factories reject it for ExecuteWranglingDataflow with a
 * 400 "invalid reference 'autoresolveintegrationruntime'"). So: discover an
 * explicitly-defined Managed IR; if none exists, create a small Managed (Azure)
 * IR (`loom-managed-ir`) and use it. Returns the IR name to reference. Throws
 * on a real failure so the caller can honest-gate (never fakes a run).
 */
export async function ensureWranglingIntegrationRuntime(): Promise<string> {
  const irs = await listIntegrationRuntimes();
  const managed = irs.filter((ir) => (ir.properties?.type || '') === 'Managed');
  // Prefer an explicitly-defined Managed IR (incl. an explicit AutoResolve one).
  const preferred =
    managed.find((ir) => ir.name === 'AutoResolveIntegrationRuntime') || managed[0];
  if (preferred?.name) return preferred.name;
  // No Managed IR is defined in this factory — create one. A Managed IR with
  // AutoResolve compute location is the Azure-hosted Spark/data-movement IR that
  // Power Query (Wrangling Data Flow) activities require.
  const name = 'loom-managed-ir';
  await upsertIntegrationRuntime(name, {
    name,
    properties: {
      type: 'Managed',
      description: 'Loom-managed Azure IR for Power Query / Wrangling Data Flow runs.',
      typeProperties: {
        computeProperties: {
          location: 'AutoResolve',
          dataFlowProperties: { computeType: 'General', coreCount: 8, timeToLive: 10 },
        },
      },
    },
  });
  return name;
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

export interface AdfIntegrationRuntimeAuthKeys { authKey1?: string; authKey2?: string }

/**
 * Retrieve the registration ("install") keys for a Self-Hosted IR. These are
 * the keys an operator pastes into the Microsoft Integration Runtime gateway
 * installed on the on-prem/VM node to register it with this factory.
 *
 * ADF management-plane action:
 *   POST .../integrationruntimes/{name}/listAuthKeys
 *
 * Grounded in @azure/arm-datafactory IntegrationRuntimes.listAuthKeys →
 * IntegrationRuntimeAuthKeys { authKey1, authKey2 }. The keys are secrets — the
 * BFF returns them only to an authenticated session and never persists them.
 */
export async function listIntegrationRuntimeAuthKeys(name: string): Promise<AdfIntegrationRuntimeAuthKeys> {
  const r = await call(`${base()}/integrationruntimes/${encodeURIComponent(name)}/listAuthKeys?api-version=${API}`, { method: 'POST' });
  return jsonOrThrow<AdfIntegrationRuntimeAuthKeys>(r, `listIntegrationRuntimeAuthKeys(${name})`);
}

/**
 * Detect whether a pipeline's run will execute (in whole or part) on a
 * Self-Hosted Integration Runtime — the signal that the SHIR VMSS must be
 * scaled up before the run.
 *
 * ADF's IR-selection rule: a Copy (or other data-movement) activity runs on the
 * SHIR when the linked service it (or its dataset) uses carries
 * `connectVia: { referenceName, type: 'IntegrationRuntimeReference' }` pointing
 * at a SelfHosted IR. We therefore:
 *   1. getPipeline(name) and walk properties.activities[], collecting every
 *      referenced linked service name — directly via activity.linkedServiceName
 *      and indirectly via any dataset reference's linked service.
 *   2. Resolve each linked service; if its properties.connectVia is an
 *      IntegrationRuntimeReference, check whether that IR is SelfHosted (against
 *      the factory's IR list, fetched once).
 *
 * Returns true on the first SelfHosted match. Fail-open: any error (pipeline /
 * LS / IR read failure) returns false so the run is never blocked by detection
 * — the worst case is the SHIR isn't pre-warmed, which the activity itself
 * surfaces. Grounded in:
 *   https://learn.microsoft.com/azure/data-factory/concepts-integration-runtime#determining-which-ir-to-use
 *   https://learn.microsoft.com/azure/data-factory/concepts-linked-services#linked-service-json
 */
export async function pipelineUsesSelfHostedIr(pipelineName: string): Promise<boolean> {
  try {
    const pipeline = await getPipeline(pipelineName);
    const activities = (pipeline.properties?.activities || []) as Array<Record<string, any>>;
    if (!activities.length) return false;

    // Collect the linked-service names referenced by activities (directly and
    // via dataset references) plus the dataset names we must resolve to LS.
    const lsNames = new Set<string>();
    const datasetNames = new Set<string>();
    const collectFromRefArray = (arr: unknown, into: Set<string>, refType: string) => {
      if (!Array.isArray(arr)) return;
      for (const e of arr) {
        const ref = (e as any)?.referenceName ?? (e as any)?.[refType.toLowerCase()]?.referenceName;
        if (typeof ref === 'string') into.add(ref);
      }
    };
    for (const act of activities) {
      const tp = (act?.typeProperties || {}) as Record<string, any>;
      const lsRef = act?.linkedServiceName?.referenceName;
      if (typeof lsRef === 'string') lsNames.add(lsRef);
      // Copy activity inputs/outputs are dataset references.
      collectFromRefArray(act?.inputs, datasetNames, 'DatasetReference');
      collectFromRefArray(act?.outputs, datasetNames, 'DatasetReference');
      // Lookup/GetMetadata/etc. carry a single dataset on typeProperties.dataset.
      const dsRef = tp?.dataset?.referenceName;
      if (typeof dsRef === 'string') datasetNames.add(dsRef);
      // Copy source/sink also reference datasets in some shapes.
      for (const side of [tp?.source, tp?.sink]) {
        const r = side?.dataset?.referenceName;
        if (typeof r === 'string') datasetNames.add(r);
      }
    }

    // Resolve dataset → linked service.
    await Promise.all(
      [...datasetNames].map(async (dn) => {
        try {
          const ds = await getDataset(dn);
          const r = ds.properties?.linkedServiceName?.referenceName;
          if (typeof r === 'string') lsNames.add(r);
        } catch { /* skip unresolvable dataset */ }
      }),
    );

    if (!lsNames.size) return false;

    // Build the set of SelfHosted IR names once.
    const irs = await listIntegrationRuntimes();
    const selfHosted = new Set(
      irs.filter((ir) => ir.properties?.type === 'SelfHosted').map((ir) => ir.name),
    );
    if (!selfHosted.size) return false;

    // Any linked service pinned (connectVia) to a SelfHosted IR ⇒ true.
    for (const name of lsNames) {
      try {
        const ls = await getLinkedService(name);
        const cv = (ls.properties as any)?.connectVia;
        if (cv?.type === 'IntegrationRuntimeReference' && typeof cv?.referenceName === 'string' && selfHosted.has(cv.referenceName)) {
          return true;
        }
      } catch { /* skip unresolvable LS */ }
    }
    return false;
  } catch {
    return false;
  }
}

// ============================================================
// Change Data Capture (adfcdcs) — the Azure-native backend for a Loom
// Mirrored Database's continuous replication. A ChangeDataCapture resource
// (Microsoft.DataFactory/factories/adfcdcs) does the same job Fabric Mirroring
// does — an initial full load + continuous CDC from a relational source — but
// it is an ADF resource, no Microsoft Fabric required. It lands the captured
// rows in **Delta** format in ADLS Bronze via the factory's own managed
// identity (granted Storage Blob Data Contributor in adf.bicep).
//
// Refs (grounded in @azure/arm-datafactory ChangeDataCapture + Mapper* shapes):
//   - properties.policy = { mode: 'Continuous'|'Microbatch', recurrence? }
//   - properties.sourceConnectionsInfo[] = { sourceEntities[], connection }
//   - properties.targetConnectionsInfo[] = { targetEntities[], connection,
//       dataMapperMappings[], relationships[] }
//   - MapperConnection = { linkedService{referenceName,type}, linkedServiceType,
//       type:'linkedservicetype', commonDslConnectorProperties[] }
//   - MapperTable = { name, dslConnectorProperties[], schema[] }
//
// The source/target linked services are pre-existing ADF linked services
// (created by operators via the Loom ADF editor): a relational source linked
// service (Azure SQL / SQL Server / PostgreSQL) and an AzureBlobFS linked
// service pointing at the DLZ ADLS account.
// ============================================================

/** A connector property name/value pair (commonDsl / dsl connector props). */
export interface MapperDslProperty { name: string; value: unknown }

/** A linked-service reference inside a CDC mapper connection. */
export interface MapperLinkedServiceRef {
  referenceName: string;
  type: 'LinkedServiceReference';
  parameters?: Record<string, unknown>;
}

/** A CDC mapper connection (source or target). */
export interface MapperConnection {
  /** Pre-existing ADF linked service for this endpoint. */
  linkedService?: MapperLinkedServiceRef;
  /** ADF connector type, e.g. 'AzureSqlDatabase', 'SqlServer', 'AzurePostgreSql', 'AzureBlobFS'. */
  linkedServiceType?: string;
  /** Always the literal 'linkedservicetype' for linked-service-backed connections. */
  type: 'linkedservicetype';
  isInlineDataset?: boolean;
  commonDslConnectorProperties?: MapperDslProperty[];
}

/** A CDC mapper table/entity (one source table or one target Delta folder). */
export interface MapperTable {
  /** Display name — `schema.table` for the source, `schema.table` for the sink. */
  name: string;
  dslConnectorProperties?: MapperDslProperty[];
  schema?: Array<{ name: string; dataType?: string }>;
}

export interface MapperSourceConnectionsInfo {
  sourceEntities: MapperTable[];
  connection: MapperConnection;
}

export interface MapperTargetConnectionsInfo {
  targetEntities: MapperTable[];
  connection: MapperConnection;
  /** Per-table column mappings (auto-map when omitted). */
  dataMapperMappings?: unknown[];
  relationships?: unknown[];
}

export interface AdfCdcPolicy {
  /** 'Continuous' = streaming CDC; 'Microbatch' = scheduled batches. */
  mode: 'Continuous' | 'Microbatch' | string;
  recurrence?: { frequency: 'Hour' | 'Minute' | 'Second'; interval: number };
}

export interface AdfCdcSpec {
  description?: string;
  folder?: { name: string };
  policy: AdfCdcPolicy;
  sourceConnectionsInfo: MapperSourceConnectionsInfo[];
  targetConnectionsInfo: MapperTargetConnectionsInfo[];
  allowVNetOverride?: boolean;
  /** Read-only on GET — 'Running' once started, 'Stopped' otherwise. */
  status?: string;
}

export interface AdfCdc {
  id?: string;
  name: string;
  type?: string;
  etag?: string;
  properties: AdfCdcSpec;
}

/**
 * Honest config gate for the ADF CDC path. Mirrors {@link adfConfigGate} — the
 * CDC resource lives under the same env-pinned factory, so it needs exactly the
 * same three env vars. Returns the missing var or null.
 */
export function adfCdcConfigGate(): { missing: string } | null {
  return adfConfigGate();
}

/** Idempotently create/replace a ChangeDataCapture (adfcdcs) resource. */
export async function upsertAdfCdc(name: string, spec: AdfCdcSpec): Promise<AdfCdc> {
  const body = { name, properties: spec };
  const r = await call(`${base()}/adfcdcs/${encodeURIComponent(name)}?api-version=${API}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return jsonOrThrow<AdfCdc>(r, `upsertAdfCdc(${name})`);
}

export async function getAdfCdc(name: string): Promise<AdfCdc> {
  const r = await call(`${base()}/adfcdcs/${encodeURIComponent(name)}?api-version=${API}`);
  return jsonOrThrow<AdfCdc>(r, `getAdfCdc(${name})`);
}

/** Start a CDC resource — transitions it to Running (initial load + continuous CDC). */
export async function startAdfCdc(name: string): Promise<void> {
  const r = await call(`${base()}/adfcdcs/${encodeURIComponent(name)}/start?api-version=${API}`, { method: 'POST' });
  if (!r.ok && r.status !== 200 && r.status !== 202) {
    throw new Error(`startAdfCdc failed ${r.status}: ${await r.text()}`);
  }
}

/** Stop a running CDC resource (the landed Delta data + the resource remain). */
export async function stopAdfCdc(name: string): Promise<void> {
  const r = await call(`${base()}/adfcdcs/${encodeURIComponent(name)}/stop?api-version=${API}`, { method: 'POST' });
  if (!r.ok && r.status !== 200 && r.status !== 202) {
    throw new Error(`stopAdfCdc failed ${r.status}: ${await r.text()}`);
  }
}

export async function deleteAdfCdc(name: string): Promise<void> {
  const r = await call(`${base()}/adfcdcs/${encodeURIComponent(name)}?api-version=${API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 204) {
    throw new Error(`deleteAdfCdc failed ${r.status}: ${await r.text()}`);
  }
}

/** List every ChangeDataCapture (adfcdcs) resource in the env-pinned factory. */
export async function listAdfCdcs(): Promise<AdfCdc[]> {
  const r = await call(`${base()}/adfcdcs?api-version=${API}`);
  const body = await jsonOrThrow<{ value: AdfCdc[] }>(r, 'listAdfCdcs');
  return body.value || [];
}

/**
 * GET the live status for a CDC resource. The ARM endpoint
 * `GET .../adfcdcs/{name}/status` responds with a BARE JSON string — e.g.
 * `"Running"` / `"Stopped"` / `"Starting"` / `"Stopping"` — not an object.
 * We strip the surrounding quotes and return the plain string. (Some
 * api-versions wrap it as `{ status: "Running" }`; both are normalized.)
 */
export async function statusAdfCdc(name: string): Promise<string> {
  const r = await call(`${base()}/adfcdcs/${encodeURIComponent(name)}/status?api-version=${API}`);
  if (!r.ok) throw new Error(`statusAdfCdc failed ${r.status}: ${await r.text()}`);
  const text = (await r.text()).trim();
  if (!text) return 'Unknown';
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { status?: unknown }).status === 'string') {
      return (parsed as { status: string }).status;
    }
    return text;
  } catch {
    return text.replace(/^"|"$/g, '');
  }
}

// ============================================================
// CDC change-data PREVIEW — read the rows the CDC resource actually
// captured. A ChangeDataCapture resource lands its initial load +
// continuous changes as **Delta** in ADLS Bronze (one Delta folder per
// target entity, carried in targetConnectionsInfo[].targetEntities[]
// .dslConnectorProperties as { fileSystem, folderPath, format:'delta' } —
// see mirror-engine.runMirrorAdfCdc). To preview the real change data we
// read that landed Delta target via the SAME Synapse Serverless OPENROWSET
// FORMAT='DELTA' path the Lakehouse file preview uses (no extra SDK, no
// Parquet/_delta_log parsing in-process). This is the data the resource
// produced — not a source-side sample — so it is honest "change data".
//
// No Fabric dependency: the Delta target is plain ADLS Gen2 and the reader
// is Synapse Serverless. Works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
// Required infra: the env-pinned factory (LOOM_ADF_NAME etc.) to resolve
// the CDC target folder, plus LOOM_SYNAPSE_WORKSPACE for the Serverless
// reader (the Synapse Serverless MI needs Storage Blob Data Reader on the
// Bronze container — granted by the DLZ deploy). Missing config surfaces as
// an honest gate, never a mock.
// ============================================================

/** One target entity that can be previewed (a landed Delta folder). */
export interface AdfCdcTargetEntity {
  /** `schema.table` display name of the captured entity. */
  name: string;
  /** ADLS container (file system) the Delta folder lives in, e.g. 'bronze'. */
  container: string;
  /** Container-relative path of the Delta table folder. */
  folderPath: string;
}

export interface AdfCdcPreviewResult {
  /** The entity actually previewed (the resolved Delta folder). */
  entity: AdfCdcTargetEntity;
  /** Every previewable target entity, so the editor can offer a picker. */
  entities: AdfCdcTargetEntity[];
  /** Column headers, in order. */
  columns: string[];
  /** Up to `rowLimit` captured-change rows (parallel to `columns`). */
  rows: unknown[][];
  rowCount: number;
  /** True when the resource returned at least `rowLimit` rows (more exist). */
  truncated: boolean;
  /** abfss/https URL of the Delta folder read (receipt / deep-link). */
  deltaUrl: string;
}

/** Extract a single DSL connector property value (string) by name. */
function dslValue(props: MapperDslProperty[] | undefined, name: string): string | undefined {
  const hit = (props || []).find((p) => p.name === name);
  return typeof hit?.value === 'string' ? hit.value : undefined;
}

/**
 * Flatten a CDC resource's target connections into the previewable Delta
 * folders. Only Delta-format AzureBlobFS targets carrying both `fileSystem`
 * and `folderPath` are returned (the shape mirror-engine writes).
 */
function cdcTargetEntities(c: AdfCdc): AdfCdcTargetEntity[] {
  const out: AdfCdcTargetEntity[] = [];
  for (const t of c.properties?.targetConnectionsInfo || []) {
    for (const e of t.targetEntities || []) {
      const container = dslValue(e.dslConnectorProperties, 'fileSystem');
      const folderPath = dslValue(e.dslConnectorProperties, 'folderPath');
      const format = (dslValue(e.dslConnectorProperties, 'format') || 'delta').toLowerCase();
      if (!container || !folderPath || format !== 'delta') continue;
      out.push({ name: e.name, container, folderPath: folderPath.replace(/^\/+|\/+$/g, '') });
    }
  }
  return out;
}

function escapeSqlSingleQuotes(s: string): string {
  return escapeSqlLiteral(s);
}

/**
 * Preview the real change data a CDC resource landed in its Delta target.
 *
 *  - `name`     CDC (adfcdcs) resource name.
 *  - `entity`   optional `schema.table` to preview; defaults to the first
 *               Delta target entity on the resource.
 *  - `rowLimit` clamped to 1..1000 (ADF Studio's data-preview row cap).
 *
 * Returns columns + rows read via Synapse Serverless OPENROWSET FORMAT='DELTA'
 * over the landed Bronze Delta folder. Throws (caller surfaces a gate / 502)
 * when the resource has no Delta target, the named entity is unknown, or the
 * Serverless reader / storage RBAC is not configured.
 */
export async function previewAdfCdcTarget(
  name: string,
  entity?: string,
  rowLimit = 100,
): Promise<AdfCdcPreviewResult> {
  const limit = Math.min(Math.max(Math.trunc(rowLimit) || 100, 1), 1000);
  const c = await getAdfCdc(name);
  const entities = cdcTargetEntities(c);
  if (entities.length === 0) {
    throw new Error(
      `CDC resource "${name}" has no Delta target folder to preview. The resource must define a target entity with fileSystem + folderPath (Delta format) — re-create it via the mirror wizard, or Start it so it lands data.`,
    );
  }
  const target = entity
    ? entities.find((e) => e.name === entity)
    : entities[0];
  if (!target) {
    throw new Error(`CDC resource "${name}" has no target entity named "${entity}".`);
  }
  // Defence-in-depth: the Delta container must be a known DLZ container so the
  // OPENROWSET URL host/container cannot be steered to an arbitrary account.
  if (!(KNOWN_CONTAINERS as readonly string[]).includes(target.container)) {
    throw new Error(`CDC target container "${target.container}" is not a known DLZ container.`);
  }

  const deltaUrl = pathToHttpsUrl(target.container, target.folderPath);
  const safeUrl = escapeSqlSingleQuotes(deltaUrl);
  // limit is an integer 1..1000 (clamped above) — safe to inline.
  const sqlText = `SELECT TOP ${limit} * FROM OPENROWSET(BULK '${safeUrl}', FORMAT = 'DELTA') AS r;`;

  const result = await executeQuery(serverlessTarget('master'), sqlText);
  return {
    entity: target,
    entities,
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rowCount,
    truncated: result.rowCount >= limit,
    deltaUrl,
  };
}

// ============================================================
// Global parameters (Microsoft.DataFactory/factories/globalParameters)
//
// ADF stores every factory-level global parameter in a SINGLE child resource
// conventionally named `default`, whose `properties` is the full
// { paramName -> { type, value } } dictionary. `type` is one of
// Bool|String|Int|Float|Object|Array. This is a pure ADF ARM resource
// (api-version 2018-06-01) — no Fabric dependency, works Commercial + Gov.
//
// The editor manages add/edit/remove on the whole dict client-side and PUTs
// the entire set in one call — exactly how ADF Studio's Manage → Global
// parameters publish works. Grounded in the ADF REST reference
// (GlobalParameters_CreateOrUpdate) + @azure/arm-datafactory FactoryProperties.
// ============================================================

export type AdfGlobalParameterType = 'Bool' | 'String' | 'Int' | 'Float' | 'Object' | 'Array';

export interface AdfGlobalParameterSpec {
  /** Global Parameter type — Bool | String | Int | Float | Object | Array. */
  type: AdfGlobalParameterType | string;
  /** Value of the parameter (shape depends on `type`). */
  value: unknown;
}

/** All global parameters live under one child resource conventionally named `default`. */
const GLOBAL_PARAMS_RESOURCE = 'default';

/**
 * Read the factory's global parameters (the { name -> { type, value } } dict
 * from the `default` globalParameters child resource). Returns {} when no
 * global parameters are defined (the resource 404s) rather than throwing —
 * so the navigator renders an empty group instead of an error.
 */
export async function getGlobalParameters(): Promise<Record<string, AdfGlobalParameterSpec>> {
  const r = await call(`${base()}/globalParameters/${GLOBAL_PARAMS_RESOURCE}?api-version=${API}`);
  if (r.status === 404) return {};
  const body = await jsonOrThrow<{ properties?: Record<string, AdfGlobalParameterSpec> }>(r, 'getGlobalParameters');
  return body.properties || {};
}

/**
 * Replace the factory's ENTIRE global-parameter set (idempotent PUT of the
 * `default` globalParameters resource). The editor supplies the full dict after
 * applying add/edit/remove; PUTting it replaces the set (an empty dict clears
 * all global parameters). Returns the persisted dict. Real ARM REST — no mocks.
 */
export async function updateGlobalParameters(
  params: Record<string, AdfGlobalParameterSpec>,
): Promise<Record<string, AdfGlobalParameterSpec>> {
  const r = await call(`${base()}/globalParameters/${GLOBAL_PARAMS_RESOURCE}?api-version=${API}`, {
    method: 'PUT',
    body: JSON.stringify({ properties: params }),
  });
  const body = await jsonOrThrow<{ properties?: Record<string, AdfGlobalParameterSpec> }>(r, 'updateGlobalParameters');
  return body.properties || {};
}

// ============================================================
// Managed Virtual Network + Managed Private Endpoints
// (Microsoft.DataFactory/factories/managedVirtualNetworks/{mvnet}/managedPrivateEndpoints)
//
// A managed private endpoint lets the factory's Managed VNet Azure IR reach a
// PE-locked data source (ADLS, Azure SQL, Key Vault, …) privately — the ADF
// analogue of the Purview managed-VNet PE path. ADF's managed VNet is
// conventionally named `default`; managed PEs live under it. A newly-created PE
// lands in a **Pending** connection state — the OWNER of the target resource
// must APPROVE the private-endpoint connection (a separate ARM action on the
// source) before traffic can traverse it. Loom surfaces that as a next step; it
// does not auto-approve. Pure ADF ARM (2018-06-01), no Fabric. Grounded in the
// ADF REST reference + @azure/arm-datafactory ManagedPrivateEndpoints.
// ============================================================

/** ADF's managed virtual network is conventionally named `default`. */
export const DEFAULT_MANAGED_VNET = 'default';

export interface AdfManagedVnet {
  name: string;
  id?: string;
}

export interface AdfManagedPrivateEndpoint {
  name: string;
  /** ARM resource id of the private-link resource the PE targets. */
  privateLinkResourceId?: string;
  /** Sub-resource group id (e.g. `dfs`/`blob` for ADLS Gen2, `sqlServer` for Azure SQL). */
  groupId?: string;
  provisioningState?: string;
  /** Owner-reported approval status: Pending | Approved | Rejected | Disconnected. */
  connectionStatus?: string;
  fqdns?: string[];
  isReserved?: boolean;
}

function mapManagedPe(raw: any): AdfManagedPrivateEndpoint {
  return {
    name: raw?.name,
    privateLinkResourceId: raw?.properties?.privateLinkResourceId,
    groupId: raw?.properties?.groupId,
    provisioningState: raw?.properties?.provisioningState,
    connectionStatus: raw?.properties?.connectionState?.status,
    fqdns: raw?.properties?.fqdns,
    isReserved: raw?.properties?.isReserved,
  };
}

/** List the managed virtual networks on the env-pinned factory (usually 0 or 1 — `default`). */
export async function listManagedVnets(): Promise<AdfManagedVnet[]> {
  const r = await call(`${base()}/managedVirtualNetworks?api-version=${API}`);
  if (r.status === 404) return [];
  const body = await jsonOrThrow<{ value?: Array<{ name: string; id?: string }> }>(r, 'listManagedVnets');
  return (body.value || []).map((v) => ({ name: v.name, id: v.id }));
}

/**
 * Create (idempotent PUT) the factory's managed virtual network — the
 * prerequisite for managed private endpoints. Safe to call when it already
 * exists. Returns the managed VNet. Real ARM REST.
 */
export async function ensureManagedVnet(mvnet: string = DEFAULT_MANAGED_VNET): Promise<AdfManagedVnet> {
  const r = await call(`${base()}/managedVirtualNetworks/${encodeURIComponent(mvnet)}?api-version=${API}`, {
    method: 'PUT',
    body: JSON.stringify({ properties: {} }),
  });
  const raw = await jsonOrThrow<{ name?: string; id?: string }>(r, `ensureManagedVnet(${mvnet})`);
  return { name: raw.name || mvnet, id: raw.id };
}

/** List the managed private endpoints in a managed VNet (empty when the VNet doesn't exist). */
export async function listManagedPrivateEndpoints(
  mvnet: string = DEFAULT_MANAGED_VNET,
): Promise<AdfManagedPrivateEndpoint[]> {
  const r = await call(`${base()}/managedVirtualNetworks/${encodeURIComponent(mvnet)}/managedPrivateEndpoints?api-version=${API}`);
  if (r.status === 404) return [];
  const body = await jsonOrThrow<{ value?: any[] }>(r, 'listManagedPrivateEndpoints');
  return (body.value || []).map(mapManagedPe);
}

/**
 * Create (idempotent PUT) a managed private endpoint to a target resource.
 * `privateLinkResourceId` is the ARM id of the source (e.g. the DLZ lake's
 * storage account) and `groupId` its sub-resource (`dfs`/`blob`, `sqlServer`,
 * `vault`, …). The PE is created **Pending** — the resource owner must approve
 * the private-endpoint connection on the target before it carries traffic. Real
 * ARM REST; throws the raw ARM error on non-2xx so the route can surface it.
 */
export async function upsertManagedPrivateEndpoint(
  name: string,
  opts: { privateLinkResourceId: string; groupId: string; fqdns?: string[]; mvnet?: string },
): Promise<AdfManagedPrivateEndpoint> {
  const mvnet = opts.mvnet || DEFAULT_MANAGED_VNET;
  const properties: Record<string, unknown> = {
    privateLinkResourceId: opts.privateLinkResourceId,
    groupId: opts.groupId,
  };
  if (opts.fqdns && opts.fqdns.length) properties.fqdns = opts.fqdns;
  const r = await call(
    `${base()}/managedVirtualNetworks/${encodeURIComponent(mvnet)}/managedPrivateEndpoints/${encodeURIComponent(name)}?api-version=${API}`,
    { method: 'PUT', body: JSON.stringify({ properties }) },
  );
  const raw = await jsonOrThrow<any>(r, `upsertManagedPrivateEndpoint(${name})`);
  return mapManagedPe(raw);
}

export async function deleteManagedPrivateEndpoint(
  name: string,
  mvnet: string = DEFAULT_MANAGED_VNET,
): Promise<void> {
  const r = await call(
    `${base()}/managedVirtualNetworks/${encodeURIComponent(mvnet)}/managedPrivateEndpoints/${encodeURIComponent(name)}?api-version=${API}`,
    { method: 'DELETE' },
  );
  if (!r.ok && r.status !== 200 && r.status !== 204) {
    throw new Error(`deleteManagedPrivateEndpoint failed ${r.status}: ${await r.text()}`);
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

// ============================================================
// Factory provisioning — create a NEW ADF-standalone factory (Wave A
// binder "Create new factory" flow). The unified Data pipeline editor's
// runtime selector lets the operator target a non-default ADF factory; the
// binder UI can provision one inline rather than only reusing an existing
// one via AzureResourcePicker.
//
// This is the ONE op in this client that targets an OPERATOR-CHOSEN
// (subscription, resourceGroup, name) — NOT the env-pinned default factory.
// It therefore builds its own cross-sub/rg ARM URL from ARM_BASE and goes
// through `callRaw` (raw UAMI ARM token, NO self-heal): `call()`'s
// 404/403 → Resource-Graph-by-name self-heal keys on LOOM_ADF_NAME, which is
// only correct for the default factory — applying it to a brand-new factory
// name would be wrong (and the resource intentionally doesn't exist yet).
//
// Real ARM REST (no mock, per no-vaporware.md):
//   PUT .../Microsoft.DataFactory/factories/{name}?api-version=2018-06-01
//   body { location, properties: {} }
// Azure-native default per no-fabric-dependency.md — ADF is the default
// pipeline runtime; no Fabric workspace is involved.
// ============================================================

/** Lightweight view of a created/resolved ADF factory (binder create-new). */
export interface AdfFactoryLite {
  id: string;
  name: string;
  subscriptionId: string;
  resourceGroup: string;
  location: string;
}

/**
 * Create (idempotent PUT) an ADF-standalone factory at an operator-chosen
 * (subscription, resourceGroup, name, location). Backs
 * `POST /api/adf/factories/create` for the unified pipeline editor's binder.
 *
 * Builds its OWN ARM URL (NOT `base()`, which is pinned to the env factory)
 * and uses `callRaw` so the default-factory self-heal in `call()` never
 * rewrites the target. Throws with the raw ARM error text on a non-2xx so the
 * route can map it to an honest 403 (Console UAMI lacks Contributor on the RG)
 * or 502 — never a mock.
 */
export async function createFactory(args: {
  name: string;
  location: string;
  subscriptionId: string;
  resourceGroup: string;
}): Promise<AdfFactoryLite> {
  const url =
    `${ARM_BASE}/subscriptions/${encodeURIComponent(args.subscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(args.resourceGroup)}` +
    `/providers/Microsoft.DataFactory/factories/${encodeURIComponent(args.name)}` +
    `?api-version=${API}`;
  const r = await callRaw(url, {
    method: 'PUT',
    body: JSON.stringify({ location: args.location, properties: {} }),
  });
  if (!r.ok && r.status !== 202) {
    throw new Error(`createFactory(${args.name}) failed ${r.status}: ${await r.text()}`);
  }
  const body = await jsonOrThrow<{
    id?: string;
    name?: string;
    location?: string;
  }>(r, `createFactory(${args.name})`);
  return {
    id: body.id || `/subscriptions/${args.subscriptionId}/resourceGroups/${args.resourceGroup}/providers/Microsoft.DataFactory/factories/${args.name}`,
    name: body.name || args.name,
    subscriptionId: args.subscriptionId,
    resourceGroup: args.resourceGroup,
    location: body.location || args.location,
  };
}
