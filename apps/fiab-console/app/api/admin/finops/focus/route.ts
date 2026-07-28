/**
 * B-N19e — GET /api/admin/finops/focus
 *
 * The FOCUS 1.1 cost-per-query / per-dashboard mart. Joins two REAL sources:
 *
 *   1. the BR-COSTATTR `cost-attribution` Cosmos ledger — every query run
 *      tagged with WHO / WHICH item / WHICH dashboard / how long it ran
 *      (written by `lib/finops/query-run.ts` from every execution edge), and
 *   2. Azure Cost Management — the actual metered dollars per ARM resource
 *      type, via the cached Loom cost summary (`getLoomCostSummaryCached`).
 *
 * Each run is priced by allocating its engine's real metered spend across the
 * runs recorded against that resource type, LCU-weighted (`buildFocusMart`).
 * Nothing is fabricated: when Cost Management is unavailable the mart still
 * renders with `costSource:'unmetered'` (zero dollars + the transparent LCU
 * estimate) plus an HONEST `gate` naming the `svc-cost-management` remediation,
 * so the surface degrades instead of disappearing (no-vaporware.md, G2).
 *
 *   ?days       = 1..90 (default 30) — the charge window
 *   ?groupBy    = query (default) | dashboard | item | user | engine
 *   ?itemId / ?dashboardId / ?workspaceId — optional drill-down scope
 *   ?timeframe  = MonthToDate (default) | BillingMonthToDate | TheLastMonth
 *                 | Last7Days | Last30Days   (the Cost Management window)
 *   ?format=csv → the mart as FOCUS-column-named CSV (text/csv attachment)
 *   ?refresh=1  → bypass the shared cost cache
 *
 * Tenant-admin gated. Azure-native end to end (no Fabric dependency).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiServerError } from '@/lib/api/respond';
import { tenantScopeId } from '@/lib/auth/session';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import {
  getLoomCostSummaryCached,
  loomScopeLabel,
  MonitorError,
  MonitorNotConfiguredError,
  type CostSummary,
  type CostTimeframe,
} from '@/lib/azure/cost-client';
import { queryRunAttributionRows } from '@/lib/azure/cost-attribution';
import {
  FOCUS_QUERY_ENGINES,
  buildFocusMart,
  focusCsv,
  rollupFocus,
  type FocusGroupBy,
  type FocusRunInput,
} from '@/lib/finops/focus-mart';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const TIMEFRAMES: CostTimeframe[] = ['MonthToDate', 'BillingMonthToDate', 'TheLastMonth', 'Last7Days', 'Last30Days'];
const GROUPS: FocusGroupBy[] = ['query', 'dashboard', 'item', 'user', 'engine'];

/** The honest gate this surface renders when Cost Management can't be read. */
const COST_GATE = {
  id: 'svc-cost-management',
  missing: ['Cost Management Reader on the Loom subscription(s)'],
  message:
    'Azure Cost Management could not be read, so per-query cost is shown as recorded consumption '
    + '(Loom Capacity Units) only — no dollars are estimated. Grant the Console UAMI "Cost Management '
    + 'Reader" at subscription scope (the push-button deploy grants it automatically) and the same '
    + 'rows will carry real allocated spend.',
} as const;

export const GET = withTenantAdmin(async (req: NextRequest, { session }) => {
  const q = req.nextUrl.searchParams;
  const days = Math.max(1, Math.min(90, Number(q.get('days') || '30') || 30));
  const tfParam = (q.get('timeframe') || 'MonthToDate') as CostTimeframe;
  const timeframe: CostTimeframe = TIMEFRAMES.includes(tfParam) ? tfParam : 'MonthToDate';
  const gbParam = (q.get('groupBy') || 'query') as FocusGroupBy;
  const groupBy: FocusGroupBy = GROUPS.includes(gbParam) ? gbParam : 'query';
  const itemId = q.get('itemId') || undefined;
  const dashboardId = q.get('dashboardId') || undefined;
  const workspaceId = q.get('workspaceId') || undefined;
  const wantsCsv = (q.get('format') || '').toLowerCase() === 'csv';
  const refresh = q.get('refresh') === '1';
  const tenantId = tenantScopeId(session);

  // Kill-switch (default-ON, fail-open): OFF returns a guided "turned off" body
  // rather than a broken panel.
  if (!(await runtimeFlag('n19e-focus-cost-attribution'))) {
    return NextResponse.json({
      ok: false,
      error: 'FOCUS cost attribution is turned off (runtime flag n19e-focus-cost-attribution).',
      hint: 'Re-enable it on /admin/runtime-flags. Query runs are still recorded to the attribution ledger.',
    }, { status: 503 });
  }

  try {
    // Real ledger read — the per-run detail the mart needs.
    const runs = await queryRunAttributionRows(tenantId, {
      windowDays: days,
      engines: FOCUS_QUERY_ENGINES,
      itemId,
      dashboardId,
      workspaceId,
    });

    // Real Cost Management read — degraded (not failed) when access is missing.
    let summary: CostSummary | null = null;
    let gate: typeof COST_GATE | null = null;
    try {
      summary = (await getLoomCostSummaryCached({ timeframe, bypass: refresh })).value;
    } catch (e) {
      if (e instanceof MonitorError || e instanceof MonitorNotConfiguredError) gate = COST_GATE;
      else throw e;
    }

    const costByResourceType: Record<string, number> = {};
    for (const row of summary?.byResourceType || []) {
      costByResourceType[(row.key || '').toLowerCase()] = Number(row.cost) || 0;
    }

    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - days * 24 * 3600 * 1000);

    const mart = buildFocusMart({
      runs: runs as unknown as FocusRunInput[],
      costByResourceType,
      costManagementAvailable: !!summary,
      currency: summary?.currency || 'USD',
      billingAccountId: process.env.LOOM_BILLING_SCOPE || loomScopeLabel(),
      billingAccountName: loomScopeLabel(),
      subAccountNames: summary?.subscriptionNames || {},
      // FOCUS: BillingPeriodEnd / ChargePeriodEnd are EXCLUSIVE.
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      windowDays: days,
    });

    if (wantsCsv) {
      return new NextResponse(focusCsv(mart.rows), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'cache-control': 'no-store',
          'content-disposition':
            `attachment; filename="loom-focus-${mart.specVersion}-${days}d-${periodEnd.toISOString().slice(0, 10)}.csv"`,
          'x-loom-focus-version': mart.specVersion,
          'x-loom-focus-rows': String(mart.rows.length),
          'x-loom-focus-cost-source': mart.costSource,
        },
      });
    }

    return apiOk({
      groupBy,
      timeframe,
      mart: {
        specVersion: mart.specVersion,
        currency: mart.currency,
        totalBilledCost: mart.totalBilledCost,
        totalEffectiveCost: mart.totalEffectiveCost,
        totalEstimatedCost: mart.totalEstimatedCost,
        unattributedCost: mart.unattributedCost,
        unattributed: mart.unattributed,
        costSource: mart.costSource,
        runCount: mart.runCount,
        windowDays: mart.windowDays,
        periodStart: mart.periodStart,
        periodEnd: mart.periodEnd,
        generatedAt: mart.generatedAt,
      },
      // The panel charts + tables the rollup; the full row set is the CSV export.
      rows: rollupFocus(mart.rows, groupBy).slice(0, 200),
      ...(gate ? { gate } : {}),
    });
  } catch (e) {
    return apiServerError(e, 'Failed to build the FOCUS cost mart');
  }
});
