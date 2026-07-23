/**
 * GET /api/admin/rum — RUM1 admin rollup: real-user page-load percentiles,
 * Web Vitals and top client errors by surface, from the App Insights
 * workspace tables in the Loom Log Analytics workspace
 * (loom-next-level ws-verification-dr.md RUM1).
 *
 * Backend: four REAL KQL queries via the existing `queryLogs` (monitor-client
 * — cloud-aware api.loganalytics host, Console UAMI credential) over the
 * workspace-based App Insights tables, filtered to the RUM cloud role
 * 'loom-console-browser' so server-side telemetry never mixes in:
 *
 *   AppBrowserTimings — hard page loads (p50/p95 total + phase breakdown)
 *   AppEvents         — 'loom-rum-vitals' (p75 LCP / FCP / CLS / INP-approx)
 *   AppExceptions     — client errors grouped by type + message
 *   AppPageViews      — soft route-change view counts
 *
 * Honest gate: MonitorNotConfiguredError (LOOM_LOG_ANALYTICS_WORKSPACE_ID
 * unset) → 503 naming the exact env var; the /admin/rum panel renders the
 * MessageBar. Empty tables are a REAL zero (data appears minutes after the
 * first browser session), not a gate.
 *
 * Cached 5 min (getOrComputeCached, serve-stale) — the admin view is a
 * rollup, and LA queries are the expensive hop.
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiHonestError, apiOk, apiServerError } from '@/lib/api/respond';
import { MonitorNotConfiguredError, queryLogs } from '@/lib/azure/monitor-client';
import { getOrComputeCached } from '@/lib/azure/query-result-cache';
import { RUM_CLOUD_ROLE, RUM_FLAG_ID } from '@/lib/telemetry/rum-shared';
import { isRumEnvEnabled, rumSampleRate } from '@/lib/telemetry/rum-ingest';
import { runtimeFlag } from '@/lib/admin/runtime-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Allowed lookback windows (dropdown on /admin/rum — no freeform). */
const WINDOWS = new Set(['P1D', 'P3D', 'P7D']);

export interface RumSurfaceRow {
  surface: string;
  views: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface RumTrendPoint {
  ts: string;
  p50Ms: number | null;
  p95Ms: number | null;
  views: number;
}

export interface RumErrorRow {
  type: string;
  message: string;
  surface: string;
  count: number;
  lastSeen: string;
}

export interface RumVitals {
  lcpP75Ms: number | null;
  fcpP75Ms: number | null;
  ttfbP75Ms: number | null;
  clsP75: number | null;
  inpP75Ms: number | null;
  samples: number;
}

export interface RumRollup {
  window: string;
  loads: { views: number; p50Ms: number | null; p95Ms: number | null };
  trend: RumTrendPoint[];
  surfaces: RumSurfaceRow[];
  errors: RumErrorRow[];
  errorCount: number;
  routeChanges: number;
  vitals: RumVitals;
  capture: { envEnabled: boolean; flagEnabled: boolean; sampleRate: number };
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
};

async function computeRollup(window: string): Promise<Omit<RumRollup, 'capture'>> {
  const role = RUM_CLOUD_ROLE;
  const surfaceExpr = `tostring(Properties['csa-loom.surface'])`;

  const [loadsQ, trendQ, surfacesQ, errorsQ, vitalsQ, pageViewsQ] = await Promise.all([
    queryLogs(
      `AppBrowserTimings | where AppRoleName == '${role}'
       | summarize views = count(), p50 = percentile(TotalDurationMs, 50), p95 = percentile(TotalDurationMs, 95)`,
      window,
    ),
    queryLogs(
      `AppBrowserTimings | where AppRoleName == '${role}'
       | summarize p50 = percentile(TotalDurationMs, 50), p95 = percentile(TotalDurationMs, 95), views = count() by bin(TimeGenerated, 1h)
       | order by TimeGenerated asc`,
      window,
    ),
    queryLogs(
      `AppBrowserTimings | where AppRoleName == '${role}'
       | summarize views = count(), p50 = percentile(TotalDurationMs, 50), p95 = percentile(TotalDurationMs, 95) by surface = ${surfaceExpr}
       | order by views desc | take 25`,
      window,
    ),
    queryLogs(
      `AppExceptions | where AppRoleName == '${role}'
       | summarize count_ = count(), lastSeen = max(TimeGenerated) by type = tostring(ExceptionType), message = tostring(OuterMessage), surface = ${surfaceExpr}
       | order by count_ desc | take 25`,
      window,
    ),
    queryLogs(
      `AppEvents | where AppRoleName == '${role}' and Name == 'loom-rum-vitals'
       | summarize samples = count(),
           lcp = percentile(todouble(Measurements['lcpMs']), 75),
           fcp = percentile(todouble(Measurements['fcpMs']), 75),
           ttfb = percentile(todouble(Measurements['ttfbMs']), 75),
           cls = percentile(todouble(Measurements['cls']), 75),
           inp = percentile(todouble(Measurements['inpMs']), 75)`,
      window,
    ),
    queryLogs(
      `AppPageViews | where AppRoleName == '${role}' | summarize views = count()`,
      window,
    ),
  ]);

  const col = (r: { columns: string[] }, name: string) => r.columns.indexOf(name);

  const loadsRow = loadsQ.rows[0] || [];
  const loads = {
    views: (num(loadsRow[col(loadsQ, 'views')]) ?? 0) as number,
    p50Ms: num(loadsRow[col(loadsQ, 'p50')]),
    p95Ms: num(loadsRow[col(loadsQ, 'p95')]),
  };

  const trend: RumTrendPoint[] = trendQ.rows.map((r) => ({
    ts: String(r[col(trendQ, 'TimeGenerated')] ?? ''),
    p50Ms: num(r[col(trendQ, 'p50')]),
    p95Ms: num(r[col(trendQ, 'p95')]),
    views: (num(r[col(trendQ, 'views')]) ?? 0) as number,
  }));

  const surfaces: RumSurfaceRow[] = surfacesQ.rows.map((r) => ({
    surface: String(r[col(surfacesQ, 'surface')] || '(unknown)'),
    views: (num(r[col(surfacesQ, 'views')]) ?? 0) as number,
    p50Ms: num(r[col(surfacesQ, 'p50')]),
    p95Ms: num(r[col(surfacesQ, 'p95')]),
  }));

  const errors: RumErrorRow[] = errorsQ.rows.map((r) => ({
    type: String(r[col(errorsQ, 'type')] || 'Error'),
    message: String(r[col(errorsQ, 'message')] || ''),
    surface: String(r[col(errorsQ, 'surface')] || '(unknown)'),
    count: (num(r[col(errorsQ, 'count_')]) ?? 0) as number,
    lastSeen: String(r[col(errorsQ, 'lastSeen')] ?? ''),
  }));

  const vRow = vitalsQ.rows[0] || [];
  const vitals: RumVitals = {
    samples: (num(vRow[col(vitalsQ, 'samples')]) ?? 0) as number,
    lcpP75Ms: num(vRow[col(vitalsQ, 'lcp')]),
    fcpP75Ms: num(vRow[col(vitalsQ, 'fcp')]),
    ttfbP75Ms: num(vRow[col(vitalsQ, 'ttfb')]),
    clsP75: num(vRow[col(vitalsQ, 'cls')]),
    inpP75Ms: num(vRow[col(vitalsQ, 'inp')]),
  };

  const pvRow = pageViewsQ.rows[0] || [];
  const routeChanges = (num(pvRow[col(pageViewsQ, 'views')]) ?? 0) as number;

  return {
    window,
    loads,
    trend,
    surfaces,
    errors,
    errorCount: errors.reduce((n, e) => n + e.count, 0),
    routeChanges,
    vitals,
  };
}

export const GET = withTenantAdmin(async (req: NextRequest) => {
  const window = req.nextUrl.searchParams.get('window') || 'P1D';
  if (!WINDOWS.has(window)) return apiHonestError(new Error('window must be one of P1D | P3D | P7D'), 400);
  try {
    const { value } = await getOrComputeCached(
      `admin-rum:${window}`,
      'admin',
      () => computeRollup(window),
      { ttlMs: 5 * 60_000, staleWhileRevalidate: true, budgetMs: 45_000, serveStaleOnError: true },
    );
    const envEnabled = isRumEnvEnabled();
    const flagEnabled = await runtimeFlag(RUM_FLAG_ID);
    const rollup: RumRollup = {
      ...value,
      capture: { envEnabled, flagEnabled, sampleRate: rumSampleRate() },
    };
    return apiOk({ rum: rollup });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return apiHonestError(
        e,
        503,
        'RUM analytics need the Log Analytics workspace: set LOOM_LOG_ANALYTICS_WORKSPACE_ID ' +
          '(auto-derived from the monitoring module on a push-button deploy) and grant the Console UAMI ' +
          '"Log Analytics Reader" on the workspace. Browser beacons are still being captured and shipped ' +
          'to App Insights — only this admin view is gated.',
      );
    }
    return apiServerError(e);
  }
});
