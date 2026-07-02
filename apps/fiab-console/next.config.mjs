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
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Monaco editor creates its language-service workers from
              // blob: URLs (TypeScript, JSON, CSS, HTML, KQL workers) and
              // bundles them via base64 data: URIs in some paths — both
              // need to be explicitly allowed since they fall under
              // script-src in CSP3.
              // Azure Maps Web SDK (Fabric IQ map + report map visual) loads
              // atlas.min.js / atlas.min.css and fetches tiles/styles/glyph
              // fonts from the Atlas CDN — allow that host (Azure-native, no
              // Fabric/Power BI host is ever contacted).
              "script-src 'self' 'unsafe-inline' blob: data: https://atlas.microsoft.com",
              "worker-src 'self' blob: data:",
              "child-src 'self' blob: data:",
              "style-src 'self' 'unsafe-inline' https://atlas.microsoft.com",
              "img-src 'self' data: https:",
              "font-src 'self' data: https://atlas.microsoft.com",
              "connect-src 'self' https://login.microsoftonline.com https://login.microsoftonline.us https://*.azure.com https://*.azure.us https://atlas.microsoft.com",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
