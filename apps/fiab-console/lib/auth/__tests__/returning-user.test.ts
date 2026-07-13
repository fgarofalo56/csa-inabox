/**
 * Unit tests for the returning-user reauth-destination decision
 * (lib/auth/returning-user).
 *
 * This locks the core auth-UX fix: an unauthenticated session-expiry 401 must
 * send a RETURNING user (identity-free `loom_seen` hint present) to the seamless
 * SSO initiator, but a FIRST-TIME / never-authenticated visitor to the /welcome
 * landing surface — so the "Request access" path is reachable instead of an
 * auto-bounce to Entra.
 *
 * Pure string logic — no React render, no network, no DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  hasReturningUserHint,
  reauthDestination,
  returningUserCookieHeader,
  RETURNING_USER_COOKIE,
  SIGN_IN_PATH,
  WELCOME_PATH,
} from '../returning-user';

describe('returning-user reauth decision', () => {
  describe('hasReturningUserHint', () => {
    it('is false for empty / null / undefined cookie strings', () => {
      expect(hasReturningUserHint('')).toBe(false);
      expect(hasReturningUserHint(null)).toBe(false);
      expect(hasReturningUserHint(undefined)).toBe(false);
    });

    it('is false when loom_seen is absent (other cookies present)', () => {
      expect(hasReturningUserHint('loom_session=abc; theme=dark')).toBe(false);
    });

    it('is true when loom_seen has a non-empty value', () => {
      expect(hasReturningUserHint('loom_seen=1')).toBe(true);
      expect(hasReturningUserHint('theme=dark; loom_seen=1; other=x')).toBe(true);
    });

    it('is false when loom_seen is present but empty', () => {
      expect(hasReturningUserHint('loom_seen=')).toBe(false);
      expect(hasReturningUserHint('loom_seen=;theme=dark')).toBe(false);
    });

    it('does not false-match a cookie whose name merely ends with the hint name', () => {
      // `not_loom_seen` must not be read as `loom_seen`.
      expect(hasReturningUserHint('not_loom_seen=1')).toBe(false);
      expect(hasReturningUserHint('xloom_seen=1')).toBe(false);
    });

    it('tolerates surrounding whitespace around pairs', () => {
      expect(hasReturningUserHint('  loom_seen=1  ')).toBe(true);
      expect(hasReturningUserHint('a=b ;  loom_seen=1')).toBe(true);
    });
  });

  describe('reauthDestination', () => {
    it('routes a RETURNING user (hint present) to the seamless SSO initiator', () => {
      expect(reauthDestination('loom_seen=1')).toBe(SIGN_IN_PATH);
      expect(reauthDestination('loom_session=x; loom_seen=1')).toBe('/auth/sign-in');
    });

    it('routes a FIRST-TIME user (hint absent) to the /welcome landing surface', () => {
      expect(reauthDestination('')).toBe(WELCOME_PATH);
      expect(reauthDestination(null)).toBe('/welcome');
      expect(reauthDestination('loom_session=x')).toBe('/welcome');
    });
  });

  describe('returningUserCookieHeader', () => {
    it('stamps a durable, non-HttpOnly, Secure, SameSite=Lax, root-path hint', () => {
      const header = returningUserCookieHeader();
      expect(header.startsWith(`${RETURNING_USER_COOKIE}=1;`)).toBe(true);
      expect(header).toMatch(/Path=\//);
      expect(header).toMatch(/Secure/);
      expect(header).toMatch(/SameSite=Lax/);
      // NOT HttpOnly — client-fetch must read it from document.cookie.
      expect(header).not.toMatch(/HttpOnly/i);
      // Durable (~180 days), not a session cookie.
      expect(header).toMatch(/Max-Age=\d{6,}/);
      // The header the callback writes must be recognized by the reader.
      const value = header.split(';')[0];
      expect(hasReturningUserHint(value)).toBe(true);
    });
  });
});
