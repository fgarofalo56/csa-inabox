// Node-runtime half of instrumentation.ts. Kept in its own module so the edge
// instrumentation bundle never traces it: it reaches `crypto` via
// lib/azure/query-result-cache, which webpack cannot resolve for the edge.

export async function registerNode() {
  const { configureTelemetry } = await import('./lib/telemetry/app-insights');
  await configureTelemetry();

  // Keep the expensive deployment-scoped dashboard reads warm (cost, alerts,
  // diagnostics, action groups) so no user ever pays the cold aggregation —
  // measured live 2026-07-15: a cold Cost Management read outlives Front
  // Door's ~30s edge budget. See lib/perf/read-warmer.ts.
  const { startReadWarmer } = await import('./lib/perf/read-warmer');
  startReadWarmer();

  // One [mem] line per minute so a heap-limit crash leaves a trail.
  const { startMemLog } = await import('./lib/perf/mem-log');
  startMemLog();

  // Pylance-grade Python IntelliSense over a WebSocket bridge for notebook
  // cells. Opt-in via LOOM_PYLSP_ENABLED so the default deployment (which runs
  // `node server.js` with no Python) is completely untouched. We patch the CJS
  // http singleton's createServer so the upgrade handler attaches to the very
  // server Next.js's standalone start-server creates — same port, same ingress
  // (Container Apps exposes a single port), no custom CMD required.
  if ((process.env.LOOM_PYLSP_ENABLED || '').trim() === '') return;
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const http = require('http'); // CJS singleton — mutable, shared with Next's start-server
    const { attachPylspBridge } = await import('./lib/lsp/pylsp-bridge.mjs');

    const originalCreateServer = http.createServer;
    let bridged = false;
    http.createServer = function patchedCreateServer(...args: unknown[]) {
      const server = originalCreateServer.apply(this, args);
      if (!bridged) {
        bridged = true;
        Promise.resolve(attachPylspBridge(server)).catch((e: unknown) =>
          console.error('[pylsp-bridge] attach failed:', e),
        );
      }
      return server;
    };
  } catch (e) {
    console.error('[pylsp-bridge] initialization failed:', e);
  }
}
