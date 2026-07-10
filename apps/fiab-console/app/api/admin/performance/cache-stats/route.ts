/**
 * PSR-5 / PSR-6 — GET /api/admin/performance/cache-stats
 *
 * Live result-cache telemetry for the PSR-1 perf surface: the per-backend cache
 * hit/miss counters (`cache-counters.ts`) + the result-cache tier config
 * (`queryCacheStats`) + the KPI metadata (target hit-rate). Real in-process
 * numbers, never fabricated (no-vaporware.md); all Azure-native (no Fabric —
 * no-fabric-dependency.md).
 *
 * Tenant-admin gated (org-wide perf posture) — same authz as the sibling
 * GET /api/admin/performance trend route.
 */
import { apiOk, apiUnauthorized } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { queryCacheStats } from '@/lib/azure/query-result-cache';
import { cacheCountersSnapshot } from '@/lib/perf/cache-counters';
import { CACHE_HIT_RATE_KPI } from '@/lib/perf/perf-metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  return apiOk({
    kpi: CACHE_HIT_RATE_KPI,
    resultCache: queryCacheStats(),
    counters: cacheCountersSnapshot(),
  });
}
