/**
 * Unit tests for the rel-T12 login-CSRF authflow module (lib/auth/authflow).
 *
 * Pure crypto/logic — no React render, no network — so it runs under the node
 * test env. SESSION_SECRET is set before importing (the AES-256-GCM at-rest key
 * is derived from it), mirroring the sibling refresh.test.ts.
 *
 * Asserts:
 *   1. newAuthFlow() mints an RFC-7636-shaped verifier (43–128 unreserved chars),
 *      a correct S256 challenge (base64url(SHA-256(verifier))), and distinct state
 *      + nonce that differ across calls.
 *   2. encode → decode round-trips {state, verifier, nonce} exactly.
 *   3. A tampered / garbage cookie decodes to null (never throws).
 *   4. safeEqual is true only for identical non-empty strings (empty ⇒ false).
 *   5. The kill switch (LOOM_AUTH_CSRF_ENABLED=false) disables the hardening.
 */
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';

process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0123456789';

import {
  newAuthFlow,
  encodeAuthFlowCookie,
  decodeAuthFlowCookie,
  safeEqual,
  authCsrfEnabled,
} from '../authflow';

describe('authflow (rel-T12 login-CSRF)', () => {
  it('newAuthFlow mints an RFC 7636 verifier + correct S256 challenge', () => {
    const f = newAuthFlow();
    // Verifier: 43–128 chars, only RFC 7636 unreserved chars (base64url alphabet).
    expect(f.verifier).toMatch(/^[A-Za-z0-9\-_]{43,128}$/);
    // Challenge = base64url(SHA-256(verifier)).
    const expected = crypto.createHash('sha256').update(f.verifier).digest('base64url');
    expect(f.challenge).toBe(expected);
    expect(f.state.length).toBeGreaterThanOrEqual(20);
    expect(f.nonce.length).toBeGreaterThanOrEqual(16);
  });

  it('mints distinct values across calls', () => {
    const a = newAuthFlow();
    const b = newAuthFlow();
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('encode → decode round-trips exactly', () => {
    const f = newAuthFlow();
    const cookie = encodeAuthFlowCookie(f);
    expect(cookie).toBeTruthy();
    const back = decodeAuthFlowCookie(cookie);
    expect(back).toEqual({ state: f.state, verifier: f.verifier, nonce: f.nonce });
  });

  it('decodes tampered/garbage/empty cookies to null (never throws)', () => {
    expect(decodeAuthFlowCookie(undefined)).toBeNull();
    expect(decodeAuthFlowCookie('')).toBeNull();
    expect(decodeAuthFlowCookie('not-a-valid-cookie')).toBeNull();
    const cookie = encodeAuthFlowCookie(newAuthFlow())!;
    // Flip the last char to force an AES-GCM auth-tag / format failure.
    const tampered = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A');
    expect(decodeAuthFlowCookie(tampered)).toBeNull();
  });

  it('safeEqual is constant-time-correct: true only for identical non-empty strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false); // length mismatch never throws
    expect(safeEqual('', '')).toBe(false);
    expect(safeEqual(undefined, 'abc')).toBe(false);
    expect(safeEqual('abc', null)).toBe(false);
  });

  it('kill switch: LOOM_AUTH_CSRF_ENABLED=false disables, default is on', () => {
    delete process.env.LOOM_AUTH_CSRF_ENABLED;
    expect(authCsrfEnabled()).toBe(true);
    process.env.LOOM_AUTH_CSRF_ENABLED = 'false';
    expect(authCsrfEnabled()).toBe(false);
    process.env.LOOM_AUTH_CSRF_ENABLED = 'true';
    expect(authCsrfEnabled()).toBe(true);
    delete process.env.LOOM_AUTH_CSRF_ENABLED;
  });
});
