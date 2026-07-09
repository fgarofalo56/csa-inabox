/**
 * /api/admin/developer/tokens — tenant-wide API-token inventory (BR-PAT, admin).
 *
 *   GET → every token in the caller's tenant (safe view). Tenant-admin only
 *   (requireTenantAdmin); the list is scoped to the admin's own tenant so an
 *   admin never sees another tenant's tokens.
 *
 * Admins do not MINT tokens here — creation is per-user under
 * /api/developer/tokens. This surface is oversight + revoke.
 */

import { getSession, tenantScopeId } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiServerError } from '@/lib/api/respond';
import { listPatTokensForTenant } from '@/lib/auth/pat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;
  try {
    const tokens = await listPatTokensForTenant(tenantScopeId(session!));
    return apiOk({ tokens });
  } catch (e) {
    return apiServerError(e, 'could not list tenant API tokens');
  }
}
