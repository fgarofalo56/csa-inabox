/**
 * FGC-28 — Chargeback report (per-domain / per-department spend).
 *
 * Attributes real Azure spend to a Loom governance domain by grouping
 * Microsoft.CostManagement/query on the `loom-domain` tag VALUE that Loom
 * stamps on a domain's DLZ resources (DOMAIN_TAG_KEY), then joining the tag
 * value → the domain's display name from the governance-domains registry.
 *
 * The Azure-native 1:1 of the Fabric Chargeback app — a real report, not just a
 * tagging toggle. Real Cost Management REST only (no fabricated numbers); a
 * 401/403/404 or unconfigured billing scope surfaces as an honest gate the
 * route renders (per no-vaporware.md). Tag values are normalized so both
 * `loom-domain:<id>` and a bare `<id>` fold to the same domain.
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { MonitorError } from '@/lib/azure/monitor-client';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { loomCostSubscriptions, type CostTimeframe } from '@/lib/azure/cost-client';
import { DOMAIN_TAG_KEY } from '@/lib/azure/domain-registry';

const ARM = armBase();
const ARM_SCOPE = armScope();
const COST_API = '2023-03-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Raw (tag value, cost) pair returned by a Cost Management group-by-tag query. */
export interface TagCostRow {
  /** The raw `loom-domain` tag value as Cost Management returned it. */
  tagValue: string;
  cost: number;
}

export interface DomainCostRow {
  domainId: string;
  name: string;
  cost: number;
  pctOfTotal: number;
}

export interface DomainChargebackModel {
  currency: string;
  timeframe: CostTimeframe;
  rows: DomainCostRow[];
  /** Spend on resources carrying no `loom-domain` tag (surfaced honestly, never hidden). */
  untaggedCost: number;
  totalCost: number;
  tagKey: string;
  subscriptions: string[];
  subscriptionErrors: { subscription: string; error: string }[];
  generatedAt: string;
}

/**
 * Strip a `loom-domain:` (or `loom-domain=`) prefix from a Cost Management tag
 * value so both stamped forms fold to the bare domain id. Case-insensitive on
 * the key; the id itself is returned verbatim.
 */
export function normalizeDomainTagValue(raw: string): string {
  const v = (raw || '').trim();
  if (!v) return '';
  const m = new RegExp(`^${DOMAIN_TAG_KEY}\\s*[:=]\\s*`, 'i').exec(v);
  return m ? v.slice(m[0].length).trim() : v;
}

/**
 * Pure aggregation (unit-tested): fold raw per-subscription (tagValue, cost)
 * rows into per-domain rows joined to display names, plus the untagged bucket
 * and the total. Domains are sorted by descending spend.
 */
export function foldDomainCostRows(
  raw: TagCostRow[],
  domainNames: Record<string, string>,
): { rows: DomainCostRow[]; untaggedCost: number; totalCost: number } {
  const byDomain = new Map<string, number>();
  let untaggedCost = 0;
  let totalCost = 0;
  for (const r of raw) {
    const cost = Number(r.cost) || 0;
    totalCost += cost;
    const id = normalizeDomainTagValue(r.tagValue);
    if (!id) { untaggedCost += cost; continue; }
    byDomain.set(id, (byDomain.get(id) || 0) + cost);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const rows: DomainCostRow[] = Array.from(byDomain.entries())
    .map(([domainId, cost]) => ({
      domainId,
      name: domainNames[domainId] || domainId,
      cost: round(cost),
      pctOfTotal: totalCost > 0 ? Math.round((cost / totalCost) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
  return { rows, untaggedCost: round(untaggedCost), totalCost: round(totalCost) };
}

const colIndex = (cols: any[], name: string): number =>
  (cols || []).findIndex((c) => (c?.name || '').toLowerCase() === name.toLowerCase());

/** One Cost Management group-by-tag query for a subscription, with backoff. */
async function queryDomainCost(sub: string, timeframe: CostTimeframe): Promise<TagCostRow[]> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new MonitorError('Failed to acquire ARM token for Cost Management', 401);
  const url = `${ARM}/subscriptions/${sub}/providers/Microsoft.CostManagement/query?api-version=${COST_API}`;
  const body = {
    type: 'ActualCost',
    timeframe,
    dataset: {
      granularity: 'None',
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      grouping: [{ type: 'TagKey', name: DOMAIN_TAG_KEY }],
    },
  };
  const maxAttempts = 4;
  let lastErr: MonitorError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    }, 60_000);
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* leave */ }
    if (res.ok) {
      const cols = json?.properties?.columns || [];
      const rows: any[][] = json?.properties?.rows || [];
      const iCost = colIndex(cols, 'Cost');
      // The tag column is named after the TagKey (or 'TagKey' on some API builds).
      let iTag = colIndex(cols, DOMAIN_TAG_KEY);
      if (iTag < 0) iTag = colIndex(cols, 'TagKey');
      return rows.map((r) => ({ tagValue: String(iTag >= 0 ? r[iTag] ?? '' : ''), cost: Number(r[iCost]) || 0 }));
    }
    const msg = (json?.error?.message || text || `Cost query failed (${res.status})`).toString();
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get('retry-after'))
        || Number(res.headers.get('x-ms-ratelimit-microsoft.costmanagement-client-retry-after'));
      const backoff = Math.min((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0) || 2000 * 2 ** (attempt - 1), 20_000);
      await sleep(Math.round(backoff / 2 + Math.random() * (backoff / 2)));
      lastErr = new MonitorError(msg, res.status, json || text);
      continue;
    }
    throw new MonitorError(msg, res.status, json || text);
  }
  throw lastErr || new MonitorError('Cost query failed after retries', 429);
}

/**
 * Build the per-domain chargeback model across every Loom subscription. Throws
 * MonitorError (401/403/404) on no Cost Management access so the route can render
 * the honest gate. One sub failing (e.g. missing Cost Management Reader on a DLZ
 * sub) is captured per-sub; the report still renders from the subs that answer.
 */
export async function getDomainChargeback(opts: {
  timeframe?: CostTimeframe;
  domainNames?: Record<string, string>;
} = {}): Promise<DomainChargebackModel> {
  const timeframe: CostTimeframe = opts.timeframe || 'MonthToDate';
  const subs = await loomCostSubscriptions();
  if (subs.length === 0) throw new MonitorError('No Loom subscriptions configured for Cost Management', 404);

  const raw: TagCostRow[] = [];
  const subscriptionErrors: { subscription: string; error: string }[] = [];
  let anySucceeded = false;
  let firstAuthError: MonitorError | null = null;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        const rows = await queryDomainCost(sub, timeframe);
        raw.push(...rows);
        anySucceeded = true;
      } catch (e) {
        const err = e instanceof MonitorError ? e : new MonitorError(String(e), 500);
        if ((err.status === 401 || err.status === 403 || err.status === 404) && !firstAuthError) firstAuthError = err;
        subscriptionErrors.push({ subscription: sub, error: err.message });
      }
    }),
  );

  // Every subscription denied access → propagate the honest gate.
  if (!anySucceeded) throw firstAuthError || new MonitorError('Cost Management query failed for all subscriptions', 403);

  const { rows, untaggedCost, totalCost } = foldDomainCostRows(raw, opts.domainNames || {});
  return {
    currency: 'USD',
    timeframe,
    rows,
    untaggedCost,
    totalCost,
    tagKey: DOMAIN_TAG_KEY,
    subscriptions: subs,
    subscriptionErrors,
    generatedAt: new Date().toISOString(),
  };
}
