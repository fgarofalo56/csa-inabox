/** @type {import('next').NextConfig} */

// CSA-0020 Phase 1: static security headers complement the per-request
// Content-Security-Policy set by `src/middleware.ts` (which cannot be
// expressed statically because it embeds a per-request nonce).
const STATIC_SECURITY_HEADERS = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains; preload',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
];

const nextConfig = {
  reactStrictMode: true,
  output: process.env.STATIC_EXPORT === 'true' ? 'export' : undefined,
  env: {
    API_URL: process.env.NEXT_PUBLIC_API_URL || '/api',
  },
  async rewrites() {
    // In production the frontend is served behind a reverse proxy that
    // routes /api/* to the backend — no rewrite needed.  For local dev
    // NEXT_PUBLIC_API_URL should point at the backend (e.g.
    // http://localhost:8000/api).
    const backendUrl = process.env.NEXT_PUBLIC_API_URL;
    if (!backendUrl) return [];
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/:path*`,
      },
    ];
  },
  async headers() {
    // CSP is NOT set here — it lives in middleware so it can carry a
    // per-request nonce. These headers are safe to set statically.
    return [
      {
        source: '/:path*',
        headers: STATIC_SECURITY_HEADERS,
      },
    ];
  },
};

module.exports = nextConfig;
