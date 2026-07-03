/**
 * OAuth login-CSRF hardening for the MSAL BFF flow (rel-T12).
 *
 * Adds the three standard pre-callback anti-forgery values to the authorization-
 * code flow and carries them across the AAD round-trip in a SHORT-LIVED,
 * single-use cookie:
 *
 *   - `state`     — RFC 6749 §10.12 login-CSRF token. The callback rejects any
 *                   response whose `state` param doesn't match the cookie, so an
 *                   attacker cannot graft their own authorization code onto a
 *                   victim's browser (session fixation).
 *   - `verifier`  — RFC 7636 PKCE code_verifier (43 chars, base64url). The
 *                   authorize URL carries its S256 `code_challenge`; the token
 *                   exchange sends the verifier. Binds the code to THIS browser.
 *   - `nonce`     — OIDC nonce. Echoed into the returned id_token; the callback
 *                   confirms the id_token's `nonce` claim matches, defeating
 *                   id_token replay.
 *
 * The cookie (`loom_authflow`) is encrypted with the SAME SESSION_SECRET-derived
 * AES-256-GCM helper the sibling user-token stores use (encryptAtRest /
 * decryptAtRest in lib/auth/session) — so it cannot be forged without the
 * deployment secret and needs no NEW secret. It is intentionally SEPARATE from
 * the `loom_session` cookie: different name, different lifetime (10 min vs 8h),
 * different HKDF `info` label (at-rest key, not the session key), and it never
 * touches the session-cookie format.
 *
 * Cookie flags mirror the proven `loom_session` cookie: HttpOnly + Secure +
 * SameSite=Lax. Lax is REQUIRED — the callback is a top-level cross-site GET
 * navigation back from login.microsoftonline.com, and Lax (not Strict) is what
 * lets a first-party cookie ride that navigation. Path is scoped to `/auth`
 * (tighter than the session cookie's `/`) which still covers BOTH the sign-in
 * write and the `/auth/callback` read, so the cookie is guaranteed to round-trip
 * — the property that makes the state-mismatch self-heal loop-free.
 *
 * Kill switch: LOOM_AUTH_CSRF_ENABLED (default ON). Set to `false` to revert the
 * flow BYTE-FOR-BYTE to the pre-rel-T12 behavior (no state/PKCE/nonce, no
 * authflow cookie, no callback validation) — a single-flip rollback if the
 * required live login walk surfaces a problem, matching the codebase's
 * LOOM_SESSION_SLIDING_ENABLED / LOOM_MSAL_CACHE_PERSIST_ENABLED convention.
 */

import crypto from 'node:crypto';
import { encryptAtRest, decryptAtRest } from './session';

/** Short-lived, single-use login-CSRF cookie. Distinct from `loom_session`. */
export const AUTHFLOW_COOKIE_NAME = 'loom_authflow';
/** Cookie lifetime (seconds). A login round-trip is seconds; 10 min is generous. */
export const AUTHFLOW_MAX_AGE_SECS = 600;
/** Cookie Path — covers `/auth/sign-in` (write) AND `/auth/callback` (read). */
const AUTHFLOW_PATH = '/auth';

/** The anti-forgery values persisted across the AAD round-trip. */
export interface AuthFlowState {
  /** RFC 6749 login-CSRF token, matched against the callback `state` param. */
  state: string;
  /** RFC 7636 PKCE code_verifier, sent on the token exchange. */
  verifier: string;
  /** OIDC nonce, matched against the returned id_token `nonce` claim. */
  nonce: string;
}

/** A freshly-minted flow plus the derived S256 challenge for the authorize URL. */
export interface NewAuthFlow extends AuthFlowState {
  /** base64url(SHA-256(verifier)) — the PKCE `code_challenge` (method S256). */
  challenge: string;
}

/**
 * Whether the login-CSRF hardening is active. ON by default; a single
 * LOOM_AUTH_CSRF_ENABLED=false flip reverts the login flow byte-for-byte to the
 * pre-rel-T12 behavior (the documented rollback trigger).
 */
export function authCsrfEnabled(): boolean {
  return (process.env.LOOM_AUTH_CSRF_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Mint a new {state, verifier, nonce} + the S256 code_challenge. All values are
 * CSPRNG-derived (node:crypto.randomBytes) and base64url-encoded, so `verifier`
 * is a 43-char RFC 7636 code_verifier using only unreserved characters.
 */
export function newAuthFlow(): NewAuthFlow {
  const state = crypto.randomBytes(32).toString('base64url'); // 43 chars
  const verifier = crypto.randomBytes(32).toString('base64url'); // 43 chars (RFC 7636: 43–128)
  const nonce = crypto.randomBytes(16).toString('base64url'); // 22 chars
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { state, verifier, nonce, challenge };
}

/**
 * Encrypt the flow into the cookie value. Returns null if the value cannot be
 * encrypted (SESSION_SECRET unset) — the caller then adds NO state/PKCE/nonce
 * params and sets NO cookie, so the flow degrades to the pre-rel-T12 path atomically
 * (the callback's own no_session_secret gate still fires downstream, unchanged).
 */
export function encodeAuthFlowCookie(flow: AuthFlowState): string | null {
  try {
    return encryptAtRest(JSON.stringify({ state: flow.state, verifier: flow.verifier, nonce: flow.nonce }));
  } catch {
    return null;
  }
}

/** Decrypt + validate a `loom_authflow` cookie value. Null on tamper/format/miss. */
export function decodeAuthFlowCookie(value: string | undefined | null): AuthFlowState | null {
  if (!value) return null;
  const plain = decryptAtRest(value);
  if (!plain) return null;
  try {
    const o = JSON.parse(plain) as Partial<AuthFlowState>;
    if (typeof o.state === 'string' && typeof o.verifier === 'string' && typeof o.nonce === 'string') {
      return { state: o.state, verifier: o.verifier, nonce: o.nonce };
    }
    return null;
  } catch {
    return null;
  }
}

/** Set-Cookie header that issues the short-lived authflow cookie. */
export function setAuthFlowCookieHeader(value: string): string {
  return `${AUTHFLOW_COOKIE_NAME}=${value}; Path=${AUTHFLOW_PATH}; Max-Age=${AUTHFLOW_MAX_AGE_SECS}; HttpOnly; Secure; SameSite=Lax`;
}

/** Set-Cookie header that clears the authflow cookie (single-use / on failure). */
export function clearAuthFlowCookieHeader(): string {
  return `${AUTHFLOW_COOKIE_NAME}=; Path=${AUTHFLOW_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Constant-time equality for two short ASCII tokens (state / nonce). Length-guards
 * first so timingSafeEqual never throws on a length mismatch, and returns false
 * for any empty operand.
 */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
