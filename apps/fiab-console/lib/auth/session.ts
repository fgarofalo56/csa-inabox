/**
 * Cookie-backed session for the BFF.
 * Encrypts the user's session token using an HKDF-derived key from
 * SESSION_SECRET (Key Vault reference). Token never leaves the server.
 */

import { cookies } from 'next/headers';
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

export function setSession(payload: SessionPayload): void {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const value = Buffer.concat([iv, tag, encrypted]).toString('base64url');

  cookies().set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60 * 8, // 8h
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

export function clearSession(): void {
  cookies().delete(COOKIE_NAME);
}
