/**
 * BR-COSTATTR — cost-attribution rollup API (per-user / per-engine / per-domain).
 *
 * GET /api/admin/chargeback/attribution?days=30&domainId=<optional>
 *   → { ok:true, rollup: AttributionRollup } — real per-execution attribution
 *     folded into per-user / per-engine / per-domain LCU + USD-estimate rollups,
 *     over the last `days`, optionally scoped to one domain (the FGC-28 chargeback
 *     page's per-domain drill-down).
 *
 * Tenant-admin gated. Real Cosmos read — an honest empty rollup when nothing has
 * been recorded yet, never fabricated numbers (no-vaporware).
 */
import { NextRequest } from 'next/server';
import { apiOk, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { queryAttributionRollup } from '@/lib/azure/cost-attribution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const days = Math.max(1, Math.min(90, Number(req.nextUrl.searchParams.get('days') || '30') || 30));
  const domainId = req.nextUrl.searchParams.get('domainId') || undefined;

  try {
    const rollup = await queryAttributionRollup(tenantScopeId(s), { windowDays: days, domainId });
    return apiOk({ rollup });
  } catch (e) {
    return apiServerError(e, 'Failed to load cost attribution');
  }
}
