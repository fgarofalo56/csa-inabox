/**
 * /api/v1/whoami — the first BR-PAT-authenticated API-surface endpoint.
 *
 * A non-interactive client verifies its scoped API token here:
 *
 *   curl -H "Authorization: Bearer loom_pat_<id>_<secret>" https://<host>/api/v1/whoami
 *   → { ok: true, oid, upn, name, tenantId, auth: "pat", scope, tokenId }
 *
 * It accepts BOTH auth modes via {@link getApiSession}: a browser cookie
 * session (auth:"cookie") or a PAT (auth:"pat"). It exposes ONLY the caller's
 * own identity + the token's scope — no cross-tenant data — so it doubles as the
 * canonical "is my token working / what can it do" probe for the developer docs.
 * This is the real resolvePat() consumer that proves the middleware end-to-end
 * (no-vaporware.md), and the template the BR-OPENAPI surface routes follow.
 */

import { getApiSession } from '@/lib/auth/api-session';
import { apiOk, apiUnauthorized } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const session = await getApiSession(req);
  if (!session) {
    return apiUnauthorized(
      'unauthenticated — send a browser session cookie or an Authorization: Bearer loom_pat_… header',
    );
  }
  return apiOk({
    auth: session.pat ? 'pat' : 'cookie',
    oid: session.claims.oid,
    upn: session.claims.upn,
    name: session.claims.name,
    tenantId: session.claims.tid || session.claims.oid,
    ...(session.pat ? { scope: session.pat.scope, tokenId: session.pat.tokenId } : {}),
  });
}
