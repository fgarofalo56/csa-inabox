/**
 * Azure Cost Management client — the real backend for the /monitor → Cost tab
 * (Monitor command-center M3: costing + predictive).
 *
 * Queries Microsoft.CostManagement across EVERY subscription the CSA Loom
 * deployment spans (admin-plane + DLZ + Stream Analytics / Event Hubs / explicit
 * extras), narrowed to the Loom resource groups. For each timeframe it returns:
 *   - month-to-date / period actual cost + previous-period total (trend %)
 *   - a simple linear period-end FORECAST from the daily run-rate
 *   - breakdowns by service, resource group, SUBSCRIPTION, top RESOURCE, location
 *   - the daily series, and any Consumption BUDGETS with current burn
 *
 * Real REST only (no mocks). Auth: the same UAMI/Chained credential as every
 * other Loom ARM client. The UAMI needs "Cost Management Reader" (or Reader)
 * on each subscription; a 401/403 surfaces as an honest infra-gate.
 *
 *   POST {ARM}/subscriptions/{sub}/providers/Microsoft.CostManagement/query?api-version=2023-03-01
 *   https://learn.microsoft.com/rest/api/cost-management/query/usage
 *   GET  .../providers/Microsoft.Consumption/budgets?api-version=2023-05-01
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { readMonitorConfig, MonitorError, MonitorNotConfiguredError } from './monitor-client';
import { armBase, armScope } from './cloud-endpoints';

// Sovereign-cloud ARM host + scope (Commercial / GCC-High / IL5).
const ARM = armBase();
const ARM_SCOPE = armScope();
const COST_API = '2023-03-01';
const BUDGETS_API = '2023-05-01';

/** Distinct set of subscriptions the Loom deployment spans (admin + DLZ + BYO). */
export function loomSubscriptions(): string[] {
  const subs = new Set<string>();
  const add = (v?: string) => { if (v && v.trim()) subs.add(v.trim()); };
  add(process.env.LOOM_SUBSCRIPTION_ID);
  add(process.env.LOOM_DLZ_SUB);
  add(process.env.LOOM_ASA_SUB);
  add(process.env.LOOM_EVENTHUB_SUB);
  add(process.env.LOOM_AI_SEARCH_SUB);
  add(process.env.LOOM_FOUNDRY_SUB);
  for (const s of (process.env.LOOM_COST_SUBSCRIPTIONS || '').split(',')) add(s);
  return Array.from(subs);
}

export type CostTimeframe = 'MonthToDate' | 'BillingMonthToDate' | 'TheLastMonth' | 'Last7Days' | 'Last30Days';
const PREV_TIMEFRAME: Record<CostTimeframe, CostTimeframe | null> = {
  MonthToDate: 'TheLastMonth',
  BillingMonthToDate: 'TheLastMonth',
  TheLastMonth: null,
  Last7Days: null,
  Last30Days: null,
};

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cost Management is aggressively rate-limited (HTTP 429 "Too many requests").
 * It returns a Retry-After header; we honor it (capped) with a few attempts +
 * jittered exponential backoff so the Cost tab loads instead of erroring.
 */
async function costQuery(subscriptionId: string, body: unknown): Promise<any> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new MonitorError('Failed to acquire ARM token for Cost Management', 401);
  const url = `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=${COST_API}`;
  const maxAttempts = 5;
  let lastErr: MonitorError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* leave */ }
    if (res.ok) return json;
    const msg = (json?.error?.message || text || `Cost query failed (${res.status})`).toString();
    // 429 (throttle) and 503/504 (transient) → retry with backoff. Honor Retry-After.
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get('retry-after')) || Number(res.headers.get('x-ms-ratelimit-microsoft.costmanagement-client-retry-after'));
      const backoff = Math.min((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0) || 2000 * 2 ** (attempt - 1), 30_000);
      const wait = Math.round(backoff / 2 + Math.random() * (backoff / 2));
      lastErr = new MonitorError(msg, res.status, json || text);
      await sleep(wait);
      continue;
    }
    throw new MonitorError(msg, res.status, json || text);
  }
  throw lastErr || new MonitorError('Cost query failed after retries', 429);
}

/** Column index by name (Cost Management returns columns + rows). */
function colIndex(cols: any[], name: string): number {
  return (cols || []).findIndex((c) => (c?.name || '').toLowerCase() === name.toLowerCase());
}

export interface CostBreakdownRow { key: string; cost: number; }
export interface CostBudget {
  name: string;
  subscription: string;
  amount: number;
  currentSpend: number;
  /** 0-100+ percentage of the budget consumed. */
  percentUsed: number;
  timeGrain: string;
  scope: string;
}
export interface CostSummary {
  currency: string;
  timeframe: CostTimeframe;
  /** Total actual cost for the selected timeframe (kept as monthToDate for back-compat). */
  monthToDate: number;
  /** Previous comparable period total (null when N/A) + % change. */
  previousPeriod: number | null;
  trendPct: number | null;
  /** Linear period-end projection from the daily run-rate. */
  forecast: number;
  byService: CostBreakdownRow[];
  byResourceGroup: CostBreakdownRow[];
  bySubscription: CostBreakdownRow[];
  byResource: CostBreakdownRow[];
  byLocation: CostBreakdownRow[];
  daily: { date: string; cost: number }[];
  budgets: CostBudget[];
  loomResourceGroups: string[];
  subscriptions: string[];
  /** Per-subscription query errors (e.g. one sub missing Cost Management Reader). */
  subscriptionErrors: { subscription: string; error: string }[];
}

const inLoom = (rg: string, loomRgs: Set<string>) => !loomRgs.size || loomRgs.has(rg.toLowerCase());
const addTo = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) || 0) + v);
const sortDesc = (m: Map<string, number>): CostBreakdownRow[] =>
  Array.from(m.entries()).map(([key, cost]) => ({ key: key || 'unknown', cost })).sort((a, b) => b.cost - a.cost);

/** Sum the actual cost for a timeframe in one sub, filtered to Loom RGs. */
async function periodTotal(sub: string, timeframe: CostTimeframe, loomRgs: Set<string>): Promise<number> {
  const q = await costQuery(sub, {
    type: 'ActualCost', timeframe,
    dataset: {
      granularity: 'None',
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      grouping: [{ type: 'Dimension', name: 'ResourceGroupName' }],
    },
  });
  const cols = q?.properties?.columns || [];
  const rows: any[][] = q?.properties?.rows || [];
  const iCost = colIndex(cols, 'Cost');
  const iRg = colIndex(cols, 'ResourceGroupName');
  let total = 0;
  for (const r of rows) if (inLoom(String(r[iRg] ?? ''), loomRgs)) total += Number(r[iCost]) || 0;
  return total;
}

/** Best-effort: list Consumption budgets in a sub + their current burn. */
async function listBudgets(sub: string): Promise<CostBudget[]> {
  try {
    const t = await credential.getToken(ARM_SCOPE);
    const res = await fetchWithTimeout(`${ARM}/subscriptions/${sub}/providers/Microsoft.Consumption/budgets?api-version=${BUDGETS_API}`, {
      headers: { authorization: `Bearer ${t?.token}`, accept: 'application/json' }, cache: 'no-store',
    });
    if (!res.ok) return [];
    const j = await res.json().catch(() => null);
    return (j?.value || []).map((b: any): CostBudget => {
      const amount = Number(b?.properties?.amount) || 0;
      const currentSpend = Number(b?.properties?.currentSpend?.amount) || 0;
      return {
        name: b?.name || 'budget',
        subscription: sub,
        amount,
        currentSpend,
        percentUsed: amount > 0 ? Math.round((currentSpend / amount) * 1000) / 10 : 0,
        timeGrain: b?.properties?.timeGrain || 'Monthly',
        scope: (b?.properties?.category as string) || 'Cost',
      };
    });
  } catch { return []; }
}

export interface CostOptions { timeframe?: CostTimeframe; }

/** Build the multi-subscription cost summary for the Loom deployment. */
export async function getLoomCostSummary(opts: CostOptions = {}): Promise<CostSummary> {
  const cfg = readMonitorConfig(); // throws MonitorNotConfiguredError if unset
  const loomRgs = new Set(cfg.resourceGroups.map((r) => r.toLowerCase()));
  const timeframe = opts.timeframe || 'MonthToDate';
  const subs = loomSubscriptions();
  if (subs.length === 0) subs.push(cfg.subscriptionId);

  const bySvc = new Map<string, number>();
  const byRg = new Map<string, number>();
  const bySub = new Map<string, number>();
  const byResource = new Map<string, number>();
  const byLocation = new Map<string, number>();
  const dailyMap = new Map<string, number>();
  const budgets: CostBudget[] = [];
  const subscriptionErrors: { subscription: string; error: string }[] = [];
  let total = 0;
  let previousPeriod: number | null = null;
  let currency = 'USD';
  const prevTf = PREV_TIMEFRAME[timeframe];

  // Query each subscription independently; one sub failing (e.g. no Cost
  // Management Reader) is folded into subscriptionErrors, not fatal.
  await Promise.all(subs.map(async (sub) => {
    // Fire all six CostManagement calls for this sub CONCURRENTLY. They are
    // independent groupings of the same period, so the wall-clock cost is the
    // slowest single query — not the sum — which keeps the aggregate under the
    // gateway timeout (the sequential version reliably 504'd on multi-grouping).
    const [groupedR, dailyR, resR, locR, prevR, budgetsR] = await Promise.allSettled([
      // 1) RG × Service (totals, byRg, bySvc, bySub) — the only REQUIRED query.
      costQuery(sub, {
        type: 'ActualCost', timeframe,
        dataset: {
          granularity: 'None',
          aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
          grouping: [
            { type: 'Dimension', name: 'ResourceGroupName' },
            { type: 'Dimension', name: 'ServiceName' },
          ],
        },
      }),
      // 2) Daily series (run-rate forecast).
      costQuery(sub, {
        type: 'ActualCost', timeframe,
        dataset: {
          granularity: 'Daily',
          aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
          grouping: [{ type: 'Dimension', name: 'ResourceGroupName' }],
        },
      }),
      // 3) Top resources (best-effort; separate dim).
      costQuery(sub, {
        type: 'ActualCost', timeframe,
        dataset: {
          granularity: 'None',
          aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
          grouping: [
            { type: 'Dimension', name: 'ResourceGroupName' },
            { type: 'Dimension', name: 'ResourceId' },
          ],
        },
      }),
      // 4) By location (best-effort).
      costQuery(sub, {
        type: 'ActualCost', timeframe,
        dataset: {
          granularity: 'None',
          aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
          grouping: [
            { type: 'Dimension', name: 'ResourceGroupName' },
            { type: 'Dimension', name: 'ResourceLocation' },
          ],
        },
      }),
      // 5) Previous period total (for trend).
      prevTf ? periodTotal(sub, prevTf, loomRgs) : Promise.resolve(null),
      // 6) Budgets.
      listBudgets(sub),
    ]);

    // The grouped query is the gate: if it failed (e.g. no Cost Management
    // Reader on this sub), record the sub error and skip — exactly the old
    // outer-catch behaviour. The other five are best-effort.
    if (groupedR.status === 'rejected') {
      subscriptionErrors.push({ subscription: sub, error: (groupedR.reason as Error)?.message || String(groupedR.reason) });
      return;
    }

    const grouped = groupedR.value;
    const gCols = grouped?.properties?.columns || [];
    const gRows: any[][] = grouped?.properties?.rows || [];
    const iCost = colIndex(gCols, 'Cost'), iRg = colIndex(gCols, 'ResourceGroupName');
    const iSvc = colIndex(gCols, 'ServiceName'), iCur = colIndex(gCols, 'Currency');
    if (iCur >= 0 && gRows[0]) currency = String(gRows[0][iCur]) || currency;
    for (const row of gRows) {
      if (!inLoom(String(row[iRg] ?? ''), loomRgs)) continue;
      const cost = Number(row[iCost]) || 0;
      total += cost;
      addTo(byRg, String(row[iRg] ?? 'unknown'), cost);
      addTo(bySvc, String(row[iSvc] ?? 'Other'), cost);
      addTo(bySub, sub, cost);
    }

    if (dailyR.status === 'fulfilled') {
      const dCols = dailyR.value?.properties?.columns || [];
      const dRows: any[][] = dailyR.value?.properties?.rows || [];
      const dCost = colIndex(dCols, 'Cost'), dDate = colIndex(dCols, 'UsageDate'), dRg = colIndex(dCols, 'ResourceGroupName');
      for (const row of dRows) {
        if (!inLoom(String(row[dRg] ?? ''), loomRgs)) continue;
        const raw = String(row[dDate] ?? '');
        const date = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
        addTo(dailyMap, date, Number(row[dCost]) || 0);
      }
    }

    if (resR.status === 'fulfilled') {
      const rCols = resR.value?.properties?.columns || [];
      const rRows: any[][] = resR.value?.properties?.rows || [];
      const rCost = colIndex(rCols, 'Cost'), rRg = colIndex(rCols, 'ResourceGroupName'), rId = colIndex(rCols, 'ResourceId');
      for (const row of rRows) {
        if (!inLoom(String(row[rRg] ?? ''), loomRgs)) continue;
        const id = String(row[rId] ?? '');
        addTo(byResource, id ? id.split('/').pop() || id : 'unknown', Number(row[rCost]) || 0);
      }
    }

    if (locR.status === 'fulfilled') {
      const lCols = locR.value?.properties?.columns || [];
      const lRows: any[][] = locR.value?.properties?.rows || [];
      const lCost = colIndex(lCols, 'Cost'), lRg = colIndex(lCols, 'ResourceGroupName'), lLoc = colIndex(lCols, 'ResourceLocation');
      for (const row of lRows) {
        if (!inLoom(String(row[lRg] ?? ''), loomRgs)) continue;
        addTo(byLocation, String(row[lLoc] ?? 'global') || 'global', Number(row[lCost]) || 0);
      }
    }

    if (prevR.status === 'fulfilled' && prevR.value != null) {
      previousPeriod = (previousPeriod || 0) + (prevR.value as number);
    }

    if (budgetsR.status === 'fulfilled') {
      budgets.push(...budgetsR.value);
    }
  }));

  const daily = Array.from(dailyMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, cost]) => ({ date, cost }));

  // Period-end forecast (MTD-style only; for fixed windows forecast == total).
  let forecast = total;
  if ((timeframe === 'MonthToDate' || timeframe === 'BillingMonthToDate') && daily.length) {
    const daysElapsed = Math.max(1, daily.length);
    const ref = daily[daily.length - 1].date;
    const dim = new Date(`${ref.slice(0, 7)}-01T00:00:00Z`);
    const daysInMonth = new Date(dim.getUTCFullYear(), dim.getUTCMonth() + 1, 0).getUTCDate();
    forecast = total > 0 ? (total / daysElapsed) * daysInMonth : 0;
  }

  const trendPct = previousPeriod && previousPeriod > 0
    ? Math.round(((total - previousPeriod) / previousPeriod) * 1000) / 10
    : null;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  return {
    currency,
    timeframe,
    monthToDate: r2(total),
    previousPeriod: previousPeriod == null ? null : r2(previousPeriod),
    trendPct,
    forecast: r2(forecast),
    byService: sortDesc(bySvc),
    byResourceGroup: sortDesc(byRg),
    bySubscription: sortDesc(bySub),
    byResource: sortDesc(byResource).slice(0, 25),
    byLocation: sortDesc(byLocation),
    daily,
    budgets: budgets.sort((a, b) => b.percentUsed - a.percentUsed),
    loomResourceGroups: cfg.resourceGroups,
    subscriptions: subs,
    subscriptionErrors,
  };
}

export { MonitorError, MonitorNotConfiguredError };
