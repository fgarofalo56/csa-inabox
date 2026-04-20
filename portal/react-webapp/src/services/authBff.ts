/**
 * BFF (Backend-for-Frontend) auth client — CSA-0020 Phase 2.
 *
 * When `NEXT_PUBLIC_AUTH_MODE=bff`, the browser never holds access or
 * refresh tokens. Instead, the FastAPI `auth_bff` router
 * (`portal/shared/api/routers/auth_bff.py`) runs the MSAL Auth Code +
 * PKCE flow server-side and stores the session server-side behind an
 * opaque `csa_sid` httpOnly cookie.
 *
 * This module exposes small typed wrappers around the BFF endpoints
 * that the React app can call from auth-gating components.
 *
 * `credentials: 'include'` is mandatory on every call so the browser
 * sends the `csa_sid` cookie. The same-origin deployment of the BFF
 * means `SameSite=Lax` is sufficient; for split-origin deployments
 * the operator must configure the cookie as `SameSite=None; Secure`
 * via `BFF_COOKIE_SAMESITE` on the backend.
 *
 * See ADR-0014 for the migration plan.
 */

import { resolveAuthMode } from './authConfig';

/**
 * Shape of the payload returned by `GET /auth/me` on a live session.
 * Mirrors `portal.shared.api.models.auth_bff.AuthMeResponse`.
 */
export interface BffUserProfile {
  oid: string;
  tid: string;
  name: string;
  email: string;
  roles: string[];
}

/**
 * Base URL for BFF API calls. Defaults to same-origin so Next.js
 * rewrites (or a reverse proxy) can front the FastAPI service.
 */
function bffBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.NEXT_PUBLIC_BFF_API_ORIGIN || '';
}

/**
 * Fetch the current user's session profile from the BFF.
 *
 * Returns `null` on 401 (no session / expired), which is the happy
 * unauthenticated path the login UI consumes. Any other non-2xx
 * response throws.
 */
export async function bffFetchMe(
  env: NodeJS.ProcessEnv = process.env
): Promise<BffUserProfile | null> {
  if (resolveAuthMode(env) !== 'bff') {
    // Calling `/auth/me` on an SPA-mode deployment returns 404; skip
    // the network round-trip entirely so callers can safely invoke
    // this helper regardless of mode.
    return null;
  }

  const res = await fetch(`${bffBaseUrl(env)}/auth/me`, {
    method: 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });

  if (res.status === 401) {
    return null;
  }
  if (!res.ok) {
    throw new Error(
      `bffFetchMe: unexpected status ${res.status} from /auth/me`
    );
  }
  return (await res.json()) as BffUserProfile;
}

/**
 * Navigate the top-level browser to the BFF login route. The BFF
 * handles state / nonce / PKCE generation server-side and then
 * redirects to Entra ID.
 */
export function bffLoginRedirect(
  redirectTo: string = '/',
  env: NodeJS.ProcessEnv = process.env
): void {
  const url = new URL(`${bffBaseUrl(env)}/auth/login`, window.location.origin);
  url.searchParams.set('redirect_to', redirectTo);
  window.location.assign(url.toString());
}

/**
 * POST to `/auth/logout` to destroy the server-side session and clear
 * the `csa_sid` cookie. Returns `true` on 204 Success.
 */
export async function bffLogout(
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (resolveAuthMode(env) !== 'bff') {
    return false;
  }
  const res = await fetch(`${bffBaseUrl(env)}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
  return res.status === 204;
}
