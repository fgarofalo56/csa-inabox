/**
 * External data share — single-share route (FGC-30).
 *
 *   GET    /api/external-shares/[id]?sourceItemId=<id>  → { ok, share }
 *   DELETE /api/external-shares/[id]?sourceItemId=<id>  → { ok, share } (revoked)
 *
 * Revoke removes the guest's scoped ADLS ACL on every granted path and flips the
 * Cosmos row to `revoked`. Tenant-scoped: the caller must be in the owning tenant
 * (the share row is partitioned by sourceItemId and stamped with tenantId).
 */
import { NextRequest } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiForbidden, apiNotFound, apiServerError } from '@/lib/api/respond';
import { getExternalShare, revokeExternalShare } from '@/lib/azure/external-share-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function resolveOwnedShare(id: string, sourceItemId: string, tenantId: string) {
  const share = await getExternalShare(id, sourceItemId);
  if (!share) return { share: null as null, denied: false };
  if (share.tenantId !== tenantId) return { share, denied: true };
  return { share, denied: false };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  const sourceItemId = (new URL(req.url).searchParams.get('sourceItemId') || '').trim();
  if (!sourceItemId) return apiError('sourceItemId is required', 400);
  try {
    const { share, denied } = await resolveOwnedShare(id, sourceItemId, tenantScopeId(session));
    if (!share) return apiNotFound('share not found');
    if (denied) return apiForbidden('not in the owning tenant');
    return apiOk({ share });
  } catch (e: any) {
    return apiServerError(e, 'Failed to read the external share');
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  const sourceItemId = (new URL(req.url).searchParams.get('sourceItemId') || '').trim();
  if (!sourceItemId) return apiError('sourceItemId is required', 400);
  try {
    const { share, denied } = await resolveOwnedShare(id, sourceItemId, tenantScopeId(session));
    if (!share) return apiNotFound('share not found');
    if (denied) return apiForbidden('not in the owning tenant');
    const revoked = await revokeExternalShare(id, sourceItemId);
    return apiOk({ share: revoked });
  } catch (e: any) {
    if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
      return apiError(e.message || 'cannot revoke', e.status);
    }
    return apiServerError(e, 'Failed to revoke the external share');
  }
}
