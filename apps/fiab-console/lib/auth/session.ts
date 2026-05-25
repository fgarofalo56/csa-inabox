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

import { cookies } from 'next/headers';
import crypto from 'node:crypto';
import type { UserClaims } from './msal';

export const COOKIE_NAME = 'loom_session';
export const MAX_AGE_SECS = 60 * 60 * 8; // 8h
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

export function encodeSessionCookie(payload: SessionPayload): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

export function getSession(): SessionPayload | null {
  const cookie = cookies().get(COOKIE_NAME);
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
