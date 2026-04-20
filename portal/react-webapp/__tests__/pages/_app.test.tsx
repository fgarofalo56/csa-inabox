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

import { resolveAuthEnabled } from '@/services/authConfig';

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
