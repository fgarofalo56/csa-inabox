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

import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

const POWERBI_BASE = process.env.LOOM_POWERBI_BASE || 'https://api.powerbi.com/v1.0/myorg';
const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';

const POWERBI_SCOPE = 'https://analysis.windows.net/powerbi/api/.default';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
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
  const res = await fetch(url, {
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
// Workspaces (groups)
// ============================================================

export async function listWorkspaces(): Promise<PbiWorkspace[]> {
  const j = await call<{ value: PbiWorkspace[] }>('/groups');
  return j.value || [];
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
    datasets?: { id: string }[];
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

export type ExportFormat = 'PDF' | 'PPTX' | 'PNG';

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
  const res = await fetch(url, {
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
