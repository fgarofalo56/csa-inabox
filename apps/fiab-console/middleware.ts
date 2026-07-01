import { NextRequest, NextResponse } from 'next/server';

/**
 * Per-request Content-Security-Policy with a fresh nonce (deep-audit hardening).
 *
 * WHY: the console previously shipped its CSP from next.config.mjs with
 *   script-src 'self' 'unsafe-inline' blob: data: https://atlas.microsoft.com
 * `'unsafe-inline'` (and `data:`) in script-src permit arbitrary inline / data-URI
 * script execution, which negates most XSS protection for a data/security
 * console. A static header can't carry a per-request nonce, so the CSP now lives
 * here in middleware.
 *
 * HOW: we mint a nonce per request, expose it on the `x-nonce` request header,
 * and set the CSP (containing `'nonce-<n>'`) on BOTH the request and the
 * response. Next.js reads the nonce from the *request* Content-Security-Policy
 * header (getScriptNonceFromHeader) and stamps it onto its own inline framework
 * bootstrap scripts, so no inline allowance is needed for Next to boot. App code
 * that emits its own inline <script> (the two /auth/* route handlers) reads the
 * same `x-nonce` header and stamps it too.
 *
 * Deliberate choices:
 *  - NO `'strict-dynamic'`. Under CSP3, strict-dynamic makes browsers IGNORE
 *    host allowlists in script-src — which would silently drop
 *    `https://atlas.microsoft.com`. The Azure Maps Web SDK (atlas.min.js) loads
 *    as an external script from that host, so the host source must remain
 *    effective; we keep the host and omit strict-dynamic.
 *  - script-src drops `blob:` and `data:`. Monaco's language-service workers are
 *    created from blob:/data: URLs but run in the WORKER context, governed by
 *    `worker-src`/`child-src` (which keep blob: data:), NOT script-src. So Monaco
 *    is unaffected.
 *  - style-src keeps `'unsafe-inline'` unchanged. Fluent UI v9 (Griffel) injects
 *    inline <style>; adding a nonce to style-src would disable 'unsafe-inline'
 *    and break styling. Inline STYLE is materially lower-risk than inline SCRIPT.
 *  - All other directives are carried over 1:1 from the previous next.config CSP.
 *
 * NOTE: reading request headers for the nonce forces dynamic rendering of matched
 * routes. That is already this app's posture (auth-gated, force-dynamic, and HTML
 * is served `no-store` per next.config), so there is no caching regression.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://atlas.microsoft.com`,
    "worker-src 'self' blob: data:",
    "child-src 'self' blob: data:",
    "style-src 'self' 'unsafe-inline' https://atlas.microsoft.com",
    "img-src 'self' data: https:",
    "font-src 'self' data: https://atlas.microsoft.com",
    "connect-src 'self' https://login.microsoftonline.com https://login.microsoftonline.us https://*.azure.com https://*.azure.us https://atlas.microsoft.com",
    "frame-ancestors 'none'",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Next.js extracts the nonce from this request header and applies it to its
  // inline framework scripts (see getScriptNonceFromHeader in Next's renderer).
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // Run middleware on the Node.js runtime (Next 15.5+). The default Edge runtime
  // would force Next to compile instrumentation.ts (App Insights / OpenTelemetry
  // gRPC, guarded by NEXT_RUNTIME==='nodejs') into an Edge bundle, which fails to
  // resolve Node core modules (fs/tls/stream) at build time. The Node runtime
  // keeps this middleware in the same process as the standalone server, matches
  // the app's telemetry stack, and gives native crypto/Buffer.
  runtime: 'nodejs',
  matcher: [
    /*
     * Match every request path EXCEPT:
     *  - api            (JSON route handlers — no HTML document to protect)
     *  - _next/static   (immutable hashed assets)
     *  - _next/image    (image optimizer)
     *  - favicon.ico    (static icon)
     * and skip next/link prefetches so we don't spend a nonce on a request whose
     * HTML is never rendered.
     */
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
