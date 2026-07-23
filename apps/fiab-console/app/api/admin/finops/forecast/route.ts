/**
 * GET /api/admin/finops/forecast — C2 (loom-next-level): the FinOps forecast
 * feed for the admin cost surfaces (the C4 forecast chart consumes this).
 *
 * Real backend (no mocks — no-vaporware.md): the Cost Management **Forecast
 * API** (POST {scope}/providers/Microsoft.CostManagement/forecast,
 * api-version 2025-03-01, CostUSD aggregation) fanned out per Loom
 * subscription, falling back to a computed linear / seasonal projection from
 * the REAL cached daily series when the API is unavailable (Gov
 * FailedDependency, IL5, insufficient history). `data.method` says which path
 * produced the numbers — the UI labels it verbatim.
 *
 * Query params:
 *   timeframe = MonthToDate (default) | BillingMonthToDate | TheLastMonth | Last30Days | Last7Days
 *   scope     = 'loom' (default, every Loom sub) | /subscriptions/<id>[/resourceGroups/<rg>]
 *   horizon   = forecast days (1–90; default LOOM_COST_FORECAST_HORIZON_DAYS → 30)
 *   method    = auto | api | linear | seasonal (default LOOM_COST_FORECAST_METHOD → auto)
 *   refresh=1 = bypass the shared 'cost' cache (15 min TTL otherwise)
 *
 * Shape: { ok:true, data: CostForecast, meta } | { ok:false, gate } | { ok:false, error }
 * Tenant-admin gated (org-wide $ rollup), same as /api/admin/capacity/chargeback.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { forecastCostCached } from '@/lib/azure/cost-forecast';
import type { CostForecastMethodPref } from '@/lib/azure/cost-forecast-core';
import { MonitorError, MonitorNotConfiguredError, type CostTimeframe } from '@/lib/azure/cost-client';
import { ComputeBudgetExceededError } from '@/lib/azure/query-result-cache';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The per-sub Forecast fan-out rides the shared Cost Management QPU limiter;
// give the cold path the same headroom as the other cost routes.
export const maxDuration = 90;

const TIMEFRAMES: CostTimeframe[] = ['MonthToDate', 'BillingMonthToDate', 'TheLastMonth', 'Last7Days', 'Last30Days'];
const METHODS: CostForecastMethodPref[] = ['auto', 'api', 'linear', 'seasonal'];
const SCOPE_RE = /^\/subscriptions\/[^/]+(\/resourceGroups\/[^/]+)?$/i;

export const GET = withTenantAdmin(async (req: NextRequest) => {
  const q = req.nextUrl.searchParams;
  const tfParam = (q.get('timeframe') || 'MonthToDate') as CostTimeframe;
  const timeframe: CostTimeframe = TIMEFRAMES.includes(tfParam) ? tfParam : 'MonthToDate';
  const scopeParam = (q.get('scope') || 'loom').trim();
  const scope = scopeParam !== 'loom' && SCOPE_RE.test(scopeParam) ? scopeParam : 'loom';
  const horizonRaw = Number(q.get('horizon'));
  const horizonDays = Number.isFinite(horizonRaw) && horizonRaw > 0
    ? Math.min(90, Math.max(1, Math.floor(horizonRaw)))
    : undefined; // undefined → LOOM_COST_FORECAST_HORIZON_DAYS (default 30)
  const methodRaw = (q.get('method') || '').trim().toLowerCase() as CostForecastMethodPref;
  const method = METHODS.includes(methodRaw) ? methodRaw : undefined; // undefined → env pref
  const refresh = q.get('refresh') === '1';

  try {
    const { value, meta } = await forecastCostCached(scope, timeframe, { horizonDays, method, bypass: refresh });
    const res = NextResponse.json({ ok: true, data: value, meta });
    res.headers.set('X-Cache', meta.hit ? (meta.stale ? 'stale' : 'hit') : 'miss');
    return res;
  } catch (e) {
    if (e instanceof ComputeBudgetExceededError) {
      return NextResponse.json({
        ok: false,
        warming: true,
        error: 'The cost forecast is still aggregating (first load can take a minute under Cost Management throttling) — it will appear automatically; retry shortly.',
      }, { status: 202 });
    }
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } }, { status: 503 });
    }
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: ['Cost Management Reader'],
          message:
            'The Console UAMI cannot read Cost Management. Grant it "Cost Management Reader" at subscription scope ' +
            '(bicep-granted by modules/admin-plane/cost-management-reader-rbac.bicep on a push-button deploy) so the ' +
            'forecast can query real spend + the Forecast API.',
        },
      }, { status: 503 });
    }
    if (e instanceof MonitorError && e.status !== 500) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    return apiServerError(e, 'Failed to compute the cost forecast', 'cost_forecast_failed');
  }
});
