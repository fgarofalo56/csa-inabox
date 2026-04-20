/**
 * CSA-0020 Phase 1 — Content-Security-Policy + Trusted Types builder.
 *
 * Extracted from `src/middleware.ts` so the header shape can be
 * unit-tested in jsdom without pulling the `next/server` runtime
 * (which depends on the Edge `Request` global that Jest/jsdom does
 * not polyfill).
 *
 * The nonce is generated per-request in `middleware.ts` and passed
 * in here; this module is pure and has no side effects.
 */

// Entra ID endpoints (commercial + gov) and Microsoft Graph. Keeping
// both clouds allows the same build to serve commercial and gov
// deploys — the SPA picks the authority at runtime from
// NEXT_PUBLIC_AZURE_CLOUD.
const CONNECT_SRC_BASE: readonly string[] = [
  "'self'",
  'https://login.microsoftonline.com',
  'https://login.microsoftonline.us',
  'https://graph.microsoft.com',
  'https://graph.microsoft.us',
];

/**
 * Build the `Content-Security-Policy` header value for a given nonce.
 *
 * Directives:
 *   - `script-src 'self' 'nonce-<n>' 'strict-dynamic'` — the nonce
 *     bootstraps the first-party runtime; `strict-dynamic` lets scripts
 *     we load themselves load their dependencies without us having to
 *     enumerate every CDN.
 *   - `style-src 'self' 'nonce-<n>'` — inline styles require the
 *     nonce; Tailwind compiles to static CSS so `'unsafe-inline'` is
 *     NOT needed.
 *   - `img-src 'self' data: https:` — `data:` covers inline SVGs; the
 *     https fallback is intentional for user-avatar / marketplace
 *     thumbnails.
 *   - `frame-ancestors 'none'` — defence in depth against clickjacking
 *     (matches the backend `X-Frame-Options: DENY`).
 *   - `require-trusted-types-for 'script'` + `trusted-types default` —
 *     enforces a Trusted Types policy on string-to-DOM sinks, cutting
 *     off a common XSS exfil path for MSAL session tokens.
 *   - A `BFF_API_ORIGIN` can be injected via `NEXT_PUBLIC_BFF_API_ORIGIN`
 *     so the browser can fetch `/auth/me` when `AUTH_MODE=bff`.
 */
export function buildCspHeader(
  nonce: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const bffOrigin = env.NEXT_PUBLIC_BFF_API_ORIGIN;
  const connectSrc = bffOrigin
    ? [...CONNECT_SRC_BASE, bffOrigin]
    : [...CONNECT_SRC_BASE];

  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: https:",
    `connect-src ${connectSrc.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types default',
  ];
  return directives.join('; ');
}

/**
 * Generate a 16-byte base64 CSP nonce using Web Crypto.
 *
 * Exported so middleware and any future SSR code paths can share a
 * single implementation. The Edge runtime exposes `crypto.getRandomValues`
 * globally — no import needed.
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  // `crypto` is a global in both the Edge runtime and modern browsers.
  // In Node 20+ (used by local `next dev`) it's also available globally.
  crypto.getRandomValues(bytes);
  let binary = '';
  // Index-based loop keeps tsc target=es5 happy without --downlevelIteration
  // (the webapp tsconfig targets es5; Next.js down-compiles for itself).
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // btoa is available globally in the Edge runtime and browsers.
  return btoa(binary);
}
