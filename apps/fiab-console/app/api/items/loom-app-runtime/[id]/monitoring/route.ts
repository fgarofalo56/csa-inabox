/**
 * GET /api/items/loom-app-runtime/[id]/monitoring?window=PT6H
 *   → { resourceId, metrics: MetricResult[], cost?: { amount, currency, days } }
 *
 * Per-app monitoring (APP-W5 S4) — reuses the platform Monitor primitives
 * scoped to THIS app's Container App:
 *   - fetchMetrics (Azure Monitor) for Requests / Replicas / CPU / Memory
 *   - the cost-client byResource breakdown filtered to the app's ACA resource
 * Logs are already served by the sibling /logs route. Honest-gates when the app
 * isn't deployed or when Monitor/Cost isn't wired (each sub-read degrades
 * independently — a metrics failure never blanks the cost figure).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { readAppRuntime, LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';
import { appContainerResourceId } from '@/lib/azure/loom-apps-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const APP_METRICS = ['Requests', 'Replicas', 'UsageNanoCores', 'WorkingSetBytes'];

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    const rt = readAppRuntime(access.item);
    if (!rt.containerAppName) {
      return apiError('The app is not deployed yet — Deploy it to see metrics + cost.', 409, { code: 'not_deployed' });
    }

    let resourceId = '';
    try { resourceId = appContainerResourceId(rt.containerAppName); }
    catch (e: any) { return apiError(e?.message || 'Loom Apps runtime not configured.', 503, { code: 'not_configured' }); }

    const timespan = (req.nextUrl.searchParams.get('window') || 'PT6H').trim();

    // Metrics + cost degrade independently. Cost is a cross-subscription Cost
    // Management scan that can exceed the client's 20s budget and blank the whole
    // tab (live receipt 2026-07-19) — so it gets its OWN short internal deadline;
    // when it's slow the tab still renders metrics + an honest "open full
    // Monitor" cost note instead of a whole-request timeout.
    const withDeadline = <T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> =>
      Promise.race([p, new Promise<T>((res) => setTimeout(() => res(onTimeout), ms))]);

    const [metrics, cost] = await Promise.all([
      (async () => {
        try {
          const { fetchMetrics } = await import('@/lib/azure/monitor-client');
          return await fetchMetrics({ resourceId, metricNames: APP_METRICS, timespan, aggregation: 'Average' });
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
      })(),
      withDeadline(
        (async () => {
          try {
            const { getLoomCostSummary } = await import('@/lib/azure/cost-client');
            const summary = await getLoomCostSummary({ timeframe: 'MonthToDate' });
            const tail = rt.containerAppName || '';
            const row = (summary.byResource || []).find((r) => r.key === tail || (tail && r.key.endsWith(tail)));
            return row
              ? { amount: row.cost, currency: summary.currency, timeframe: 'MonthToDate' }
              : { amount: 0, currency: summary.currency, timeframe: 'MonthToDate', note: 'No cost recorded yet (autoscale-to-zero apps rest at ~$0).' };
          } catch (e: any) {
            return { error: e?.message || String(e) };
          }
        })(),
        12_000,
        { error: 'Cost query is taking a while (cross-subscription scan) — see it in the full Monitor → Cost tab.' } as Record<string, unknown>,
      ),
    ]);

    return apiOk({ resourceId, containerAppName: rt.containerAppName, url: rt.url, metrics, cost });
  } catch (e) {
    return apiServerError(e, 'failed to read app monitoring');
  }
}
