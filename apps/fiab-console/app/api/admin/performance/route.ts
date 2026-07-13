/**
 * PSR-1 — GET /api/admin/performance
 *
 * Returns the persisted benchmark trend across recent runs:
 *   { ok:true, data:TrendModel } — per-metric p50/p95/p99 sparkline series +
 *     the run list, read from the `perf-benchmarks` Cosmos container.
 *
 * Tenant-admin gated (org-wide perf posture). Real Cosmos read, never a
 * fabricated number (no-vaporware.md). All metrics are Azure-native backends
 * (no Fabric — no-fabric-dependency.md).
 */
import { NextRequest } from 'next/server';
import { apiOk, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { CosmosNotConfiguredError } from '@/lib/azure/cosmos-client';
import { loadTrend } from '@/lib/perf/perf-store';
import { resolveMetricConfigMap } from '@/lib/perf/perf-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const maxRunsParam = Number(req.nextUrl.searchParams.get('maxRuns'));
  const maxRuns = Number.isFinite(maxRunsParam) && maxRunsParam > 0 ? Math.min(100, maxRunsParam) : 30;

  try {
    const data = await loadTrend(maxRuns);
    // Attach the LIVE server-side backend-config map so each card decides its
    // gate from current deployment env — not the last run's persisted flag.
    // This stops a configured backend from showing a stale "…is not set" gate.
    data.config = resolveMetricConfigMap(data.metrics.map((m) => m.metric));
    return apiOk({ data });
  } catch (e) {
    if (e instanceof CosmosNotConfiguredError) {
      return apiOk({
        data: { metrics: [], runs: [], generatedAt: new Date().toISOString() },
        gate: {
          missing: ['LOOM_COSMOS_ENDPOINT'],
          message:
            'The perf-benchmarks trend store lives in Cosmos. Set LOOM_COSMOS_ENDPOINT and grant ' +
            'the Console UAMI Cosmos DB Built-in Data Contributor. No run has been persisted yet.',
        },
      });
    }
    return apiServerError(e, 'Failed to load benchmark trend');
  }
}
