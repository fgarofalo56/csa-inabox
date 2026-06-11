/**
 * Power BI / Fabric REST client — for the v2.1 Power BI editor family
 * (Semantic Model, Report, Dashboard, Paginated Report, Scorecard).
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) via ManagedIdentityCredential,
 * chained with DefaultAzureCredential for local dev.
 *
 * Scopes used:
 *   - Power BI REST       : https://analysis.windows.net/powerbi/api/.default
 *   - Fabric REST         : https://api.fabric.microsoft.com/.default
 *
 * Endpoints used:
 *   - Power BI v1.0  : https://api.powerbi.com/v1.0/myorg/...
 *   - Fabric v1      : https://api.fabric.microsoft.com/v1/...
 *
 * Pre-requisites for real data (these surface as 401/403/Unauthorized
 * errors from Power BI if missing; the editor displays the error verbatim
 * via MessageBar — operators should follow the "Bootstrap" steps below):
 *
 *   1. A Power BI admin must enable the tenant setting:
 *        "Service principals can use Fabric APIs"
 *      (or, for Power BI subset: "Service principals can use Power BI APIs"),
 *      and add a security group that contains the Console UAMI's SP.
 *
 *   2. The Console UAMI must be added to each Power BI workspace (Member or
 *      Contributor at minimum) that the platform should be able to inspect.
 *
 *   3. The UAMI SP must exist in the customer's Power BI / Fabric tenant.
 *      For a UAMI in the same tenant as Power BI this is automatic; for
 *      cross-tenant scenarios the SP must be provisioned via consent.
 *
 * No mocks. All errors are wrapped in PowerBiError with status + body so
 * the BFF route can surface them to the editor.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { getPbiGovHost, getPbiScope, getPbiEmbedHostname } from './cloud-endpoints';

export { getPbiEmbedHostname } from './cloud-endpoints';

// Power BI REST base. When LOOM_POWERBI_BASE is unset we resolve the
// sovereign-cloud-aware host: Commercial / GCC → api.powerbi.com, GCC-High /
// IL5 / DoD → api.powerbigov.us (the Azure-Government-backed Power BI REST
// host — NOT a Fabric API host — so this is permitted per no-fabric-dependency).
// Backwards-compatible: getPbiGovHost() returns api.powerbi.com in Commercial.
const POWERBI_BASE = process.env.LOOM_POWERBI_BASE || `${getPbiGovHost()}/v1.0/myorg`;
const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';

// Sovereign-cloud-aware Power BI REST scope. Commercial → the historical
// `analysis.windows.net/powerbi/api/.default`; GCC-High / DoD use the Gov /
// DoD analysis audiences. Hard-coding the Commercial scope silently 401s
// against api.powerbigov.us in the Government clouds. `LOOM_POWERBI_SCOPE`
// (honoured inside getPbiScope) overrides outright.
const POWERBI_SCOPE = getPbiScope();
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

export class PowerBiError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string) {
    super(message);
    this.name = 'PowerBiError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

async function getToken(scope: string): Promise<string> {
  const t = await credential.getToken(scope);
  if (!t?.token) throw new PowerBiError(`Failed to acquire AAD token for ${scope}`, 401);
  return t.token;
}

type Api = 'powerbi' | 'fabric';

function baseFor(api: Api): string {
  return api === 'fabric' ? FABRIC_BASE : POWERBI_BASE;
}

function scopeFor(api: Api): string {
  return api === 'fabric' ? FABRIC_SCOPE : POWERBI_SCOPE;
}

interface CallOpts {
  api?: Api;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

async function call<T = any>(path: string, opts: CallOpts = {}): Promise<T> {
  const api: Api = opts.api ?? 'powerbi';
  const method = opts.method ?? 'GET';
  const token = await getToken(scopeFor(api));
  let url = `${baseFor(api)}${path}`;
  if (opts.query) {
    const qs = new URLSearchParams();
    Object.entries(opts.query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) qs.append(k, String(v));
    });
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const res = await fetchWithTimeout(url, {
    method,
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || json?.message || text || `${api} ${method} ${path} failed`).toString();
    throw new PowerBiError(msg, res.status, json || text, url);
  }
  return (json as T) ?? ({} as T);
}

// ============================================================
// Types — slim, only fields the editors render.
// ============================================================

export interface PbiWorkspace {
  id: string;
  name: string;
  type?: string;
  state?: string;
  isReadOnly?: boolean;
  isOnDedicatedCapacity?: boolean;
  capacityId?: string;
}

export interface PbiReport {
  id: string;
  name: string;
  webUrl?: string;
  embedUrl?: string;
  datasetId?: string;
  reportType?: 'PowerBIReport' | 'PaginatedReport';
  modifiedDateTime?: string;
  modifiedBy?: string;
}

export interface PbiDashboard {
  id: string;
  displayName: string;
  isReadOnly?: boolean;
  webUrl?: string;
  embedUrl?: string;
}

export interface PbiTile {
  id: string;
  title?: string;
  subTitle?: string;
  embedUrl?: string;
  reportId?: string;
  datasetId?: string;
  rowSpan?: number;
  colSpan?: number;
}

export interface PbiDataset {
  id: string;
  name: string;
  webUrl?: string;
  configuredBy?: string;
  isRefreshable?: boolean;
  isEffectiveIdentityRequired?: boolean;
  isEffectiveIdentityRolesRequired?: boolean;
  targetStorageMode?: string;
  createdDate?: string;
}

export interface PbiTable {
  name: string;
  columns?: Array<{ name: string; dataType?: string }>;
  measures?: Array<{ name: string; expression?: string }>;
}

export interface PbiRefresh {
  requestId?: string;
  refreshType?: string;
  startTime?: string;
  endTime?: string;
  status?: string;
  serviceExceptionJson?: string;
}

export interface FabricScorecard {
  id: string;
  displayName: string;
  description?: string;
  workspaceId?: string;
}

// ============================================================
// Config gate
// ============================================================

/**
 * powerbiConfigGate — honest infra-gate for the Power BI workspace navigator.
 *
 * Power BI REST has no single "endpoint" env var the way Databricks/Synapse do
 * (the base is always api.powerbi.com); reachability is gated by the Power BI
 * *tenant* admin enabling service-principal API access and adding the Console
 * UAMI to each workspace. Those failures surface at call-time as 401/403 and
 * are passed through verbatim by the routes.
 *
 * The one thing the *console* must have to authenticate at all is a managed
 * identity / credential. When `LOOM_UAMI_CLIENT_ID` is unset AND no ambient
 * Azure credential is available (i.e. neither MI nor `az login`), the token
 * acquisition fails. We expose that as a structured gate so the navigator can
 * render the precise remediation instead of a raw 401.
 *
 * Returns `null` when the console is configured to *attempt* a real call.
 */
export function powerbiConfigGate(): { missing: string; detail: string } | null {
  const hasUami = !!process.env.LOOM_UAMI_CLIENT_ID;
  // In a deployed Container App the UAMI client id is always set. Locally,
  // DefaultAzureCredential (az login / VS auth) can still mint a token, so we
  // only hard-gate when neither is present.
  const hasLocalCred =
    !!process.env.AZURE_CLIENT_ID ||
    !!process.env.AZURE_TENANT_ID ||
    !!process.env.AZURE_FEDERATED_TOKEN_FILE ||
    process.env.NODE_ENV !== 'production';
  if (!hasUami && !hasLocalCred) {
    return {
      missing: 'LOOM_UAMI_CLIENT_ID',
      detail:
        'No Azure credential is available to call Power BI. Set LOOM_UAMI_CLIENT_ID ' +
        'to the Console user-assigned managed identity client id (or run `az login` ' +
        'for local dev). The UAMI service principal must also be (1) granted Power BI ' +
        'tenant access via "Service principals can use Fabric APIs" and (2) added as ' +
        'Member/Contributor to each target workspace.',
    };
  }
  return null;
}

/**
 * The remediation string surfaced verbatim by the navigator routes when Power
 * BI returns 401/403 (SP not authorized in the tenant or not a workspace member).
 */
export const POWERBI_SP_HINT =
  'The Console service principal is not authorized for Power BI. A Power BI admin must ' +
  '(1) enable "Service principals can use Fabric APIs" (or the Power BI subset) in the ' +
  'tenant settings and add the Console UAMI to that security group, and ' +
  '(2) add the UAMI as Member or Contributor on each target workspace.';

// ============================================================
// Workspaces (groups)
// ============================================================

export async function listWorkspaces(): Promise<PbiWorkspace[]> {
  const j = await call<{ value: PbiWorkspace[] }>('/groups');
  return j.value || [];
}

// ============================================================
// Deployment pipelines (Dev / Test / Prod stage promotion)
//
//   GET  /v1.0/myorg/pipelines                      → list pipelines
//   GET  /v1.0/myorg/pipelines/{id}/stages          → stages (order + workspace)
//   POST /v1.0/myorg/pipelines/{id}/deployAll        → promote a stage forward
//
// Docs: https://learn.microsoft.com/rest/api/power-bi/pipelines
// ============================================================

export interface PbiPipeline {
  id: string;
  displayName: string;
  description?: string;
}

export interface PbiPipelineStage {
  order: number;
  workspaceId?: string;
  workspaceName?: string;
}

export async function listPipelines(): Promise<PbiPipeline[]> {
  const j = await call<{ value: PbiPipeline[] }>('/pipelines');
  return j.value || [];
}

export async function getPipelineStages(pipelineId: string): Promise<PbiPipelineStage[]> {
  const j = await call<{ value: PbiPipelineStage[] }>(
    `/pipelines/${encodeURIComponent(pipelineId)}/stages`,
  );
  return (j.value || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * POST /pipelines/{id}/deployAll — promote ALL artifacts from `sourceStageOrder`
 * to the next stage (0→1 Dev→Test, 1→2 Test→Prod). Power BI runs the deployment
 * async and returns 202 with an operation id. The caller surfaces 401/403
 * (SP not a pipeline admin) verbatim.
 */
export async function deployPipelineAll(
  pipelineId: string,
  sourceStageOrder: number,
  options?: { note?: string },
): Promise<{ ok: true }> {
  await call(
    `/pipelines/${encodeURIComponent(pipelineId)}/deployAll`,
    { method: 'POST', body: { sourceStageOrder, options: { allowOverwriteArtifact: true, allowCreateArtifact: true }, ...(options?.note ? { note: options.note } : {}) } },
  );
  return { ok: true };
}

// ============================================================
// Dataflows  (GET/POST/DELETE /groups/{ws}/dataflows[/{id}/refreshes])
//
// Docs: https://learn.microsoft.com/rest/api/power-bi/dataflows
// ============================================================

export interface PbiDataflow {
  objectId: string;
  name: string;
  description?: string;
  modelUrl?: string;
  configuredBy?: string;
}

export async function listDataflows(workspaceId: string): Promise<PbiDataflow[]> {
  const j = await call<{ value: PbiDataflow[] }>(
    `/groups/${encodeURIComponent(workspaceId)}/dataflows`,
  );
  return j.value || [];
}

/**
 * POST /groups/{ws}/dataflows/{id}/refreshes — trigger an on-demand dataflow
 * refresh. Power BI requires the notifyOption body. 200/202 on success.
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/dataflows/refresh-dataflow
 */
export async function refreshDataflow(
  workspaceId: string,
  dataflowId: string,
  notifyOption: 'MailOnCompletion' | 'MailOnFailure' | 'NoNotification' = 'NoNotification',
): Promise<{ ok: true }> {
  await call(
    `/groups/${encodeURIComponent(workspaceId)}/dataflows/${encodeURIComponent(dataflowId)}/refreshes`,
    { method: 'POST', body: { notifyOption } },
  );
  return { ok: true };
}

/**
 * GET /groups/{ws}/dataflows/{id}/transactions — dataflow refresh history.
 * Falls back to [] on 404 so the navigator renders an honest empty state.
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/dataflows/get-dataflow-transactions
 */
export interface PbiDataflowTransaction {
  id?: string;
  refreshType?: string;
  startTime?: string;
  endTime?: string;
  status?: string;
}

export async function listDataflowTransactions(
  workspaceId: string,
  dataflowId: string,
): Promise<PbiDataflowTransaction[]> {
  try {
    const j = await call<{ value: PbiDataflowTransaction[] }>(
      `/groups/${encodeURIComponent(workspaceId)}/dataflows/${encodeURIComponent(dataflowId)}/transactions`,
    );
    return j.value || [];
  } catch (e) {
    if (e instanceof PowerBiError && (e.status === 404 || e.status === 400)) return [];
    throw e;
  }
}

export async function deleteDataflow(workspaceId: string, dataflowId: string): Promise<void> {
  await call(
    `/groups/${encodeURIComponent(workspaceId)}/dataflows/${encodeURIComponent(dataflowId)}`,
    { method: 'DELETE' },
  );
}

export async function deleteDashboard(workspaceId: string, dashboardId: string): Promise<void> {
  // Power BI exposes dashboard delete only via the admin group; the
  // user-scoped REST surface does not support DELETE on a dashboard. We keep
  // this honest: the navigator routes DELETE for dashboards to a 501 with a
  // clear message rather than pretending. (No fake success.)
  throw new PowerBiError(
    'Power BI REST does not support deleting a dashboard via the workspace API. ' +
      'Delete it from the Power BI service UI.',
    501,
    undefined,
    `/groups/${workspaceId}/dashboards/${dashboardId}`,
  );
}

// ============================================================
// Reports
// ============================================================

export async function listReports(workspaceId: string): Promise<PbiReport[]> {
  const j = await call<{ value: PbiReport[] }>(`/groups/${encodeURIComponent(workspaceId)}/reports`);
  return j.value || [];
}

export async function getReport(workspaceId: string, reportId: string): Promise<PbiReport> {
  return call<PbiReport>(`/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}`);
}

export interface PbiReportPage {
  /** Internal page name used by the embed `setPage(name)` API. */
  name: string;
  /** Friendly tab title shown in the report. */
  displayName?: string;
  order?: number;
}

/**
 * GET /groups/{ws}/reports/{id}/pages — list the report's pages so the editor
 * can render a page-navigation list and deep-link the embed via setPage(name).
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/reports/get-pages-in-group
 */
export async function getReportPages(workspaceId: string, reportId: string): Promise<PbiReportPage[]> {
  const j = await call<{ value: PbiReportPage[] }>(
    `/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}/pages`,
  );
  return j.value || [];
}

export async function cloneReport(
  workspaceId: string,
  reportId: string,
  body: { name: string; targetWorkspaceId?: string; targetModelId?: string },
): Promise<PbiReport> {
  return call<PbiReport>(`/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}/Clone`, {
    method: 'POST',
    body,
  });
}

export async function deleteReport(workspaceId: string, reportId: string): Promise<void> {
  await call(`/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}`, { method: 'DELETE' });
}

export async function listPaginatedReports(workspaceId: string): Promise<PbiReport[]> {
  const all = await listReports(workspaceId);
  return all.filter((r) => r.reportType === 'PaginatedReport');
}

// ============================================================
// Dashboards
// ============================================================

export async function listDashboards(workspaceId: string): Promise<PbiDashboard[]> {
  const j = await call<{ value: PbiDashboard[] }>(`/groups/${encodeURIComponent(workspaceId)}/dashboards`);
  return j.value || [];
}

export async function getDashboard(workspaceId: string, dashboardId: string): Promise<PbiDashboard> {
  return call<PbiDashboard>(`/groups/${encodeURIComponent(workspaceId)}/dashboards/${encodeURIComponent(dashboardId)}`);
}

export async function listDashboardTiles(workspaceId: string, dashboardId: string): Promise<PbiTile[]> {
  const j = await call<{ value: PbiTile[] }>(
    `/groups/${encodeURIComponent(workspaceId)}/dashboards/${encodeURIComponent(dashboardId)}/tiles`,
  );
  return j.value || [];
}

export async function addDashboardTile(
  workspaceId: string,
  dashboardId: string,
  body: { reportId?: string; datasetId?: string; title?: string; subTitle?: string },
): Promise<PbiTile> {
  return call<PbiTile>(
    `/groups/${encodeURIComponent(workspaceId)}/dashboards/${encodeURIComponent(dashboardId)}/tiles`,
    { method: 'POST', body },
  );
}

// ============================================================
// Datasets (semantic models in Fabric)
// ============================================================

export async function listDatasets(workspaceId: string): Promise<PbiDataset[]> {
  const j = await call<{ value: PbiDataset[] }>(`/groups/${encodeURIComponent(workspaceId)}/datasets`);
  return j.value || [];
}

export async function getDataset(workspaceId: string, datasetId: string): Promise<PbiDataset> {
  return call<PbiDataset>(`/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}`);
}

export async function listDatasetTables(workspaceId: string, datasetId: string): Promise<PbiTable[]> {
  const j = await call<{ value: PbiTable[] }>(
    `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/tables`,
  );
  return j.value || [];
}

export interface PbiRelationship {
  name?: string;
  fromTable?: string;
  fromColumn?: string;
  toTable?: string;
  toColumn?: string;
  crossFilteringBehavior?: string;
}

/**
 * GET /groups/{ws}/datasets/{id}/relationships — list the model's table
 * relationships. This IS a real Power BI REST endpoint (push-dataset
 * relationships are returned here, and imported models expose their
 * relationship graph the same way). Falls back to an empty list on 404/400 so
 * the editor renders an honest "no relationships" state rather than erroring.
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/push-datasets/datasets-post-dataset-in-group
 */
export async function listDatasetRelationships(workspaceId: string, datasetId: string): Promise<PbiRelationship[]> {
  try {
    const j = await call<{ value: PbiRelationship[] }>(
      `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/relationships`,
    );
    return j.value || [];
  } catch (e) {
    if (e instanceof PowerBiError && (e.status === 404 || e.status === 400)) return [];
    throw e;
  }
}

// ============================================================
// Push datasets (real model authoring via Power BI REST)
//
// Power BI REST genuinely supports BUILDING a semantic model — creating a
// "push" dataset with tables, typed columns, measures, and relationships —
// without the XMLA endpoint. This is the supported REST authoring path
// (Microsoft.PowerBI.Api PostDataset). Imported / Direct Lake models still
// require XMLA / Desktop for table/measure writes; that stays honestly gated.
//
// Docs: https://learn.microsoft.com/rest/api/power-bi/push-datasets/datasets-post-dataset-in-group
// ============================================================

export type PushColumnType =
  | 'Int64' | 'Double' | 'Boolean' | 'DateTime' | 'String' | 'Decimal';

export interface PushColumn {
  name: string;
  dataType: PushColumnType;
  /** Optional format string (e.g. "0.00", "yyyy-mm-dd"). */
  formatString?: string;
}

export interface PushMeasure {
  name: string;
  expression: string;
  formatString?: string;
}

export interface PushTable {
  name: string;
  columns: PushColumn[];
  measures?: PushMeasure[];
}

export interface PushRelationship {
  name: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  /** "OneDirection" (default) | "BothDirections" | "Automatic". */
  crossFilteringBehavior?: 'OneDirection' | 'BothDirections' | 'Automatic';
}

export interface CreatePushDatasetRequest {
  name: string;
  tables: PushTable[];
  relationships?: PushRelationship[];
  /** Push (default) | PushStreaming | Streaming. */
  defaultMode?: 'Push' | 'PushStreaming' | 'Streaming' | 'AsAzure' | 'AsOnPrem';
}

/**
 * POST /groups/{ws}/datasets — create a real push dataset (semantic model)
 * with tables, typed columns, measures, and relationships. Returns the new
 * dataset id. The Console UAMI must be a Member/Contributor on the workspace.
 */
export async function createPushDataset(
  workspaceId: string,
  body: CreatePushDatasetRequest,
  retentionPolicy: 'None' | 'basicFIFO' = 'None',
): Promise<{ id: string; name: string }> {
  return call<{ id: string; name: string }>(
    `/groups/${encodeURIComponent(workspaceId)}/datasets`,
    {
      method: 'POST',
      query: retentionPolicy !== 'None' ? { defaultRetentionPolicy: retentionPolicy } : undefined,
      body: {
        name: body.name,
        defaultMode: body.defaultMode || 'Push',
        tables: body.tables,
        relationships: body.relationships,
      },
    },
  );
}

/**
 * PUT /groups/{ws}/datasets/{id}/tables/{tableName} — replace a push table's
 * schema (the REST path to add/edit measures + columns on an existing push
 * dataset without XMLA).
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/push-datasets/datasets-put-table-in-group
 */
export async function putPushTable(
  workspaceId: string,
  datasetId: string,
  table: PushTable,
): Promise<{ ok: true }> {
  await call(
    `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/tables/${encodeURIComponent(table.name)}`,
    { method: 'PUT', body: { name: table.name, columns: table.columns, measures: table.measures } },
  );
  return { ok: true };
}

/**
 * POST /groups/{ws}/datasets/{id}/tables/{tableName}/rows — push rows into a
 * push table so the model is immediately queryable (real data, not a mock).
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/push-datasets/datasets-post-rows-in-group
 */
export async function postPushRows(
  workspaceId: string,
  datasetId: string,
  tableName: string,
  rows: Array<Record<string, unknown>>,
): Promise<{ ok: true }> {
  await call(
    `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/tables/${encodeURIComponent(tableName)}/rows`,
    { method: 'POST', body: { rows } },
  );
  return { ok: true };
}

export async function refreshDataset(
  workspaceId: string,
  datasetId: string,
  body?: { notifyOption?: 'MailOnCompletion' | 'MailOnFailure' | 'NoNotification' },
): Promise<{ ok: true }> {
  await call(`/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/refreshes`, {
    method: 'POST',
    body: body ?? { notifyOption: 'NoNotification' },
  });
  return { ok: true };
}

/**
 * Enhanced (asynchronous) refresh body — the rich superset of `refreshDataset`.
 * Supports commitMode, applyRefreshPolicy (drives the incremental-refresh
 * partition apply for hybrid tables), effectiveDate, partition-level targeting
 * and a timeout. Used by the semantic-model Incremental-refresh surface.
 *
 * Docs: https://learn.microsoft.com/power-bi/connect-data/asynchronous-refresh
 */
export interface EnhancedRefreshBody {
  type?: 'full' | 'clearValues' | 'calculate' | 'dataOnly' | 'automatic' | 'defragment';
  commitMode?: 'transactional' | 'partialBatch';
  maxParallelism?: number;
  retryCount?: number;
  /** Applies the incremental refresh policy when true. NOT valid with partialBatch. */
  applyRefreshPolicy?: boolean;
  /** Overrides "today" for rolling-window calculation. ISO date e.g. "2025-06-08". */
  effectiveDate?: string;
  objects?: Array<{ table: string; partition?: string }>;
  /** e.g. "02:00:00" (hh:mm:ss). */
  timeout?: string;
}

/**
 * Enhanced refresh — POST /groups/{ws}/datasets/{id}/refreshes with the full
 * async-refresh body. Returns the requestId parsed from the 202 Location header
 * so callers can poll GET /refreshes/{requestId} for status. Uses a raw fetch
 * (not `call`) because the requestId lives in the response header, not the body.
 */
export async function enhancedRefreshDataset(
  workspaceId: string,
  datasetId: string,
  body: EnhancedRefreshBody = {},
): Promise<{ requestId: string }> {
  const token = await getToken(POWERBI_SCOPE);
  const url = `${POWERBI_BASE}/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/refreshes`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ type: 'full', commitMode: 'transactional', ...body }),
    cache: 'no-store',
  });
  if (res.status !== 202) {
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
    throw new PowerBiError(
      json?.error?.message || json?.message || text || `enhancedRefresh failed ${res.status}`,
      res.status,
      json || text,
      url,
    );
  }
  const location = res.headers.get('location') || res.headers.get('Location') || '';
  const requestId = location.split('/').pop() || '';
  return { requestId };
}

export async function listRefreshHistory(
  workspaceId: string,
  datasetId: string,
  top = 25,
): Promise<PbiRefresh[]> {
  const j = await call<{ value: PbiRefresh[] }>(
    `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/refreshes`,
    { query: { $top: top } },
  );
  return j.value || [];
}

export async function getRefreshSchedule(workspaceId: string, datasetId: string): Promise<any | null> {
  try {
    return await call<any>(
      `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/refreshSchedule`,
    );
  } catch (e) {
    if (e instanceof PowerBiError && e.status === 404) return null;
    throw e;
  }
}

/**
 * RefreshSchedule write fields — the editable subset Power BI exposes via
 * PATCH /datasets/{id}/refreshSchedule. The body is wrapped in `{ value: ... }`.
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/datasets/update-refresh-schedule-in-group
 */
export interface RefreshScheduleWrite {
  enabled?: boolean;
  /** e.g. ["Sunday","Monday",...]; required by PBI when enabling. */
  days?: string[];
  /** e.g. ["07:00","12:00"]; times must be on 30-minute boundaries. */
  times?: string[];
  /** PBI tz id e.g. "UTC", "Pacific Standard Time". */
  localTimeZoneId?: string;
  notifyOption?: 'MailOnFailure' | 'NoNotification';
}

/**
 * PATCH /groups/{ws}/datasets/{id}/refreshSchedule — update the scheduled
 * refresh. Power BI 400s if `enabled:true` is sent without at least one day +
 * time; the route surfaces that verbatim. Returns nothing on success (200).
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/datasets/update-refresh-schedule-in-group
 */
export async function patchRefreshSchedule(
  workspaceId: string,
  datasetId: string,
  value: RefreshScheduleWrite,
): Promise<{ ok: true }> {
  await call(
    `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/refreshSchedule`,
    { method: 'PATCH', body: { value } },
  );
  return { ok: true };
}

/**
 * POST /groups/{ws}/datasets/{id}/Default.TakeOver — transfer dataset
 * ownership to the calling principal (the Console UAMI). Required before the
 * UAMI can edit the refresh schedule / bind credentials when another user or
 * SP currently owns the dataset.
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/datasets/take-over-in-group
 */
export async function takeOverDataset(workspaceId: string, datasetId: string): Promise<{ ok: true }> {
  await call(
    `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/Default.TakeOver`,
    { method: 'POST' },
  );
  return { ok: true };
}

// ============================================================
// Fabric Scorecards
// ============================================================

export async function listScorecards(workspaceId: string): Promise<FabricScorecard[]> {
  // Fabric Scorecard REST is under api.fabric.microsoft.com
  const j = await call<{ value: FabricScorecard[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/scorecards`,
    { api: 'fabric' },
  );
  return j.value || [];
}

export async function getScorecard(workspaceId: string, scorecardId: string): Promise<FabricScorecard> {
  return call<FabricScorecard>(
    `/workspaces/${encodeURIComponent(workspaceId)}/scorecards/${encodeURIComponent(scorecardId)}`,
    { api: 'fabric' },
  );
}

export async function listScorecardGoals(workspaceId: string, scorecardId: string): Promise<any[]> {
  try {
    const j = await call<{ value: any[] }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/scorecards/${encodeURIComponent(scorecardId)}/goals`,
      { api: 'fabric' },
    );
    return j.value || [];
  } catch (e) {
    if (e instanceof PowerBiError && (e.status === 404 || e.status === 400)) return [];
    throw e;
  }
}

export async function addScorecardGoalValue(
  workspaceId: string,
  scorecardId: string,
  goalId: string,
  body: { value: number; targetValue?: number; noteText?: string; goalValueDate?: string },
): Promise<any> {
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/scorecards/${encodeURIComponent(scorecardId)}/goals/${encodeURIComponent(goalId)}/values`,
    { api: 'fabric', method: 'POST', body },
  );
}

// ============================================================
// Token helpers (exposed for future Embed SDK token issuance)
// ============================================================

export async function getEmbedToken(
  workspaceId: string,
  body: {
    datasets?: { id: string; xmlaPermissions?: 'Off' | 'ReadOnly' }[];
    reports?: { id: string; allowEdit?: boolean }[];
    targetWorkspaces?: { id: string }[];
    accessLevel?: 'View' | 'Edit' | 'Create';
  },
): Promise<{ token: string; tokenId: string; expiration: string }> {
  return call<{ token: string; tokenId: string; expiration: string }>(
    '/GenerateToken',
    { method: 'POST', body: { ...body, datasets: body.datasets, reports: body.reports } },
  );
}

/**
 * Per-item GenerateToken (preferred over the workspace-scoped one above
 * when embedding a single report or dashboard — narrower scope, lower
 * blast radius if the token leaks).
 */
export async function generateReportEmbedToken(
  workspaceId: string,
  reportId: string,
  accessLevel: 'View' | 'Edit' = 'View',
): Promise<{ token: string; tokenId: string; expiration: string }> {
  return call(
    `/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}/GenerateToken`,
    { method: 'POST', body: { accessLevel } },
  );
}

/**
 * Embed token for a **paginated report** (RDL). Unlike standard Power BI
 * reports, paginated reports may reference one or more Power BI semantic
 * models as data sources, so the embed token must be minted with the
 * MULTI-RESOURCE `POST /v1.0/myorg/GenerateToken` (not the per-report
 * `/reports/{id}/GenerateToken`). Per Microsoft Learn the request must:
 *   - list the report under `reports[]` with `allowEdit: false`
 *     (paginated reports cannot be edited via the embed SDK), and
 *   - list every referenced Power BI semantic model under `datasets[]` with
 *     `xmlaPermissions: 'ReadOnly'` so the token grants read access to the
 *     bound model without write/XMLA rights.
 *
 * The Console UAMI must be a **Member or above** in the workspace for
 * GenerateToken to succeed for paginated content.
 *
 * Docs:
 *   https://learn.microsoft.com/power-bi/developer/embedded/embed-paginated-reports-customers
 *   https://learn.microsoft.com/rest/api/power-bi/embed-token/generate-token
 */
export async function generatePaginatedReportEmbedToken(
  reportId: string,
  datasetIds: string[] = [],
): Promise<{ token: string; tokenId: string; expiration: string }> {
  return getEmbedToken('', {
    reports: [{ id: reportId, allowEdit: false }],
    datasets: datasetIds.filter(Boolean).map((id) => ({ id, xmlaPermissions: 'ReadOnly' })),
  });
}

export async function generateDashboardEmbedToken(
  workspaceId: string,
  dashboardId: string,
  accessLevel: 'View' | 'Edit' = 'View',
): Promise<{ token: string; tokenId: string; expiration: string }> {
  return call(
    `/groups/${encodeURIComponent(workspaceId)}/dashboards/${encodeURIComponent(dashboardId)}/GenerateToken`,
    { method: 'POST', body: { accessLevel } },
  );
}

export async function generateTileEmbedToken(
  workspaceId: string,
  dashboardId: string,
  tileId: string,
  accessLevel: 'View' | 'Edit' = 'View',
): Promise<{ token: string; tokenId: string; expiration: string }> {
  return call(
    `/groups/${encodeURIComponent(workspaceId)}/dashboards/${encodeURIComponent(dashboardId)}/tiles/${encodeURIComponent(tileId)}/GenerateToken`,
    { method: 'POST', body: { accessLevel } },
  );
}

export async function generateDatasetEmbedToken(
  workspaceId: string,
  datasetId: string,
  accessLevel: 'View' | 'Edit' = 'View',
): Promise<{ token: string; tokenId: string; expiration: string }> {
  return call(
    `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/GenerateToken`,
    { method: 'POST', body: { accessLevel } },
  );
}

/**
 * ExecuteQueries — POST /v1.0/myorg/groups/{ws}/datasets/{id}/executeQueries
 *
 * Runs a DAX query against the dataset and returns the result tables. We use
 * this to validate a candidate DAX measure expression server-side (compiles
 * it via `DEFINE MEASURE` and evaluates a single-row probe). Persistence of
 * new measures requires the XMLA endpoint (a paid Premium / Fabric capacity
 * feature) or Power BI Desktop — the editor surfaces this honestly via
 * MessageBar rather than pretending Save persists.
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/datasets/execute-queries
 */
export async function executeDatasetQueries(
  workspaceId: string,
  datasetId: string,
  daxQuery: string,
): Promise<{
  results: Array<{
    tables: Array<{ rows: Array<Record<string, unknown>> }>;
  }>;
}> {
  return call(
    `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/executeQueries`,
    { method: 'POST', body: { queries: [{ query: daxQuery }], serializerSettings: { includeNulls: true } } },
  );
}

// ============================================================
// Export to file (async ExportTo job)
// ============================================================
//
// Power BI report export is a 3-step async job:
//   1. POST /reports/{id}/ExportTo            -> { id, status: 'Running' }
//   2. GET  /reports/{id}/exports/{exportId}  -> poll until 'Succeeded'
//   3. GET  /reports/{id}/exports/{exportId}/file -> binary (PDF/PPTX/PNG)
//
// Docs: https://learn.microsoft.com/rest/api/power-bi/reports/export-to-file-in-group
//
// All three steps are groupId-scoped (per the PowerBIEntityNotFound fix).

/**
 * Standard Power BI report export formats (PowerBIReport ExportTo). Paginated
 * reports support a wider set via `PaginatedExportFormat`.
 */
export type ExportFormat = 'PDF' | 'PPTX' | 'PNG';

/**
 * Paginated-report (RDL) export formats. The Power BI `ExportTo` REST renders
 * paginated reports through the SSRS rendering extensions, which support PDF,
 * Word (DOCX), Excel (XLSX), PowerPoint (PPTX), CSV, XML, MHTML and image
 * formats. Verified against Microsoft Learn
 * (power-bi/developer/embedded/export-paginated-report).
 */
export type PaginatedExportFormat = 'PDF' | 'DOCX' | 'XLSX' | 'PPTX' | 'CSV' | 'XML' | 'MHTML' | 'IMAGE';

export interface ExportJob {
  id: string;
  status: 'NotStarted' | 'Running' | 'Succeeded' | 'Failed' | 'Undefined';
  percentComplete?: number;
  reportId?: string;
  error?: { message?: string };
  resourceFileExtension?: string;
}

/** Step 1 — queue an export job. Returns the export job id + initial status. */
export async function startReportExport(
  workspaceId: string,
  reportId: string,
  format: ExportFormat,
): Promise<ExportJob> {
  return call<ExportJob>(
    `/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}/ExportTo`,
    { method: 'POST', body: { format } },
  );
}

/**
 * Step 1 (paginated) — queue an export job for a **paginated report** (RDL).
 * Same `ExportTo` endpoint as standard reports, but the request body must carry
 * a `paginatedReportConfiguration` object (even if empty) so Power BI routes the
 * job through the SSRS rendering engine. Optional report parameters are passed
 * as `parameterValues` (the `rp:` parameter bar values). Verified against
 * Microsoft Learn (power-bi/developer/embedded/export-paginated-report).
 */
export async function startPaginatedReportExport(
  workspaceId: string,
  reportId: string,
  format: PaginatedExportFormat,
  parameterValues: Array<{ name: string; value: string }> = [],
): Promise<ExportJob> {
  return call<ExportJob>(
    `/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}/ExportTo`,
    {
      method: 'POST',
      body: {
        format,
        paginatedReportConfiguration: {
          formatSettings: {},
          ...(parameterValues.length ? { parameterValues } : {}),
        },
      },
    },
  );
}

/** Step 2 — poll a queued export job. */
export async function getReportExportStatus(
  workspaceId: string,
  reportId: string,
  exportId: string,
): Promise<ExportJob> {
  return call<ExportJob>(
    `/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}/exports/${encodeURIComponent(exportId)}`,
  );
}

/**
 * Step 3 — download the finished file as raw bytes. Uses a direct fetch
 * (not the JSON `call` helper) because the response body is binary.
 */
export async function getReportExportFile(
  workspaceId: string,
  reportId: string,
  exportId: string,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const token = await getToken(POWERBI_SCOPE);
  const url = `${POWERBI_BASE}/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}/exports/${encodeURIComponent(exportId)}/file`;
  const res = await fetchWithTimeout(url, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new PowerBiError(text || `export file download failed (${res.status})`, res.status, text, url);
  }
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const bytes = await res.arrayBuffer();
  return { bytes, contentType };
}

/**
 * CloneTile — POST /v1.0/myorg/groups/{ws}/dashboards/{id}/tiles/{tile}/Clone
 * Validator's recommended Dashboard editor uplift.
 */
export async function cloneDashboardTile(
  workspaceId: string,
  dashboardId: string,
  tileId: string,
  body: { targetDashboardId: string; targetWorkspaceId?: string; targetReportId?: string; targetModelId?: string },
): Promise<unknown> {
  return call(
    `/groups/${encodeURIComponent(workspaceId)}/dashboards/${encodeURIComponent(dashboardId)}/tiles/${encodeURIComponent(tileId)}/Clone`,
    { method: 'POST', body },
  );
}

// ============================================================
// Workspace access — Group Users (the REAL Power BI workspace ACL)
//
// This is the canonical "Manage access" surface on a Power BI workspace, NOT
// the Loom-native Cosmos roles. Members are added/updated/removed with one of
// the four Power BI workspace roles (Admin / Member / Contributor / Viewer).
//
// Docs:
//   GET    /groups/{ws}/users                 (Groups - Get Group Users In Group)
//   POST   /groups/{ws}/users  { groupUserAccessRight, identifier, principalType }
//          (Groups - Add Group User)
//   PUT    /groups/{ws}/users  { groupUserAccessRight, identifier, principalType }
//          (Groups - Update Group User)
//   DELETE /groups/{ws}/users/{user}          (Groups - Delete User In Group)
//   https://learn.microsoft.com/rest/api/power-bi/groups/add-group-user
//   https://learn.microsoft.com/rest/api/power-bi/groups/update-group-user
//   https://learn.microsoft.com/rest/api/power-bi/groups/delete-user-in-group
// ============================================================

/** The four Power BI workspace roles (GroupUserAccessRight). */
export type GroupUserAccessRight = 'Admin' | 'Member' | 'Contributor' | 'Viewer' | 'None';
export type PbiPrincipalType = 'User' | 'Group' | 'App' | 'None';

export interface PbiGroupUser {
  /** Email (for users) or object id (for apps/groups). The DELETE key. */
  identifier?: string;
  /** Email address of a user principal, when present. */
  emailAddress?: string;
  displayName?: string;
  groupUserAccessRight?: GroupUserAccessRight;
  principalType?: PbiPrincipalType;
  graphId?: string;
}

export async function listGroupUsers(workspaceId: string): Promise<PbiGroupUser[]> {
  const j = await call<{ value: PbiGroupUser[] }>(
    `/groups/${encodeURIComponent(workspaceId)}/users`,
  );
  return j.value || [];
}

/**
 * POST /groups/{ws}/users — add a principal to the workspace at the given role.
 * `identifier` is the user's email (User), or the object id (Group / App / SP).
 */
export async function addGroupUser(
  workspaceId: string,
  user: { identifier: string; groupUserAccessRight: GroupUserAccessRight; principalType?: PbiPrincipalType },
): Promise<{ ok: true }> {
  await call(
    `/groups/${encodeURIComponent(workspaceId)}/users`,
    {
      method: 'POST',
      body: {
        identifier: user.identifier,
        groupUserAccessRight: user.groupUserAccessRight,
        principalType: user.principalType || 'User',
      },
    },
  );
  return { ok: true };
}

/**
 * PUT /groups/{ws}/users — change an existing principal's workspace role. Same
 * body shape as AddGroupUser; Power BI matches on `identifier`.
 */
export async function updateGroupUser(
  workspaceId: string,
  user: { identifier: string; groupUserAccessRight: GroupUserAccessRight; principalType?: PbiPrincipalType },
): Promise<{ ok: true }> {
  await call(
    `/groups/${encodeURIComponent(workspaceId)}/users`,
    {
      method: 'PUT',
      body: {
        identifier: user.identifier,
        groupUserAccessRight: user.groupUserAccessRight,
        principalType: user.principalType || 'User',
      },
    },
  );
  return { ok: true };
}

/**
 * DELETE /groups/{ws}/users/{user} — remove a principal from the workspace.
 * `user` is the identifier (email for users; object id for apps/groups).
 */
export async function deleteGroupUser(workspaceId: string, user: string): Promise<{ ok: true }> {
  await call(
    `/groups/${encodeURIComponent(workspaceId)}/users/${encodeURIComponent(user)}`,
    { method: 'DELETE' },
  );
  return { ok: true };
}

// ============================================================
// Endorsement (Promote / Certify)
//
// READ: the Fabric Items REST returns an item's current endorsement —
//   GET /v1/workspaces/{ws}/items/{id}  → { endorsement: { endorsementStatus, certifiedBy } }
//   https://learn.microsoft.com/rest/api/fabric/core/items/get-item
//
// WRITE: setting endorsement programmatically is a Power BI **Admin** REST
// operation (requires Tenant.ReadWrite.All / a Fabric admin SP):
//   PUT /admin/groups/{ws}/datasets/{id}  { endorsementDetails: { endorsement, certifiedBy } }
//   PUT /admin/groups/{ws}/reports/{id}   { endorsementDetails: { endorsement, certifiedBy } }
//   EndorsementDetails(endorsement, certifiedBy):
//   https://learn.microsoft.com/dotnet/api/microsoft.powerbi.api.models.endorsementdetails.-ctor
//
// Power BI dashboards cannot be endorsed (per the endorsement overview), so we
// only expose this for datasets / reports / dataflows. When the SP isn't a
// tenant admin the PUT returns 401/403 and the route surfaces it as an honest
// gate (the UI still renders the read-only current endorsement + control).
// ============================================================

export type EndorsementStatus = 'None' | 'Promoted' | 'Certified';

export interface ItemEndorsement {
  endorsementStatus: EndorsementStatus;
  certifiedBy?: string;
}

/**
 * GET /v1/workspaces/{ws}/items/{id} (Fabric) — read the live endorsement badge
 * for any Fabric/Power BI item. Returns { endorsementStatus:'None' } when the
 * item has no endorsement object or the Fabric items API isn't reachable for it.
 */
export async function getItemEndorsement(workspaceId: string, itemId: string): Promise<ItemEndorsement> {
  try {
    const j = await call<{ endorsement?: { endorsementStatus?: string; certifiedBy?: string } }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}`,
      { api: 'fabric' },
    );
    const e = j.endorsement;
    return {
      endorsementStatus: (e?.endorsementStatus as EndorsementStatus) || 'None',
      certifiedBy: e?.certifiedBy,
    };
  } catch (e) {
    if (e instanceof PowerBiError && (e.status === 404 || e.status === 400)) {
      return { endorsementStatus: 'None' };
    }
    throw e;
  }
}

/**
 * PUT /admin/groups/{ws}/datasets|reports/{id} — set endorsement on a dataset
 * or report via the Power BI Admin REST. `certifiedBy` is required by Power BI
 * when endorsement === 'Certified' (the certifier UPN). Sending
 * endorsement:'None' clears the badge.
 *
 * Requires the calling SP to be a Power BI / Fabric **admin**; otherwise PBI
 * returns 401/403 which the route surfaces as an honest admin-gate.
 */
export async function setItemEndorsement(
  workspaceId: string,
  itemType: 'datasets' | 'reports' | 'dataflows',
  itemId: string,
  endorsement: EndorsementStatus,
  certifiedBy?: string,
): Promise<{ ok: true }> {
  await call(
    `/admin/groups/${encodeURIComponent(workspaceId)}/${itemType}/${encodeURIComponent(itemId)}`,
    {
      method: 'PUT',
      body: {
        endorsementDetails: {
          endorsement,
          certifiedBy: endorsement === 'Certified' ? (certifiedBy || '') : undefined,
        },
      },
    },
  );
  return { ok: true };
}

// ============================================================
// Semantic-model gateway binding + data-source credentials
//
//   GET  /groups/{ws}/datasets/{id}/datasources          (cloud data sources)
//   GET  /groups/{ws}/datasets/{id}/Default.GetBoundGatewayDatasources
//        (gateway data sources the model is bound to)
//   GET  /groups/{ws}/datasets/{id}/Default.DiscoverGateways
//        (gateways the caller could bind the model to)
//   POST /groups/{ws}/datasets/{id}/Default.BindToGateway  { gatewayObjectId, datasourceObjectIds? }
//   POST /groups/{ws}/datasets/{id}/Default.UpdateDatasources { updateDetails: [...] }
//
// Docs:
//   https://learn.microsoft.com/rest/api/power-bi/datasets/get-datasources-in-group
//   https://learn.microsoft.com/rest/api/power-bi/datasets/get-gateway-datasources-in-group
//   https://learn.microsoft.com/rest/api/power-bi/datasets/discover-gateways-in-group
//   https://learn.microsoft.com/rest/api/power-bi/datasets/bind-to-gateway-in-group
//   https://learn.microsoft.com/rest/api/power-bi/datasets/update-datasources-in-group
// ============================================================

export interface PbiDatasource {
  datasourceType?: string;
  datasourceId?: string;
  gatewayId?: string;
  connectionDetails?: { server?: string; database?: string; url?: string; path?: string };
  name?: string;
}

export interface PbiGateway {
  id: string;
  name?: string;
  type?: string;
  gatewayStatus?: string;
}

/** GET cloud data sources for the model (no gateway). */
export async function getDatasetDatasources(workspaceId: string, datasetId: string): Promise<PbiDatasource[]> {
  try {
    const j = await call<{ value: PbiDatasource[] }>(
      `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/datasources`,
    );
    return j.value || [];
  } catch (e) {
    if (e instanceof PowerBiError && (e.status === 404 || e.status === 400)) return [];
    throw e;
  }
}

/** GET the gateway data sources the model is currently bound to. */
export async function getBoundGatewayDatasources(workspaceId: string, datasetId: string): Promise<PbiDatasource[]> {
  try {
    const j = await call<{ value: PbiDatasource[] }>(
      `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/Default.GetBoundGatewayDatasources`,
    );
    return j.value || [];
  } catch (e) {
    if (e instanceof PowerBiError && (e.status === 404 || e.status === 400)) return [];
    throw e;
  }
}

/** GET gateways the caller could bind this model to. */
export async function discoverGateways(workspaceId: string, datasetId: string): Promise<PbiGateway[]> {
  try {
    const j = await call<{ value: PbiGateway[] }>(
      `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/Default.DiscoverGateways`,
    );
    return j.value || [];
  } catch (e) {
    if (e instanceof PowerBiError && (e.status === 404 || e.status === 400)) return [];
    throw e;
  }
}

/**
 * POST .../Default.BindToGateway — bind the model to a gateway. Optionally pass
 * the gateway data-source object ids to map (otherwise PBI auto-maps matching
 * sources).
 */
export async function bindToGateway(
  workspaceId: string,
  datasetId: string,
  gatewayObjectId: string,
  datasourceObjectIds?: string[],
): Promise<{ ok: true }> {
  await call(
    `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/Default.BindToGateway`,
    {
      method: 'POST',
      body: {
        gatewayObjectId,
        datasourceObjectIds: datasourceObjectIds && datasourceObjectIds.length ? datasourceObjectIds : undefined,
      },
    },
  );
  return { ok: true };
}

export interface UpdateDatasourceDetail {
  /** The current connection to match (server/database/url/path). */
  datasourceSelector: { datasourceType: string; connectionDetails: Record<string, string> };
  /** The new connection to set. */
  connectionDetails: Record<string, string>;
}

/**
 * POST .../Default.UpdateDatasources — repoint the model's data source(s) to a
 * new server/database (the supported REST path to change connection details).
 * Note: this changes the *connection*, not credentials; credential set is the
 * gateway/cloud-connection Update Datasource API which needs an encrypted
 * credential payload — surfaced honestly in the UI.
 */
export async function updateDatasetDatasources(
  workspaceId: string,
  datasetId: string,
  updateDetails: UpdateDatasourceDetail[],
): Promise<{ ok: true }> {
  await call(
    `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/Default.UpdateDatasources`,
    { method: 'POST', body: { updateDetails } },
  );
  return { ok: true };
}

// ============================================================
// Information Protection — bulk set sensitivity labels (Admin)
//
//   POST /v1.0/myorg/admin/informationprotection/setLabels
//   body: { artifacts: { dashboards?, reports?, datasets?, dataflows? },
//           labelId, assignmentMethod?, delegatedUser? }
//
// labelId MUST be a real Microsoft Information Protection (MIP) label GUID
// (from Graph /security/informationProtection/sensitivityLabels), NOT a
// Loom-native label id. The calling principal (Console UAMI) must be a
// **Fabric Administrator** in the tenant.
//
// Limits (per the API docs): max 25 requests/hour, up to 2000 artifacts per
// request. The response reports a per-artifact ChangeLabelStatus.
//
// Docs: https://learn.microsoft.com/rest/api/power-bi/admin/information-protection-set-labels-as-admin
// ============================================================

export type PbiArtifactType = 'reports' | 'datasets' | 'dashboards' | 'dataflows';

export interface PbiSetLabelArtifacts {
  dashboards?: { id: string }[];
  reports?: { id: string }[];
  datasets?: { id: string }[];
  dataflows?: { id: string }[];
}

/** Per-artifact status values per the API spec. */
export type PbiLabelChangeStatus =
  | 'Succeeded'
  | 'Failed'
  | 'NotFound'
  | 'InsufficientUsageRights'
  | 'FailedToGetUsageRights';

export interface PbiLabelChangeResult {
  id: string;
  status: PbiLabelChangeStatus;
}

export interface PbiSetLabelsResponse {
  dashboards?: PbiLabelChangeResult[];
  reports?: PbiLabelChangeResult[];
  datasets?: PbiLabelChangeResult[];
  dataflows?: PbiLabelChangeResult[];
}

/**
 * POST /admin/informationprotection/setLabels — set a sensitivity label on
 * Power BI items in bulk. `labelId` must be a real MIP GUID. Requires the
 * Console UAMI to be a Fabric Administrator; otherwise Power BI returns
 * 401/403 which the route surfaces as an honest admin-gate.
 */
export async function setLabelsAsAdmin(
  artifacts: PbiSetLabelArtifacts,
  labelId: string,
  assignmentMethod: 'Standard' | 'Priviledged' = 'Standard',
  delegatedUser?: { emailAddress: string },
): Promise<PbiSetLabelsResponse> {
  if (!labelId) throw new PowerBiError('labelId (MIP label GUID) is required', 400);
  return call<PbiSetLabelsResponse>(
    '/admin/informationprotection/setLabels',
    {
      method: 'POST',
      body: {
        artifacts,
        labelId,
        assignmentMethod,
        ...(delegatedUser ? { delegatedUser } : {}),
      },
    },
  );
}

// ============================================================
// Calculation Groups + Field Parameters — TMSL shapes
//
// These types are shared by the BFF model route, the semantic-model
// provisioner, the aas-client TMSL builders, and the SemanticModelEditor UI.
// They mirror the TMSL / TOM object model exactly:
//   https://learn.microsoft.com/analysis-services/tabular-models/calculation-groups
//   https://learn.microsoft.com/power-bi/create-reports/power-bi-field-parameters
// ============================================================

export interface TmslCalcItem {
  /** Calculation item name (becomes a slicer value, e.g. "YTD"). */
  name: string;
  /** DAX expression using SELECTEDMEASURE(). */
  expression: string;
  /** Optional dynamic format-string DAX (e.g. SELECTEDMEASUREFORMATSTRING()). */
  formatStringDefinition?: string;
  /** Display order (-1 = unordered, sorts by name). */
  ordinal?: number;
}

export interface TmslCalcGroup {
  /** Table name that also becomes the slicer column users see. */
  name: string;
  /** Integer precedence — higher = applied outermost when groups nest. */
  precedence: number;
  /** The calculation items in this group. */
  items: TmslCalcItem[];
}

export interface FieldParamEntry {
  /** Friendly label shown in the slicer (e.g. "Total Sales"). */
  displayName: string;
  /** NAMEOF-ready reference: 'Table'[Column] or 'Table'[Measure]. */
  fieldRef: string;
  /** Sort order of this entry in the parameter table. */
  order: number;
}

export interface FieldParamDef {
  /** Calculated-table name. Appears in the Fields pane + drives a slicer. */
  name: string;
  /** The fields the reader can switch between. */
  fields: FieldParamEntry[];
}

/** Request body for POST /api/items/semantic-model/{id}/model. */
export interface ModelWriteRequest {
  calculationGroups?: TmslCalcGroup[];
  fieldParameters?: FieldParamDef[];
}

// ============================================================
// Fabric Semantic Model Definition (opt-in path only — no-fabric-dependency.md)
//   GET  /v1/workspaces/{ws}/semanticModels/{id}/definition
//   POST /v1/workspaces/{ws}/semanticModels/{id}/updateDefinition
// Only reached when LOOM_SEMANTIC_BACKEND=fabric + a bound workspace.
//   https://learn.microsoft.com/rest/api/fabric/semanticmodel/items/update-semantic-model-definition
// ============================================================

export interface FabricDefinitionPart {
  path: string;
  /** base64-encoded payload. */
  payload: string;
  payloadType: 'InlineBase64';
}

/** Read the current TMSL/TMDL definition parts of a Fabric semantic model. */
export async function getFabricModelDefinition(
  workspaceId: string,
  modelId: string,
  format: 'TMSL' | 'TMDL' = 'TMSL',
): Promise<{ definition: { parts: FabricDefinitionPart[] } }> {
  return call<{ definition: { parts: FabricDefinitionPart[] } }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/semanticModels/${encodeURIComponent(modelId)}/getDefinition`,
    { api: 'fabric', method: 'POST', query: { format } },
  );
}

/** Replace the definition parts of a Fabric semantic model (full TMSL push). */
export async function updateFabricModelDefinition(
  workspaceId: string,
  modelId: string,
  parts: FabricDefinitionPart[],
): Promise<{ ok: true }> {
  await call(
    `/workspaces/${encodeURIComponent(workspaceId)}/semanticModels/${encodeURIComponent(modelId)}/updateDefinition`,
    { api: 'fabric', method: 'POST', body: { definition: { parts } } },
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Paginated-report (RDL) support: download an RDL definition from a Power BI
// workspace report via the REST /Export endpoint. STRICTLY OPT-IN — only used
// when the paginated-report backend is explicitly 'powerbi'/'fabric' with a
// bound workspace+report (no-fabric-dependency.md). The Azure-native default
// renderer path never calls this.
// ---------------------------------------------------------------------------
export async function downloadReportDefinition(workspaceId: string, reportId: string): Promise<string> {
  const token = await getToken(POWERBI_SCOPE);
  const url = `${POWERBI_BASE}/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}/Export`;
  const res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new PowerBiError(text || `rdl download failed (${res.status})`, res.status, text, url);
  }
  return res.text();
}
