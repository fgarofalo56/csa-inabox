/**
 * Azure Monitor observability client — the real backend behind the Loom
 * /monitor surface. Calls live Azure REST only; no mocks, no sample data.
 *
 * Surfaces (each maps to a Monitor tab):
 *   - Resource inventory: ARM "list resources in RG" across the Loom RGs.
 *   - Resource health:    Microsoft.ResourceHealth availabilityStatuses
 *                         (per-subscription list).
 *   - Metrics:            Azure Monitor metrics REST
 *                         (GET .../providers/microsoft.insights/metrics).
 *   - Logs (KQL):         Log Analytics query API
 *                         (POST https://api.loganalytics.azure.com/v1/workspaces/{id}/query).
 *   - Activity log:       ARM Activity Log REST
 *                         (GET .../Microsoft.Insights/eventtypes/management/values).
 *   - Alerts:             Azure Monitor metricAlerts list
 *                         (GET .../Microsoft.Insights/metricAlerts).
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential), identical to
 * every other Loom ARM client. The UAMI needs "Monitoring Reader" on the
 * Loom subscription/RGs (and "Log Analytics Reader" on the LA workspace) to
 * read metrics, activity log, resource health, and run KQL. When the
 * Log-Analytics workspace id isn't configured, the logs section returns an
 * honest gate naming the exact env var to set; the rest of the surface
 * still renders.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

const ARM = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';
const LA_ENDPOINT = process.env.LOOM_LOG_ANALYTICS_ENDPOINT || 'https://api.loganalytics.azure.com';
const LA_SCOPE = `${LA_ENDPOINT}/.default`;

// API versions (stable unless noted).
const ARM_RESOURCES_API = '2021-04-01';
const METRICS_API = '2023-10-01';
const ACTIVITY_LOG_API = '2015-04-01';
const RESOURCE_HEALTH_API = '2023-10-01-preview';
const METRIC_ALERTS_API = '2018-03-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class MonitorError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'MonitorError';
    this.status = status;
    this.body = body;
  }
}

export class MonitorNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`Monitor not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'MonitorNotConfiguredError';
  }
}

// ----------------------------------------------------------------------------
// config
// ----------------------------------------------------------------------------

export interface MonitorConfig {
  subscriptionId: string;
  /** Distinct RGs the Loom platform deploys into. */
  resourceGroups: string[];
}

/** Read the subscription + the set of Loom resource groups from env. */
export function readMonitorConfig(): MonitorConfig {
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID || '';
  if (!subscriptionId) throw new MonitorNotConfiguredError(['LOOM_SUBSCRIPTION_ID']);
  const rgs = new Set<string>();
  for (const v of [
    process.env.LOOM_ADMIN_RG,
    process.env.LOOM_ACA_RG,
    process.env.LOOM_DLZ_RG,
    process.env.LOOM_AI_SEARCH_RG,
    process.env.LOOM_KUSTO_RG,
    process.env.LOOM_APIM_RG,
    process.env.LOOM_FOUNDRY_RG,
    process.env.LOOM_AOAI_RG,
  ]) {
    if (v && v.trim()) rgs.add(v.trim());
  }
  if (rgs.size === 0) throw new MonitorNotConfiguredError(['LOOM_ADMIN_RG (or any Loom *_RG)']);
  return { subscriptionId, resourceGroups: Array.from(rgs) };
}

/** Log Analytics workspace GUID, or null when unconfigured (→ honest gate). */
export function logAnalyticsWorkspaceId(): string | null {
  const v = process.env.LOOM_LOG_ANALYTICS_WORKSPACE_ID;
  return v && v.trim() ? v.trim() : null;
}

// ----------------------------------------------------------------------------
// token + fetch helpers
// ----------------------------------------------------------------------------

async function token(scope: string): Promise<string> {
  const t = await credential.getToken(scope);
  if (!t?.token) throw new MonitorError(`Failed to acquire token for ${scope}`, 401);
  return t.token;
}

async function armGet(path: string): Promise<any> {
  const tk = await token(ARM_SCOPE);
  const url = path.startsWith('http') ? path : `${ARM}${path}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${tk}`, accept: 'application/json' },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || text || `ARM GET failed (${res.status})`).toString();
    throw new MonitorError(msg, res.status, json || text);
  }
  return json;
}

async function armPut(path: string, body: unknown): Promise<any> {
  const tk = await token(ARM_SCOPE);
  const url = path.startsWith('http') ? path : `${ARM}${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tk}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || text || `ARM PUT failed (${res.status})`).toString();
    throw new MonitorError(msg, res.status, json || text);
  }
  return json;
}

// ----------------------------------------------------------------------------
// 1) Resource inventory — ARM list resources across the Loom RGs
// ----------------------------------------------------------------------------

export interface LoomResource {
  id: string;
  name: string;
  type: string;
  location: string;
  resourceGroup: string;
  kind?: string;
  sku?: string;
}

function rgFromId(id: string): string {
  const m = /\/resourceGroups\/([^/]+)/i.exec(id);
  return m ? m[1] : '';
}

/** List every Azure resource the Loom platform deployed across its RGs. */
export async function listResources(): Promise<LoomResource[]> {
  const cfg = readMonitorConfig();
  const all: LoomResource[] = [];
  await Promise.all(
    cfg.resourceGroups.map(async (rg) => {
      const j = await armGet(
        `/subscriptions/${cfg.subscriptionId}/resourceGroups/${rg}/resources?api-version=${ARM_RESOURCES_API}`,
      );
      for (const r of j?.value || []) {
        all.push({
          id: r.id,
          name: r.name,
          type: r.type,
          location: r.location,
          resourceGroup: rgFromId(r.id) || rg,
          kind: r.kind,
          sku: r.sku?.name,
        });
      }
    }),
  );
  // Stable sort by type then name for a predictable inventory grid.
  all.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type)));
  return all;
}

// ----------------------------------------------------------------------------
// 2) Resource health — Microsoft.ResourceHealth availabilityStatuses
// ----------------------------------------------------------------------------

export interface ResourceHealthStatus {
  resourceId: string;
  availabilityState: string; // Available | Unavailable | Degraded | Unknown
  summary?: string;
  reasonType?: string;
  occurredTime?: string;
}

/**
 * Current availability status for every resource in the subscription.
 * ResourceHealth only emits statuses for resource types it monitors; we
 * key results by resourceId so the inventory grid can join on them.
 */
export async function listResourceHealth(): Promise<Record<string, ResourceHealthStatus>> {
  const cfg = readMonitorConfig();
  const out: Record<string, ResourceHealthStatus> = {};
  let next: string | null =
    `/subscriptions/${cfg.subscriptionId}/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=${RESOURCE_HEALTH_API}`;
  let guard = 0;
  while (next && guard < 20) {
    guard++;
    const j: any = await armGet(next);
    for (const s of j?.value || []) {
      const props = s?.properties || {};
      // availabilityStatuses id looks like {resourceId}/providers/Microsoft.ResourceHealth/availabilityStatuses/current
      const resourceId = (s?.id || '').replace(
        /\/providers\/Microsoft\.ResourceHealth\/availabilityStatuses\/.*/i,
        '',
      );
      out[resourceId.toLowerCase()] = {
        resourceId,
        availabilityState: props.availabilityState || 'Unknown',
        summary: props.summary,
        reasonType: props.reasonType,
        occurredTime: props.occurredTime,
      };
    }
    next = j?.nextLink || null;
  }
  return out;
}

// ----------------------------------------------------------------------------
// 3) Metrics — Azure Monitor metrics REST
// ----------------------------------------------------------------------------

export interface MetricSeriesPoint {
  timeStamp: string;
  value: number | null;
}

export interface MetricResult {
  name: string;
  unit: string;
  aggregation: string;
  points: MetricSeriesPoint[];
}

export interface FetchMetricsOpts {
  resourceId: string;
  metricNames: string[];
  /** ISO duration window e.g. PT1H, P1D. Defaults to PT6H. */
  timespan?: string;
  /** ISO grain e.g. PT5M, PT1H. Defaults to PT15M. */
  interval?: string;
  /** Average | Total | Count | Minimum | Maximum. Defaults to Average. */
  aggregation?: string;
}

/**
 * Read platform metric time-series for one resource. The default
 * aggregation column is picked from the response per metric.
 */
export async function fetchMetrics(opts: FetchMetricsOpts): Promise<MetricResult[]> {
  if (!opts.resourceId) throw new MonitorError('resourceId required', 400);
  if (!opts.metricNames?.length) throw new MonitorError('metricNames required', 400);
  const aggregation = opts.aggregation || 'Average';
  const timespanIso = opts.timespan || 'PT6H';
  const interval = opts.interval || 'PT15M';
  // timespan param needs start/end; convert ISO duration → window ending now.
  const end = new Date();
  const start = new Date(end.getTime() - isoDurationMs(timespanIso));
  const timespan = `${start.toISOString()}/${end.toISOString()}`;

  const qs = new URLSearchParams({
    'api-version': METRICS_API,
    metricnames: opts.metricNames.join(','),
    aggregation,
    timespan,
    interval,
  });
  const j = await armGet(`${opts.resourceId}/providers/microsoft.insights/metrics?${qs.toString()}`);
  const results: MetricResult[] = [];
  for (const m of j?.value || []) {
    const series = m?.timeseries?.[0]?.data || [];
    const aggKey = aggregation.toLowerCase();
    results.push({
      name: m?.name?.value || m?.name || '',
      unit: m?.unit || '',
      aggregation,
      points: series.map((d: any) => ({
        timeStamp: d.timeStamp,
        value: typeof d[aggKey] === 'number' ? d[aggKey] : null,
      })),
    });
  }
  return results;
}

/** Minimal ISO-8601 duration → milliseconds (supports PnDTnHnMnS / PTnHnM). */
export function isoDurationMs(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso.trim());
  if (!m) return 6 * 3600_000;
  const [, d, h, min, s] = m;
  return (
    (Number(d || 0) * 86400 +
      Number(h || 0) * 3600 +
      Number(min || 0) * 60 +
      Number(s || 0)) *
    1000
  );
}

// ----------------------------------------------------------------------------
// 4) Logs — Log Analytics KQL query API
// ----------------------------------------------------------------------------

export interface LogQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

/**
 * Run a KQL query against the configured Log Analytics workspace.
 * Throws MonitorNotConfiguredError when LOOM_LOG_ANALYTICS_WORKSPACE_ID is
 * unset so the route can render an honest gate.
 */
export async function queryLogs(kql: string, timespan = 'P1D'): Promise<LogQueryResult> {
  const workspaceId = logAnalyticsWorkspaceId();
  if (!workspaceId) throw new MonitorNotConfiguredError(['LOOM_LOG_ANALYTICS_WORKSPACE_ID']);
  if (!kql?.trim()) throw new MonitorError('query required', 400);
  const tk = await token(LA_SCOPE);
  const url = `${LA_ENDPOINT}/v1/workspaces/${workspaceId}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tk}`,
      'content-type': 'application/json',
      accept: 'application/json',
      // Bump server-side timeout to the LA max.
      prefer: 'wait=60',
    },
    body: JSON.stringify({ query: kql, timespan }),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || json?.error?.innererror?.message || text || 'Log Analytics query failed').toString();
    throw new MonitorError(msg, res.status, json || text);
  }
  const table = (json?.tables || [])[0];
  if (!table) return { columns: [], rows: [], rowCount: 0 };
  const columns = (table.columns || []).map((c: any) => c.name);
  const rows = table.rows || [];
  return { columns, rows, rowCount: rows.length };
}

// ----------------------------------------------------------------------------
// 5) Activity log — ARM Activity Log REST
// ----------------------------------------------------------------------------

export interface ActivityLogEvent {
  eventTimestamp: string;
  operationName?: string;
  status?: string;
  level?: string;
  resourceGroup?: string;
  resourceId?: string;
  resourceType?: string;
  caller?: string;
  category?: string;
  correlationId?: string;
}

/**
 * Recent ARM Activity Log events for the Loom RGs (deployments, role
 * changes, scale ops). The activity log retains 90 days; default window
 * is 7 days. We query per-RG (filter supports a single resourceGroupName)
 * and merge.
 */
export async function listActivityLog(opts?: { days?: number; maxPerRg?: number }): Promise<ActivityLogEvent[]> {
  const cfg = readMonitorConfig();
  const days = Math.min(90, Math.max(1, opts?.days ?? 7));
  const maxPerRg = Math.min(1000, Math.max(1, opts?.maxPerRg ?? 200));
  const startTime = new Date(Date.now() - days * 86400_000).toISOString();
  const endTime = new Date().toISOString();
  const select = [
    'eventTimestamp', 'operationName', 'status', 'level', 'resourceGroupName',
    'resourceId', 'resourceType', 'caller', 'category', 'correlationId',
  ].join(',');

  const events: ActivityLogEvent[] = [];
  await Promise.all(
    cfg.resourceGroups.map(async (rg) => {
      const filter =
        `eventTimestamp ge '${startTime}' and eventTimestamp le '${endTime}' and resourceGroupName eq '${rg}'`;
      const qs = new URLSearchParams({ 'api-version': ACTIVITY_LOG_API });
      // $filter / $select OData params: encode values, leave the operators readable.
      let next: string | null =
        `/subscriptions/${cfg.subscriptionId}/providers/Microsoft.Insights/eventtypes/management/values?${qs.toString()}&$filter=${encodeURIComponent(filter)}&$select=${select}`;
      let guard = 0;
      let taken = 0;
      while (next && guard < 10 && taken < maxPerRg) {
        guard++;
        const j: any = await armGet(next);
        for (const e of j?.value || []) {
          if (taken >= maxPerRg) break;
          taken++;
          events.push({
            eventTimestamp: e.eventTimestamp,
            operationName: e.operationName?.localizedValue || e.operationName?.value,
            status: e.status?.localizedValue || e.status?.value,
            level: e.level,
            resourceGroup: e.resourceGroupName,
            resourceId: e.resourceId,
            resourceType: e.resourceType?.value || e.resourceType,
            caller: e.caller,
            category: e.category?.localizedValue || e.category?.value,
            correlationId: e.correlationId,
          });
        }
        next = j?.nextLink || null;
      }
    }),
  );
  events.sort((a, b) => new Date(b.eventTimestamp).getTime() - new Date(a.eventTimestamp).getTime());
  return events;
}

// ----------------------------------------------------------------------------
// 6) Alerts — Azure Monitor metricAlerts list
// ----------------------------------------------------------------------------

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  severity?: number;
  description?: string;
  scopes?: string[];
  resourceGroup?: string;
}

/** List metric alert rules in the subscription (Loom RGs included). */
export async function listAlertRules(): Promise<AlertRule[]> {
  const cfg = readMonitorConfig();
  const j = await armGet(
    `/subscriptions/${cfg.subscriptionId}/providers/Microsoft.Insights/metricAlerts?api-version=${METRIC_ALERTS_API}`,
  );
  const loomRgs = new Set(cfg.resourceGroups.map((r) => r.toLowerCase()));
  const rules: AlertRule[] = [];
  for (const a of j?.value || []) {
    const rg = rgFromId(a.id || '');
    // Keep alerts scoped to our RGs (the API returns the whole sub).
    if (loomRgs.size && rg && !loomRgs.has(rg.toLowerCase())) {
      // still include if any scope points at a Loom RG resource
      const scopes: string[] = a?.properties?.scopes || [];
      const touchesLoom = scopes.some((s) => loomRgs.has(rgFromId(s).toLowerCase()));
      if (!touchesLoom) continue;
    }
    rules.push({
      id: a.id,
      name: a.name,
      enabled: a?.properties?.enabled !== false,
      severity: a?.properties?.severity,
      description: a?.properties?.description,
      scopes: a?.properties?.scopes,
      resourceGroup: rg,
    });
  }
  return rules;
}

// ----------------------------------------------------------------------------
// metric catalog — the platform metrics Loom surfaces, keyed by resource type
// ----------------------------------------------------------------------------

/**
 * Curated platform-metric catalog: for each Azure resource type the Loom
 * platform deploys, the headline metrics + the right aggregation. Grounded
 * in the Microsoft.Insights supported-metrics docs. Used by the Metrics tab
 * to know which metrics to request per inventory resource.
 */
export const METRIC_CATALOG: Record<string, { metric: string; aggregation: string; label: string }[]> = {
  'microsoft.app/containerapps': [
    { metric: 'UsageNanoCores', aggregation: 'Average', label: 'CPU (nanocores)' },
    { metric: 'WorkingSetBytes', aggregation: 'Average', label: 'Memory (bytes)' },
    { metric: 'Requests', aggregation: 'Total', label: 'Requests' },
    { metric: 'Replicas', aggregation: 'Maximum', label: 'Replicas' },
  ],
  'microsoft.documentdb/databaseaccounts': [
    { metric: 'TotalRequestUnits', aggregation: 'Total', label: 'Request Units' },
    { metric: 'TotalRequests', aggregation: 'Count', label: 'Requests' },
    { metric: 'ServerSideLatency', aggregation: 'Average', label: 'Server latency (ms)' },
  ],
  'microsoft.search/searchservices': [
    { metric: 'SearchLatency', aggregation: 'Average', label: 'Search latency (s)' },
    { metric: 'SearchQueriesPerSecond', aggregation: 'Average', label: 'Queries / sec' },
    { metric: 'ThrottledSearchQueriesPercentage', aggregation: 'Average', label: 'Throttled %' },
  ],
  'microsoft.kusto/clusters': [
    { metric: 'CPU', aggregation: 'Average', label: 'CPU %' },
    { metric: 'IngestionUtilization', aggregation: 'Average', label: 'Ingestion util %' },
    { metric: 'KeepAlive', aggregation: 'Average', label: 'Keep-alive' },
  ],
  'microsoft.synapse/workspaces': [
    { metric: 'IntegrationPipelineRunsEnded', aggregation: 'Total', label: 'Pipeline runs ended' },
    { metric: 'IntegrationActivityRunsEnded', aggregation: 'Total', label: 'Activity runs ended' },
  ],
  'microsoft.datafactory/factories': [
    { metric: 'PipelineSucceededRuns', aggregation: 'Total', label: 'Pipeline runs succeeded' },
    { metric: 'PipelineFailedRuns', aggregation: 'Total', label: 'Pipeline runs failed' },
    { metric: 'ActivityFailedRuns', aggregation: 'Total', label: 'Activity runs failed' },
  ],
  'microsoft.apimanagement/service': [
    { metric: 'Requests', aggregation: 'Total', label: 'Requests' },
    { metric: 'Duration', aggregation: 'Average', label: 'Duration (ms)' },
  ],
  'microsoft.insights/components': [
    { metric: 'requests/count', aggregation: 'Count', label: 'Requests' },
    { metric: 'requests/failed', aggregation: 'Count', label: 'Failed requests' },
    { metric: 'requests/duration', aggregation: 'Average', label: 'Server response (ms)' },
  ],
  'microsoft.fabric/capacities': [
    { metric: 'cu_percentage', aggregation: 'Average', label: 'CU %' },
  ],
  'microsoft.cognitiveservices/accounts': [
    { metric: 'TotalCalls', aggregation: 'Total', label: 'Total calls' },
    { metric: 'TotalTokens', aggregation: 'Total', label: 'Total tokens' },
  ],
};

/** Metrics catalog entries for a resource type (lower-cased lookup). */
export function metricsForType(type: string): { metric: string; aggregation: string; label: string }[] {
  return METRIC_CATALOG[type.toLowerCase()] || [];
}

// ----------------------------------------------------------------------------
// 7) WRITE — action groups + scheduled query alert rules
//
// The Azure-native backend for the Loom Activator (Reflex). A Loom activator
// rule (condition + action) maps 1:1 to an Azure Monitor scheduled query alert
// rule (Microsoft.Insights/scheduledQueryRules) that runs a KQL query over the
// configured Log Analytics workspace / ADX cluster and fires an action group.
// No Microsoft Fabric required (see .claude/rules/no-fabric-dependency.md).
//   https://learn.microsoft.com/rest/api/monitor/scheduled-query-rules
//   https://learn.microsoft.com/rest/api/monitor/action-groups
// ----------------------------------------------------------------------------

const ACTION_GROUPS_API = '2023-01-01';
const SCHEDULED_QUERY_RULES_API = '2023-03-15-preview';

/** Resolve the RG alert resources are written into (alert RG → admin RG). */
function alertResourceGroup(): string {
  const rg = process.env.LOOM_ALERT_RG || process.env.LOOM_ADMIN_RG;
  if (!rg) throw new MonitorNotConfiguredError(['LOOM_ALERT_RG (or LOOM_ADMIN_RG)']);
  return rg.trim();
}

/** ARM resource id of the Log Analytics workspace the alert query runs against. */
export function logAnalyticsResourceId(): string | null {
  const v = process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID;
  return v && v.trim() ? v.trim() : null;
}

// ----------------------------------------------------------------------------
// Diagnostic-settings coverage — "are all logs ON and flowing to the Loom LAW?"
//
// Loom's bicep wires diagnostic settings on the first-class resources at deploy
// (modules/shared/diagnostic-settings.bicep). This pair lets the Monitor pane
// AUDIT every live resource and ENABLE the standardized setting on any that is
// missing it — covering runtime-created resources + config drift. The standard
// setting routes categoryGroup=allLogs + AllMetrics to LOOM_LOG_ANALYTICS_RESOURCE_ID.
// ----------------------------------------------------------------------------

const DIAG_API = '2021-05-01-preview';
/** Consistent name so bicep + console + DSC tooling all reference one setting. */
export const DIAG_SETTING_NAME = 'diag-loom-stdz';

export interface DiagCoverage {
  id: string;
  name: string;
  type: string;
  resourceGroup: string;
  /** Resource type supports diagnostic settings at all. */
  supported: boolean;
  /** A setting exists that routes to the Loom Log Analytics workspace. */
  routesToLoomLaw: boolean;
  /** Names of existing diagnostic settings (any destination). */
  settingNames: string[];
  /** Set when the per-resource probe failed for a non-"unsupported" reason. */
  note?: string;
}

/** Resource types that never support diagnostic settings — skip the probe. */
const DIAG_UNSUPPORTED = [
  'microsoft.managedidentity/userassignedidentities',
  'microsoft.network/privateendpoints',
  'microsoft.network/privatednszones',
  'microsoft.network/networkinterfaces',
  'microsoft.network/privatednszones/virtualnetworklinks',
  'microsoft.compute/disks',
  'microsoft.alertsmanagement/smartdetectoralertrules',
  'microsoft.insights/actiongroups',
  'microsoft.insights/components',
  'microsoft.insights/scheduledqueryrules',
  'microsoft.operationalinsights/workspaces',
  'microsoft.portal/dashboards',
];

function sameLaw(workspaceId: string | undefined, loomLaw: string): boolean {
  if (!workspaceId) return false;
  return workspaceId.replace(/\/+$/, '').toLowerCase() === loomLaw.replace(/\/+$/, '').toLowerCase();
}

/** Audit diagnostic-settings coverage for every Loom resource. */
export async function getDiagnosticsCoverage(): Promise<DiagCoverage[]> {
  const loomLaw = logAnalyticsResourceId();
  if (!loomLaw) throw new MonitorNotConfiguredError(['LOOM_LOG_ANALYTICS_RESOURCE_ID']);
  const resources = await listResources();

  const probes = resources.map(async (r): Promise<DiagCoverage> => {
    const base: DiagCoverage = {
      id: r.id, name: r.name, type: r.type, resourceGroup: r.resourceGroup,
      supported: true, routesToLoomLaw: false, settingNames: [],
    };
    if (DIAG_UNSUPPORTED.includes(r.type.toLowerCase())) {
      return { ...base, supported: false };
    }
    try {
      const j = await armGet(`${r.id}/providers/microsoft.insights/diagnosticSettings?api-version=${DIAG_API}`);
      const settings: any[] = j?.value || [];
      base.settingNames = settings.map((s) => s?.name).filter(Boolean);
      base.routesToLoomLaw = settings.some((s) => sameLaw(s?.properties?.workspaceId, loomLaw));
      return base;
    } catch (e) {
      const status = e instanceof MonitorError ? e.status : 0;
      // 404 / NotSupported / BadRequest → the type can't take diag settings.
      if (status === 404 || status === 400 || status === 405) return { ...base, supported: false };
      return { ...base, note: (e as Error).message };
    }
  });

  return Promise.all(probes);
}

/**
 * Enable the standardized Loom diagnostic setting on a resource. Tries
 * allLogs+AllMetrics first; if the resource rejects one half (logs-only or
 * metrics-only types), retries with the surviving half so the call still
 * succeeds. Idempotent (PUT to the fixed setting name).
 */
export async function enableDiagnostics(resourceId: string): Promise<{ settingName: string; mode: string }> {
  const loomLaw = logAnalyticsResourceId();
  if (!loomLaw) throw new MonitorNotConfiguredError(['LOOM_LOG_ANALYTICS_RESOURCE_ID']);
  const path = `${resourceId}/providers/microsoft.insights/diagnosticSettings/${DIAG_SETTING_NAME}?api-version=${DIAG_API}`;
  const withLogs = { logs: [{ categoryGroup: 'allLogs', enabled: true }] };
  const withMetrics = { metrics: [{ category: 'AllMetrics', enabled: true }] };

  const attempts: Array<{ mode: string; props: Record<string, unknown> }> = [
    { mode: 'allLogs+AllMetrics', props: { workspaceId: loomLaw, ...withLogs, ...withMetrics } },
    { mode: 'AllMetrics', props: { workspaceId: loomLaw, ...withMetrics } },
    { mode: 'allLogs', props: { workspaceId: loomLaw, ...withLogs } },
  ];

  let lastErr: unknown;
  for (const a of attempts) {
    try {
      await armPut(path, { properties: a.props });
      return { settingName: DIAG_SETTING_NAME, mode: a.mode };
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new MonitorError('enableDiagnostics failed', 500);
}

export interface ActionGroupInput {
  /** Resource name e.g. 'loom-activator-ag'. */
  name: string;
  /** 1-12 char short name shown in notifications. */
  shortName: string;
  /** Email receivers; each becomes an emailReceiver. */
  emails?: string[];
}

/** Create/update an action group (Global). Returns its ARM id. Idempotent PUT. */
export async function upsertActionGroup(input: ActionGroupInput): Promise<string> {
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID || '';
  if (!subscriptionId) throw new MonitorNotConfiguredError(['LOOM_SUBSCRIPTION_ID']);
  const rg = alertResourceGroup();
  const emailReceivers = (input.emails || [])
    .filter((e) => e && e.includes('@'))
    .map((e, i) => ({ name: `email${i}`, emailAddress: e.trim(), useCommonAlertSchema: true }));
  const path =
    `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Insights/actionGroups/${encodeURIComponent(input.name)}?api-version=${ACTION_GROUPS_API}`;
  const body = {
    location: 'Global',
    properties: {
      groupShortName: input.shortName.slice(0, 12),
      enabled: true,
      emailReceivers,
    },
  };
  const res = await armPut(path, body);
  return res?.id || `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/microsoft.insights/actionGroups/${input.name}`;
}

export interface ScheduledQueryRuleInput {
  name: string;
  description?: string;
  /** KQL the rule evaluates (returns rows when the condition is met). */
  query: string;
  /** ARM scope(s) — defaults to the LA workspace resource id. */
  scopes?: string[];
  /** GreaterThan | LessThan | Equal | GreaterThanOrEqual | LessThanOrEqual. */
  operator?: string;
  /** Threshold the aggregated query result is compared against. Default 0. */
  threshold?: number;
  /** 0 (critical) – 4 (verbose). Default 3. */
  severity?: number;
  /** ISO duration, default PT5M. */
  evaluationFrequency?: string;
  windowSize?: string;
  /** Action group ARM ids to fire. */
  actionGroupIds?: string[];
  /** Whether the rule evaluates. Default true; set false to "stop" the rule. */
  enabled?: boolean;
}

/** Create/update a scheduled query alert rule. Returns its ARM id. */
export async function upsertScheduledQueryRule(input: ScheduledQueryRuleInput): Promise<string> {
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID || '';
  if (!subscriptionId) throw new MonitorNotConfiguredError(['LOOM_SUBSCRIPTION_ID']);
  const rg = alertResourceGroup();
  const scopeId = logAnalyticsResourceId();
  const scopes = input.scopes && input.scopes.length ? input.scopes : (scopeId ? [scopeId] : []);
  if (scopes.length === 0) {
    throw new MonitorNotConfiguredError(['LOOM_LOG_ANALYTICS_RESOURCE_ID (alert query scope)']);
  }
  const location = process.env.LOOM_ALERT_LOCATION || process.env.LOOM_LOCATION || 'eastus';
  const path =
    `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Insights/scheduledQueryRules/${encodeURIComponent(input.name)}?api-version=${SCHEDULED_QUERY_RULES_API}`;
  const body = {
    location,
    properties: {
      displayName: input.name,
      description: input.description || 'Created by CSA Loom Activator',
      severity: input.severity ?? 3,
      enabled: input.enabled ?? true,
      scopes,
      evaluationFrequency: input.evaluationFrequency || 'PT5M',
      windowSize: input.windowSize || 'PT5M',
      criteria: {
        allOf: [
          {
            query: input.query,
            timeAggregation: 'Count',
            operator: input.operator || 'GreaterThan',
            threshold: input.threshold ?? 0,
            failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 },
          },
        ],
      },
      autoMitigate: true,
      actions: input.actionGroupIds && input.actionGroupIds.length
        ? { actionGroups: input.actionGroupIds }
        : undefined,
    },
  };
  const res = await armPut(path, body);
  return res?.id || `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/microsoft.insights/scheduledQueryRules/${input.name}`;
}
