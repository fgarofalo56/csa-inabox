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

    // THE TAMPER IS ASSERTED, NOT ASSUMED (#3837 / #3856).
    //
    // This used to flip the LAST base64url character:
    //   cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A')
    // which is a padding no-op 1 run in 16, so the spec that exists to prove the
    // login-CSRF cookie CANNOT be tampered with proved nothing ~6% of the time
    // and failed red the rest of that 6%.
    //
    // The rate is structural, not incidental. `encodeAuthFlowCookie` seals
    // {state(43), verifier(43), nonce(22)} → a JSON body that is ALWAYS 145
    // bytes, and `encryptAtRest` prepends iv(12) + tag(16) to an equal-length
    // GCM ciphertext → ALWAYS 173 bytes. 173 % 3 === 2, so the final base64url
    // character carries 4 significant bits followed by 2 pure padding bits: its
    // alphabet index is always a multiple of 4 (A E I M Q U Y c g k o s w 0 4 8),
    // and the 'A' → 'B' arm lands on the one value whose decoded nibble is
    // unchanged. Measured over 100,000 freshly generated 173-byte tokens with
    // the old expression verbatim: 6,263 no-ops = 6.263%, against 1/16 = 6.25%.
    //
    // So tamper at the BYTE level, inside the GCM tag (iv is 0..11, tag 12..27),
    // and assert the corruption is real before asserting the decoder rejects it.
    // Without the control arm a future edit could silently stop tampering again
    // and this spec would go back to passing for the wrong reason.
    const raw = Buffer.from(cookie, 'base64url');
    const flipped = Buffer.from(raw);
    flipped[20] ^= 0xff; // byte 20 is inside the 16-byte auth tag
    const tampered = flipped.toString('base64url');
    expect(Buffer.from(tampered, 'base64url').equals(raw)).toBe(false);
    expect(decodeAuthFlowCookie(tampered)).toBeNull();
  });

  it('CONTROL: the tamper is byte-real for every cookie, not 15 times in 16', () => {
    // The property the case above depends on, exercised over enough freshly
    // minted cookies that the old 1-in-16 no-op could not survive here either
    // (P(all 200 clean) under the old scheme ≈ 0.9375^200 ≈ 2.4e-6).
    for (let i = 0; i < 200; i++) {
      const cookie = encodeAuthFlowCookie(newAuthFlow())!;
      const raw = Buffer.from(cookie, 'base64url');
      // The fixed 173-byte layout the comment above leans on. If the sealed
      // shape ever changes, this is the assertion that says so rather than the
      // tamper quietly moving outside the tag.
      expect(raw.length).toBe(173);
      const flipped = Buffer.from(raw);
      flipped[20] ^= 0xff;
      expect(Buffer.from(flipped.toString('base64url'), 'base64url').equals(raw)).toBe(false);
      expect(decodeAuthFlowCookie(flipped.toString('base64url'))).toBeNull();
    }
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
