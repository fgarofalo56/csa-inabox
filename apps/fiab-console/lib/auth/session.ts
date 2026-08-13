/**
 * Cookie-backed session for the BFF — v1.18.
 *
 * Cookie payload is intentionally MINIMAL: the user's identity claims
 * (oid, tid, name, email, upn), their Entra `groups` (#3175), and the
 * expiry.
 *
 * Why: MSAL's access token is ~3KB which inflates the encrypted
 * + base64-encoded cookie value past Front Door's per-header size
 * limit (~4KB) and FD silently drops the Set-Cookie header. The
 * resulting cookie was never reaching the browser even though every
 * other layer of the stack was emitting it correctly.
 *
 * `groups` is the one UNBOUNDED field and it reproduced that exact
 * failure on 2026-08-13 (a 99-object Global Admin → 5383 bytes → a
 * permanent sign-in loop). `encodeSessionCookie` therefore enforces
 * MAX_COOKIE_VALUE_BYTES and degrades to the Graph membership fallback
 * rather than minting an undeliverable cookie. Anything added to
 * UserClaims inherits that bound — keep it that way.
 *
 * When the BFF needs an access token for downstream OBO calls (Graph,
 * Synapse, etc.), it acquires one on demand via the MSAL confidential-
 * client cache keyed by the user's homeAccountId — MSAL handles
 * refresh transparently. No need to round-trip the token through the
 * browser cookie.
 */

import { cookies, type UnsafeUnwrappedCookies } from 'next/headers';
import crypto from 'node:crypto';
import type { UserClaims } from './msal';

export const COOKIE_NAME = 'loom_session';
/**
 * Hard ceiling for the ENCODED `loom_session` cookie value (bytes).
 *
 * RFC 6265 §6.1 obliges a user agent to support at least 4096 bytes per cookie
 * *including the name and attributes*, and every major browser implements that
 * as a hard cap — an over-length Set-Cookie is DISCARDED SILENTLY, with no error
 * anywhere in the stack. Azure Front Door applies the same ~4KB per-header
 * ceiling and drops the header just as quietly (the incident recorded in this
 * file's header comment, when the MSAL access token still rode in the cookie).
 *
 * 3500 leaves ~596 bytes of headroom for `loom_session=` + `Path` + `Max-Age` +
 * `HttpOnly` + `Secure` + `SameSite` — the attributes count against the 4096.
 *
 * This is NOT a style preference. When the value exceeds the cap the browser
 * keeps NO session, `/` sees an unauthenticated request, and the user is bounced
 * back to sign-in — an infinite login loop in which the server logs a perfectly
 * successful `[auth/callback] session encoded` line every time. See #3175's
 * regression: the `groups` claim pushed a Global Admin's cookie to 5383 bytes.
 */
export const MAX_COOKIE_VALUE_BYTES = 3500;
/**
 * Session cookie lifetime (seconds) — BOTH the cookie `Max-Age` and, when
 * sliding sessions are enabled, the session payload `exp` window. Overridable
 * via LOOM_SESSION_MAX_AGE_SECS; default 8h (28800). Default-unset value is
 * byte-for-byte the previous literal.
 */
export const MAX_AGE_SECS = Number(process.env.LOOM_SESSION_MAX_AGE_SECS) || 60 * 60 * 8; // 8h
const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  const ab = crypto.hkdfSync('sha256', Buffer.from(secret, 'utf-8'), Buffer.alloc(32), Buffer.from('loom-session-v1'), 32);
  return Buffer.from(ab as ArrayBuffer);
}

/**
 * Marker attached to a session that was resolved from a scoped API token (PAT)
 * rather than the browser `loom_session` cookie (BR-PAT). The cookie path NEVER
 * sets this — `getSession()` returns a payload with `pat` UNDEFINED — so
 * `session.pat` is the single, reliable signal that "this caller is a
 * non-interactive token, not an interactive human". Guards read it to (a)
 * enforce the token's scope (read-only rejects mutations), (b) forbid a token
 * from minting further tokens or reaching /admin unless it is admin-scoped AND
 * its creator is a tenant admin at resolve time. See lib/auth/pat.ts.
 */
export interface PatSessionContext {
  /** The public token id (the `<id>` in `loom_pat_<id>_<secret>`). */
  tokenId: string;
  /** Typed scope the token was minted with. */
  scope: 'read-only' | 'read-write' | 'admin';
}

export interface SessionPayload {
  /** Claims are the only thing in the cookie. Small + sufficient for /api/me + UI. */
  claims: UserClaims;
  /** Unix seconds. */
  exp: number;
  /**
   * Present ONLY when this session was resolved from a scoped API token (PAT)
   * via {@link resolvePat}. Undefined for every cookie-backed session — so the
   * cookie code path in this file is byte-for-byte unchanged. Its presence
   * downgrades the caller to the token's scope in the API guards.
   */
  pat?: PatSessionContext;
}

/**
 * The partition key for TENANT-SHARED state (feature-permission grants) —
 * the Entra tenant id (`tid`) so a grant written by an admin resolves for any
 * grantee in the SAME tenant (rel-T11 / B4). Falls back to the user's `oid`
 * when `tid` is absent (sessions minted before rel-T11, or the single-operator
 * bootstrap) so behavior is byte-identical for the single-user path.
 *
 * NOTE: this is deliberately NOT used for the `workspaces` / `items` containers
 * — those are partitioned by the OWNER's `oid` (immutable partition key) and
 * sharing is layered on via the `workspace-roles` ACL (see workspace-access.ts).
 */
export function tenantScopeId(session: { claims: UserClaims }): string {
  return session.claims.tid || session.claims.oid;
}

function encodeSessionCookieRaw(payload: SessionPayload): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

/**
 * Encode the session cookie, GUARANTEEING the result is small enough to actually
 * reach the browser.
 *
 * The only unbounded field in the payload is `claims.groups` — one 36-char GUID
 * per Entra directory object the user belongs to. `groupMembershipClaims:
 * SecurityGroup` (set on the app registration by #3175) makes Entra emit security
 * groups AND directory roles, so a Global Admin can easily carry ~100 entries:
 * measured 5383 bytes against a 4096-byte cap, which the browser discarded
 * silently and turned into a permanent sign-in loop.
 *
 * When the payload does not fit we drop `groups` and re-encode. Dropping it is
 * correct rather than merely convenient: `groups` is left UNDEFINED, which is the
 * SAME state Entra itself produces for the >200-group overage case (it replaces
 * the inline claim with `_claim_names`/`_claim_sources`), and which
 * `groupsClaimUnavailable()` in lib/auth/domain-role.ts already routes to an
 * authoritative Graph membership lookup. So a heavily-grouped user keeps working
 * authorization via the designed fallback, and a normally-grouped user keeps the
 * fast inline-claim path #3175 restored.
 *
 * `[]` would be WRONG here — it asserts "this user is in no groups", a fact we
 * never established, and it is indistinguishable from a real answer to every
 * caller that does `session.claims.groups || []`.
 *
 * A session that STILL does not fit without groups is a payload bug, not a
 * membership size: we return the over-length value rather than mint a corrupt
 * session, and the guard below plus the callback's own length log make it visible.
 */
export function encodeSessionCookie(payload: SessionPayload): string {
  const encoded = encodeSessionCookieRaw(payload);
  if (encoded.length <= MAX_COOKIE_VALUE_BYTES) return encoded;
  if (!payload.claims.groups?.length) return encoded;
  const { groups: _dropped, ...claimsWithoutGroups } = payload.claims;
  return encodeSessionCookieRaw({ ...payload, claims: claimsWithoutGroups });
}

/**
 * Whether a payload's groups claim would be dropped by {@link encodeSessionCookie}
 * to keep the cookie deliverable. Exposed so the auth callback can say so in its
 * log line — an oversized membership silently switching to the Graph fallback is
 * exactly the kind of state that must not be invisible to an operator.
 */
export function sessionGroupsDroppedForSize(payload: SessionPayload): boolean {
  if (!payload.claims.groups?.length) return false;
  return encodeSessionCookieRaw(payload).length > MAX_COOKIE_VALUE_BYTES;
}

export function getSession(): SessionPayload | null {
  const cookie = (cookies() as unknown as UnsafeUnwrappedCookies).get(COOKIE_NAME);
  if (!cookie) return null;
  try {
    const raw = Buffer.from(cookie.value, 'base64url');
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const encrypted = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALG, getKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf-8')) as SessionPayload;
    if (payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function clearSessionCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Whether SLIDING sessions are enabled (default ON via
 * LOOM_SESSION_SLIDING_ENABLED). When ON, the auth-callback (and the
 * /api/auth/refresh route) set the session `exp` to `now + MAX_AGE_SECS` so the
 * cookie's logical expiry tracks its Max-Age (8h) rather than the ~60m MSAL
 * ACCESS-token expiry — fixing the hourly-logout bug (the access token is
 * claims-only here and re-acquired from the MSAL cache on demand). When OFF, the
 * callback reverts byte-for-byte to deriving `exp` from the access-token expiry,
 * making the change migration-safe + reversible by a single env flip.
 */
export function sessionSlidingEnabled(): boolean {
  return (process.env.LOOM_SESSION_SLIDING_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Set-Cookie header that (re-)issues the encrypted session cookie with the
 * SAME flags the auth-callback uses. Shared so the silent-refresh route re-mints
 * the cookie byte-identically (no new crypto, no drift in Path/Max-Age/flags).
 */
export function setSessionCookieHeader(value: string): string {
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${MAX_AGE_SECS}; HttpOnly; Secure; SameSite=Lax`;
}

// ---------------------------------------------------------------------------
// Reusable AES-256-GCM helpers for encrypting sensitive values AT REST
// (e.g. a cached user ARM token in Cosmos). These derive a DISTINCT key from
// SESSION_SECRET via a different HKDF `info` label than the session cookie, so
// a leaked at-rest blob can never be replayed as a session cookie and vice
// versa. Both still require SESSION_SECRET to decode — no new secret needed.
// ---------------------------------------------------------------------------

function getAtRestKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  const ab = crypto.hkdfSync('sha256', Buffer.from(secret, 'utf-8'), Buffer.alloc(32), Buffer.from('loom-at-rest-v1'), 32);
  return Buffer.from(ab as ArrayBuffer);
}

/** Encrypt an arbitrary UTF-8 string for storage at rest. Returns base64url. */
export function encryptAtRest(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, getAtRestKey(), iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf-8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

/** Decrypt a value produced by {@link encryptAtRest}. Returns null on tamper/format error. */
export function decryptAtRest(encoded: string): string | null {
  try {
    const raw = Buffer.from(encoded, 'base64url');
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const enc = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALG, getAtRestKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8');
  } catch {
    return null;
  }
}
