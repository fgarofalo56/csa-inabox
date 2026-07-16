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

import { buildScopedCacheKey, getOrComputeCached } from '@/lib/azure/query-result-cache';

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
  const [{ getLoomCostSummary }, monitor] = await Promise.all([
    import('@/lib/azure/cost-client'),
    import('@/lib/azure/monitor-client'),
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
