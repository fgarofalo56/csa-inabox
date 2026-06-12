/**
 * GET /api/admin/usage/cost — per-domain + per-subscription cost rollup for the
 * Loom deployment (D4 chargeback). Real Microsoft.CostManagement query REST,
 * scoped to the Loom resource groups and grouped by the `csa-loom-domain` tag
 * that dlz-attach stamps on every DLZ resource.
 *
 * Query params:
 *   - timeframe  one of CostTimeframe (default MonthToDate)
 *   - domain     restrict the whole summary to a single domain (drill-down)
 *   - format     'csv' → text/csv chargeback export of the byDomain + bySub rows
 *
 * Shape: { ok, data: CostSummary } | { ok:false, gate } | { ok:false, error }
 *        | (format=csv) text/csv attachment
 *
 * No Microsoft Fabric required — Cost Management Query + Consumption budgets are
 * Azure-native and work on Commercial, GCC, GCC-High, and IL5 via armBase().
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getLoomCostSummary, type CostTimeframe, type CostSummary } from '@/lib/azure/cost-client';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The multi-sub CostManagement aggregation (now 7 concurrent groupings) can take
// a while under throttling; raise the per-invocation budget above the platform
// default so it completes server-side rather than being cut to a 504.
export const maxDuration = 120;

const TIMEFRAMES: CostTimeframe[] = ['MonthToDate', 'BillingMonthToDate', 'TheLastMonth', 'Last7Days', 'Last30Days'];

/** RFC-4180-ish CSV cell quoting. */
function csvCell(v: string | number): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build the chargeback CSV export from a CostSummary. */
function buildCsv(data: CostSummary): string {
  const lines: string[] = [];
  lines.push(`# CSA Loom chargeback export — timeframe ${data.timeframe} — currency ${data.currency}`);
  lines.push('scope,key,cost');
  for (const r of data.byDomain) lines.push(['domain', csvCell(r.key), r.cost].join(','));
  for (const r of data.bySubscription) lines.push(['subscription', csvCell(r.key), r.cost].join(','));
  for (const r of data.byResourceGroup) lines.push(['resourceGroup', csvCell(r.key), r.cost].join(','));
  for (const b of data.budgets) {
    lines.push(['budget', csvCell(`${b.name} (${b.subscription})`), b.currentSpend].join(','));
  }
  return lines.join('\n');
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const tfParam = req.nextUrl.searchParams.get('timeframe') as CostTimeframe | null;
  const timeframe = tfParam && TIMEFRAMES.includes(tfParam) ? tfParam : 'MonthToDate';
  const domain = (req.nextUrl.searchParams.get('domain') || '').trim() || undefined;
  const format = (req.nextUrl.searchParams.get('format') || '').trim().toLowerCase();

  try {
    const data = await getLoomCostSummary({ timeframe, domain });
    if (format === 'csv') {
      const csv = buildCsv(data);
      const stamp = new Date().toISOString().slice(0, 10);
      const fname = `loom-chargeback-${domain ? `${domain}-` : ''}${timeframe}-${stamp}.csv`;
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${fname}"`,
          'cache-control': 'no-store',
        },
      });
    }
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
            'The Console UAMI cannot read Cost Management. Grant it "Cost Management Reader" (or Reader) on the subscription so the chargeback rollup can query per-domain + per-subscription spend.',
        },
      });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
