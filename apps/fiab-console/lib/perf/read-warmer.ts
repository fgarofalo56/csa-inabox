/**
 * read-warmer — keeps the EXPENSIVE deployment-scoped dashboard reads warm so
 * no user ever pays the cold aggregation.
 *
 * WHY (perf directive 2026-07-15): the cold Cost Management aggregation takes
 * longer than Front Door's ~30s edge budget even in a small estate — measured
 * live: the first /api/monitor/cost read 504s at the edge while the server is
 * still aggregating, and because the request dies the cache stays empty for
 * the next user. SWR only helps once a copy EXISTS. This warmer populates and
 * re-populates the shared tier from the server side, off the request path:
 *
 *   • at startup (after a settle delay so boot isn't slowed), then
 *   • every WARM_INTERVAL_MS (default 10 min — inside every route TTL's
 *     stale-floor so served copies stay fresh-ish).
 *
 * The warm list mirrors the ROUTE cache keys exactly (same buildScopedCacheKey
 * inputs + modelId) — keep them in sync when a route's key changes. Failures
 * are logged and swallowed: warming is an optimization, never a fault source.
 * Escape hatch: LOOM_READ_WARMER_DISABLED=1.
 */

import { buildScopedCacheKey, getOrComputeCached, resolveBackendTtl } from '@/lib/azure/query-result-cache';

const SETTLE_MS = 90_000;
const WARM_INTERVAL_MS = Number(process.env.LOOM_READ_WARMER_INTERVAL_MS) || 10 * 60_000;

let started = false;
let running = false;

interface WarmTarget {
  label: string;
  key: string;
  modelId: string;
  ttlMs: number;
  produce: () => Promise<unknown>;
}

async function targets(): Promise<WarmTarget[]> {
  // Dynamic imports keep the warmer out of every route's module graph.
  const [{ getLoomCostSummary }, monitor, { getDefenderSummary }] = await Promise.all([
    import('@/lib/azure/cost-client'),
    import('@/lib/azure/monitor-client'),
    import('@/lib/azure/defender-client'),
  ]);
  return [
    {
      label: 'monitor/cost MonthToDate',
      key: buildScopedCacheKey('monitor/cost', { timeframe: 'MonthToDate' }),
      modelId: 'monitor',
      ttlMs: 15 * 60_000,
      produce: () => getLoomCostSummary({ timeframe: 'MonthToDate' }),
    },
    {
      label: 'monitor/alerts metric',
      key: buildScopedCacheKey('monitor/alerts', { kind: 'metric' }),
      modelId: 'monitor',
      ttlMs: 2 * 60_000,
      produce: () => monitor.listAlertRules(),
    },
    {
      label: 'monitor/diagnostics',
      key: buildScopedCacheKey('monitor/diagnostics', {}),
      modelId: 'monitor',
      ttlMs: 5 * 60_000,
      produce: () => monitor.getDiagnosticsCoverage(),
    },
    {
      label: 'monitor/action-groups',
      key: buildScopedCacheKey('monitor/action-groups', {}),
      modelId: 'monitor',
      ttlMs: 5 * 60_000,
      produce: () => monitor.listActionGroups(),
    },
    // 2026-07-16 live receipt: defender (secure score crawl) and health
    // (whole-subscription Resource Health, ~20 serial paginated calls) both
    // measured ~12s on a cache miss — the slowest monitor first-paints left.
    {
      label: 'monitor/defender',
      key: buildScopedCacheKey('monitor/defender', {}),
      modelId: 'monitor',
      ttlMs: 10 * 60_000,
      produce: () => getDefenderSummary(),
    },
    {
      label: 'monitor/health',
      key: buildScopedCacheKey('monitor/health', {}),
      modelId: 'monitor',
      ttlMs: 90_000,
      produce: async () => ({ statuses: Object.values(await monitor.listResourceHealth()) }),
    },
    {
      label: 'monitor/activities default',
      // Mirrors the route's DEFAULT param set (days=30, limit=200,
      // synapse on, arm off) — the shape the Monitor page first-paints with.
      key: buildScopedCacheKey('monitor/activities', { days: 30, limit: 200, includeSynapse: true, includeArmLog: false }),
      modelId: 'monitor',
      ttlMs: 3 * 60_000,
      produce: () => monitor.queryActivityFeed({ days: 30, limit: 200, includeSynapse: true, includeArmLog: false }),
    },
    ...(await chargebackTargets()),
  ];
}

/**
 * Chargeback warm targets (operator report 2026-07-17: the cross-subscription
 * Cost Management aggregation exceeds the 25s inline budget under QPU throttle,
 * so users kept landing on 202-"warming" — the cache only populated if someone
 * waited out the background compute). Warming server-side means the first user
 * click always finds a copy.
 *
 * The routes scope their keys AND modelId by tenantScopeId (= session tid) —
 * every real signed-in user shares the AAD tenant id, which the server knows as
 * AZURE_TENANT_ID. No tenant id → skip (keys would never match a real session).
 */
async function chargebackTargets(): Promise<WarmTarget[]> {
  const tenantId = process.env.AZURE_TENANT_ID;
  if (!tenantId) return [];
  const timeframe = 'MonthToDate';
  const [{ getChargebackModel }, { getDomainChargeback }, { loadOrSeedDomains }, { tenantSettingsContainer }] = await Promise.all([
    import('@/lib/azure/cost-management-client'),
    import('@/lib/azure/domain-chargeback'),
    import('@/lib/azure/domain-registry'),
    import('@/lib/azure/cosmos-client'),
  ]);
  return [
    {
      label: 'admin/capacity/chargeback MonthToDate',
      key: buildScopedCacheKey('admin/capacity/chargeback', { tenantId, timeframe }),
      modelId: tenantId,
      ttlMs: resolveBackendTtl('costmgmt', 10 * 60_000),
      produce: () => getChargebackModel({ timeframe }),
    },
    {
      label: 'admin/chargeback MonthToDate',
      key: buildScopedCacheKey('admin/chargeback', { tenantId, timeframe }),
      modelId: tenantId,
      ttlMs: resolveBackendTtl('costmgmt', 20 * 60_000),
      // Mirrors the route's closure shape { data, taggingEnabled } exactly.
      produce: async () => {
        const [domainDoc, tagging] = await Promise.all([
          loadOrSeedDomains(tenantId, 'system:read-warmer').catch(() => null),
          (async () => {
            try {
              const c = await tenantSettingsContainer();
              const { resource } = await c.item(tenantId, tenantId).read<{ settings?: Record<string, boolean> }>();
              return resource?.settings?.['billing.chargebackTagging'] === true;
            } catch { return false; }
          })(),
        ]);
        const domainNames: Record<string, string> = {};
        for (const d of domainDoc?.items || []) domainNames[d.id] = d.name;
        const data = await getDomainChargeback({ timeframe, domainNames });
        return { data, taggingEnabled: tagging };
      },
    },
  ];
}

async function warmOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const t of await targets()) {
      try {
        // bypass:true recomputes + rewrites the tiers even when a fresh copy
        // exists — the warmer's job is keeping copies YOUNG, not reading them.
        await getOrComputeCached(t.key, t.modelId, t.produce, { ttlMs: t.ttlMs, bypass: true });
      } catch (e) {
        console.warn(`[read-warmer] ${t.label} failed:`, (e as Error)?.message);
      }
    }
  } finally {
    running = false;
  }
}

/** Start the warmer loop (idempotent; called from instrumentation.ts). */
export function startReadWarmer(): void {
  if (started) return;
  if (process.env.LOOM_READ_WARMER_DISABLED === '1') return;
  started = true;
  const t1 = setTimeout(() => { void warmOnce(); }, SETTLE_MS);
  const t2 = setInterval(() => { void warmOnce(); }, WARM_INTERVAL_MS);
  // Never keep the process alive just for warming.
  t1.unref?.(); t2.unref?.();
}
