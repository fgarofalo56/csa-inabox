/**
 * returning-user — the "has signed in before" hint that decides where an
 * UNAUTHENTICATED session-expiry 401 sends the browser.
 *
 * The problem it solves: a first-time / never-authenticated / deprovisioned
 * visitor who lands on any Loom surface fires a session-gated /api probe, takes
 * a `{error:'unauthenticated'}` 401, and the client-fetch reauth used to bounce
 * them STRAIGHT to Entra (`/auth/sign-in` → 302 AAD) — so they never saw the
 * "Request access" affordance and the request-access feature was unreachable.
 *
 * The fix is a durable, NON-SENSITIVE hint cookie (`loom_seen`) set on every
 * successful login. It carries NO identity — just the fact that this browser has
 * completed sign-in at least once. On a 401 reauth:
 *   - hint PRESENT  → the visitor is a returning/known user → keep the seamless
 *     SSO bounce to `/auth/sign-in` (no extra click).
 *   - hint ABSENT   → send them to the pre-auth `/welcome` landing surface, which
 *     shows BOTH "Sign in" and "Request access" and does NOT auto-forward to AAD.
 *
 * Pure + framework-free so both the server (callback route, to WRITE the cookie)
 * and the browser (client-fetch, to READ it) share one source of truth and it is
 * trivially unit-testable.
 */

/** Cookie name for the non-sensitive "has signed in before" hint. */
export const RETURNING_USER_COOKIE = 'loom_seen';

/** Opaque, identity-free value. Presence is all that matters. */
export const RETURNING_USER_COOKIE_VALUE = '1';

/** ~180 days. Long enough that a genuine returning user keeps seamless SSO. */
export const RETURNING_USER_MAX_AGE_SECS = 60 * 60 * 24 * 180;

/** Pre-auth landing surface: renders Sign in + Request access, never auto-AAD. */
export const WELCOME_PATH = '/welcome';

/** Terminal surface of the sign-in circuit breaker (#3334). Never auto-AAD. */
export const SIGN_IN_BLOCKED_PATH = '/auth/blocked';

/**
 * Surfaces on which a top-level reauth navigation must be a NO-OP.
 *
 * These are the pages whose entire job is to be the END of an unauthenticated
 * journey. Navigating away from one on a 401 re-enters the loop it just left:
 *
 *   - `/welcome` — the pre-auth landing. Bouncing it to itself loops.
 *   - `/auth/blocked` — the circuit breaker's terminal page. It is reached
 *     BECAUSE sign-in is looping; a 401 from anything the app shell mounts
 *     around it would navigate to /auth/sign-in, which would trip the breaker
 *     again and redirect straight back here. Bounded, but still a redirect
 *     ping-pong the user would watch forever. So: no-op.
 *
 * Compared with `startsWith` so a query string or trailing slash cannot smuggle
 * a surface out of the set.
 */
const PRE_AUTH_SURFACES = [WELCOME_PATH, SIGN_IN_BLOCKED_PATH] as const;

/**
 * True when `pathname` is a surface that must never trigger a top-level reauth
 * navigation. Pure + total; a null/empty pathname is not a pre-auth surface.
 */
export function isPreAuthSurface(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return PRE_AUTH_SURFACES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}


/** BFF sign-in initiator (302s to AAD) — the seamless SSO destination. */
export const SIGN_IN_PATH = '/auth/sign-in';

/**
 * True when the raw `document.cookie` / request cookie string carries a non-empty
 * `loom_seen` hint — i.e. this browser has completed sign-in before. Parses the
 * `k=v; k=v` string itself (no framework) so it runs identically server- and
 * client-side. Never throws; a null/empty string is simply "not a returning user".
 */
export function hasReturningUserHint(cookieString: string | null | undefined): boolean {
  if (!cookieString) return false;
  return cookieString.split(';').some((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return false;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    return key === RETURNING_USER_COOKIE && value.length > 0;
  });
}

/**
 * Where an UNAUTHENTICATED session-expiry 401 should send the browser, given the
 * current cookie string. Returning users (hint present) keep the seamless SSO
 * bounce to Entra; first-time / never-authenticated users go to the `/welcome`
 * landing surface so the "Request access" path is reachable. Pure + total.
 */
export function reauthDestination(cookieString: string | null | undefined): string {
  return hasReturningUserHint(cookieString) ? SIGN_IN_PATH : WELCOME_PATH;
}

/**
 * The Set-Cookie header that stamps the returning-user hint after a successful
 * login. Deliberately NOT HttpOnly — client-fetch reads it from `document.cookie`
 * to pick the reauth destination. It carries NO identity, so JS-readability leaks
 * nothing. `Secure` + `SameSite=Lax` + `Path=/` match the session cookie's flags.
 */
export function returningUserCookieHeader(): string {
  return (
    `${RETURNING_USER_COOKIE}=${RETURNING_USER_COOKIE_VALUE}; Path=/; ` +
    `Max-Age=${RETURNING_USER_MAX_AGE_SECS}; Secure; SameSite=Lax`
  );
}
