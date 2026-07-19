/**
 * api-session — the PAT-aware session resolver (BR-PAT).
 *
 * The interactive product reads the encrypted `loom_session` cookie via
 * synchronous {@link getSession}. Non-interactive callers (CI, Terraform, SCIM)
 * instead present `Authorization: Bearer loom_pat_<id>_<secret>`. Resolving a
 * PAT requires an async Cosmos lookup + hash verify, so it CANNOT live inside
 * the synchronous cookie `getSession()` (which 1100+ routes call). Instead this
 * async resolver composes them as a strict FALLBACK:
 *
 *     cookie session (getSession)   →  if present, WINS. PAT never consulted.
 *     else Authorization: Bearer PAT →  resolvePat() (real Cosmos read).
 *
 * The cookie path is byte-for-byte unchanged — a browser request behaves
 * exactly as before. Only a request WITHOUT a valid cookie falls through to the
 * bearer header. API-surface routes (BR-OPENAPI/TERRAFORM/SCIM) call
 * {@link getApiSession} instead of {@link getSession} to accept both.
 */

import { NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { resolvePat, scopeAllowsMethod, patCanAdmin } from '@/lib/auth/pat';

/** Minimal request shape — anything with `headers.get()` + a `method`. */
export interface ApiRequestLike {
  headers: { get(name: string): string | null };
  method?: string;
}

/**
 * Resolve the caller's session: the browser cookie FIRST (unchanged), then a
 * scoped API token from the `Authorization` header. Returns null when neither
 * authenticates. Never throws.
 */
export async function getApiSession(req: ApiRequestLike): Promise<SessionPayload | null> {
  // Cookie wins — identical to every existing route's `getSession()`.
  const cookie = getSession();
  if (cookie) return cookie;
  // Fallback: a scoped API token on the Authorization header. Null-safe on
  // headers: synthetic test requests (and some framework shims) omit them —
  // no header simply means no PAT, never a throw.
  return resolvePat(req?.headers?.get?.('authorization') ?? null);
}

/**
 * Enforce a PAT session's scope for THIS request. No-op (returns null) for a
 * cookie session — those are governed by the normal owner/admin guards. For a
 * PAT session it enforces:
 *   - read-only scope rejects any mutating verb (only GET/HEAD/OPTIONS pass);
 *   - when `adminRequired`, the token must be admin-scoped AND its creator must
 *     still be a tenant admin at resolve time.
 * Returns a structured 403 NextResponse when blocked, or null when allowed.
 */
export function enforcePatAccess(
  session: SessionPayload,
  method: string,
  opts: { adminRequired?: boolean } = {},
): NextResponse | null {
  if (!session.pat) return null; // cookie session — not this helper's remit

  if (!scopeAllowsMethod(session.pat.scope, method)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'forbidden',
        code: 'pat_scope_read_only',
        reason:
          `This API token is scoped read-only and cannot perform a ${method.toUpperCase()} request. ` +
          'Create a read-write (or admin) token to make changes.',
      },
      { status: 403 },
    );
  }

  if (opts.adminRequired && !patCanAdmin(session)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'forbidden',
        code: 'pat_not_admin_scoped',
        reason:
          'This API token cannot access admin surfaces. An admin-scoped token is required, and its ' +
          'creator must be a tenant admin at the time the token is used.',
      },
      { status: 403 },
    );
  }
  return null;
}
