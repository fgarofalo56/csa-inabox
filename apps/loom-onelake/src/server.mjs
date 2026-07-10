// CSA Loom — Loom OneLake namespace/catalog service (HYP-1).
//
// The unified-namespace service every Loom engine funnels through: it owns one
//   loom://<tenant>/<workspace>/<item>/<path>
// address space and resolves it to the REAL physical ADLS Gen2 location
// (abfss://<container>@<account>.dfs.<suffix>/<root>) + SAS-less managed-identity
// passthrough auth. Backed by a Cosmos registry (createIfNotExists) that owns
// the { workspace→container, item→managed folder, shortcut→target, role→ACL }
// mapping the console libs persist per-item today.
//
// Internal-ingress ACA app (never public). Node built-ins for the transport
// (http) — the mcp-bridge pattern — with @azure/cosmos used only inside the
// lazily-loaded registry, so the convention-resolve core path runs with zero
// deps installed. minReplicas:1 (resolution is on the hot path).
//
// Endpoints:
//   GET  /health                       → liveness + configured flags
//   POST /resolve   { uri }            → resolve one loom:// address
//   GET  /resolve?uri=loom://...       → same, query-string form
//   POST /register  { tenant, workspace, item, ... }  → upsert a registration
//   GET  /catalog?tenant=...           → list a tenant's registrations
//
// Azure-native only — no api.fabric.microsoft.com / onelake.dfs.fabric /
// api.powerbi.com is ever reached (.claude/rules/no-fabric-dependency.md).

import http from 'node:http';
import { parseLoomUri, resolvePhysical, deriveStorageConfig } from './resolver.mjs';
import { OneLakeRegistry } from './registry.mjs';

const PORT = parseInt(process.env.PORT || process.env.LOOM_ONELAKE_PORT || '8080', 10);
const VERSION = '0.1.0';

const registry = new OneLakeRegistry(process.env);
// Storage config is read once at boot (env is immutable for the container life).
const storage = deriveStorageConfig(process.env);

function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(json);
}

async function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Resolve one loom:// uri to a physical pointer (the core path). */
async function doResolve(uri, tenantHint) {
  const parsed = parseLoomUri(uri);
  if (parsed.ok !== true) {
    return { status: 400, body: { ok: false, error: parsed.error } };
  }
  // Look up the registration (Cosmos when configured; null → convention).
  let entry = null;
  try {
    entry = await registry.lookup(parsed.tenant, parsed.workspace, parsed.item, parsed.itemType);
  } catch (e) {
    // A registry read failure must not fake a result — surface it honestly.
    return {
      status: 502,
      body: { ok: false, error: `registry lookup failed: ${e && e.message ? e.message : String(e)}` },
    };
  }
  const resolved = resolvePhysical(parsed, entry, storage);
  if (resolved.ok !== true) {
    // Honest 503 gate — no real storage configured. Names the env to set.
    const status = resolved.code === 'not_configured' ? 503 : 400;
    return { status, body: resolved };
  }
  return { status: 200, body: resolved };
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    return send(res, 400, { ok: false, error: 'bad request url' });
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    // ── Health ────────────────────────────────────────────────────────────
    if (path === '/health' || path === '/healthz' || path === '/.well-known/health') {
      return send(res, 200, {
        ok: true,
        service: 'loom-onelake',
        version: VERSION,
        configured: { registry: registry.configured, storage: !!storage },
      });
    }

    // ── Resolve (GET query-string form) ──────────────────────────────────
    if (path === '/resolve' && req.method === 'GET') {
      const uri = url.searchParams.get('uri') || '';
      const r = await doResolve(uri, url.searchParams.get('tenant'));
      return send(res, r.status, r.body);
    }

    // ── Resolve (POST body form) ─────────────────────────────────────────
    if (path === '/resolve' && req.method === 'POST') {
      const body = await readJson(req);
      const r = await doResolve(body.uri || '', body.tenant);
      return send(res, r.status, r.body);
    }

    // ── Register an item's namespace mapping ─────────────────────────────
    if (path === '/register' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body.tenant || !body.workspace || !body.item) {
        return send(res, 400, { ok: false, error: 'tenant, workspace, and item are required' });
      }
      if (!registry.configured) {
        return send(res, 503, {
          ok: false,
          code: 'not_configured',
          error:
            'The OneLake registry is not deployed. Set LOOM_ONELAKE_COSMOS_ENDPOINT ' +
            '(or the shared LOOM_COSMOS_ENDPOINT) and grant the service UAMI the ' +
            'Cosmos DB Built-in Data Contributor role. See ' +
            'platform/fiab/bicep/modules/compute/loom-onelake-app.bicep. No Fabric required.',
        });
      }
      const saved = await registry.register(body);
      return send(res, 200, { ok: true, registration: saved });
    }

    // ── Catalog (Explore/Govern/Secure discovery) ───────────────────────
    if (path === '/catalog' && req.method === 'GET') {
      const tenant = url.searchParams.get('tenant') || '';
      if (!tenant) return send(res, 400, { ok: false, error: 'tenant is required' });
      if (!registry.configured) {
        return send(res, 503, {
          ok: false,
          code: 'not_configured',
          error:
            'The OneLake registry is not deployed. Set LOOM_ONELAKE_COSMOS_ENDPOINT ' +
            'to enable catalog discovery. The resolver works by convention without it.',
        });
      }
      const entries = await registry.list(tenant);
      return send(res, 200, { ok: true, entries });
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    // Never leak stack traces to the client.
    // eslint-disable-next-line no-console
    console.error('[loom-onelake] error:', e && e.stack ? e.stack : String(e));
    const msg = e && e.message === 'invalid JSON body' ? e.message : 'internal error';
    return send(res, e && e.message === 'invalid JSON body' ? 400 : 500, { ok: false, error: msg });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(
    `[loom-onelake] listening on :${PORT} registry=${registry.configured ? 'cosmos' : 'convention-only'} ` +
      `storage=${storage ? 'configured' : '(unset)'}`,
  );
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { server };
