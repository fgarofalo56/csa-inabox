/**
 * cost-scope — C1: resolve the sub / resource-group / tag scopes a Cost
 * Management pull can roll up, for the per-scope FinOps views (forecast,
 * anomaly rules, budget CRUD target pickers).
 *
 *   - `enumerateScopes()` — every Loom subscription + every distinct resource
 *     group carrying a Loom resource (real ARM inventory via `listResources`).
 *   - `tagScope(tagKey)`  — the distinct VALUES of a cost-allocation tag, via
 *     a real Cost Management `query` grouped on the TagKey dimension.
 *
 * Both are BOUNDED (`MAX_COST_SCOPES`, override `LOOM_COST_MAX_SCOPES`) and
 * cached under the shared C1 cost-cache posture (15 min TTL, 45s budget,
 * serve-stale-on-error, 'cost' hit-rate counter) so scope enumeration never
 * burns the tiny Cost Management QPU quota per page-paint. All REST rides the
 * sovereign-cloud-correct clients (`cloud-endpoints.ts` via cost-client /
 * monitor-client) — Commercial `management.azure.com`, Gov
 * `management.usgovcloudapi.net`. Real REST only, no mocks
 * (`no-vaporware.md`); Fabric-free (`no-fabric-dependency.md`).
 */
import { listResources } from './monitor-client';
import {
  loomCostSubscriptions,
  runCostQuery,
  costKey,
  COST_CACHE_OPTS,
  loomScopeLabel,
} from './cost-client';
import { getOrComputeCached } from './query-result-cache';

/** Upper bound on returned scopes — keeps pickers + fan-outs bounded. */
export const MAX_COST_SCOPES: number = (() => {
  const n = Number(process.env.LOOM_COST_MAX_SCOPES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
})();

export interface CostScope {
  kind: 'subscription' | 'resourceGroup' | 'tag';
  /**
   * The Cost Management scope path for sub / RG scopes
   * (`/subscriptions/<id>[/resourceGroups/<rg>]`); a stable `tag:<key>=<value>`
   * label for tag scopes (tag rollups filter by TagKey, they are not an ARM
   * scope path).
   */
  scope: string;
  /** Human label for pickers. */
  label: string;
  subscriptionId?: string;
  resourceGroup?: string;
  tagKey?: string;
  tagValue?: string;
}

// ---------------------------------------------------------------------------
// pure folds (unit-tested without Azure)
// ---------------------------------------------------------------------------

const RG_RE = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)/i;

/**
 * Pure: fold the Loom subscription list + ARM resource-id inventory into a
 * bounded, deduped scope list — one subscription scope per sub, then one
 * resource-group scope per distinct (sub, rg) pair (case-insensitive dedupe,
 * first-seen casing wins), capped at `max`.
 */
export function scopesFromInventory(
  subscriptionIds: string[],
  resourceIds: string[],
  max: number = MAX_COST_SCOPES,
): CostScope[] {
  const out: CostScope[] = [];
  const seenSubs = new Set<string>();
  for (const sub of subscriptionIds) {
    const key = sub.toLowerCase();
    if (!sub || seenSubs.has(key)) continue;
    seenSubs.add(key);
    out.push({
      kind: 'subscription',
      scope: `/subscriptions/${sub}`,
      label: `Subscription ${sub}`,
      subscriptionId: sub,
    });
    if (out.length >= max) return out;
  }
  const seenRgs = new Set<string>();
  for (const id of resourceIds) {
    const m = RG_RE.exec(id || '');
    if (!m) continue;
    const [, sub, rg] = m;
    const key = `${sub}/${rg}`.toLowerCase();
    if (seenRgs.has(key)) continue;
    seenRgs.add(key);
    out.push({
      kind: 'resourceGroup',
      scope: `/subscriptions/${sub}/resourceGroups/${rg}`,
      label: rg,
      subscriptionId: sub,
      resourceGroup: rg,
    });
    if (out.length >= max) return out;
  }
  return out;
}

/**
 * Pure: extract the distinct non-empty tag VALUES from a Cost Management
 * `query` response grouped on a TagKey. Robust to the API naming the value
 * column after the tag key vs. a generic `TagValue` — the value column is
 * whichever column is not Cost / Currency / UsageDate / ResourceGroupName
 * (mirrors the battle-tested tag fold in cost-client.ts). Sorted by summed
 * cost descending so the biggest allocation buckets list first.
 */
export function tagValuesFromQueryResponse(resp: any): { value: string; cost: number }[] {
  const cols: any[] = resp?.properties?.columns || [];
  const rows: any[][] = resp?.properties?.rows || [];
  const lower = cols.map((c) => String(c?.name || '').toLowerCase());
  const iCost = lower.indexOf('cost');
  const NON_VALUE = new Set(['cost', 'currency', 'usagedate', 'resourcegroupname']);
  const iVal = lower.findIndex((n) => !NON_VALUE.has(n));
  if (iVal < 0) return [];
  const m = new Map<string, number>();
  for (const r of rows) {
    const v = String(r[iVal] ?? '').trim();
    if (!v) continue; // untagged spend is not an addressable tag scope
    m.set(v, (m.get(v) || 0) + (iCost >= 0 ? Number(r[iCost]) || 0 : 0));
  }
  return Array.from(m.entries())
    .map(([value, cost]) => ({ value, cost }))
    .sort((a, b) => b.cost - a.cost);
}

// ---------------------------------------------------------------------------
// live enumerators (cached under the shared C1 posture)
// ---------------------------------------------------------------------------

/**
 * Every scope a Loom cost pull can roll up: the Loom subscriptions (env +
 * attached-registry) and every distinct resource group carrying a Loom
 * resource. Bounded + cached ('cost' counter; 15 min TTL).
 */
export async function enumerateScopes(): Promise<CostScope[]> {
  const { value } = await getOrComputeCached(
    costKey(loomScopeLabel(), 'None', 'scopes'),
    'cost-mgmt',
    async () => {
      const subs = await loomCostSubscriptions();
      let resourceIds: string[] = [];
      try {
        resourceIds = (await listResources()).map((r) => r.id);
      } catch {
        resourceIds = []; // inventory unavailable → subscription scopes still return
      }
      return scopesFromInventory(subs, resourceIds, MAX_COST_SCOPES);
    },
    COST_CACHE_OPTS,
  );
  return value;
}

/**
 * The distinct values of a cost-allocation tag across every Loom subscription
 * — one real Cost Management `query` per sub grouped on the TagKey (through
 * the shared throttle-aware loop), folded + bounded. An unauthorized / absent
 * sub degrades to the other subs' values (best-effort per sub); a tenant with
 * no such tag returns [] honestly.
 */
export async function tagScope(tagKey: string): Promise<CostScope[]> {
  const key = (tagKey || '').trim();
  if (!key) return [];
  const { value } = await getOrComputeCached(
    costKey(loomScopeLabel(), 'MonthToDate', `tag:${key.toLowerCase()}`),
    'cost-mgmt',
    async () => {
      const subs = await loomCostSubscriptions();
      const deadline = Date.now() + COST_CACHE_OPTS.budgetMs;
      const merged = new Map<string, number>();
      await Promise.all(subs.map(async (sub) => {
        try {
          const resp = await runCostQuery(sub, {
            type: 'ActualCost',
            timeframe: 'MonthToDate',
            dataset: {
              granularity: 'None',
              aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
              grouping: [{ type: 'TagKey', name: key }],
            },
          }, deadline);
          for (const { value: v, cost } of tagValuesFromQueryResponse(resp)) {
            merged.set(v, (merged.get(v) || 0) + cost);
          }
        } catch { /* per-sub best-effort — other subs still contribute */ }
      }));
      return Array.from(merged.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_COST_SCOPES)
        .map(([v]): CostScope => ({
          kind: 'tag',
          scope: `tag:${key}=${v}`,
          label: `${key} = ${v}`,
          tagKey: key,
          tagValue: v,
        }));
    },
    COST_CACHE_OPTS,
  );
  return value;
}
