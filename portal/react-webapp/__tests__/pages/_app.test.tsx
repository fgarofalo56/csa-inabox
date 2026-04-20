/**
 * Tests for the app-level auth gate (CSA-0122).
 *
 * The gate decides whether MsalProvider / AuthenticatedTemplate wrap the
 * tree. We cover the decision function directly because Next.js inlines
 * `NEXT_PUBLIC_*` values at build time, which makes exercising the full
 * MSAL render path inside Jest brittle (and `_app.tsx` has module-level
 * side effects — MSAL instance construction, API client binding — that
 * are intentionally not re-initialised per test).
 */

import {
  resolveAuthEnabled,
  resolveAuthMode,
  msalConfig,
} from '@/services/authConfig';

describe('msalConfig cache hardening (CSA-0020 Phase 1)', () => {
  it('retains sessionStorage cache (interim, until BFF rollout per ADR-0014)', () => {
    expect(msalConfig.cache?.cacheLocation).toBe('sessionStorage');
  });

  it('does NOT carry the removed-in-MSAL-v4 storeAuthStateInCookie key (see authConfig.ts header)', () => {
    // The AQ-0012 mitigation that `storeAuthStateInCookie: true`
    // previously provided is now the MSAL v5 default (redirect flows
    // cookie their request state out of the box). We explicitly assert
    // the key is absent so a future MSAL version cannot silently
    // regress us back onto the deprecated flag without a conscious
    // config change + test update.
    const cache = msalConfig.cache as Record<string, unknown> | undefined;
    expect(cache).toBeDefined();
    expect(cache && 'storeAuthStateInCookie' in cache).toBe(false);
  });
});

describe('resolveAuthMode (CSA-0020 / ADR-0014)', () => {
  it('defaults to spa when NEXT_PUBLIC_AUTH_MODE is unset', () => {
    expect(resolveAuthMode({} as unknown as NodeJS.ProcessEnv)).toBe('spa');
  });

  it('returns spa explicitly when NEXT_PUBLIC_AUTH_MODE === "spa"', () => {
    expect(
      resolveAuthMode({ NEXT_PUBLIC_AUTH_MODE: 'spa' } as unknown as NodeJS.ProcessEnv)
    ).toBe('spa');
  });

  it('returns bff when NEXT_PUBLIC_AUTH_MODE === "bff"', () => {
    expect(
      resolveAuthMode({ NEXT_PUBLIC_AUTH_MODE: 'bff' } as unknown as NodeJS.ProcessEnv)
    ).toBe('bff');
  });

  it('falls back to spa on unknown values (fails safe — never silently disables SPA auth)', () => {
    expect(
      resolveAuthMode({ NEXT_PUBLIC_AUTH_MODE: 'hybrid' } as unknown as NodeJS.ProcessEnv)
    ).toBe('spa');
    expect(
      resolveAuthMode({ NEXT_PUBLIC_AUTH_MODE: 'BFF' } as unknown as NodeJS.ProcessEnv)
    ).toBe('spa');
    expect(
      resolveAuthMode({ NEXT_PUBLIC_AUTH_MODE: '' } as unknown as NodeJS.ProcessEnv)
    ).toBe('spa');
  });
});

describe('resolveAuthEnabled (CSA-0122)', () => {
  it('returns true when NEXT_PUBLIC_AUTH_ENABLED === "true" (MsalProvider gates the tree)', () => {
    expect(
      resolveAuthEnabled({
        NEXT_PUBLIC_AUTH_ENABLED: 'true',
        NODE_ENV: 'development',
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it('returns false when NEXT_PUBLIC_AUTH_ENABLED === "false" (children render directly, even in prod)', () => {
    expect(
      resolveAuthEnabled({
        NEXT_PUBLIC_AUTH_ENABLED: 'false',
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it('fails closed (auth on) in production when the flag is unset', () => {
    expect(
      resolveAuthEnabled({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it('fails open (demo mode) in non-production when the flag is unset', () => {
    expect(
      resolveAuthEnabled({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      resolveAuthEnabled({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it('only accepts canonical "true" / "false" as explicit overrides', () => {
    // Anything else falls through to the NODE_ENV default.
    expect(
      resolveAuthEnabled({
        NEXT_PUBLIC_AUTH_ENABLED: '1',
        NODE_ENV: 'development',
      } as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      resolveAuthEnabled({
        NEXT_PUBLIC_AUTH_ENABLED: 'TRUE',
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });
});
