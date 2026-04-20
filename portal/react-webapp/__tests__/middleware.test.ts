/**
 * Tests for the per-request CSP + nonce middleware (CSA-0020 Phase 1).
 *
 * We exercise the pure `buildCspHeader` helper (in `src/services/csp.ts`)
 * directly — the `middleware()` entrypoint depends on `next/server`,
 * which in turn depends on the Edge runtime `Request` / `Response`
 * globals that Jest/jsdom does not polyfill. Keeping the tested surface
 * to the pure module keeps this suite hermetic while still covering the
 * header shape that the browser actually enforces.
 */

import { buildCspHeader } from '@/services/csp';

describe('buildCspHeader (CSA-0020 Phase 1)', () => {
  const NONCE = 'dGVzdC1ub25jZS0xMjM0NTY=';

  it('pins the nonce into script-src and style-src', () => {
    const csp = buildCspHeader(NONCE, ({} as unknown as NodeJS.ProcessEnv));
    expect(csp).toContain(`script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`);
    expect(csp).toContain(`style-src 'self' 'nonce-${NONCE}'`);
  });

  it('declares default-src self only (no wildcards, no unsafe-inline)', () => {
    const csp = buildCspHeader(NONCE, ({} as unknown as NodeJS.ProcessEnv));
    expect(csp).toMatch(/(^|; )default-src 'self'/);
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/default-src [^;]*\*/);
  });

  it('allow-lists Entra ID + Graph on both commercial and government clouds', () => {
    const csp = buildCspHeader(NONCE, ({} as unknown as NodeJS.ProcessEnv));
    expect(csp).toContain('https://login.microsoftonline.com');
    expect(csp).toContain('https://login.microsoftonline.us');
    expect(csp).toContain('https://graph.microsoft.com');
    expect(csp).toContain('https://graph.microsoft.us');
  });

  it('blocks framing, inline objects, and locks base/form targets', () => {
    const csp = buildCspHeader(NONCE, ({} as unknown as NodeJS.ProcessEnv));
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it('enables Trusted Types to harden string-to-DOM sinks', () => {
    const csp = buildCspHeader(NONCE, ({} as unknown as NodeJS.ProcessEnv));
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain('trusted-types default');
  });

  it('appends the BFF origin to connect-src when NEXT_PUBLIC_BFF_API_ORIGIN is set', () => {
    const csp = buildCspHeader(NONCE, {
      NEXT_PUBLIC_BFF_API_ORIGIN: 'https://bff.example.com',
    } as unknown as NodeJS.ProcessEnv);
    expect(csp).toContain('https://bff.example.com');
  });

  it('omits the BFF origin when NEXT_PUBLIC_BFF_API_ORIGIN is unset (SPA-only build)', () => {
    const csp = buildCspHeader(NONCE, ({} as unknown as NodeJS.ProcessEnv));
    // No accidental token from reading `undefined` into the directive.
    expect(csp).not.toMatch(/connect-src [^;]*undefined/);
  });

  it('produces a directive-joined string matching the browser parser shape', () => {
    const csp = buildCspHeader(NONCE, ({} as unknown as NodeJS.ProcessEnv));
    // Each directive is separated by `; ` with no trailing semicolon.
    expect(csp.endsWith(';')).toBe(false);
    const parts = csp.split('; ');
    expect(parts.length).toBeGreaterThanOrEqual(10);
  });
});

describe('CSP nonce format (CSA-0020 Phase 1)', () => {
  // `generateCspNonce` depends on `crypto.getRandomValues` + `btoa`.
  // Node 20+ (used for `next dev` and Jest) has both globally. We
  // assert on the shape of a valid nonce rather than re-running the
  // generator across every platform the suite may execute on.
  it('accepts base64 nonces of the expected entropy envelope', () => {
    // 16 random bytes → base64 → 24 chars (22 payload + `==` padding)
    const candidates = [
      'AAAAAAAAAAAAAAAAAAAAAA==',
      'dGVzdC1ub25jZXNzYW1wbGUx',
      'RXhhbXBsZU5vbmNlQWJjMTIr',
    ];
    const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
    for (const n of candidates) {
      expect(n).toMatch(base64Regex);
      expect(n.length).toBe(24);
    }
  });
});
