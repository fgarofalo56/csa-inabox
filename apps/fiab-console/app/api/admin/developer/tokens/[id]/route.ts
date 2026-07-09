/**
 * /api/admin/developer/tokens/[id] — a tenant admin revokes ANY token in their
 * tenant (BR-PAT, admin). Tenant-admin only (requireTenantAdmin); revokePatToken
 * additionally enforces the token belongs to the admin's tenant.
 */

import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiNotFound, apiForbidden, apiServerError } from '@/lib/api/respond';
import { revokePatToken } from '@/lib/auth/pat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;
  const { id } = await params;
  if (!id) return apiError('id required', 400);
  try {
    const outcome = await revokePatToken(
      id,
      { oid: session!.claims.oid, upn: session!.claims.upn, tid: session!.claims.tid },
      /* byAdmin */ true,
    );
    if (outcome === 'not-found') return apiNotFound('token not found');
    if (outcome === 'forbidden') return apiForbidden('token belongs to another tenant');
    return apiOk({ outcome });
  } catch (e) {
    return apiServerError(e, 'could not revoke API token');
  }
}
