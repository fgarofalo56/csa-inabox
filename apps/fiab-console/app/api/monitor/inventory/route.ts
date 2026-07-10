/**
 * GET /api/monitor/inventory — the Loom-deployed Azure resource inventory.
 *
 * Backend: ARM "list resources in RG" across every Loom RG (real Azure REST).
 *
 * Shape: { ok, data: { resources: LoomResource[] }, error? }
 * Honest gate: 200 { ok:false, gate } when LOOM_SUBSCRIPTION_ID / Loom RGs
 * aren't configured.
 *
 * PERF: this route deliberately does NOT join Resource Health inline. The
 * whole-subscription Microsoft.ResourceHealth availabilityStatuses crawl is a
 * slow, serial, paginated call (up to 20 round-trips) and was the dominant
 * cost of the Monitor first paint. Health now lives behind its own
 * /api/monitor/health route and the client fetches it in parallel, merging
 * badges into the (instantly rendered) inventory grid as they arrive.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listResources, MonitorNotConfiguredError, MonitorError,
} from '@/lib/azure/monitor-client';
import { buildScopedCacheKey, getOrComputeCached, resolveBackendTtl } from '@/lib/azure/query-result-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req?: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const refresh = req?.nextUrl?.searchParams.get('refresh') === '1';
  try {
    // Whole-estate ARM resource crawl — the dominant cost of Monitor's first paint.
    // Served stale-while-revalidate on a short 90s window (LOOM_QUERY_CACHE_TTL_MS_MONITOR).
    const { value, meta } = await getOrComputeCached(
      buildScopedCacheKey('monitor/inventory', {}),
      'monitor',
      async () => ({ resources: await listResources() }),
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
