#!/usr/bin/env node
/**
 * CSA Loom — Apps install E2E test.
 *
 * For each of the 10 curated CSA apps in apps-catalog, hits
 * POST /api/apps/[id]/install with a fresh workspace and asserts every
 * bundled item gets created in Cosmos.
 *
 * Run: SESSION_SECRET=<from-KV> node tests/apps-install-e2e.mjs
 */
import crypto from 'node:crypto';

const BASE = process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
const SECRET = process.env.SESSION_SECRET;
if (!SECRET) { console.error('SESSION_SECRET required'); process.exit(2); }

// mint cookie
const KEY = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(SECRET, 'utf-8'),
  Buffer.alloc(32), Buffer.from('loom-session-v1'), 32));
const PAYLOAD = {
  claims: {
    oid: process.env.UAT_OID || process.env.LOOM_AUTOMATION_OID || '00000000-0000-0000-0000-000000000000',
    name: process.env.LOOM_AUTOMATION_NAME || 'Loom UAT',
    email: 'uat@example.invalid',
    upn: 'uat@example.invalid',
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

console.log(`\n=== Apps install E2E — ${BASE} ===\n`);

// 1. Ensure catalogs are bootstrapped
const bs = await call('POST', '/api/admin/bootstrap-catalogs');
if (!bs.json?.ok) { console.error('bootstrap failed:', bs); process.exit(1); }
console.log(`✓ Catalogs seeded: ${bs.json.appsSeeded} apps, ${bs.json.workloadsSeeded} workloads`);

// 2. List apps
const apps = await call('GET', '/api/apps-catalog');
if (!apps.json?.ok) { console.error('apps-catalog list failed:', apps); process.exit(1); }
const appList = apps.json.apps || [];
console.log(`✓ Found ${appList.length} apps in catalog\n`);

// 3. Create a temporary workspace for installs
const ws = await call('POST', '/api/workspaces', { name: `apps-install-uat-${Date.now()}` });
if (!ws.json?.id) { console.error('workspace create failed:', ws); process.exit(1); }
const wsId = ws.json.id;
console.log(`✓ Workspace created: ${wsId}\n`);

// 4. Install each app — twice (second call should be idempotent)
let pass = 0, fail = 0;
const summary = [];

for (const app of appList) {
  process.stdout.write(`  ${app.name.padEnd(40)} `);
  const r1 = await call('POST', `/api/apps/${app.id}/install`, { workspaceId: wsId });
  if (!r1.json?.ok) {
    console.log(`FAIL — ${r1.json?.error || r1.status}`);
    fail++; summary.push({ app: app.name, status: 'fail', error: r1.json?.error });
    continue;
  }
  const created = r1.json.installed.filter(i => i.status === 'created').length;
  const existed = r1.json.installed.filter(i => i.status === 'existed').length;
  const failed = r1.json.installed.filter(i => i.status === 'failed').length;
  if (failed > 0) {
    console.log(`PARTIAL — created=${created} existed=${existed} failed=${failed}`);
    summary.push({ app: app.name, status: 'partial', created, existed, failed,
                    errors: r1.json.installed.filter(i => i.error).map(i => `${i.itemType}: ${i.error}`).slice(0,3) });
    fail++;
    continue;
  }

  // 5. Idempotency check — second install of same app should produce 'existed' for all items
  const r2 = await call('POST', `/api/apps/${app.id}/install`, { workspaceId: wsId });
  const r2existed = r2.json?.installed?.every(i => i.status === 'existed');
  if (!r2existed) {
    console.log(`PASS but NOT IDEMPOTENT (second call created ${r2.json?.installed?.filter(i => i.status === 'created').length} duplicates)`);
    summary.push({ app: app.name, status: 'pass-not-idempotent', items: created });
    fail++;
    continue;
  }
  console.log(`PASS — ${created} items created, idempotent`);
  pass++; summary.push({ app: app.name, status: 'pass', items: created });
}

// 6. Cleanup
await call('DELETE', `/api/workspaces/${wsId}`);

console.log(`\n=== ${pass}/${appList.length} apps install cleanly + idempotently ===`);
if (fail > 0) {
  console.log('\nFailures / partials:');
  for (const s of summary.filter(x => x.status !== 'pass')) {
    console.log(`  ${s.app}: ${s.status}${s.errors ? '\n    ' + s.errors.join('\n    ') : ''}`);
  }
  process.exit(1);
}
