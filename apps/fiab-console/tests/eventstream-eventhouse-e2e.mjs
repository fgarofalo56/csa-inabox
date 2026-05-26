#!/usr/bin/env node
/**
 * CSA Loom — Eventstream + Eventhouse E2E smoke.
 *
 * Proves the Kusto/ADX pipe end-to-end:
 *   1. Eventhouse → list databases (real Kusto ARM + control plane)
 *   2. KQL database → execute `print now()` (real Kusto query endpoint)
 *   3. KQL database → list tables (real .show tables mgmt command)
 *   4. Eventstream  → save a (source, sink, transforms) config + read back
 *      from Cosmos
 *
 * Run: SESSION_SECRET=<from-KV> node tests/eventstream-eventhouse-e2e.mjs
 */
import crypto from 'node:crypto';

const BASE = process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
const SECRET = process.env.SESSION_SECRET;
if (!SECRET) { console.error('SESSION_SECRET required'); process.exit(2); }

const KEY = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(SECRET, 'utf-8'),
  Buffer.alloc(32), Buffer.from('loom-session-v1'), 32));
const PAYLOAD = {
  claims: {
    oid: process.env.UAT_OID || '866a2e12-0fee-4c99-923c-7cdfd61e08cd',
    name: 'Frank Garofalo (UAT)',
    email: 'fgarofalo@limitlessdata.ai',
    upn: 'fgarofalo@limitlessdata.ai',
  },
  exp: Math.floor(Date.now() / 1000) + 8 * 3600,
};
const iv = crypto.randomBytes(12);
const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify(PAYLOAD))), c.final()]);
const COOKIE = `loom_session=${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url')}`;

async function call(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie: COOKIE, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text };
}

console.log(`\n=== Eventstream + Eventhouse E2E — ${BASE} ===\n`);

const ws = await call('POST', '/api/workspaces', { name: `kusto-e2e-${Date.now()}` });
if (!ws.json?.id) { console.error('workspace create failed:', ws); process.exit(1); }
const wsId = ws.json.id;
console.log(`✓ Workspace ${wsId.slice(0, 8)}\n`);

const probes = [];
let pass = 0, fail = 0, skipped = 0;

async function probe(label, fn) {
  process.stdout.write(`  ${label.padEnd(42)} `);
  try {
    const r = await fn();
    if (r.skipped) { console.log(`SKIP — ${r.reason}`); skipped++; probes.push({ label, ...r }); return; }
    if (r.ok) { console.log(`PASS — ${r.hint || ''}`); pass++; probes.push({ label, status: 'pass', ...r }); return; }
    console.log(`FAIL — ${r.error}`);
    fail++; probes.push({ label, status: 'fail', ...r });
  } catch (e) {
    console.log(`FAIL — ${e.message}`);
    fail++; probes.push({ label, status: 'fail', error: e.message });
  }
}

// 1. Eventhouse create + databases
let eventhouseId;
await probe('Eventhouse: create item', async () => {
  const r = await call('POST', `/api/workspaces/${wsId}/items`,
    { itemType: 'eventhouse', displayName: `eh-${Date.now()}` });
  if (!r.json?.id) return { ok: false, error: r.json?.error || r.status };
  eventhouseId = r.json.id;
  return { ok: true, hint: eventhouseId.slice(0, 8) };
});

await probe('Eventhouse: list KQL databases (real Kusto)', async () => {
  if (!eventhouseId) return { skipped: true, reason: 'create failed' };
  const r = await call('GET', `/api/items/eventhouse/${eventhouseId}`);
  if (r.status === 503) return { skipped: true, reason: 'ADX not provisioned in this env' };
  if (!r.json?.ok) return { ok: false, error: r.json?.error || r.status };
  return { ok: true, hint: `cluster=${r.json.cluster?.slice(0, 30)}... dbs=${r.json.databases?.length || 0}` };
});

// 2. KQL database query + tables (create a kql-database item)
let kqlDbId;
await probe('KQL database: create item', async () => {
  const r = await call('POST', `/api/workspaces/${wsId}/items`,
    { itemType: 'kql-database', displayName: `kdb-${Date.now()}` });
  if (!r.json?.id) return { ok: false, error: r.json?.error || r.status };
  kqlDbId = r.json.id;
  return { ok: true, hint: kqlDbId.slice(0, 8) };
});

await probe('KQL database: execute `print now()`', async () => {
  if (!kqlDbId) return { skipped: true, reason: 'create failed' };
  const r = await call('POST', `/api/items/kql-database/${kqlDbId}/query`, { kql: 'print now()' });
  if (r.status === 503) return { skipped: true, reason: 'ADX not provisioned' };
  if (!r.json?.ok) return { ok: false, error: r.json?.error || r.status };
  return { ok: true, hint: `rows=${r.json.rows?.length ?? r.json.results?.length ?? '?'}` };
});

await probe('KQL database: list tables', async () => {
  if (!kqlDbId) return { skipped: true, reason: 'create failed' };
  const r = await call('GET', `/api/items/kql-database/${kqlDbId}/tables`);
  if (r.status === 503) return { skipped: true, reason: 'ADX not provisioned' };
  if (!r.json?.ok) return { ok: false, error: r.json?.error || r.status };
  return { ok: true, hint: `tables=${(r.json.tables || []).length}` };
});

// 3. Eventstream config round-trip
let esId;
await probe('Eventstream: create item', async () => {
  const r = await call('POST', `/api/workspaces/${wsId}/items`,
    { itemType: 'eventstream', displayName: `es-${Date.now()}` });
  if (!r.json?.id) return { ok: false, error: r.json?.error || r.status };
  esId = r.json.id;
  return { ok: true, hint: esId.slice(0, 8) };
});

await probe('Eventstream: PUT pipeline config', async () => {
  if (!esId) return { skipped: true, reason: 'create failed' };
  const config = {
    source: { kind: 'eventhub', namespace: 'ns-loom-smoke', hub: 'smoke-events' },
    sink:   { kind: 'kql-table', database: 'loom', table: 'SmokeEvents' },
    transforms: [{ kind: 'filter', expression: 'EventType == "smoke"' }],
  };
  const r = await call('PUT', `/api/items/eventstream/${esId}`, config);
  if (!r.json?.ok) return { ok: false, error: r.json?.error || r.status };
  return { ok: true, hint: 'config saved' };
});

await probe('Eventstream: GET pipeline config (round-trip)', async () => {
  if (!esId) return { skipped: true, reason: 'create failed' };
  const r = await call('GET', `/api/items/eventstream/${esId}`);
  if (!r.json?.ok) return { ok: false, error: r.json?.error || r.status };
  const src = r.json.state?.source?.kind;
  const sink = r.json.state?.sink?.kind;
  if (src !== 'eventhub' || sink !== 'kql-table') {
    return { ok: false, error: `round-trip mismatch: source=${src} sink=${sink}` };
  }
  return { ok: true, hint: `source=${src} → sink=${sink}` };
});

await call('DELETE', `/api/workspaces/${wsId}`);

console.log(`\n=== ${pass} pass · ${skipped} skipped · ${fail} fail (of ${probes.length}) ===\n`);
if (fail > 0) process.exit(1);
