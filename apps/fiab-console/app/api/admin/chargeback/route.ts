/**
 * FGC-28 — Chargeback report API (per-domain / per-department spend).
 *
 * GET /api/admin/chargeback?timeframe=MonthToDate
 *   → { ok:true, data: DomainChargebackModel, taggingEnabled } — real Azure
 *     Cost Management spend grouped by the `loom-domain` tag, joined to the
 *     governance-domains registry for display names.
 *   → { ok:false, gate:{ missing, message } } (503) — honest gate when the
 *     Console UAMI lacks Cost Management Reader, or no offer exists (some Gov
 *     CSP subs). Never a fabricated number (no-vaporware).
 *
 * Tenant-admin gated: rolls up spend across every workspace/domain in the
 * tenant. `taggingEnabled` echoes the billing.chargebackTagging toggle so the
 * page can warn when new items aren't being tagged (existing DLZ resources may
 * still carry the tag from dlz-attach, so the report still renders).
 */
import { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/respond';
import { NextResponse } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { MonitorError } from '@/lib/azure/monitor-client';
import { getDomainChargeback } from '@/lib/azure/domain-chargeback';
import { loadOrSeedDomains } from '@/lib/azure/domain-registry';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import type { CostTimeframe } from '@/lib/azure/cost-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const TIMEFRAMES: CostTimeframe[] = ['MonthToDate', 'BillingMonthToDate', 'TheLastMonth', 'Last7Days', 'Last30Days'];

function costGate() {
  return NextResponse.json(
    {
      ok: false,
      gate: {
        missing: ['Cost Management Reader', 'LOOM_BILLING_SCOPE'],
        message:
          'The chargeback report needs read access to Azure Cost Management. Grant the Console UAMI the ' +
          '"Cost Management Reader" role (72fafb9e-0641-4937-9268-a91bfd8191a3) at the subscription (or ' +
          'billing) scope. Bicep: platform/fiab/bicep/modules/admin-plane/cost-management-rbac.bicep. ' +
          'Per-domain spend appears once every DLZ resource carries the loom-domain tag (dlz-attach stamps ' +
          'it; enable Tenant settings → Billing → Per-domain chargeback tagging for new items).',
      },
    },
    { status: 503 },
  );
}

async function taggingEnabled(tenantId: string): Promise<boolean> {
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(tenantId, tenantId).read<{ settings?: Record<string, boolean> }>();
    return resource?.settings?.['billing.chargebackTagging'] === true;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const tfParam = (req.nextUrl.searchParams.get('timeframe') || 'MonthToDate') as CostTimeframe;
  const timeframe: CostTimeframe = TIMEFRAMES.includes(tfParam) ? tfParam : 'MonthToDate';
  const tenantId = tenantScopeId(s);

  try {
    // Domain display names + the tagging toggle (both best-effort, non-fatal).
    const [domainDoc, tagging] = await Promise.all([
      loadOrSeedDomains(tenantId, s.claims.upn || s.claims.oid).catch(() => null),
      taggingEnabled(tenantId),
    ]);
    const domainNames: Record<string, string> = {};
    for (const d of domainDoc?.items || []) domainNames[d.id] = d.name;

    const data = await getDomainChargeback({ timeframe, domainNames });
    return apiOk({ data, taggingEnabled: tagging });
  } catch (e) {
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403 || e.status === 404)) return costGate();
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
