/**
 * GET /api/monitor/health — current Azure Resource Health availability
 * status for every monitored resource in the Loom subscription.
 *
 * Backend: Microsoft.ResourceHealth/availabilityStatuses (real ARM REST).
 * Shape: { ok, data: { statuses: ResourceHealthStatus[] }, error? }
 * Honest gate when subscription/RGs unconfigured.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listResourceHealth, MonitorNotConfiguredError, MonitorError,
} from '@/lib/azure/monitor-client';
import { buildScopedCacheKey, getOrComputeCached, resolveBackendTtl } from '@/lib/azure/query-result-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req?: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const refresh = req?.nextUrl?.searchParams.get('refresh') === '1';
  try {
    // Whole-subscription Resource Health crawl (up to ~20 serial paginated calls).
    // Served stale-while-revalidate on a short 90s window (LOOM_QUERY_CACHE_TTL_MS_MONITOR).
    const { value, meta } = await getOrComputeCached(
      buildScopedCacheKey('monitor/health', {}),
      'monitor',
      async () => ({ statuses: Object.values(await listResourceHealth()) }),
      { ttlMs: resolveBackendTtl('monitor', 90_000), staleWhileRevalidate: true, bypass: refresh },
    );
    return NextResponse.json({ ok: true, data: value, meta });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
