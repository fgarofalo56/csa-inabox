/**
 * /api/developer/tokens/[id] — revoke one of the caller's OWN tokens (BR-PAT).
 *
 *   DELETE → revoke. Owner-scoped: revokePatToken enforces the caller owns the
 *   token (session.claims.oid), so a user cannot revoke someone else's token.
 */

import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiForbidden, apiServerError } from '@/lib/api/respond';
import { revokePatToken, patCannotMint } from '@/lib/auth/pat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  if (patCannotMint(session)) {
    return apiError('API tokens cannot revoke tokens', 403, { code: 'pat_cannot_mint' });
  }
  const { id } = await params;
  if (!id) return apiError('id required', 400);
  try {
    const outcome = await revokePatToken(
      id,
      { oid: session.claims.oid, upn: session.claims.upn, tid: session.claims.tid },
      /* byAdmin */ false,
    );
    if (outcome === 'not-found') return apiNotFound('token not found');
    if (outcome === 'forbidden') return apiForbidden('you can only revoke your own tokens');
    return apiOk({ outcome });
  } catch (e) {
    return apiServerError(e, 'could not revoke API token');
  }
}
