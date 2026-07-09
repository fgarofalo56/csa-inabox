/**
 * External data sharing — RECIPIENT view (FGC-30).
 *
 *   GET /api/external-shares/received  → { ok, shares }
 *
 * What an accepted (or pending) external guest sees: every share targeted at
 * THEIR email, across all owning tenants. The guest is a B2B member of this
 * tenant after redeeming the invite, so getSession() authenticates them; the
 * list is scoped to shares whose targetEmail matches the caller's own email —
 * a guest can only ever see shares addressed to them.
 */
import { getSession } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiError, apiServerError } from '@/lib/api/respond';
import { listReceivedShares } from '@/lib/azure/external-share-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const email = (session.claims.email || session.claims.upn || '').trim();
  if (!email) return apiError('no email on the caller session', 400);
  try {
    const shares = await listReceivedShares(email);
    // Surface only recipient-relevant fields (never leak owner internals like
    // grantedPaths / notes to the guest).
    const view = shares.map((s) => ({
      id: s.id,
      sourceItemId: s.sourceItemId,
      sourceItemType: s.sourceItemType,
      sourceItemName: s.sourceItemName,
      container: s.container,
      sharedPath: s.sharedPath,
      readOnly: s.readOnly,
      expiry: s.expiry,
      state: s.state,
      inviteRedeemUrl: s.state === 'pending' ? s.inviteRedeemUrl : undefined,
      createdAt: s.createdAt,
    }));
    return apiOk({ shares: view });
  } catch (e: any) {
    return apiServerError(e, 'Failed to list received shares');
  }
}
