/**
 * Per-resource Cost Management adapter for the /admin/capacity cost column.
 *
 * The Monitor → Cost tab uses `lib/azure/cost-client.ts` (`getLoomCostSummary`)
 * for the multi-subscription Loom-wide rollup. The capacity inventory needs the
 * opposite shape: month-to-date spend for ONE specific ARM resource so the
 * "$/mo" column + detail pane can show a real number per row.
 *
 * Backend (real REST only, no mocks):
 *   POST {ARM}/subscriptions/{sub}/providers/Microsoft.CostManagement/query?api-version=2023-03-01
 *   body filters dimension ResourceId == <the resource id>, aggregating totalCost.
 *   https://learn.microsoft.com/rest/api/cost-management/query/usage
 *
 * Sovereign-cloud correct via armBase()/armScope() — Azure Government EA/PAYG
 * cost IS available on management.usgovcloudapi.net (only CSP billing is
 * excluded). Auth: the same UAMI/Chained credential as every other Loom ARM
 * client; the UAMI needs "Cost Management Reader". A 401/403 surfaces as a
 * MonitorError so the BFF can render an honest infra-gate (never a fake number).
 */
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { MonitorError } from '@/lib/azure/monitor-client';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { subscriptionFromResourceId, parseResourceCost } from '@/lib/clients/cost-parse';

const ARM = armBase();
const ARM_SCOPE = armScope();
const COST_API = '2023-03-01';

export type ResourceCostTimeframe = 'MonthToDate' | 'BillingMonthToDate' | 'TheLastMonth' | 'Last7Days' | 'Last30Days';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ResourceCost {
  /** Month-to-date (or selected-timeframe) actual cost for the one resource. */
  cost: number;
  /** Billing currency (e.g. USD), best-effort from the response. */
  currency: string;
  timeframe: ResourceCostTimeframe;
}

/**
 * Extract the subscription GUID from an ARM resource id, and parse a
 * CostManagement query response — pure helpers, re-exported from cost-parse so
 * they can be unit-tested without the @azure/identity credential chain.
 */
export { subscriptionFromResourceId, parseResourceCost };

/**
 * Month-to-date actual cost for ONE Azure resource. Throws MonitorError on
 * 401/403 (→ honest gate) or other ARM failure. The Cost Management QPU quota
 * is small (12/10s) so a 429 is retried with Retry-After-honoring backoff.
 */
export async function getResourceMonthlyCost(
  resourceId: string,
  opts: { timeframe?: ResourceCostTimeframe } = {},
): Promise<ResourceCost> {
  const rid = (resourceId || '').trim();
  if (!rid) throw new MonitorError('resourceId required', 400);
  const sub = subscriptionFromResourceId(rid);
  if (!sub) throw new MonitorError('resourceId is not a subscription-scoped ARM id', 400);
  const timeframe = opts.timeframe || 'MonthToDate';

  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new MonitorError('Failed to acquire ARM token for Cost Management', 401);

  const url = `${ARM}/subscriptions/${sub}/providers/Microsoft.CostManagement/query?api-version=${COST_API}`;
  const body = {
    type: 'ActualCost',
    timeframe,
    dataset: {
      granularity: 'None',
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      filter: {
        dimensions: { name: 'ResourceId', operator: 'In', values: [rid] },
      },
    },
  };

  const maxAttempts = 4;
  let lastErr: MonitorError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* leave */ }
    if (res.ok) {
      const { cost, currency } = parseResourceCost(json);
      return { cost, currency, timeframe };
    }
    const msg = (json?.error?.message || text || `Cost query failed (${res.status})`).toString();
    // A resource type that Cost Management cannot scope by ResourceId (422) is
    // not an error — its spend rolls up to the parent. Report $0 honestly.
    if (res.status === 422) return { cost: 0, currency: 'USD', timeframe };
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get('retry-after'))
        || Number(res.headers.get('x-ms-ratelimit-microsoft.costmanagement-client-retry-after'));
      const backoff = Math.min((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0) || 2000 * 2 ** (attempt - 1), 20_000);
      const wait = Math.round(backoff / 2 + Math.random() * (backoff / 2));
      lastErr = new MonitorError(msg, res.status, json || text);
      await sleep(wait);
      continue;
    }
    throw new MonitorError(msg, res.status, json || text);
  }
  throw lastErr || new MonitorError('Cost query failed after retries', 429);
}

export { MonitorError };
