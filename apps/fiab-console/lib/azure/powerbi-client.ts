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

export async function listDatasetRelationships(workspaceId: string, datasetId: string): Promise<any[]> {
  // /datasets/{id}/relationships is not supported in Power BI REST; surface the
  // model via /datasets/{id}/sources for now. Editors render whatever this returns.
  try {
    const j = await call<{ value: any[] }>(
      `/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/datasources`,
    );
    return j.value || [];
  } catch {
    return [];
  }
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
