/**
 * GET /api/admin/finops/breakdown — C4 FinOps hub per-scope spend breakdown.
 *
 * Real Cost Management rollups (no mocks — no-vaporware): the cached Loom cost
 * summary (getLoomCostSummaryCached — C1) already folds real spend by service,
 * resource group, subscription, resource type, and the cost-allocation tag
 * (loom-domain). Returns the requested dimension so the hub's Breakdown section
 * charts real $ tied to the chargeback model.
 *
 *   ?dimension = service (default) | resourceGroup | subscription | resourceType | tag
 *   ?timeframe = MonthToDate (default) | BillingMonthToDate | TheLastMonth | Last7Days | Last30Days
 *
 * Tenant-admin gated. Honest 503 gate when Cost Management is unconfigured.
 */
import { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiServerError } from '@/lib/api/respond';
import {
  getLoomCostSummaryCached,
  MonitorError,
  MonitorNotConfiguredError,
  type CostTimeframe,
  type CostBreakdownRow,
} from '@/lib/azure/cost-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const TIMEFRAMES: CostTimeframe[] = ['MonthToDate', 'BillingMonthToDate', 'TheLastMonth', 'Last7Days', 'Last30Days'];
const DIMENSIONS = ['service', 'resourceGroup', 'subscription', 'resourceType', 'tag'] as const;
type Dimension = (typeof DIMENSIONS)[number];

const DIM_FIELD: Record<Dimension, 'byService' | 'byResourceGroup' | 'bySubscription' | 'byResourceType' | 'byTag'> = {
  service: 'byService',
  resourceGroup: 'byResourceGroup',
  subscription: 'bySubscription',
  resourceType: 'byResourceType',
  tag: 'byTag',
};

export const GET = withTenantAdmin(async (req: NextRequest) => {
  const q = req.nextUrl.searchParams;
  const tfParam = (q.get('timeframe') || 'MonthToDate') as CostTimeframe;
  const timeframe: CostTimeframe = TIMEFRAMES.includes(tfParam) ? tfParam : 'MonthToDate';
  const dimParam = (q.get('dimension') || 'service') as Dimension;
  const dimension: Dimension = DIMENSIONS.includes(dimParam) ? dimParam : 'service';

  try {
    const summary = (await getLoomCostSummaryCached({ timeframe })).value;
    const rows: CostBreakdownRow[] = (summary[DIM_FIELD[dimension]] as CostBreakdownRow[]) || [];
    return apiOk({
      dimension,
      timeframe,
      currency: summary.currency,
      total: summary.monthToDate,
      tagKey: summary.tagKey,
      subscriptionNames: summary.subscriptionNames,
      rows: rows.slice(0, 100),
    });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return apiOk({ dimension, timeframe, rows: [], gate: { missing: e.missing, message: e.message } });
    }
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
      return apiOk({
        dimension, timeframe, rows: [],
        gate: {
          missing: ['Cost Management Reader'],
          message: 'The Console UAMI cannot read Cost Management. Grant it "Cost Management Reader" at subscription scope (cost-management-reader-rbac.bicep).',
        },
      });
    }
    return apiServerError(e, 'Failed to load the cost breakdown', 'finops_breakdown_failed');
  }
});
