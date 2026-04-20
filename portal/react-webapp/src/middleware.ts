/**
 * CSA-0020 Phase 1 — Strict CSP with per-request nonces.
 *
 * Next.js middleware runs on every request (subject to the `matcher`
 * below) and injects a freshly-generated nonce into both the
 * `Content-Security-Policy` response header and a request header
 * (`x-nonce`) that `_document.tsx` reads via `getInitialProps` so that
 * `<NextScript>` and `<Head>` carry the matching `nonce=` attribute.
 *
 * The pure header/nonce logic lives in `services/csp.ts` so it can be
 * unit-tested in jsdom without pulling the Edge runtime globals that
 * `next/server` depends on.
 *
 * Why nonces + `strict-dynamic` (instead of a hash allow-list or
 * `'unsafe-inline'`)?
 *   - Nonces are per-response, so a leaked nonce is stale on the next
 *     load — strictly better than a long-lived hash list.
 *   - `strict-dynamic` lets scripts we load (Next.js chunks, MSAL
 *     helpers) load their dependencies without us having to enumerate
 *     every CDN up-front.
 *   - `require-trusted-types-for 'script'` + the `default` Trusted
 *     Types policy blocks string-to-DOM sinks (e.g. `innerHTML`),
 *     cutting off a common XSS exfil path for MSAL session tokens.
 *
 * Interim rationale: CSP alone does not eliminate the XSS token
 * exfiltration class for `sessionStorage`-backed MSAL — that requires
 * the BFF pattern (Phase 2, ADR-0014). CSP dramatically raises the
 * cost of writing a successful exploit in the meantime.
 */

import { NextRequest, NextResponse } from 'next/server';
import { buildCspHeader, generateCspNonce } from '@/services/csp';

export function middleware(request: NextRequest): NextResponse {
  const nonce = generateCspNonce();
  const csp = buildCspHeader(nonce);

  // Propagate the nonce to the downstream handler (SSR/_document) via
  // a request header — this is how `_document.tsx` reads it in
  // `getInitialProps(ctx)`.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // Set on the response so the browser enforces the policy.
  response.headers.set('content-security-policy', csp);
  // Mirror the nonce on the response for debugging / client-side
  // introspection; the authoritative source remains the request header
  // above which `_document.tsx` reads.
  response.headers.set('x-nonce', nonce);

  return response;
}

/**
 * Skip middleware on Next.js static assets and internal image
 * optimisation — they are served with long-lived cache headers and
 * are not HTML documents, so a per-request CSP nonce is both wasted
 * work and can break caching.
 *
 * The API rewrite (`/api/*` -> backend) still gets CSP headers because
 * the backend may embed error HTML responses.
 */
export const config = {
  matcher: [
    /*
     * Match every path except:
     *   - /_next/static (static assets)
     *   - /_next/image (image optimiser)
     *   - /favicon.ico
     *   - any file with an extension (images, fonts, source maps, etc.)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
};
