/**
 * /api/developer/tokens — a signed-in user's OWN scoped API tokens (BR-PAT).
 *
 *   GET  → list the caller's tokens (safe view; never the secret/hash).
 *   POST → create a token; returns the one-time full token string ONCE.
 *
 * Owner-scoped: every read/write binds `session.claims.oid`, so a user only
 * ever sees/creates their own tokens. A PAT session is FORBIDDEN from minting
 * tokens (patCannotMint) — token management is a human, cookie-only surface.
 */

import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import {
  createPatToken,
  listPatTokensForUser,
  patCannotMint,
  isPatScope,
  PAT_MAX_TTL_DAYS,
  PAT_DEFAULT_TTL_DAYS,
} from '@/lib/auth/pat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const tokens = await listPatTokensForUser(session.claims.oid);
    return apiOk({ tokens, maxTtlDays: PAT_MAX_TTL_DAYS, defaultTtlDays: PAT_DEFAULT_TTL_DAYS });
  } catch (e) {
    return apiServerError(e, 'could not list API tokens');
  }
}

export async function POST(req: Request) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  // A token can never create another token — human-only management surface.
  if (patCannotMint(session)) {
    return apiError('API tokens cannot create further tokens', 403, { code: 'pat_cannot_mint' });
  }

  let body: { name?: unknown; scope?: unknown; ttlDays?: unknown };
  try {
    body = await req.json();
  } catch {
    return apiError('invalid JSON body', 400);
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return apiError('name is required', 400);
  if (!isPatScope(body.scope)) {
    return apiError('scope must be one of read-only, read-write, admin', 400);
  }

  try {
    const { view, token } = await createPatToken({
      name,
      scope: body.scope,
      ttlDays: body.ttlDays as number | undefined,
      creator: session.claims,
    });
    // The full token is returned ONCE — the UI shows it, then it's unrecoverable.
    return apiOk({ token, tokenInfo: view });
  } catch (e) {
    return apiServerError(e, 'could not create API token');
  }
}
