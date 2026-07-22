/**
 * GET /api/monitor/cost — Azure Cost Management spend for the Loom deployment
 * (Monitor Cost tab, M3). Real Microsoft.CostManagement query REST scoped to
 * the Loom resource groups: total by service / RG / SUBSCRIPTION / resource /
 * region / cost-allocation TAG, resolved subscription DISPLAY NAMES, the daily
 * series + a linear month-end forecast, and daily-spend ANOMALIES.
 *
 * Shape: { ok, data: CostSummary } | { ok:false, gate } | { ok:false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getLoomCostSummaryCached, type CostTimeframe } from '@/lib/azure/cost-client';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';
import { apiServerError } from '@/lib/api/respond';
import { ComputeBudgetExceededError } from '@/lib/azure/query-result-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The multi-sub CostManagement aggregation (now parallelized) can still take a
// while under throttling; raise the per-invocation budget above the platform
// default so it completes server-side rather than being cut to a 504.
export const maxDuration = 120;

const TIMEFRAMES: CostTimeframe[] = ['MonthToDate', 'BillingMonthToDate', 'TheLastMonth', 'Last7Days', 'Last30Days'];

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tfParam = req.nextUrl.searchParams.get('timeframe') as CostTimeframe | null;
  const timeframe = tfParam && TIMEFRAMES.includes(tfParam) ? tfParam : 'MonthToDate';
  const refresh = req.nextUrl.searchParams.get('refresh') === '1';
  try {
    // Serve-from-cache-first (15 min fresh, SWR after): the multi-sub Cost
    // Management aggregation can outlive Front Door's ~60s edge budget on a
    // cold read — cached, the tab paints in milliseconds and one background
    // refresh serves every user (cost data isn't per-user). C1: the cache now
    // lives IN cost-client (shared 'cost-mgmt' posture: 15 min TTL, 45s inline
    // budget, serveStaleOnError, 'cost' hit-rate counter) so the chargeback
    // model / report bindings / this tab all share ONE cached pull per
    // timeframe instead of each burning the Cost Management QPU quota.
    const { value, meta } = await getLoomCostSummaryCached({ timeframe, bypass: refresh });
    const res = NextResponse.json({ ok: true, data: value, meta });
    // X-Cache lets a curl receipt show miss→hit without parsing the body.
    res.headers.set('X-Cache', meta.hit ? (meta.stale ? 'stale' : 'hit') : 'miss');
    return res;
  } catch (e) {
    if (e instanceof ComputeBudgetExceededError) {
      // Cold aggregation exceeded the inline budget: the read-warmer (and the
      // request's own background refresh) will populate the cache shortly —
      // tell the tab honestly instead of letting Front Door 504 with HTML.
      return NextResponse.json({
        ok: false,
        warming: true,
        error: 'Cost data is still aggregating for this deployment — the first load takes a minute. It will appear automatically; retry shortly.',
      }, { status: 202 });
    }
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
    }
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: ['Cost Management Reader'],
          message:
            'The Console UAMI cannot read Cost Management. Grant it "Cost Management Reader" (or Reader) on the subscription so the Cost tab can query month-to-date spend + forecast.',
        },
      });
    }
    // Other MonitorErrors carry an honest, non-500 status (e.g. upstream 429/503)
    // and a safe message — surface them; genuine internal failures are
    // genericized + logged via apiServerError so nothing leaks to the client.
    if (e instanceof MonitorError && e.status !== 500) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    return apiServerError(e, 'Failed to load cost summary', 'cost_query_failed');
  }
}
