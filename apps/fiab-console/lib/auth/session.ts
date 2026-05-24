/**
 * Cookie-backed session for the BFF.
 * Encrypts the user's session token using an HKDF-derived key from
 * SESSION_SECRET. Token never leaves the server.
 *
 * v1.14 fix: NextResponse.redirect() in Next.js 14 does NOT preserve
 * cookies added via response.cookies.set() — observed live with v1.13:
 * the redirect response came back to the browser with location: / but
 * no Set-Cookie header at all. Workaround: build the cookie string
 * manually and set it via response.headers.set('set-cookie', ...).
 * That route hits the underlying ResponseInit headers and is preserved
 * across NextResponse.redirect's response cloning.
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import type { UserClaims } from './msal';

const COOKIE_NAME = 'loom_session';
const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_AGE_SECS = 60 * 60 * 8; // 8h

function getKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  const ab = crypto.hkdfSync('sha256', Buffer.from(secret, 'utf-8'), Buffer.alloc(32), Buffer.from('loom-session-v1'), 32);
  return Buffer.from(ab as ArrayBuffer);
}

interface SessionPayload {
  oboAssertion: string;
  claims: UserClaims;
  exp: number;
}

function encodeValue(payload: SessionPayload): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

/** Build a raw RFC-6265 Set-Cookie header value. */
function buildCookieHeader(value: string, maxAge: number): string {
  // SameSite=Lax: required for OAuth callback flows (Strict drops the
  // cookie on cross-site redirects back into the app).
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function setSession(payload: SessionPayload, response?: NextResponse): void {
  const value = encodeValue(payload);
  if (response) {
    // CRITICAL: NextResponse.redirect() drops response.cookies.set()
    // additions on Next 14. Set the raw header instead.
    response.headers.set('set-cookie', buildCookieHeader(value, MAX_AGE_SECS));
    return;
  }
  // Server-action / page-render contexts can still use the jar.
  cookies().set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECS,
  });
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

export function clearSession(response?: NextResponse): void {
  if (response) {
    response.headers.set('set-cookie', buildCookieHeader('', 0));
    return;
  }
  cookies().delete(COOKIE_NAME);
}
