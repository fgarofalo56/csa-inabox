/**
 * POST /api/monitor/metrics — Azure Monitor platform metric time-series
 * for one Loom resource.
 *
 * Body: { resourceId, metricNames: string[], timespan?, interval?, aggregation? }
 * Backend: GET {resourceId}/providers/microsoft.insights/metrics (real REST).
 * Shape: { ok, data: { results: MetricResult[] }, error? }
 *
 * POST (not GET) so the resourceId + metric list travel in the body rather
 * than a long query string — the metrics tab requests several metrics per
 * resource.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  fetchMetrics, MonitorNotConfiguredError, MonitorError,
} from '@/lib/azure/monitor-client';
import { buildScopedCacheKey, getOrComputeCached, resolveBackendTtl } from '@/lib/azure/query-result-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const resourceId = typeof body?.resourceId === 'string' ? body.resourceId.trim() : '';
  const metricNames = Array.isArray(body?.metricNames)
    ? body.metricNames.filter((m: unknown) => typeof m === 'string' && m)
    : [];
  if (!resourceId) return NextResponse.json({ ok: false, error: 'resourceId required' }, { status: 400 });
  if (!metricNames.length) return NextResponse.json({ ok: false, error: 'metricNames required' }, { status: 400 });

  const timespan = typeof body?.timespan === 'string' ? body.timespan : undefined;
  const interval = typeof body?.interval === 'string' ? body.interval : undefined;
  const aggregation = typeof body?.aggregation === 'string' ? body.aggregation : undefined;
  const refresh = body?.refresh === true || body?.refresh === '1';

  try {
    // Multi-metric Azure Monitor time-series fetch — idempotent + re-requested on
    // tab/timespan flips. Served stale-while-revalidate on a short 90s window
    // (LOOM_QUERY_CACHE_TTL_MS_MONITOR), keyed by the full metric request body.
    const { value, meta } = await getOrComputeCached(
      buildScopedCacheKey('monitor/metrics', { resourceId, metricNames: [...metricNames].sort(), timespan, interval, aggregation }),
      'monitor',
      async () => ({ results: await fetchMetrics({ resourceId, metricNames, timespan, interval, aggregation }) }),
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
