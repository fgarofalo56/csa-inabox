/**
 * REGRESSION GUARD — the session cookie must always be small enough to reach the
 * browser.
 *
 * THE OUTAGE (2026-08-13, Commercial, P0). #3175 started writing the Entra
 * `groups` claim into the session cookie and set `groupMembershipClaims:
 * SecurityGroup` on the app registration. That claim carries security groups AND
 * directory roles, so the tenant's Global Admin arrived with 99 object ids. The
 * cookie went to **5383 bytes** against a 4096-byte cap. Browsers (RFC 6265 §6.1)
 * and Azure Front Door both DISCARD an over-length Set-Cookie **silently**, so:
 *
 *   - AAD authenticated the user correctly
 *   - the code exchange succeeded
 *   - the server logged `[auth/callback] session encoded ... cookie length 5383`
 *   - the browser stored NOTHING
 *   - `/` saw an unauthenticated request and bounced back to sign-in
 *   - forever
 *
 * Every single layer reported success. The ONLY visible number was the cookie
 * length in a log line nothing asserted on. That is why this guard exists and why
 * it asserts the PRODUCER's output size rather than any downstream behavior.
 *
 * WHY THE GUARD BITES: `encodeSessionCookie` is the one function every session
 * cookie passes through, so a future claim added to `UserClaims` — whatever it is
 * — is covered without anyone remembering this incident. The realistic-payload
 * cases below are calibrated to the real Entra shapes (36-char GUIDs), so they
 * fail on the actual regression and not on a synthetic edge.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  encodeSessionCookie,
  sessionGroupsDroppedForSize,
  MAX_COOKIE_VALUE_BYTES,
  type SessionPayload,
} from '../session';

/** RFC 6265 §6.1 per-cookie minimum every browser implements as a hard cap. */
const BROWSER_COOKIE_CAP = 4096;

/** The `loom_session=...; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax` overhead. */
const COOKIE_ATTRIBUTE_OVERHEAD = 'loom_session=; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax'.length;

const guid = (n: number) => `716f5ec5-aaaa-bbbb-cccc-${String(n).padStart(12, '0')}`;

function payloadWithGroups(count: number): SessionPayload {
  return {
    claims: {
      oid: guid(1),
      tid: guid(2),
      name: 'Frank Garofalo',
      email: 'frank@limitlessdata.ai',
      upn: 'frank@limitlessdata.ai',
      groups: Array.from({ length: count }, (_, i) => guid(i)),
    },
    exp: Math.floor(Date.now() / 1000) + 28800,
  };
}

beforeAll(() => {
  // encodeSessionCookie derives its key from SESSION_SECRET via HKDF and throws
  // without one. Any value works — this test asserts SIZE, never a secret.
  process.env.SESSION_SECRET ||= 'test-session-secret-for-size-assertions';
});

describe('session cookie size guard (P0 sign-in loop, 2026-08-13)', () => {
  it('the configured cap leaves room for the cookie name and attributes', () => {
    expect(MAX_COOKIE_VALUE_BYTES + COOKIE_ATTRIBUTE_OVERHEAD).toBeLessThanOrEqual(BROWSER_COOKIE_CAP);
  });

  it('EXACT REGRESSION: a 99-group Global Admin still gets a deliverable cookie', () => {
    // 99 is the measured membership of the tenant admin whose sign-in looped.
    // Before the fix this encoded to 5383 bytes and the browser dropped it.
    const encoded = encodeSessionCookie(payloadWithGroups(99));
    expect(encoded.length).toBeLessThanOrEqual(MAX_COOKIE_VALUE_BYTES);
    expect(encoded.length + COOKIE_ATTRIBUTE_OVERHEAD).toBeLessThanOrEqual(BROWSER_COOKIE_CAP);
  });

  it('holds across the whole plausible membership range, including absurd ones', () => {
    // The cliff was at 73 groups. Sweep well past it: no membership size may ever
    // produce an undeliverable cookie.
    for (const count of [0, 1, 8, 50, 72, 73, 74, 99, 250, 1000, 5000]) {
      const encoded = encodeSessionCookie(payloadWithGroups(count));
      expect(
        encoded.length + COOKIE_ATTRIBUTE_OVERHEAD,
        `cookie for ${count} groups is ${encoded.length} bytes — the browser will DISCARD it and sign-in will loop`,
      ).toBeLessThanOrEqual(BROWSER_COOKIE_CAP);
    }
  });

  it('keeps the inline groups claim for normally-grouped users (does not over-trim)', () => {
    // The fix must not silently disable #3175's fast path for ordinary users —
    // that would trade a login outage for a org-wide Graph round-trip per request.
    const small = payloadWithGroups(8);
    expect(sessionGroupsDroppedForSize(small)).toBe(false);
    expect(encodeSessionCookie(small).length).toBeLessThanOrEqual(MAX_COOKIE_VALUE_BYTES);
  });

  it('reports the drop for an oversized membership so an operator can see it', () => {
    expect(sessionGroupsDroppedForSize(payloadWithGroups(99))).toBe(true);
  });

  it('drops groups to UNDEFINED, never [] — [] would suppress the Graph fallback', () => {
    // `groupsClaimUnavailable()` treats empty-or-absent as "ask Graph", but every
    // other consumer does `claims.groups || []`. Asserting "in no groups" would be
    // a fact we never established, and would DENY a heavily-grouped admin instead
    // of looking them up.
    const encoded = encodeSessionCookie(payloadWithGroups(99));
    // Decode via the module's own reader path to inspect what was actually stored.
    const raw = Buffer.from(encoded, 'base64url');
    // iv(12) + tag(16) prefix — decrypt with the same derived key the module uses.
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const key = Buffer.from(
      crypto.hkdfSync(
        'sha256',
        Buffer.from(process.env.SESSION_SECRET as string, 'utf-8'),
        Buffer.alloc(32),
        Buffer.from('loom-session-v1'),
        32,
      ) as ArrayBuffer,
    );
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf-8');
    const parsed = JSON.parse(plain) as SessionPayload;
    expect(parsed.claims.groups).toBeUndefined();
    expect(parsed.claims.groups).not.toEqual([]);
    // The identity claims must survive the trim — dropping those would break auth
    // in a different direction.
    expect(parsed.claims.oid).toBe(guid(1));
    expect(parsed.claims.upn).toBe('frank@limitlessdata.ai');
    expect(parsed.exp).toBeGreaterThan(0);
  });
});
