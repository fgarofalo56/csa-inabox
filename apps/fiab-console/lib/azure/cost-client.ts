/**
 * Azure Cost Management client — the real backend for the /monitor → Cost tab
 * (Monitor command-center M3: costing + predictive).
 *
 * Queries Microsoft.CostManagement at subscription scope for the CSA Loom
 * deployment's spend, then narrows to the Loom resource groups:
 *   - month-to-date actual cost grouped by service + by resource group
 *   - a daily-granularity series → a simple linear month-end FORECAST
 *
 * Real REST only (no mocks). Auth: the same UAMI/Chained credential as every
 * other Loom ARM client. The UAMI needs "Cost Management Reader" (or Reader)
 * on the subscription; a 401/403 surfaces as an honest infra-gate.
 *
 *   POST https://management.azure.com/subscriptions/{sub}/providers/Microsoft.CostManagement/query?api-version=2023-03-01
 *   https://learn.microsoft.com/rest/api/cost-management/query/usage
 */
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { readMonitorConfig, MonitorError, MonitorNotConfiguredError } from './monitor-client';

const ARM = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';
const COST_API = '2023-03-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function costQuery(subscriptionId: string, body: unknown): Promise<any> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new MonitorError('Failed to acquire ARM token for Cost Management', 401);
  const url = `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=${COST_API}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave */ }
  if (!res.ok) {
    const msg = (json?.error?.message || text || `Cost query failed (${res.status})`).toString();
    throw new MonitorError(msg, res.status, json || text);
  }
  return json;
}

/** Column index by name (Cost Management returns columns + rows). */
function colIndex(cols: any[], name: string): number {
  return (cols || []).findIndex((c) => (c?.name || '').toLowerCase() === name.toLowerCase());
}

export interface CostBreakdownRow { key: string; cost: number; }
export interface CostSummary {
  currency: string;
  monthToDate: number;
  /** Linear month-end projection from the daily run-rate. */
  forecast: number;
  byService: CostBreakdownRow[];
  byResourceGroup: CostBreakdownRow[];
  daily: { date: string; cost: number }[];
  loomResourceGroups: string[];
}

/** Build the month-to-date + forecast cost summary for the Loom deployment. */
export async function getLoomCostSummary(): Promise<CostSummary> {
  const cfg = readMonitorConfig(); // throws MonitorNotConfiguredError if unset
  const loomRgs = new Set(cfg.resourceGroups.map((r) => r.toLowerCase()));

  // 1) MTD grouped by ResourceGroupName + ServiceName (one query, two dims).
  const grouped = await costQuery(cfg.subscriptionId, {
    type: 'ActualCost',
    timeframe: 'MonthToDate',
    dataset: {
      granularity: 'None',
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      grouping: [
        { type: 'Dimension', name: 'ResourceGroupName' },
        { type: 'Dimension', name: 'ServiceName' },
      ],
    },
  });
  const gCols = grouped?.properties?.columns || [];
  const gRows: any[][] = grouped?.properties?.rows || [];
  const iCost = colIndex(gCols, 'Cost');
  const iRg = colIndex(gCols, 'ResourceGroupName');
  const iSvc = colIndex(gCols, 'ServiceName');
  const iCur = colIndex(gCols, 'Currency');
  const currency = iCur >= 0 && gRows[0] ? String(gRows[0][iCur]) : 'USD';

  const byRgMap = new Map<string, number>();
  const bySvcMap = new Map<string, number>();
  let monthToDate = 0;
  for (const row of gRows) {
    const rg = String(row[iRg] ?? '').toLowerCase();
    if (loomRgs.size && !loomRgs.has(rg)) continue; // only Loom RGs
    const cost = Number(row[iCost]) || 0;
    monthToDate += cost;
    byRgMap.set(String(row[iRg] ?? 'unknown'), (byRgMap.get(String(row[iRg] ?? 'unknown')) || 0) + cost);
    const svc = String(row[iSvc] ?? 'Other');
    bySvcMap.set(svc, (bySvcMap.get(svc) || 0) + cost);
  }

  // 2) Daily series (MTD) for the run-rate forecast — filtered to Loom RGs.
  const dailyQ = await costQuery(cfg.subscriptionId, {
    type: 'ActualCost',
    timeframe: 'MonthToDate',
    dataset: {
      granularity: 'Daily',
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      grouping: [{ type: 'Dimension', name: 'ResourceGroupName' }],
    },
  });
  const dCols = dailyQ?.properties?.columns || [];
  const dRows: any[][] = dailyQ?.properties?.rows || [];
  const dCost = colIndex(dCols, 'Cost');
  const dDate = colIndex(dCols, 'UsageDate');
  const dRg = colIndex(dCols, 'ResourceGroupName');
  const dailyMap = new Map<string, number>();
  for (const row of dRows) {
    const rg = String(row[dRg] ?? '').toLowerCase();
    if (loomRgs.size && !loomRgs.has(rg)) continue;
    const dateRaw = String(row[dDate] ?? ''); // YYYYMMDD as number/string
    const date = dateRaw.length === 8 ? `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}` : dateRaw;
    dailyMap.set(date, (dailyMap.get(date) || 0) + (Number(row[dCost]) || 0));
  }
  const daily = Array.from(dailyMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, cost]) => ({ date, cost }));

  // 3) Linear month-end forecast: (MTD / days-elapsed) × days-in-month.
  const daysElapsed = Math.max(1, daily.length);
  const ref = daily.length ? daily[daily.length - 1].date : '';
  const dim = ref ? new Date(`${ref.slice(0, 7)}-01T00:00:00Z`) : null;
  const daysInMonth = dim ? new Date(dim.getUTCFullYear(), dim.getUTCMonth() + 1, 0).getUTCDate() : 30;
  const forecast = monthToDate > 0 ? (monthToDate / daysElapsed) * daysInMonth : 0;

  const sortDesc = (m: Map<string, number>): CostBreakdownRow[] =>
    Array.from(m.entries()).map(([key, cost]) => ({ key, cost })).sort((a, b) => b.cost - a.cost);

  return {
    currency,
    monthToDate: Math.round(monthToDate * 100) / 100,
    forecast: Math.round(forecast * 100) / 100,
    byService: sortDesc(bySvcMap),
    byResourceGroup: sortDesc(byRgMap),
    daily,
    loomResourceGroups: cfg.resourceGroups,
  };
}

export { MonitorError, MonitorNotConfiguredError };
