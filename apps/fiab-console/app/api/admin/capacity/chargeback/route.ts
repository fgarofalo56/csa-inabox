/**
 * GET /api/admin/capacity/chargeback?timeframe=MonthToDate
 *
 * The unified capacity + chargeback rollup for the whole Loom deployment — the
 * Azure-native 1:1 of the Fabric Capacity Metrics app. Tenant-admin gated
 * (requireTenantAdmin): this rolls up cost + consumption ACROSS every workspace
 * in the tenant, so it is an org-wide admin surface, not per-user.
 *
 * Backend (real, no mocks — per no-vaporware.md):
 *   - Azure Cost Management  (Microsoft.CostManagement/query)  → $ by service,
 *     by workspace (chargeback), daily series + forecast.
 *   - Azure Monitor metrics (microsoft.insights/metrics)       → normalized CU
 *     (Synapse DWU, ADX CPU, Container Apps vCPU, Azure OpenAI tokens, ASA SU%).
 *
 * Shape:
 *   { ok:true, data: ChargebackModel }
 *   { ok:false, gate:{ missing, message } }   ← honest 503 (role/scope unset)
 *   { ok:false, error }                        ← other failure
 *
 * A 401/403 (UAMI lacks Cost Management Reader), a 404 (no Cost Management offer
 * for the subscription — common in some Gov CSP tenants), or an unconfigured
 * billing scope returns a 503 honest gate naming the exact remediation — so the
 * dashboard deploys and shows a "grant Cost Management Reader" state out of the
 * box, then lights up once granted.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import {
  getChargebackModel,
  billingScope,
  MonitorError,
  MonitorNotConfiguredError,
  type ChargebackOptions,
} from '@/lib/azure/cost-management-client';
import type { CostTimeframe } from '@/lib/azure/cost-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Cost Management is QPU-throttled; allow the backoff retries + Monitor fan-out
// to land inside the gateway window.
export const maxDuration = 90;

const TIMEFRAMES: CostTimeframe[] = ['MonthToDate', 'BillingMonthToDate', 'TheLastMonth', 'Last7Days', 'Last30Days'];

function costGate() {
  return NextResponse.json(
    {
      ok: false,
      gate: {
        missing: ['Cost Management Reader', 'LOOM_BILLING_SCOPE'],
        message:
          'The unified capacity + chargeback dashboard needs read access to Azure Cost Management. ' +
          'Grant the Console UAMI the "Cost Management Reader" role (72fafb9e-0641-4937-9268-a91bfd8191a3) ' +
          'at the subscription (or billing) scope, and set LOOM_BILLING_SCOPE to the scope the rollup should ' +
          'cover. Bicep: platform/fiab/bicep/modules/admin-plane/cost-management-rbac.bicep. Utilization ' +
          '(normalized-CU) still renders from Azure Monitor once Monitoring Reader is granted.',
        scope: billingScope(),
      },
    },
    { status: 503 },
  );
}

export async function GET(req: NextRequest) {
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;

  const tfParam = (req.nextUrl.searchParams.get('timeframe') || 'MonthToDate') as CostTimeframe;
  const timeframe: CostTimeframe = TIMEFRAMES.includes(tfParam) ? tfParam : 'MonthToDate';
  const opts: ChargebackOptions = { timeframe };

  try {
    const data = await getChargebackModel(opts);
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    // Billing scope / subscription unset, or no access / no offer → honest gate.
    if (e instanceof MonitorNotConfiguredError) return costGate();
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403 || e.status === 404)) return costGate();
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
