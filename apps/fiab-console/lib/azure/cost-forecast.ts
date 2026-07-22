/**
 * cost-forecast — C2 (loom-next-level): the REAL Cost Management **Forecast
 * API** with a computed projection fallback, replacing the C1-era run-rate
 * stub as the product's forecast source.
 *
 *   Primary  — POST {ARM}/{scope}/providers/Microsoft.CostManagement/forecast
 *              ?api-version=2025-03-01 (Learn: rest/api/cost-management/forecast/usage)
 *              type 'ActualCost', timeframe 'Custom' (2025-03-01 accepts only
 *              Custom + an explicit timePeriod), granularity Daily, aggregation
 *              totalCost = Sum(**CostUSD**) — USD-normalized to dodge the
 *              multi-currency 424 FailedDependency — with includeActualCost +
 *              includeFreshPartialCost so the chart gets the actual→forecast
 *              continuum.
 *   Fallback — on FailedDependency / insufficient history / Gov-scope variance
 *              / IL5 (endpoint unreachable): a **linear** least-squares or
 *              **seasonal** 7-day-weekday-profile projection computed from the
 *              REAL cached daily series (cost-forecast-core.ts). The result's
 *              `method` says which path produced it so every surface labels the
 *              number honestly.
 *
 * Env (both optional; fully-functional defaults — bicep emits them from the
 * admin-plane observabilityConfig bag):
 *   LOOM_COST_FORECAST_HORIZON_DAYS  forecast horizon (default 30, clamped 1–90)
 *   LOOM_COST_FORECAST_METHOD        auto (default) | api | linear | seasonal
 *
 * Sovereign clouds: rides armBase()/armScope() (Commercial
 * management.azure.com, Gov management.usgovcloudapi.net). Gov GCC-High: the
 * Forecast API is GA but enrollment/scope support varies — a per-scope failure
 * falls back to 'seasonal'/'linear' with an honest note. IL5/air-gapped: the
 * endpoint is typically unreachable → the computed projection from the C1
 * CSV-ingest/query series is the path, same shape, honestly labeled.
 *
 * Every Forecast POST rides the shared C1 QPU limiter (scheduleCostCall) and
 * the shared 'cost' cache posture — real REST only, no mocks (no-vaporware.md).
 */
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { armBase, armScope } from './cloud-endpoints';
import { MonitorError } from './monitor-client';
import {
  costKey,
  COST_CACHE_OPTS,
  getLoomCostSummary,
  loomCostSubscriptions,
  loomScopeLabel,
  runCostQuery,
  scheduleCostCall,
  type CostTimeframe,
} from './cost-client';
import { getOrComputeCached, type CacheMeta } from './query-result-cache';
import {
  addDaysIso,
  bandApiSeries,
  daysInMonthOf,
  mergeForecastRows,
  parseForecastRows,
  pickComputedMethod,
  projectDaily,
  type CostForecastMethod,
  type CostForecastMethodPref,
  type CostForecastPoint,
  type DailyCost,
  type ParsedForecastRow,
} from './cost-forecast-core';

const ARM = armBase();
const ARM_SCOPE = armScope();
const FORECAST_API = '2025-03-01';

// ── env knobs (fully-functional defaults; svc-cost-forecast ENV_CHECKS) ────

/** Forecast horizon in days (LOOM_COST_FORECAST_HORIZON_DAYS, default 30, 1–90). */
export function forecastHorizonDays(): number {
  const n = Number(process.env.LOOM_COST_FORECAST_HORIZON_DAYS);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(90, Math.max(1, Math.floor(n)));
}

/** Method preference (LOOM_COST_FORECAST_METHOD, default 'auto'). */
export function forecastMethodPref(): CostForecastMethodPref {
  const raw = (process.env.LOOM_COST_FORECAST_METHOD || '').trim().toLowerCase();
  return raw === 'api' || raw === 'linear' || raw === 'seasonal' ? raw : 'auto';
}

// ── shared credential (same UAMI chain as every Loom ARM client) ────────────

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const todayIso = () => new Date().toISOString().slice(0, 10);

// ── the real Forecast API call (per ARM scope path) ─────────────────────────

/**
 * One real Forecast POST for one ARM scope path
 * (`/subscriptions/<id>[/resourceGroups/<rg>]` — leading slash included).
 * Rides the shared C1 QPU limiter; honors Retry-After once on 429. Throws a
 * MonitorError on any non-OK (the caller decides fallback) — 424
 * FailedDependency (multi-currency / unsupported offer) included.
 */
async function forecastScopeViaApi(
  scopePath: string,
  fromIso: string,
  toIso: string,
  opts: { includeActualCost: boolean; includeFreshPartialCost: boolean },
  deadline?: number,
): Promise<{ rows: ParsedForecastRow[]; currency: string }> {
  return scheduleCostCall(async () => {
    const t = await credential.getToken(ARM_SCOPE);
    if (!t?.token) throw new MonitorError('Failed to acquire ARM token for Cost Management forecast', 401);
    const url = `${ARM}${scopePath}/providers/Microsoft.CostManagement/forecast?api-version=${FORECAST_API}`;
    const body = {
      type: 'ActualCost',
      timeframe: 'Custom',
      timePeriod: { from: `${fromIso}T00:00:00Z`, to: `${toIso}T23:59:59Z` },
      dataset: {
        granularity: 'Daily',
        // CostUSD dodges the multi-currency FailedDependency (C2 spec).
        aggregation: { totalCost: { name: 'CostUSD', function: 'Sum' } },
      },
      includeActualCost: opts.includeActualCost,
      includeFreshPartialCost: opts.includeFreshPartialCost,
    };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (deadline != null && Date.now() >= deadline) {
        throw new MonitorError('Forecast call exceeded the report time budget', 504);
      }
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      }, 45_000);
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* leave */ }
      if (res.ok) {
        const parsed = parseForecastRows(json);
        // A currency comes back USD when CostUSD aggregates; default honestly.
        return { rows: parsed.rows, currency: parsed.currency || 'USD' };
      }
      if (res.status === 429 && attempt < 2) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Math.min((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 4000), 15_000);
        if (deadline != null && Date.now() + wait >= deadline) {
          throw new MonitorError(json?.error?.message || 'Forecast throttled past the time budget', 429, json || text);
        }
        await sleep(wait);
        continue;
      }
      throw new MonitorError(
        (json?.error?.message || text || `Forecast call failed (${res.status})`).toString(),
        res.status,
        json || text,
      );
    }
    throw new MonitorError('Forecast call failed after retry', 429);
  });
}

// ── period-end remainder for the cost summary (cost-client dynamic import) ──

/**
 * API-only period-end helper for {@link import('./cost-client').computeLoomCostSummary}:
 * the summed FORECAST cost from tomorrow through the END OF THE CURRENT MONTH
 * across every given subscription. Returns null (→ the caller keeps its
 * computed linear/seasonal projection) when the month is already over tomorrow
 * or when ANY subscription's Forecast call fails — a partial multi-sub sum
 * would be a dishonest total.
 */
export async function apiPeriodEndRemainder(subs: string[], deadline?: number): Promise<number | null> {
  const today = todayIso();
  const from = addDaysIso(today, 1);
  const monthEnd = `${today.slice(0, 7)}-${String(daysInMonthOf(today)).padStart(2, '0')}`;
  if (from > monthEnd || subs.length === 0) return null;
  try {
    const results = await Promise.all(subs.map((sub) => forecastScopeViaApi(
      `/subscriptions/${sub}`, from, monthEnd,
      { includeActualCost: false, includeFreshPartialCost: false },
      deadline,
    )));
    let remainder = 0;
    for (const r of results) for (const row of r.rows) remainder += row.cost;
    return remainder;
  } catch {
    return null; // caller keeps the honest computed projection
  }
}

// ── the full forecast (points + bands + method) ─────────────────────────────

export interface CostForecast {
  /** The scope the forecast covers ('loom' = every Loom subscription, or an
   * explicit `/subscriptions/<id>[/resourceGroups/<rg>]` path). */
  scope: string;
  timeframe: CostTimeframe;
  /** What actually produced the numbers — surfaced verbatim in the UI. */
  method: CostForecastMethod;
  horizonDays: number;
  currency: string;
  /** Date-ascending actual + forecast points; Forecast rows carry the ±1σ band. */
  points: CostForecastPoint[];
  /** Actual-to-date + forecast within the current calendar month. */
  periodEnd: number;
  /** Honest note when a fallback ran (names the reason + the computed method). */
  note?: string;
  generatedAt: string;
}

const SUB_SCOPE_RE = /^\/subscriptions\/([^/]+)(\/resourceGroups\/([^/]+))?$/i;

/** Last-30-days REAL daily series for the fallback projection: the shared C1
 * cached summary for the Loom scope, or one grouped query for an explicit
 * sub/RG scope (through the shared throttle-aware loop). */
async function fallbackDaily(scope: string, deadline?: number): Promise<DailyCost[]> {
  if (scope === 'loom') {
    const summary = await getLoomCostSummary({ timeframe: 'Last30Days' });
    return summary.daily;
  }
  const m = SUB_SCOPE_RE.exec(scope);
  if (!m) return [];
  const [, sub, , rg] = m;
  const resp = await runCostQuery(sub, {
    type: 'ActualCost',
    timeframe: 'Last30Days',
    dataset: {
      granularity: 'Daily',
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      grouping: [{ type: 'Dimension', name: 'ResourceGroupName' }],
    },
  }, deadline);
  const cols: any[] = resp?.properties?.columns || [];
  const rows: any[][] = resp?.properties?.rows || [];
  const lower = cols.map((c) => String(c?.name || '').toLowerCase());
  const iCost = lower.indexOf('cost');
  const iDate = lower.indexOf('usagedate');
  const iRg = lower.indexOf('resourcegroupname');
  const byDate = new Map<string, number>();
  for (const r of rows) {
    if (rg && iRg >= 0 && String(r[iRg] ?? '').toLowerCase() !== rg.toLowerCase()) continue;
    const raw = String(r[iDate] ?? '');
    const date = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw.slice(0, 10);
    if (!date) continue;
    byDate.set(date, (byDate.get(date) || 0) + (Number(r[iCost]) || 0));
  }
  return Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, cost]) => ({ date, cost }));
}

/** Sum of points inside the current calendar month (period-end estimate). */
function periodEndOf(points: CostForecastPoint[]): number {
  const month = todayIso().slice(0, 7);
  let total = 0;
  for (const p of points) if (p.date.slice(0, 7) === month) total += p.cost;
  return Math.round(total * 100) / 100;
}

/**
 * The C2 entrypoint: forecast the given scope `horizonDays` forward.
 *   method pref 'auto'/'api' → real Forecast API first (per-sub fan-out summed
 *   for the 'loom' scope; ALL subs must succeed — a partial sum is dishonest);
 *   any failure (or pref 'linear'/'seasonal') → computed projection from the
 *   REAL cached daily series, honestly labeled with a note.
 */
export async function forecastCost(
  scope = 'loom',
  timeframe: CostTimeframe = 'MonthToDate',
  opts: { horizonDays?: number; method?: CostForecastMethodPref; deadline?: number } = {},
): Promise<CostForecast> {
  const horizon = Math.min(90, Math.max(1, Math.floor(opts.horizonDays ?? forecastHorizonDays())));
  const pref = opts.method ?? forecastMethodPref();
  const today = todayIso();
  const from = `${today.slice(0, 7)}-01`; // current-month actuals anchor the chart
  const to = addDaysIso(today, horizon);
  const base = {
    scope,
    timeframe,
    horizonDays: horizon,
    generatedAt: new Date().toISOString(),
  };

  let apiError: string | null = null;
  if (pref === 'auto' || pref === 'api') {
    try {
      const scopePaths = scope === 'loom'
        ? (await loomCostSubscriptions()).map((sub) => `/subscriptions/${sub}`)
        : [scope];
      if (scopePaths.length === 0) throw new MonitorError('No Loom subscription scope configured', 400);
      const results = await Promise.all(scopePaths.map((p) => forecastScopeViaApi(
        p, from, to, { includeActualCost: true, includeFreshPartialCost: true }, opts.deadline,
      )));
      const merged = mergeForecastRows(results.map((r) => r.rows));
      if (!merged.some((r) => r.costStatus === 'Forecast')) {
        throw new MonitorError('Forecast API returned no forward points (insufficient history for this scope)', 424);
      }
      const points = bandApiSeries(merged);
      return {
        ...base,
        method: 'api',
        currency: results.find((r) => r.currency)?.currency || 'USD',
        points,
        periodEnd: periodEndOf(points),
      };
    } catch (e) {
      // FailedDependency (424, multi-currency/offer), Gov enrollment-scope
      // variance, IL5 unreachable endpoint, throttling past budget — all land
      // here; the computed projection below guarantees a labeled number.
      apiError = (e as Error)?.message || String(e);
    }
  }

  const daily = await fallbackDaily(scope, opts.deadline);
  const method = pickComputedMethod(daily, pref);
  const projection = projectDaily(daily, horizon, method);
  const month = today.slice(0, 7);
  const actualPoints: CostForecastPoint[] = daily
    .filter((d) => d.date.slice(0, 7) === month)
    .map((d) => ({
      date: d.date,
      cost: Math.round(d.cost * 100) / 100,
      lowerBound: Math.round(d.cost * 100) / 100,
      upperBound: Math.round(d.cost * 100) / 100,
      costStatus: 'Actual' as const,
    }));
  const points = [...actualPoints, ...projection.points];
  const note = apiError
    ? `Cost Management Forecast API unavailable for this scope (${apiError}) — showing a computed ${method} projection from the real daily series.`
    : pref === 'linear' || pref === 'seasonal'
      ? `Method forced to '${pref}' via LOOM_COST_FORECAST_METHOD — computed projection from the real daily series.`
      : undefined;
  return {
    ...base,
    method,
    currency: 'USD',
    points,
    periodEnd: periodEndOf(points),
    note,
  };
}

/**
 * Cached wrapper under the shared C1 'cost' posture (15 min TTL, 45s inline
 * budget, serve-stale-on-error, 'cost' hit-rate counter) — the forecast route's
 * entrypoint. `bypass` wires `?refresh=1`.
 */
export async function forecastCostCached(
  scope = 'loom',
  timeframe: CostTimeframe = 'MonthToDate',
  opts: { horizonDays?: number; method?: CostForecastMethodPref; bypass?: boolean } = {},
): Promise<{ value: CostForecast; meta: CacheMeta }> {
  const horizon = opts.horizonDays ?? forecastHorizonDays();
  const pref = opts.method ?? forecastMethodPref();
  const scopeLabel = scope === 'loom' ? loomScopeLabel() : scope;
  return getOrComputeCached(
    costKey(scopeLabel, timeframe, `forecast:${horizon}:${pref}`),
    'cost-mgmt',
    () => forecastCost(scope, timeframe, { horizonDays: horizon, method: pref }),
    { ...COST_CACHE_OPTS, staleWhileRevalidate: true, bypass: opts.bypass },
  );
}
