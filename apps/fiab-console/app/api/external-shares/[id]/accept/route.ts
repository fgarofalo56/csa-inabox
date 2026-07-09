/**
 * External data share — RECIPIENT accept (FGC-30).
 *
 *   POST /api/external-shares/[id]/accept
 *        body { sourceItemId }
 *        → { ok, share }  (state → accepted)
 *
 * Only the TARGET guest may accept — the caller's own email must match the
 * share's targetEmail. Enforces the pending → accepted state machine; an expired
 * or already-terminal share 409s. Returns the recipient view of the accepted
 * share (source item, shared subset, read-only, expiry, storage coordinates).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiForbidden, apiNotFound, apiConflict, apiServerError } from '@/lib/api/respond';
import { getExternalShare, acceptExternalShare } from '@/lib/azure/external-share-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({} as any));
  const sourceItemId = String(body?.sourceItemId || '').trim();
  if (!sourceItemId) return apiError('sourceItemId is required', 400);

  const callerEmail = (session.claims.email || session.claims.upn || '').trim().toLowerCase();

  try {
    const share = await getExternalShare(id, sourceItemId);
    if (!share) return apiNotFound('share not found');
    // Only the addressed guest may accept.
    if (!callerEmail || callerEmail !== share.targetEmail.trim().toLowerCase()) {
      return apiForbidden('this share is not addressed to you');
    }
    const accepted = await acceptExternalShare(id, sourceItemId);
    return apiOk({
      share: {
        id: accepted.id,
        sourceItemName: accepted.sourceItemName,
        sourceItemType: accepted.sourceItemType,
        container: accepted.container,
        sharedPath: accepted.sharedPath,
        readOnly: accepted.readOnly,
        expiry: accepted.expiry,
        state: accepted.state,
        acceptedAt: accepted.acceptedAt,
      },
    });
  } catch (e: any) {
    if (e?.status === 409) return apiConflict(e.message || 'cannot accept');
    if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
      return apiError(e.message || 'cannot accept', e.status);
    }
    return apiServerError(e, 'Failed to accept the external share');
  }
}
