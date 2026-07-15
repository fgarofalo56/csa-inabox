/**
 * PERF-4.1 — POST /api/admin/performance/recommendations/apply
 *
 * Applies ONE recommendation for real. Body: { id, change } where `change` is
 * the recommendation's ApplyChange. The change is validated + CLAMPED into the
 * admin tunable bounds server-side (never trusts client numbers), then executed
 * against the real surface:
 *
 *   spark-pool-config → setSparkPoolConfig (cross-replica Cosmos config doc)
 *   cache-override    → perf-tunables doc → query-result-cache runtime override
 *   adx-autoscale     → ARM PATCH Microsoft.Kusto/clusters optimizedAutoscale
 *   warehouse-scale   → ARM PATCH Microsoft.Synapse sqlPools sku (DWU)
 *
 * Returns the real before/after receipt; every attempt lands in the auto-tune
 * audit trail. Tenant-admin gated.
 */
import { NextRequest } from 'next/server';
import { apiError, apiOk, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { validateApplyChange } from '@/lib/perf/recommendations';
import { executeApplyChange } from '@/lib/perf/apply-change';
import { getTunables } from '@/lib/perf/usage-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const id = typeof body?.id === 'string' && body.id.trim() ? body.id.trim().slice(0, 100) : '';
  if (!id) return apiError('recommendation id is required', 400);

  try {
    const tunables = await getTunables();
    const validated = validateApplyChange(body?.change, tunables);
    if (!validated.ok || !validated.change) {
      return apiError(validated.error || 'invalid change', 400);
    }
    const actor = s.claims.upn || s.claims.email || s.claims.oid || 'admin';
    const receipt = await executeApplyChange(validated.change, actor, id);
    if (!receipt.ok) {
      return apiError(receipt.error || 'apply failed', 502, { receipt });
    }
    return apiOk({ receipt });
  } catch (e) {
    return apiServerError(e, 'Failed to apply recommendation');
  }
}
