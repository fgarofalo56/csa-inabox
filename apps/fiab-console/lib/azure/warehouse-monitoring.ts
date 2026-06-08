/**
 * Warehouse monitoring — building blocks shared by the BFF route + the
 * Monitoring tab UI.
 *
 * Two engines, one uniform payload:
 *   - Databricks SQL Warehouse → /api/2.0/sql/warehouses/{id}/events (running
 *     clusters over time) + /api/2.0/sql/history/queries (recent statements).
 *   - Synapse Dedicated SQL pool (Fabric "Warehouse" Azure-native default) →
 *     sys.dm_pdw_exec_requests aggregated into time buckets + recent requests.
 *
 * No mocks: every value comes from a real Databricks REST response or a real
 * TDS DMV query. The pure shaping helpers below are unit-tested so the chart
 * math (windowing, bucketing, carry-forward) is verifiable without a live
 * backend.
 */

import type { WarehouseEvent, DbxQueryHistoryEntry } from './databricks-client';

/** One point on the running-clusters / query-load line chart. */
export interface ClusterTimelinePoint {
  /** Epoch ms (UTC). */
  ts: number;
  /** Series value at this instant — running clusters (Databricks) or query count per bucket (Synapse). */
  count: number;
}

/** One row in the recent-query table (engine-agnostic). */
export interface MonitoringQueryRow {
  id: string;
  status: string;
  text: string;
  durationMs: number | null;
  submittedAt: string;
  user: string;
}

export interface MonitoringPayload {
  ok: true;
  engine: string;
  /** Label for the chart's single series (e.g. "Running clusters" or "Queries started"). */
  seriesLabel: string;
  /** Window length in seconds the data covers. */
  windowSecs: number;
  clusterTimeline: ClusterTimelinePoint[];
  queries: MonitoringQueryRow[];
  /** First few raw backend records for the "live events payload" receipt pane. */
  rawEvents: unknown[];
}

export const DEFAULT_WINDOW_SECS = 3600;

/**
 * Build the running-clusters timeline from raw Databricks warehouse events.
 * Events arrive most-recent-first; we sort ascending, keep those within the
 * window, and carry the last-known cluster_count forward across events that
 * omit it (e.g. STOPPING) so the line is continuous. STOPPED events pin the
 * count to 0.
 */
export function buildClusterTimeline(
  events: WarehouseEvent[],
  windowSecs: number,
  now = Date.now(),
): ClusterTimelinePoint[] {
  const cutoff = now - windowSecs * 1000;
  const sorted = events
    .filter((e) => typeof e.timestamp === 'number')
    .slice()
    .sort((a, b) => (a.timestamp! - b.timestamp!));

  const points: ClusterTimelinePoint[] = [];
  let last = 0;
  for (const e of sorted) {
    const ts = e.timestamp!;
    if (typeof e.cluster_count === 'number') {
      last = e.cluster_count;
    } else if (e.event_type === 'STOPPED') {
      last = 0;
    } else if (e.event_type === 'STARTING' || e.event_type === 'RUNNING') {
      last = Math.max(last, 1);
    }
    if (ts >= cutoff) {
      points.push({ ts, count: last });
    }
  }
  return points;
}

/** Map Databricks query-history entries to the uniform recent-query rows. */
export function mapDbxQueries(entries: DbxQueryHistoryEntry[]): MonitoringQueryRow[] {
  return entries.map((q) => ({
    id: q.query_id,
    status: q.status || 'UNKNOWN',
    text: (q.query_text || q.error_message || '').slice(0, 300),
    durationMs: typeof q.duration === 'number' ? q.duration : null,
    submittedAt: q.query_start_time_ms ? new Date(q.query_start_time_ms).toISOString() : '',
    user: q.user_name || q.executed_as_user_name || '',
  }));
}

/**
 * Aggregate Synapse DMV bucket rows (bucket time + query_count) into timeline
 * points. The DMV query already buckets by 5 minutes; this just normalises the
 * row shape (TDS returns Date objects for datetime columns and numbers/strings
 * for counts) into { ts, count }.
 */
export function buildSynapseTimeline(
  rows: Array<{ bucket: unknown; query_count: unknown }>,
): ClusterTimelinePoint[] {
  return rows
    .map((r) => {
      const ts = toEpochMs(r.bucket);
      const count = toNum(r.query_count);
      return ts != null ? { ts, count: count ?? 0 } : null;
    })
    .filter((p): p is ClusterTimelinePoint => p != null)
    .sort((a, b) => a.ts - b.ts);
}

/** Map Synapse sys.dm_pdw_exec_requests rows to uniform recent-query rows. */
export function mapSynapseQueries(
  rows: Array<Record<string, unknown>>,
): MonitoringQueryRow[] {
  return rows.map((r) => ({
    id: String(r.request_id ?? ''),
    status: String(r.status ?? 'Unknown'),
    text: String(r.command ?? '').slice(0, 300),
    durationMs: toNum(r.total_elapsed_time),
    submittedAt: (() => {
      const ts = toEpochMs(r.submit_time);
      return ts != null ? new Date(ts).toISOString() : '';
    })(),
    user: String(r.login_name ?? ''),
  }));
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function toEpochMs(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// ---- T-SQL for the Synapse branch (sys.dm_pdw_exec_requests) ----------------

/**
 * 5-minute-bucketed query counts over the window. Buckets relative to a fixed
 * epoch so bucket boundaries are stable. Returns (bucket, query_count).
 */
export function synapseTimelineSql(windowSecs: number): string {
  const secs = Math.max(60, Math.min(86_400, Math.floor(windowSecs)));
  return `SELECT
  DATEADD(MINUTE, (DATEDIFF(MINUTE, '2000-01-01', submit_time) / 5) * 5, '2000-01-01') AS bucket,
  COUNT(*) AS query_count
FROM sys.dm_pdw_exec_requests
WHERE submit_time >= DATEADD(SECOND, -${secs}, GETUTCDATE())
GROUP BY DATEADD(MINUTE, (DATEDIFF(MINUTE, '2000-01-01', submit_time) / 5) * 5, '2000-01-01')
ORDER BY bucket;`;
}

/** Recent requests within the window (most recent first), capped at 50. */
export function synapseRecentRequestsSql(windowSecs: number): string {
  const secs = Math.max(60, Math.min(86_400, Math.floor(windowSecs)));
  return `SELECT TOP 50
  request_id,
  status,
  LEFT(command, 300) AS command,
  total_elapsed_time,
  submit_time,
  login_name
FROM sys.dm_pdw_exec_requests
WHERE submit_time >= DATEADD(SECOND, -${secs}, GETUTCDATE())
ORDER BY submit_time DESC;`;
}
