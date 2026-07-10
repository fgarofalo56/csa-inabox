/**
 * WS-CHGBK — per-workspace chargeback allocation API.
 *
 * GET /api/admin/chargeback/workspaces?timeframe=MonthToDate
 *   → { ok:true, currency, timeframe, rows, totalCost, unallocatedCost,
 *       usageWindowDays, generatedAt, meta } — real Cost Management per-domain
 *     spend ALLOCATED across each domain's workspaces (usage-weighted, falling
 *     back to item-weighted / even). Each row carries its allocation `basis` so
 *     the UI is honest the figure is allocated, not directly metered.
 *   → { ok:false, gate:{ missing, message } } (503) — the SAME honest Cost
 *     Management gate as the sibling per-domain report (no fabricated numbers).
 *
 * Tenant-admin gated + SWR-cached (20-min TTL, `?refresh=1` bypass), identical
 * to /api/admin/chargeback — it re-uses that report's data, so it shares the
 * cost + rate-limit envelope.
 */
import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { apiOk } from '@/lib/api/respond';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { MonitorError } from '@/lib/azure/monitor-client';
import { getWorkspaceChargeback } from '@/lib/azure/workspace-chargeback';
import { loadOrSeedDomains } from '@/lib/azure/domain-registry';
import { buildScopedCacheKey, getOrComputeCached, resolveBackendTtl } from '@/lib/azure/query-result-cache';
import type { CostTimeframe } from '@/lib/azure/cost-client';

const CHARGEBACK_TTL_MS = () => resolveBackendTtl('costmgmt', 20 * 60_000);

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
          'The per-workspace chargeback breakdown needs read access to Azure Cost Management. Grant the ' +
          'Console UAMI the "Cost Management Reader" role (72fafb9e-0641-4937-9268-a91bfd8191a3) at the ' +
          'subscription (or billing) scope. Bicep: platform/fiab/bicep/modules/admin-plane/cost-management-rbac.bicep. ' +
          'Workspace figures are allocated from the same real per-domain spend as the domain report.',
      },
    },
    { status: 503 },
  );
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const tfParam = (req.nextUrl.searchParams.get('timeframe') || 'MonthToDate') as CostTimeframe;
  const timeframe: CostTimeframe = TIMEFRAMES.includes(tfParam) ? tfParam : 'MonthToDate';
  const tenantId = tenantScopeId(s);
  const refresh = req.nextUrl.searchParams.get('refresh') === '1';
  const cacheKey = buildScopedCacheKey('admin/chargeback/workspaces', { tenantId, timeframe });

  try {
    const { value, meta } = await getOrComputeCached(
      cacheKey,
      tenantId,
      async () => {
        const domainDoc = await loadOrSeedDomains(tenantId, s.claims.upn || s.claims.oid).catch(() => null);
        const domainNames: Record<string, string> = {};
        for (const d of domainDoc?.items || []) domainNames[d.id] = d.name;
        return getWorkspaceChargeback({ tenantId, timeframe, domainNames });
      },
      { ttlMs: CHARGEBACK_TTL_MS(), staleWhileRevalidate: true, bypass: refresh },
    );
    return apiOk({ ...value, meta });
  } catch (e) {
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403 || e.status === 404)) return costGate();
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
