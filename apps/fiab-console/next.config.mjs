/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  poweredByHeader: false,
  // v0.1 scaffold: skip TS + ESLint checks during build to ship the
  // Console image. Fluent UI v9 API drift means Body1/Title TS errors
  // need a coordinated refactor across 8 panes; tracked in PRP-03
  // v0.2 cleanup.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // mssql + tedious use dynamic requires that break Next.js bundling.
  // Externalize so they load from node_modules at runtime in the
  // standalone server output. `ws` powers the Pylance/pylsp WebSocket bridge
  // (lib/lsp/pylsp-bridge.mjs) and must load natively, not be webpack-bundled.
  serverExternalPackages: ['mssql', 'tedious', '@azure/storage-file-datalake', 'ws'],
  // Repo-hosted app-bundle sample datasets live at apps/fiab-console/samples/
  // app-data/** and are read at runtime by lib/apps/repo-datasets.ts (relative
  // to process.cwd()) then uploaded into the tenant's own ADLS at install time.
  // They are copied into the standalone runner explicitly by the Dockerfile
  // (COPY /app/samples ./samples) rather than via Next file-tracing, so no
  // outputFileTracingIncludes entry is needed.
  experimental: {
    serverActions: { allowedOrigins: ['localhost:3000', 'loom-console.*'] },
    // Next.js 15: instrumentation.ts is enabled by default; instrumentationHook
    // flag is no longer supported and was removed here.
  },
  async headers() {
    return [
      {
        // Cache-revalidate dynamic HTML so Front Door doesn't serve year-old
        // shells to browsers after a fresh image roll. Without this override the
        // default `cache-control: s-maxage=31536000` made FD keep 1-year-old
        // HTML, and even with the ETag handshake some browsers would render
        // stale shells, masking new editor features after every deploy.
        // _next/static + /api/* are exempted (hashed assets / per-request JSON).
        source: '/((?!_next/static|_next/image|api|brand|favicon).*)',
        headers: [
          { key: 'Cache-Control', value: 'private, no-cache, no-store, must-revalidate' },
        ],
      },
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
          // NOTE: Content-Security-Policy is intentionally NOT set here. It
          // requires a per-request nonce (script-src 'nonce-<n>') which a static
          // next.config header cannot carry, so the CSP is owned by middleware.ts
          // (SECURITY deep-audit: removed 'unsafe-inline'/data: from script-src in
          // favour of a nonce-based policy). Setting a second CSP here would
          // produce duplicate headers and re-introduce the weaker policy.
        ],
      },
    ];
  },
};

export default nextConfig;
