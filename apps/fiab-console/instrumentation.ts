// Next.js instrumentation entry — runs once at server startup,
// before any request handlers. Standard hook for telemetry init.
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { configureTelemetry } = await import('./lib/telemetry/app-insights');
  await configureTelemetry();

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
