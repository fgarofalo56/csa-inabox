/**
 * GET /api/monitor/activity?days=7 — recent ARM Activity Log events for the
 * Loom resource groups (deployments, role changes, scale operations).
 *
 * NOTE: distinct from /api/activity, which is the Cosmos-backed *item*
 * activity feed (edits/comments/shares). This one is the Azure control-plane
 * Activity Log — "who changed infrastructure".
 *
 * Backend: GET .../Microsoft.Insights/eventtypes/management/values (real REST).
 * Shape: { ok, data: { events: ActivityLogEvent[] }, error? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listActivityLog, MonitorNotConfiguredError, MonitorError,
} from '@/lib/azure/monitor-client';
import { FetchTimeoutError } from '@/lib/azure/fetch-with-timeout';
import { buildScopedCacheKey, getOrComputeCached, resolveBackendTtl } from '@/lib/azure/query-result-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get('days')) || 7));
  const refresh = req.nextUrl.searchParams.get('refresh') === '1';
  try {
    // Paginated control-plane Activity Log crawl across every Loom RG — slow.
    // Served stale-while-revalidate on a short 90s window (LOOM_QUERY_CACHE_TTL_MS_MONITOR).
    const { value, meta } = await getOrComputeCached(
      buildScopedCacheKey('monitor/activity', { days }),
      'monitor',
      async () => ({ events: await listActivityLog({ days }) }),
      { ttlMs: resolveBackendTtl('monitor', 90_000), staleWhileRevalidate: true, bypass: refresh },
    );
    return NextResponse.json({ ok: true, data: value, meta });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
    }
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: ['Monitoring Reader'],
          message:
            'The Console identity cannot read the Azure Activity Log. Grant the Console UAMI '
            + '"Monitoring Reader" (or Reader) on the Loom subscriptions so the Activity log can '
            + 'enumerate control-plane events across the admin and DLZ resource groups.',
        },
      });
    }
    // A bare transport failure (DNS / network / timeout) surfaces as the cryptic
    // "fetch failed" / FetchTimeoutError. Return an honest, actionable message
    // (HTTP 200 so the pane shows a MessageBar, never an unhandled error banner).
    const msg = (e as Error)?.message || String(e);
    if (e instanceof FetchTimeoutError || /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|aborted/i.test(msg)) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: [],
          message:
            'Could not reach Azure Resource Manager to read the Activity Log (the request failed or '
            + 'timed out). Confirm the Console container app has outbound network access to ARM and '
            + 'that LOOM_SUBSCRIPTION_ID / LOOM_DLZ_SUBSCRIPTION_ID are correct, then retry.',
        },
      });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
