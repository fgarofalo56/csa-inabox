/**
 * Usage telemetry client (F21) — real Log Analytics KQL behind the
 * /admin/usage page. Wraps three workspace-based Application Insights queries
 * over the Loom Console's own request telemetry (the `AppRequests` table),
 * shaping raw rows into typed arrays:
 *
 *   - fetchActiveUsersTrend  → daily distinct active users (DAU)
 *   - fetchFeatureAdoption   → events + distinct users per feature (route prefix)
 *   - fetchTopItemsFromLa    → events per item id (from /items/<type>/<id> paths)
 *
 * Backend: lib/azure/monitor-client.ts#queryLogs → POST
 *   ${LOOM_LOG_ANALYTICS_ENDPOINT}/v1/workspaces/${LOOM_LOG_ANALYTICS_WORKSPACE_ID}/query
 * over the ChainedTokenCredential(UAMI, DefaultAzureCredential). The Console
 * UAMI already holds "Log Analytics Reader" on the LAW + "Monitoring Reader"
 * at subscription scope (platform/fiab/bicep/modules/admin-plane/monitoring*.bicep).
 *
 * No Microsoft Fabric required — this is pure Azure Monitor / Log Analytics
 * (per .claude/rules/no-fabric-dependency.md). When
 * LOOM_LOG_ANALYTICS_WORKSPACE_ID is unset, queryLogs throws
 * MonitorNotConfiguredError; the BFF route catches it and renders an honest
 * MessageBar — never a promotional EmptyState.
 */

import { queryLogs, MonitorNotConfiguredError } from '@/lib/azure/monitor-client';

export { MonitorNotConfiguredError };

export interface DayPoint {
  /** ISO date (yyyy-mm-dd). */
  day: string;
  /** Distinct active users on that day. */
  dau: number;
}

export interface FeatureRow {
  /** Top-level route segment the request hit, e.g. 'items', 'admin', 'monitor'. */
  feature: string;
  /** Total request events for the feature in the window. */
  events: number;
  /** Distinct users who touched the feature. */
  users: number;
}

export interface LaTopItem {
  /** GUID item id pulled from /items/<type>/<id> request paths. */
  itemId: string;
  /** Total request events that touched the item in the window. */
  events: number;
}

/** Column-index lookup helper: map a column name → its position in result.columns. */
function colIndex(columns: string[], name: string): number {
  return columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.min(90, Math.max(1, Math.floor(days)));
}

/**
 * Daily distinct active users (DAU) over the window. Reads the workspace-based
 * Application Insights `AppRequests` table emitted by the Console container app
 * (IngestionMode=LogAnalytics).
 */
export async function fetchActiveUsersTrend(days = 30): Promise<DayPoint[]> {
  const d = clampDays(days);
  const kql = `
AppRequests
| where isnotempty(UserId)
| summarize dau = dcount(UserId) by day = format_datetime(bin(TimeGenerated, 1d), 'yyyy-MM-dd')
| order by day asc`;
  const res = await queryLogs(kql, `P${d}D`);
  const di = colIndex(res.columns, 'day');
  const ui = colIndex(res.columns, 'dau');
  if (di < 0) return [];
  return res.rows.map((row) => ({
    day: str(row[di]),
    dau: ui >= 0 ? num(row[ui]) : 0,
  }));
}

/**
 * Events + distinct users per feature. "Feature" = the first non-api path
 * segment of the request URL, so /items/... → 'items', /admin/usage → 'admin',
 * /monitor → 'monitor'. Infra noise (health probes, static assets) is dropped.
 * When `feature` is supplied, results are filtered to that one feature
 * (drill-through).
 */
export async function fetchFeatureAdoption(days = 30, feature?: string): Promise<FeatureRow[]> {
  const d = clampDays(days);
  const filterClause = feature && feature.trim()
    ? `| where feature == '${feature.trim().replace(/'/g, "''")}'`
    : '';
  const kql = `
AppRequests
| extend feature = extract(@'^(?:/api)?/([^/?#]+)', 1, tostring(Url))
| where isnotempty(feature)
| where feature !in ('health', 'healthz', 'favicon.ico', '_next', 'api', 'ping', 'robots.txt')
${filterClause}
| summarize events = count(), users = dcount(UserId) by feature
| order by events desc
| take 25`;
  const res = await queryLogs(kql, `P${d}D`);
  const fi = colIndex(res.columns, 'feature');
  const ei = colIndex(res.columns, 'events');
  const ui = colIndex(res.columns, 'users');
  if (fi < 0) return [];
  return res.rows
    .map((row) => ({
      feature: str(row[fi]),
      events: ei >= 0 ? num(row[ei]) : 0,
      users: ui >= 0 ? num(row[ui]) : 0,
    }))
    .filter((r) => r.feature);
}

/**
 * Events per item id, extracted from /items/<type>/<id> request paths (id is a
 * 36-char GUID). Merged with Cosmos audit counts in the BFF route so the
 * top-items table reflects both editor traffic (LA) and audited writes (Cosmos).
 */
export async function fetchTopItemsFromLa(days = 30): Promise<LaTopItem[]> {
  const d = clampDays(days);
  const kql = `
AppRequests
| extend itemId = extract(@'/items/[^/]+/([0-9a-fA-F-]{36})', 1, tostring(Url))
| where isnotempty(itemId)
| summarize events = count() by itemId
| order by events desc
| take 50`;
  const res = await queryLogs(kql, `P${d}D`);
  const ii = colIndex(res.columns, 'itemId');
  const ei = colIndex(res.columns, 'events');
  if (ii < 0) return [];
  return res.rows
    .map((row) => ({
      itemId: str(row[ii]),
      events: ei >= 0 ? num(row[ei]) : 0,
    }))
    .filter((r) => r.itemId);
}
