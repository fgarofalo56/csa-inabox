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
 *   - a cost-allocation breakdown by TAG value (LOOM_COST_TAG_KEY, default
 *     'Environment'); honestly empty when the tenant applies no such tag
 *   - resolved subscription DISPLAY NAMES (best-effort ARM GET per sub)
 *   - daily-spend ANOMALIES derived from the daily series (mean+σ / DoD jump)
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
import { loomSubscriptionScope } from './loom-subscriptions';
import { armBase, armScope } from './cloud-endpoints';

// Sovereign-cloud ARM host + scope (Commercial / GCC-High / IL5).
const ARM = armBase();
const ARM_SCOPE = armScope();
const COST_API = '2023-03-01';
const BUDGETS_API = '2023-05-01';
const SUB_API = '2020-01-01';

/**
 * Tag key used for the cost-allocation ("chargeback by tag") breakdown. The
 * Cost Management query groups spend by the VALUES of this tag. Defaults to
 * 'Environment' (the tag the Loom bicep stamps on every resource); override
 * per-deployment with LOOM_COST_TAG_KEY. When no resource carries the tag the
 * breakdown is honestly empty (no error) — the UI surfaces the env-var hint.
 */
const COST_TAG_KEY = process.env.LOOM_COST_TAG_KEY || 'Environment';

/**
 * Per-request ceiling for a single Microsoft.CostManagement/query round-trip.
 * The Cost Management query API is genuinely slow — a single aggregation over a
 * Loom subscription's resource groups routinely takes 10-30s, and more when the
 * account is under QPU throttling or the window spans many services. The shared
 * `fetchWithTimeout` default (30s) aborted these mid-flight, so the chargeback
 * dashboard almost always surfaced its honest timeout state instead of data.
 * 60s matches the per-request budget the Monitor Cost tab already relies on and
 * lands inside the route's `maxDuration = 90`. Scoped to the cost query ONLY —
 * unrelated fast ARM/metric probes keep the 30s default. Override per-deployment
 * with `LOOM_COST_QUERY_TIMEOUT_MS`.
 */
const COST_QUERY_TIMEOUT_MS: number = (() => {
  const n = Number(process.env.LOOM_COST_QUERY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

/**
 * Distinct set of subscriptions the Loom deployment spans (admin + DLZ + BYO).
 * Delegates to the shared scope resolver so the DLZ sub
 * (LOOM_DLZ_SUBSCRIPTION_ID) is always included — the live multi-sub bug was
 * that the DLZ sub was omitted here, so its spend never rolled into the total.
 */
export function loomSubscriptions(): string[] {
  return loomSubscriptionScope();
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
    }, COST_QUERY_TIMEOUT_MS);
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
/**
 * A daily-spend outlier derived PURELY from the daily series (no extra Azure
 * call): a day whose cost exceeds mean + 2σ (severity 'high' when > 3σ, else
 * 'medium'), OR a day-over-day jump > 50% that also sits above the mean.
 */
export interface CostAnomaly {
  date: string;
  cost: number;
  /** The series mean the day is compared against (the "expected" run-rate). */
  expected: number;
  /** Signed % deviation of `cost` from `expected`. */
  deviationPct: number;
  severity: 'high' | 'medium';
}
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
  /**
   * Spend grouped by the ARM RESOURCE TYPE dimension (e.g.
   * `microsoft.synapse/workspaces`, `microsoft.kusto/clusters`,
   * `microsoft.storage/storageaccounts`, `microsoft.databricks/workspaces`,
   * `microsoft.documentdb/databaseaccounts`, `microsoft.app/containerapps`,
   * `microsoft.eventhub/namespaces`, `microsoft.apimanagement/service`). Real
   * Cost Management `ResourceType` grouping across EVERY Loom subscription, so the
   * chargeback report enumerates + totals every Loom-managed resource type — not
   * just the engines that emit an Azure Monitor CU signal.
   */
  byResourceType: CostBreakdownRow[];
  byLocation: CostBreakdownRow[];
  /** Spend grouped by the values of the cost-allocation tag (see COST_TAG_KEY). */
  byTag: CostBreakdownRow[];
  /** The tag key `byTag` is grouped on (echoed so the UI can label + hint). */
  tagKey: string;
  daily: { date: string; cost: number }[];
  /** Daily-spend outliers computed from `daily` (no extra Azure call). */
  anomalies: CostAnomaly[];
  budgets: CostBudget[];
  loomResourceGroups: string[];
  subscriptions: string[];
  /** Resolved subscriptionId → displayName (best-effort; falls back to the id). */
  subscriptionNames: Record<string, string>;
  /** Per-subscription query errors (e.g. one sub missing Cost Management Reader). */
  subscriptionErrors: { subscription: string; error: string }[];
}

const inLoom = (rg: string, loomRgs: Set<string>) => !loomRgs.size || loomRgs.has(rg.toLowerCase());
const addTo = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) || 0) + v);
const sortDesc = (m: Map<string, number>): CostBreakdownRow[] =>
  Array.from(m.entries()).map(([key, cost]) => ({ key: key || 'unknown', cost })).sort((a, b) => b.cost - a.cost);

/**
 * Pure fold (unit-tested): collapse a Cost Management
 * ResourceGroupName × `<dim>` response into descending `{ key, cost }` rows,
 * filtered to the Loom resource groups and summed per dimension value. Used for
 * the per-resource-TYPE rollup (dim = `ResourceType`) so the report covers every
 * Loom-managed resource type. Robust to a missing dimension column (folds all
 * matching spend under `unknown`) and to an absent RG column (no RG filter).
 */
export function foldByDimension(resp: any, dimName: string, loomRgs: Set<string>): CostBreakdownRow[] {
  const cols = resp?.properties?.columns || [];
  const rows: any[][] = resp?.properties?.rows || [];
  const iCost = colIndex(cols, 'Cost');
  const iRg = colIndex(cols, 'ResourceGroupName');
  const iDim = colIndex(cols, dimName);
  const m = new Map<string, number>();
  for (const r of rows) {
    if (iRg >= 0 && !inLoom(String(r[iRg] ?? ''), loomRgs)) continue;
    const key = iDim >= 0 ? String(r[iDim] ?? '').trim() : '';
    addTo(m, key || 'unknown', Number(r[iCost]) || 0);
  }
  return sortDesc(m);
}

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

/**
 * Best-effort: resolve each subscriptionId → its human displayName via a single
 * ARM GET per sub. Falls back to the id itself on any error (a sub the UAMI
 * can't read still shows, just by id) so a name lookup NEVER blocks the cost
 * summary. Runs concurrently with the cost queries.
 *   GET {ARM}/subscriptions/{id}?api-version=2020-01-01
 */
async function resolveSubscriptionNames(subs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(subs.map(async (sub) => {
    out[sub] = sub; // fallback: the id
    try {
      const t = await credential.getToken(ARM_SCOPE);
      if (!t?.token) return;
      const res = await fetchWithTimeout(`${ARM}/subscriptions/${sub}?api-version=${SUB_API}`, {
        headers: { authorization: `Bearer ${t.token}`, accept: 'application/json' }, cache: 'no-store',
      });
      if (!res.ok) return;
      const j = await res.json().catch(() => null);
      const name = j?.displayName;
      if (name) out[sub] = String(name);
    } catch { /* keep the id fallback */ }
  }));
  return out;
}

/**
 * Derive daily-spend anomalies from the daily series alone (no extra Azure
 * call). Flags a day when its cost is a statistical outlier (> mean + 2σ; 'high'
 * when > 3σ) OR when it jumps > 50% over the prior day AND sits above the mean.
 * `expected` is the series mean; `deviationPct` is the signed % over it. Needs
 * at least 3 days of data to have a meaningful mean/σ; otherwise returns [].
 */
function computeAnomalies(daily: { date: string; cost: number }[]): CostAnomaly[] {
  if (daily.length < 3) return [];
  const costs = daily.map((d) => d.cost);
  const n = costs.length;
  const mean = costs.reduce((a, b) => a + b, 0) / n;
  const variance = costs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const out: CostAnomaly[] = [];
  for (let i = 0; i < daily.length; i += 1) {
    const { date, cost } = daily[i];
    const prev = i > 0 ? daily[i - 1].cost : null;
    const dod = prev != null && prev > 0 ? ((cost - prev) / prev) * 100 : null;
    const sigmaOutlier = stddev > 0 && cost > mean + 2 * stddev;
    const dodOutlier = dod != null && dod > 50 && cost > mean;
    if (!sigmaOutlier && !dodOutlier) continue;
    const severity: CostAnomaly['severity'] = stddev > 0 && cost > mean + 3 * stddev ? 'high' : 'medium';
    out.push({
      date,
      cost: r2(cost),
      expected: r2(mean),
      deviationPct: mean > 0 ? Math.round(((cost - mean) / mean) * 1000) / 10 : 0,
      severity,
    });
  }
  // Most-severe / costliest first.
  return out.sort((a, b) => (a.severity === b.severity ? b.cost - a.cost : a.severity === 'high' ? -1 : 1));
}

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
  const byResourceType = new Map<string, number>();
  const byLocation = new Map<string, number>();
  const byTagMap = new Map<string, number>();
  const dailyMap = new Map<string, number>();
  const budgets: CostBudget[] = [];
  const subscriptionErrors: { subscription: string; error: string }[] = [];
  let total = 0;
  let previousPeriod: number | null = null;
  let currency = 'USD';
  const prevTf = PREV_TIMEFRAME[timeframe];

  // Resolve friendly subscription names concurrently with the cost queries —
  // best-effort, never blocks the summary (falls back to the id).
  const namesPromise = resolveSubscriptionNames(subs);

  // Query each subscription independently; one sub failing (e.g. no Cost
  // Management Reader) is folded into subscriptionErrors, not fatal.
  await Promise.all(subs.map(async (sub) => {
    // Fire all six CostManagement calls for this sub CONCURRENTLY. They are
    // independent groupings of the same period, so the wall-clock cost is the
    // slowest single query — not the sum — which keeps the aggregate under the
    // gateway timeout (the sequential version reliably 504'd on multi-grouping).
    const [groupedR, dailyR, resR, locR, prevR, budgetsR, tagR, typeR] = await Promise.allSettled([
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
      // 7) By cost-allocation TAG value (best-effort). Groups RG × TagKey so we
      //    can still filter to Loom RGs. A tenant with no such tag key returns
      //    no tagged rows (or the query 400s) → the breakdown is honestly empty.
      costQuery(sub, {
        type: 'ActualCost', timeframe,
        dataset: {
          granularity: 'None',
          aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
          grouping: [
            { type: 'Dimension', name: 'ResourceGroupName' },
            { type: 'TagKey', name: COST_TAG_KEY },
          ],
        },
      }),
      // 8) By ARM RESOURCE TYPE (best-effort). Groups RG × ResourceType so the
      //    report enumerates + totals EVERY Loom-managed resource type (Synapse,
      //    ADX, ADLS, Databricks, Cosmos, Container Apps, Event Hubs, APIM, …),
      //    not only the engines with an Azure Monitor CU signal.
      costQuery(sub, {
        type: 'ActualCost', timeframe,
        dataset: {
          granularity: 'None',
          aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
          grouping: [
            { type: 'Dimension', name: 'ResourceGroupName' },
            { type: 'Dimension', name: 'ResourceType' },
          ],
        },
      }),
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

    // By ARM resource type — pure fold, filtered to Loom RGs, accumulated across
    // subs (one Loom-managed type may exist in both the admin + DLZ subs).
    if (typeR.status === 'fulfilled') {
      for (const row of foldByDimension(typeR.value, 'ResourceType', loomRgs)) {
        addTo(byResourceType, row.key, row.cost);
      }
    }

    if (prevR.status === 'fulfilled' && prevR.value != null) {
      previousPeriod = (previousPeriod || 0) + (prevR.value as number);
    }

    if (budgetsR.status === 'fulfilled') {
      budgets.push(...budgetsR.value);
    }

    // Tag breakdown: the tag-VALUE column is whichever column isn't Cost /
    // ResourceGroupName / Currency (robust to the API naming the column after
    // the tag key vs. "TagKey"). Rows with no value for the tag are folded into
    // "(untagged)" so unallocated spend is visible.
    if (tagR.status === 'fulfilled') {
      const tCols = tagR.value?.properties?.columns || [];
      const tRows: any[][] = tagR.value?.properties?.rows || [];
      const tCost = colIndex(tCols, 'Cost');
      const tRg = colIndex(tCols, 'ResourceGroupName');
      const tCur = colIndex(tCols, 'Currency');
      const tTag = (tCols as any[]).findIndex((_c, idx) => idx !== tCost && idx !== tRg && idx !== tCur);
      for (const row of tRows) {
        if (tRg >= 0 && !inLoom(String(row[tRg] ?? ''), loomRgs)) continue;
        const raw = tTag >= 0 ? String(row[tTag] ?? '').trim() : '';
        addTo(byTagMap, raw || '(untagged)', Number(row[tCost]) || 0);
      }
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

  // Tag breakdown: honestly empty when the tenant carries no such tag — i.e.
  // the only bucket is "(untagged)". A mix of real values + untagged keeps the
  // untagged row (unallocated spend is meaningful signal).
  const byTagAll = sortDesc(byTagMap);
  const hasRealTag = byTagAll.some((r) => r.key !== '(untagged)');
  const byTag = hasRealTag ? byTagAll : [];

  const anomalies = computeAnomalies(daily);
  const subscriptionNames = await namesPromise;

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
    byResourceType: sortDesc(byResourceType),
    byLocation: sortDesc(byLocation),
    byTag,
    tagKey: COST_TAG_KEY,
    daily,
    anomalies,
    budgets: budgets.sort((a, b) => b.percentUsed - a.percentUsed),
    loomResourceGroups: cfg.resourceGroups,
    subscriptions: subs,
    subscriptionNames,
    subscriptionErrors,
  };
}

export { MonitorError, MonitorNotConfiguredError };
