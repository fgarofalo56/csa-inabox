// CSA Loom — MCP stdio→HTTP/SSE bridge server.
//
// Reads the declarative catalog (LOOM_MCP_BRIDGE_CONFIG → loom-mcp-bridge.json),
// spawns each enabled stdio MCP server (npx/uvx) on demand, and exposes it over
// HTTP on a single internal-ingress port (default 8080). For every bridged
// entry `<id>` it serves:
//
//   Console-compat (the shape apps/fiab-console/lib/azure/mcp-client.ts hits):
//     POST /servers/<id>/tools/list   → { jsonrpc, id, result|error }
//     POST /servers/<id>/tools/call   → { jsonrpc, id, result|error }
//
//   Standard MCP (for external agents — Foundry / Agent 365 / Copilot Studio):
//     GET  /servers/<id>/sse          → SSE stream (endpoint event + messages)
//     POST /servers/<id>/message      → JSON-RPC in, 202 Accepted; reply via SSE
//
//   Ops:
//     GET  /.well-known/health        → { ok, servers: [...] }
//     GET  /servers                   → catalog summary (no secrets)
//
// Boundary-aware: in Gov (AZURE_CLOUD=AzureUSGovernment) catalog entries whose
// `boundaries` omits the active cloud are disabled, so a server that reaches
// *.azure.com is never exposed in a *.azure.us tenant.
//
// No external dependencies — Node built-ins only (http, fs).

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StdioMcpClient } from './stdio-client.mjs';

const PORT = parseInt(process.env.LOOM_MCP_BRIDGE_PORT || process.env.PORT || '8080', 10);
const CONFIG_PATH = process.env.LOOM_MCP_BRIDGE_CONFIG || '/app/config/loom-mcp-bridge.json';
const CLOUD = (process.env.AZURE_CLOUD || 'AzureCloud').trim();

function loadCatalog() {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const all = Array.isArray(raw.servers) ? raw.servers : [];
  // Filter to enabled entries valid for the active cloud boundary.
  return all.filter((e) => {
    if (e.enabled === false) return false;
    const b = e.boundaries;
    if (Array.isArray(b) && b.length && !b.includes(CLOUD)) return false;
    return true;
  });
}

const catalog = loadCatalog();
const clients = new Map(); // id -> StdioMcpClient
for (const entry of catalog) clients.set(entry.id, new StdioMcpClient(entry));

function getClient(id) {
  return clients.get(id) || null;
}

function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(json);
}

async function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---- Console-compat handlers (JSON-RPC envelope in/out) --------------------

async function handleToolsList(res, client, rpcId) {
  try {
    const tools = await client.listTools();
    send(res, 200, { jsonrpc: '2.0', id: rpcId ?? `list-${Date.now()}`, result: { tools } });
  } catch (e) {
    send(res, 200, { jsonrpc: '2.0', id: rpcId ?? `list-${Date.now()}`, error: { code: -32000, message: String(e?.message || e) } });
  }
}

async function handleToolsCall(res, client, parsed) {
  const rpcId = parsed?.id ?? `call-${Date.now()}`;
  const name = parsed?.params?.name;
  const args = parsed?.params?.arguments || {};
  if (!name) {
    send(res, 200, { jsonrpc: '2.0', id: rpcId, error: { code: -32602, message: 'params.name is required' } });
    return;
  }
  try {
    const result = await client.callTool(name, args);
    send(res, 200, { jsonrpc: '2.0', id: rpcId, result });
  } catch (e) {
    send(res, 200, { jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: String(e?.message || e) } });
  }
}

// ---- Standard MCP SSE transport -------------------------------------------

const sseSessions = new Map(); // sessionId -> { res, client }

function handleSse(req, res, client, id) {
  const sessionId = randomUUID();
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  // First SSE event names the POST endpoint for this session (MCP SSE contract).
  res.write(`event: endpoint\ndata: /servers/${id}/message?sessionId=${sessionId}\n\n`);

  const off = client.onNotification((msg) => {
    res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
  });
  sseSessions.set(sessionId, { res, client, off });

  const ka = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => {
    clearInterval(ka);
    off();
    sseSessions.delete(sessionId);
  });
}

async function handleSseMessage(req, res, client, sessionId) {
  const sess = sessionId ? sseSessions.get(sessionId) : null;
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    send(res, 400, { error: 'invalid JSON' });
    return;
  }
  // Accept then reply over the SSE channel (MCP streamable contract).
  res.writeHead(202, { 'content-type': 'application/json' });
  res.end('{"accepted":true}');
  try {
    const result = await client.rpc(parsed);
    if (parsed.id != null && sess) {
      sess.res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result })}\n\n`);
    }
  } catch (e) {
    if (parsed.id != null && sess) {
      sess.res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32000, message: String(e?.message || e) } })}\n\n`);
    }
  }
}

// ---- Router ----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === '/.well-known/health' || path === '/health') {
    send(res, 200, { ok: true, servers: catalog.map((e) => ({ id: e.id, displayName: e.displayName })) });
    return;
  }

  if (path === '/servers' && req.method === 'GET') {
    send(res, 200, {
      ok: true,
      servers: catalog.map((e) => ({
        id: e.id,
        displayName: e.displayName,
        description: e.description,
        launcher: e.launcher,
        package: e.package,
        outputTransport: e.outputTransport || 'http',
        endpointPath: `/servers/${e.id}`,
      })),
    });
    return;
  }

  // /servers/<id>/<action>
  const m = path.match(/^\/servers\/([^/]+)\/(tools\/list|tools\/call|sse|message)$/);
  if (m) {
    const [, id, action] = m;
    const client = getClient(id);
    if (!client) { send(res, 404, { error: `unknown bridged server '${id}'` }); return; }

    if (action === 'sse' && req.method === 'GET') { handleSse(req, res, client, id); return; }
    if (action === 'message' && req.method === 'POST') { await handleSseMessage(req, res, client, url.searchParams.get('sessionId')); return; }

    if (req.method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return; }
    let parsed = {};
    try { parsed = JSON.parse(await readBody(req)); } catch { /* tolerate empty body */ }
    if (action === 'tools/list') { await handleToolsList(res, client, parsed?.id); return; }
    if (action === 'tools/call') { await handleToolsCall(res, client, parsed); return; }
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`[mcp-bridge] listening on :${PORT} cloud=${CLOUD} bridged=${catalog.map((e) => e.id).join(',') || '(none)'}`);
});

function shutdown() {
  for (const c of clients.values()) c.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
