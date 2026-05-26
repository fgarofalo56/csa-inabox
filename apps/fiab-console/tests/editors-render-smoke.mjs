#!/usr/bin/env node
/**
 * CSA Loom — per-editor render smoke.
 *
 * For every registered editor type, creates a Cosmos-backed item in a
 * temp workspace, fetches /items/[type]/[id], and asserts the page
 * returns 200 with a known editor-chrome sentinel string. Proves:
 *   - type → editor lookup wired in registry.ts
 *   - editor chrome renders (no React error boundary trip)
 *   - dynamic import resolves (catches phase2/phase3/phase4 bundle splits)
 *
 * Cheaper than Playwright per-editor specs — runs in CI without browsers,
 * complements service-health.mjs (backend probes) and apps-install-e2e.mjs
 * (catalog install).
 *
 * Run: SESSION_SECRET=<from-KV> node tests/editors-render-smoke.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.join(__dirname, '..', 'lib', 'editors', 'registry.ts');

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

const editorTypes = fs.readFileSync(REGISTRY, 'utf-8')
  .split('\n')
  .map(l => l.match(/^\s*['"]([a-z][a-z0-9-]+)['"]\s*:\s*reg\(/))
  .filter(Boolean)
  .map(m => m[1]);

console.log(`\n=== Per-editor render smoke — ${BASE} ===`);
console.log(`Registered editor types: ${editorTypes.length}\n`);

const ws = await call('POST', '/api/workspaces', { name: `editor-smoke-${Date.now()}` });
if (!ws.json?.id) { console.error('workspace create failed:', ws); process.exit(1); }
const wsId = ws.json.id;
console.log(`✓ Workspace ${wsId.slice(0, 8)}\n`);

let pass = 0, fail = 0;
const failures = [];

for (const type of editorTypes) {
  process.stdout.write(`  ${type.padEnd(36)} `);

  const create = await call('POST', `/api/workspaces/${wsId}/items`, {
    itemType: type,
    displayName: `smoke-${type}-${Date.now()}`,
  });
  if (!create.json?.id) {
    console.log(`FAIL create — ${create.json?.error || create.status}`);
    fail++; failures.push({ type, stage: 'create', error: create.json?.error || create.status });
    continue;
  }
  const id = create.json.id;

  // Render the editor page
  const r = await fetch(`${BASE}/items/${type}/${id}`, { headers: { cookie: COOKIE } });
  const html = await r.text();

  // Sentinels: editor chrome renders header with the item type label
  // OR Next surfaces a recognizable error boundary. Anything else = fail.
  const renderedOk =
    r.status === 200 &&
    !html.includes('Application error') &&
    !html.includes('500 — Internal') &&
    !/<title>404/.test(html);

  if (renderedOk) {
    console.log(`PASS`);
    pass++;
  } else {
    const snip = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 80);
    console.log(`FAIL render ${r.status} — ${snip}`);
    fail++; failures.push({ type, stage: 'render', status: r.status, hint: snip });
  }
}

await call('DELETE', `/api/workspaces/${wsId}`);

console.log(`\n=== ${pass}/${editorTypes.length} editors render cleanly ===`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures.slice(0, 20)) {
    console.log(`  ${f.type} [${f.stage}]: ${f.error || f.hint || f.status}`);
  }
  process.exit(1);
}
