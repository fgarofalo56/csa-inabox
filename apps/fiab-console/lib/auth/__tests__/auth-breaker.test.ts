/**
 * Unit tests for the sign-in circuit breaker's LOGIC and its COPY (#3334).
 *
 * The composed behaviour — that the two auth routes wired together actually
 * stop — is proven next door in app/auth/__tests__/sign-in-loop-termination.ts.
 * This file covers the two things that spec cannot isolate:
 *
 *   1. The counting rules, including the ones whose whole purpose is to NOT
 *      fire: a bare initiation is not an attempt, a stale window resets, a
 *      forged cookie is narrowed rather than trusted.
 *   2. deploy-integrity R7 — that no narrative asserts something the code did
 *      not establish. That is a property of STRINGS, so it is asserted on the
 *      strings. The `session_not_returned` case is the sharp one: it may blame
 *      the 4096-byte cookie limit ONLY when the measured header actually
 *      exceeds it, and must say so is not the explanation when it does not.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  AUTH_CAUSES,
  BROWSER_COOKIE_LIMIT_BYTES,
  authBreakerEnabled,
  authBreakerMaxAttempts,
  authBreakerWindowSecs,
  clearAttemptCookieHeader,
  decodeAttemptCookie,
  describeCause,
  encodeAttemptCookie,
  hopFromParam,
  hopFromState,
  parseCause,
  recordAttempt,
  requestIsHttps,
  setAttemptCookieHeader,
  stampOutcome,
  stateWithHop,
  type AuthAttemptState,
} from '../auth-breaker';

const NOW = 1_760_000_000;

describe('auth-breaker — configuration', () => {
  beforeEach(() => {
    delete process.env.LOOM_AUTH_BREAKER_ENABLED;
    delete process.env.LOOM_AUTH_BREAKER_MAX_ATTEMPTS;
    delete process.env.LOOM_AUTH_BREAKER_WINDOW_SECS;
  });
  afterEach(() => {
    delete process.env.LOOM_AUTH_BREAKER_ENABLED;
    delete process.env.LOOM_AUTH_BREAKER_MAX_ATTEMPTS;
    delete process.env.LOOM_AUTH_BREAKER_WINDOW_SECS;
  });

  it('is ON by default — the breaker is not an opt-in', () => {
    expect(authBreakerEnabled()).toBe(true);
    process.env.LOOM_AUTH_BREAKER_ENABLED = 'TRUE';
    expect(authBreakerEnabled()).toBe(true);
    process.env.LOOM_AUTH_BREAKER_ENABLED = 'false';
    expect(authBreakerEnabled()).toBe(false);
  });

  it('ignores nonsense overrides rather than adopting them', () => {
    process.env.LOOM_AUTH_BREAKER_MAX_ATTEMPTS = 'banana';
    expect(authBreakerMaxAttempts()).toBe(5);
    process.env.LOOM_AUTH_BREAKER_MAX_ATTEMPTS = '0';
    expect(authBreakerMaxAttempts()).toBe(5);
    // A ceiling of 5000 would be a breaker that never breaks.
    process.env.LOOM_AUTH_BREAKER_MAX_ATTEMPTS = '5000';
    expect(authBreakerMaxAttempts()).toBe(99);
    process.env.LOOM_AUTH_BREAKER_MAX_ATTEMPTS = '3';
    expect(authBreakerMaxAttempts()).toBe(3);

    process.env.LOOM_AUTH_BREAKER_WINDOW_SECS = '-1';
    expect(authBreakerWindowSecs()).toBe(600);
    process.env.LOOM_AUTH_BREAKER_WINDOW_SECS = '120';
    expect(authBreakerWindowSecs()).toBe(120);
  });
});

describe('auth-breaker — cookie codec', () => {
  it('round-trips a state exactly', () => {
    const s: AuthAttemptState = { n: 3, first: NOW, cause: 'state_mismatch', cookieHeaderBytes: 5383 };
    expect(decodeAttemptCookie(encodeAttemptCookie(s))).toEqual(s);
  });

  it('returns null for garbage instead of throwing', () => {
    expect(decodeAttemptCookie(undefined)).toBeNull();
    expect(decodeAttemptCookie('')).toBeNull();
    expect(decodeAttemptCookie('not-base64url!!!')).toBeNull();
    expect(decodeAttemptCookie(Buffer.from('{not json', 'utf-8').toString('base64url'))).toBeNull();
    expect(decodeAttemptCookie(Buffer.from('{"n":"x","first":1}', 'utf-8').toString('base64url'))).toBeNull();
  });

  it('NARROWS a forged cookie rather than trusting its fields', () => {
    // The cookie is deliberately unsigned so it survives the no_session_secret
    // case (itself one of the loop causes). Forging it must therefore be inert:
    // an unknown cause is dropped, an absurd count is clamped, and neither
    // reaches the page as-is.
    const forged = Buffer.from(
      JSON.stringify({ n: 99999, first: NOW, cause: '<script>alert(1)</script>', pending: 'nope' }),
      'utf-8',
    ).toString('base64url');
    const decoded = decodeAttemptCookie(forged);
    expect(decoded).toEqual({ n: 99, first: NOW });
    expect(decoded!.cause).toBeUndefined();
    expect(decoded!.pending).toBeUndefined();
  });

  it('parseCause admits only the closed set', () => {
    for (const c of AUTH_CAUSES) expect(parseCause(c)).toBe(c);
    expect(parseCause('state_mismatch ')).toBeNull();
    expect(parseCause('__proto__')).toBeNull();
    expect(parseCause(null)).toBeNull();
  });

  it('sets Secure only on https, so an http deployment can still be protected', () => {
    // A Secure cookie is silently dropped over http — and an http deployment is
    // itself a loop cause (the frontDoorEnabled-unset case). A breaker cookie
    // that cannot be stored there could never fire. It carries no secret.
    expect(setAttemptCookieHeader({ n: 1, first: NOW }, true)).toContain('Secure');
    expect(setAttemptCookieHeader({ n: 1, first: NOW }, false)).not.toContain('Secure');
    expect(clearAttemptCookieHeader(true)).toContain('Max-Age=0');
    expect(clearAttemptCookieHeader(false)).not.toContain('Secure');
    // Always scoped + HttpOnly + Lax so it rides the top-level callback GET.
    expect(setAttemptCookieHeader({ n: 1, first: NOW }, true)).toContain('Path=/auth');
    expect(setAttemptCookieHeader({ n: 1, first: NOW }, true)).toContain('HttpOnly');
    expect(setAttemptCookieHeader({ n: 1, first: NOW }, true)).toContain('SameSite=Lax');
  });

  it('reads the protocol from the forwarded headers the edge sets', () => {
    expect(requestIsHttps(new Headers({ 'x-forwarded-proto': 'https' }))).toBe(true);
    expect(requestIsHttps(new Headers({ 'x-forwarded-proto': 'http' }))).toBe(false);
    // Front Door can send a comma-joined list; the first hop is the client's.
    expect(requestIsHttps(new Headers({ 'x-forwarded-proto': 'https, http' }))).toBe(true);
    expect(requestIsHttps(new Headers({ host: 'localhost:3000' }))).toBe(false);
    expect(requestIsHttps(new Headers({ host: 'csa-loom.example' }))).toBe(true);
  });
});

describe('auth-breaker — the stateless hop channel', () => {
  it('appends a suffix that cannot collide with the random half of the state', () => {
    // base64url has no `~`, so the separator is unambiguous.
    const state = 'MYaWjJSsnVLmTU2QQgTssOHl_8WGVMuEgTVR-sX6rH8';
    expect(stateWithHop(state, 3)).toBe(`${state}~h3`);
    expect(hopFromState(stateWithHop(state, 3))).toBe(3);
    expect(hopFromState(state)).toBeNull();
  });

  it('bounds an attacker-supplied hop instead of trusting it', () => {
    expect(hopFromState('abc~h99')).toBe(99);
    expect(hopFromState('abc~h999')).toBeNull();      // 3 digits — not our shape
    expect(hopFromState('abc~hNaN')).toBeNull();
    expect(hopFromState('abc~h3trailing')).toBeNull(); // must be at the very end
    expect(hopFromParam('7')).toBe(7);
    expect(hopFromParam('007')).toBeNull();
    expect(hopFromParam('-1')).toBeNull();
    expect(hopFromParam('1e9')).toBeNull();
  });
});

describe('auth-breaker — counting', () => {
  beforeEach(() => {
    delete process.env.LOOM_AUTH_BREAKER_MAX_ATTEMPTS;
    delete process.env.LOOM_AUTH_BREAKER_WINDOW_SECS;
  });

  it('a bare initiation is NOT an attempt — this is why a password fumbler is safe', () => {
    // No pending stamp = no completed callback = no evidence a round trip
    // failed. Ten clicks on Sign in that never reach Entra count zero.
    let state: AuthAttemptState | null = null;
    for (let i = 0; i < 10; i++) {
      const d = recordAttempt(state, NOW + i, null);
      expect(d.tripped).toBe(false);
      expect(d.effective).toBe(0);
      state = d.state;
    }
  });

  it('counts a completed round trip that left the browser unauthenticated', () => {
    let state: AuthAttemptState | null = null;
    const max = authBreakerMaxAttempts();
    for (let i = 1; i <= max; i++) {
      // The callback stamps first; sign-in attributes and counts.
      state = stampOutcome(state, 'authflow_cookie_missing', NOW + i);
      const d = recordAttempt(state, NOW + i, null);
      expect(d.effective).toBe(i);
      expect(d.tripped).toBe(i >= max);
      expect(d.cause).toBe('authflow_cookie_missing');
      state = d.state;
    }
  });

  it('converts a session_issued stamp into session_not_returned at attribution', () => {
    // The callback established ONLY that it emitted a cookie. Sign-in adds the
    // other half — that the browser came back without one. Neither half alone
    // supports the claim; together they do.
    const stamped = stampOutcome(null, 'session_issued', NOW, 5383);
    expect(stamped.pending).toBe('session_issued');
    const d = recordAttempt(stamped, NOW, null);
    expect(d.cause).toBe('session_not_returned');
    expect(d.state.cookieHeaderBytes).toBe(5383);
  });

  it('once tripped it STAYS tripped inside the window — no accidental resume', () => {
    // The trip consumes the pending stamp, so the next sign-in has no evidence.
    // If that reset it to "not tripped" the loop would resume on every other
    // hop. Regression guard for the defect the loop spec caught.
    let state: AuthAttemptState | null = null;
    const max = authBreakerMaxAttempts();
    for (let i = 1; i <= max; i++) {
      state = recordAttempt(stampOutcome(state, 'state_mismatch', NOW, undefined), NOW, null).state;
    }
    for (let i = 0; i < 5; i++) {
      const d = recordAttempt(state, NOW + i, null);
      expect(d.tripped).toBe(true);
      expect(d.cause).toBe('state_mismatch');
      state = d.state;
    }
  });

  it('a stale window resets — a loop is seconds apart, not hours', () => {
    const tripped: AuthAttemptState = { n: 9, first: NOW, cause: 'state_mismatch' };
    const later = NOW + authBreakerWindowSecs() + 1;
    const d = recordAttempt(tripped, later, null);
    expect(d.tripped).toBe(false);
    expect(d.effective).toBe(0);
    expect(d.state.first).toBe(later);
  });

  it('a clock that went backwards resets rather than counting forever', () => {
    const state: AuthAttemptState = { n: 4, first: NOW + 10_000, cause: 'state_mismatch' };
    const d = recordAttempt(state, NOW, null);
    expect(d.effective).toBe(0);
    expect(d.state.first).toBe(NOW);
  });

  it('the hop channel trips on its own when no cookie survives', () => {
    // prev is null on every hop — the browser stores nothing. Only the hop
    // carried in the OAuth state remains, and it must still terminate.
    const max = authBreakerMaxAttempts();
    for (let hop = 0; hop < max - 1; hop++) {
      expect(recordAttempt(null, NOW, hop).tripped).toBe(false);
    }
    expect(recordAttempt(null, NOW, max - 1).tripped).toBe(true);
  });

  it('neither channel can mask the other — the effective count is the max', () => {
    const cookieAhead: AuthAttemptState = { n: 4, first: NOW, pending: 'state_mismatch' };
    // Cookie says this is attempt 5; a stale hop of 0 must not drag it back.
    expect(recordAttempt(cookieAhead, NOW, 0).effective).toBe(5);
    // Hop says 5 round trips have failed; an absent cookie must not hide it.
    expect(recordAttempt(null, NOW, 4).effective).toBe(5);
  });
});

describe('auth-breaker — the copy states only what was established (R7)', () => {
  it('every cause has a narrative — no cause can fall through to a generic string', () => {
    for (const cause of AUTH_CAUSES) {
      const n = describeCause(cause);
      expect(n.headline.length, cause).toBeGreaterThan(10);
      expect(n.established.length, cause).toBeGreaterThan(40);
    }
  });

  it('the ambiguous case SAYS it is ambiguous instead of picking a likelier cause', () => {
    const n = describeCause('no_state_returned');
    expect(n.established).toMatch(/cannot tell|did not establish|not reporting a cause it did not measure/i);
  });

  it('distinguishes a missing cookie from a genuine state MISMATCH', () => {
    // Collapsing these was the pre-#3334 behaviour: both produced
    // `auth_error=state_mismatch`, which asserts a comparison that never ran.
    const missing = describeCause('authflow_cookie_missing');
    const mismatch = describeCause('state_mismatch');
    expect(missing.established).toContain('did not come back');
    expect(missing.established).not.toMatch(/did not match/);
    expect(mismatch.established).toContain('did not match');
  });

  it('blames the cookie size ONLY when the measurement exceeds the limit', () => {
    const over = describeCause('session_not_returned', BROWSER_COOKIE_LIMIT_BYTES + 1);
    expect(over.established).toContain(String(BROWSER_COOKIE_LIMIT_BYTES + 1));
    expect(over.established).toContain('over the 4096-byte');
    expect(over.operatorAction).toBe(true);

    const under = describeCause('session_not_returned', 900);
    expect(under.established).toContain('900');
    expect(under.established).toContain('does NOT explain this');
    expect(under.established).not.toContain('over the 4096-byte');
    expect(under.operatorAction).toBe(false);
  });

  it('says it did not record the size rather than implying one', () => {
    const unknown = describeCause('session_not_returned');
    expect(unknown.established).toContain('did not record the size');
    expect(unknown.established).not.toContain('4096-byte per-cookie limit, so the size');
  });

  it('never reflects a raw secret or a raw exchange error into the page', () => {
    // The exchange detail deliberately stays server-side; the page says so.
    const n = describeCause('exchange_failed');
    expect(n.established).toContain('not shown here');
    expect(n.whatToTry.join(' ')).toContain('[auth/callback]');
  });

  it('marks deployment-side causes as operator actions', () => {
    for (const c of ['not_configured', 'no_client_secret', 'no_session_secret'] as const) {
      expect(describeCause(c).operatorAction, c).toBe(true);
    }
    for (const c of ['authflow_cookie_missing', 'state_mismatch', 'rate_limited'] as const) {
      expect(describeCause(c).operatorAction, c).toBe(false);
    }
  });
});
