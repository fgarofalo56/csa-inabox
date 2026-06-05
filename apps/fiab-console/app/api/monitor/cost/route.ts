/**
 * GET /api/monitor/cost — Azure Cost Management spend for the Loom deployment
 * (Monitor Cost tab, M3). Real Microsoft.CostManagement query REST scoped to
 * the Loom resource groups: month-to-date by service + RG, daily series, and a
 * linear month-end forecast.
 *
 * Shape: { ok, data: CostSummary } | { ok:false, gate } | { ok:false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getLoomCostSummary, type CostTimeframe } from '@/lib/azure/cost-client';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIMEFRAMES: CostTimeframe[] = ['MonthToDate', 'BillingMonthToDate', 'TheLastMonth', 'Last7Days', 'Last30Days'];

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tfParam = req.nextUrl.searchParams.get('timeframe') as CostTimeframe | null;
  const timeframe = tfParam && TIMEFRAMES.includes(tfParam) ? tfParam : 'MonthToDate';
  try {
    const data = await getLoomCostSummary({ timeframe });
    return NextResponse.json({ ok: true, data });
  } catch (e) {
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
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
