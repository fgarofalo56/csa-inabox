/**
 * Cookie-backed session for the BFF.
 * Encrypts the user's session token using an HKDF-derived key from
 * SESSION_SECRET (Key Vault reference). Token never leaves the server.
 *
 * v1.13 fix: route handlers that return their own NextResponse must
 * attach cookies via `response.cookies.set(...)` — `cookies().set()`
 * from `next/headers` only flushes for server actions / page renders
 * that don't return a custom response. The /auth/callback handler was
 * setting the session via the latter and then returning a custom
 * redirect, so the Set-Cookie header was being dropped before the
 * browser ever saw it.
 *
 * setSession(payload, response?) — when called with a NextResponse,
 * attaches the cookie to it; otherwise falls back to the next/headers
 * jar (still useful for server-action paths).
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import type { UserClaims } from './msal';

const COOKIE_NAME = 'loom_session';
const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  // hkdfSync returns ArrayBuffer in newer @types/node; wrap in Buffer for AES.
  const ab = crypto.hkdfSync('sha256', Buffer.from(secret, 'utf-8'), Buffer.alloc(32), Buffer.from('loom-session-v1'), 32);
  return Buffer.from(ab as ArrayBuffer);
}

interface SessionPayload {
  oboAssertion: string;
  claims: UserClaims;
  exp: number;
}

const COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  // 'lax' is required for OAuth callback flows. With 'strict', the
  // Set-Cookie from /auth/callback would land in the jar but cookies
  // would not be SENT on the subsequent /redirect-to-home navigation
  // when the user followed any external link back to the app.
  // 'lax' is the OAuth-recommended default.
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 60 * 60 * 8, // 8h
};

function encodeValue(payload: SessionPayload): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

export function setSession(payload: SessionPayload, response?: NextResponse): void {
  const value = encodeValue(payload);
  if (response) {
    response.cookies.set(COOKIE_NAME, value, COOKIE_OPTS);
    return;
  }
  // Fallback: server-action / page-render contexts.
  cookies().set(COOKIE_NAME, value, COOKIE_OPTS);
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
    response.cookies.set(COOKIE_NAME, '', { ...COOKIE_OPTS, maxAge: 0 });
    return;
  }
  cookies().delete(COOKIE_NAME);
}
