/**
 * Cookie-backed session for the BFF — v1.18.
 *
 * Cookie payload is intentionally MINIMAL: just the user's identity
 * claims (oid, name, email, upn) + expiry. ~100 bytes encoded.
 *
 * Why: MSAL's access token is ~3KB which inflates the encrypted
 * + base64-encoded cookie value past Front Door's per-header size
 * limit (~4KB) and FD silently drops the Set-Cookie header. The
 * resulting cookie was never reaching the browser even though every
 * other layer of the stack was emitting it correctly.
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

export interface SessionPayload {
  /** Claims are the only thing in the cookie. Small + sufficient for /api/me + UI. */
  claims: UserClaims;
  /** Unix seconds. */
  exp: number;
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

export function encodeSessionCookie(payload: SessionPayload): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
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
