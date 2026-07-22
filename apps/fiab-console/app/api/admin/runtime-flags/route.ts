/**
 * GET /api/admin/runtime-flags — every registered runtime kill-switch joined
 * with its live Cosmos state → { ok, flags: RuntimeFlagState[] }.
 *
 * FLAG0 (loom-next-level ws-verification-dr.md). HARD admin gate
 * (requireTenantAdmin): flipping a flag reverts a user-visible surface for the
 * whole deployment, so only tenant admins may even enumerate the switches.
 * Uncached read — the admin panel must show the truth immediately after a flip.
 */
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { listRuntimeFlags } from '@/lib/admin/runtime-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  try {
    const flags = await listRuntimeFlags();
    return apiOk({ flags });
  } catch (e) {
    return apiServerError(
      e,
      'Could not read runtime flags — Cosmos DB is required. Set LOOM_COSMOS_ENDPOINT (admin-plane/main.bicep apps[] env) and grant the Console UAMI "Cosmos DB Built-in Data Contributor".',
    );
  }
}
