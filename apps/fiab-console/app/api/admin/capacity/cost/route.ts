/**
 * GET /api/admin/capacity/cost?resourceId=<ARM resource id>
 *
 * Month-to-date Azure Cost Management spend for ONE inventory resource — the
 * "$/mo" column on /admin/capacity. Real Microsoft.CostManagement query REST
 * scoped to the resource via a ResourceId dimension filter (no mocks).
 *
 * Shape: { ok:true, cost, currency, timeframe }
 *      | { ok:false, gate:{ missing, message } }   ← honest infra-gate (200)
 *      | { ok:false, error }                        ← other failure
 *
 * A 401/403 (UAMI lacks Cost Management Reader) returns a 200 gate — not an
 * error page — so each row can render a "⚠ No access" badge instead of failing
 * the whole table.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getResourceMonthlyCost } from '@/lib/clients/cost-client';
import { MonitorError } from '@/lib/azure/monitor-client';
import { canAccessDlzPanes } from '@/lib/auth/domain-role';
import { loadTenantDomains } from '@/lib/auth/load-domains';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Cost Management is QPU-throttled; allow a couple of backoff retries to land.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // D2: the DLZ cost pane is tenant-admin (global) or domain-admin (their domain's
  // workspaces) only — domain contributors and unprivileged users can't read it.
  const domains = await loadTenantDomains(s.claims.oid);
  if (!(await canAccessDlzPanes(s, domains))) {
    return NextResponse.json(
      {
        ok: false,
        error: 'forbidden',
        reason:
          'The Data Landing Zone cost pane is available to tenant admins and domain admins only. A tenant admin can grant you a domain admin Entra group at /admin/permissions (Domain access).',
      },
      { status: 403 },
    );
  }

  const resourceId = (req.nextUrl.searchParams.get('resourceId') || '').trim();
  if (!resourceId) return NextResponse.json({ ok: false, error: 'resourceId required' }, { status: 400 });

  try {
    const { cost, currency, timeframe } = await getResourceMonthlyCost(resourceId);
    return NextResponse.json({ ok: true, cost, currency, timeframe });
  } catch (e) {
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: ['Cost Management Reader'],
          message:
            'The Console UAMI cannot read Cost Management. Grant it "Cost Management Reader" (or Reader) on the subscription so the cost column can show month-to-date spend per resource. Bicep: platform/fiab/bicep/modules/admin-plane/cost-management-reader-rbac.bicep.',
        },
      });
    }
    // A subscription with no Cost Management offer (e.g. CSP in some Gov
    // tenants) returns 404/NotFound — surface as an honest gate, not a crash.
    if (e instanceof MonitorError && e.status === 404) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: ['Cost Management offer'],
          message:
            'Cost Management is not available for this subscription/offer (common for some Azure Government CSP tenants). Utilization metrics below still reflect live Azure Monitor data.',
        },
      });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
