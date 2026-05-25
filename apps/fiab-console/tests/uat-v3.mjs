#!/usr/bin/env node
/**
 * CSA Loom — v3 BFF UAT sweep.
 *
 * Pure HTTP smoke against the live BFF using a minted session cookie.
 * Covers all 13 Chunk-0 routes + Chunk-4 inline item create + Chunk-5
 * workspace settings PATCH + DELETE. No browser required.
 *
 * Run:
 *   SESSION_SECRET=<from-KV> node tests/uat-v3.mjs
 *
 * Exit codes:  0 = all pass | 1 = one or more failed
 */
import crypto from 'node:crypto';

const BASE = process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
const SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  console.error('SESSION_SECRET env var required');
  process.exit(2);
}

// ---- mint cookie (mirrors lib/auth/session.ts encodeSessionCookie) ----
const KEY = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(SECRET, 'utf-8'),
  Buffer.alloc(32), Buffer.from('loom-session-v1'), 32));
const PAYLOAD = {
  claims: {
    oid: process.env.UAT_OID || '866a2e12-0fee-4c99-923c-7cdfd61e08cd',
    name: process.env.UAT_NAME || 'Frank Garofalo (UAT)',
    email: process.env.UAT_EMAIL || 'fgarofalo@limitlessdata.ai',
    upn: process.env.UAT_UPN || 'fgarofalo@limitlessdata.ai',
  },
  exp: Math.floor(Date.now() / 1000) + 8 * 3600,
};
const iv = crypto.randomBytes(12);
const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify(PAYLOAD))), c.final()]);
const COOKIE = `loom_session=${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url')}`;

// ---- helpers ----
const results = [];
async function step(name, fn) {
  process.stdout.write(`  ${name.padEnd(60)} `);
  try {
    const result = await fn();
    console.log('PASS');
    results.push({ name, ok: true, result });
    return result;
  } catch (e) {
    console.log(`FAIL — ${e.message}`);
    results.push({ name, ok: false, error: e.message });
    return null;
  }
}
async function call(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie: COOKIE,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let json;
  try { json = JSON.parse(txt); } catch { json = { raw: txt.slice(0, 100) }; }
  return { status: r.status, body: json };
}
function expect(actual, predicate, hint) {
  if (!predicate(actual)) throw new Error(hint || 'predicate failed');
  return actual;
}

// ---- sweep ----
async function main() {
  console.log(`\n=== CSA Loom v3 BFF UAT — ${BASE} ===\n`);

  await step('GET /api/version reports v3.x', async () => {
    const { status, body } = await call('GET', '/api/version');
    expect(status, s => s === 200, `status=${status}`);
    expect(body.current, v => /^v3\./.test(v), `version=${body.current}`);
  });

  await step('GET /api/me authenticates the minted cookie', async () => {
    const { status, body } = await call('GET', '/api/me');
    expect(status, s => s === 200);
    expect(body.authenticated, a => a === true, 'not authenticated');
  });

  await step('POST /api/admin/bootstrap-catalogs (idempotent)', async () => {
    const { status, body } = await call('POST', '/api/admin/bootstrap-catalogs');
    expect(status, s => s === 200);
    expect(body.appsSeeded, n => n === 10, `appsSeeded=${body.appsSeeded}`);
    expect(body.workloadsSeeded, n => n === 13, `workloadsSeeded=${body.workloadsSeeded}`);
  });

  await step('GET /api/apps-catalog (auto-copies GLOBAL→tenant)', async () => {
    const { body } = await call('GET', '/api/apps-catalog');
    expect(body.apps?.length, n => n >= 10, `apps.length=${body.apps?.length}`);
  });

  await step('GET /api/workloads-catalog', async () => {
    const { body } = await call('GET', '/api/workloads-catalog');
    expect(body.workloads?.length, n => n >= 13);
  });

  await step('POST + GET /api/user-prefs', async () => {
    await call('POST', '/api/user-prefs', { key: 'uat-v3', value: { ok: true } });
    const { body } = await call('GET', '/api/user-prefs?key=uat-v3');
    expect(body.value?.ok, v => v === true);
  });

  await step('POST + GET /api/tabs', async () => {
    await call('POST', '/api/tabs', { tabs: [{ id: '/apps', title: 'Apps', href: '/apps' }] });
    const { body } = await call('GET', '/api/tabs');
    expect(body.tabs?.length, n => n >= 1);
  });

  await step('GET /api/notifications', async () => {
    const { body } = await call('GET', '/api/notifications');
    expect(body.ok, v => v === true);
  });

  // ---- per-item round-trip (Chunk 4 inline create + Chunk 7 side panel) ----
  const ws = await step('POST /api/workspaces (create workspace)', async () => {
    const { body } = await call('POST', '/api/workspaces', { name: `uat-v3-${Date.now()}` });
    expect(body.id, id => typeof id === 'string');
    return body;
  });

  if (!ws) { summarize(); return; }

  const item = await step('POST /api/items/azure-sql-database (create item)', async () => {
    const { body } = await call('POST', '/api/items/azure-sql-database',
      { workspaceId: ws.id, displayName: 'uat-sqldb-v3' });
    expect(body.item?.id, id => typeof id === 'string');
    return body.item;
  });

  if (item) {
    await step('POST + GET /api/items/.../comments', async () => {
      await call('POST', `/api/items/azure-sql-database/${item.id}/comments`,
        { body: 'UAT v3 sweep' });
      const { body } = await call('GET', `/api/items/azure-sql-database/${item.id}/comments`);
      expect(body.comments?.length, n => n >= 1);
    });
    await step('POST + GET /api/items/.../audit', async () => {
      await call('POST', `/api/items/azure-sql-database/${item.id}/audit`,
        { action: 'edit', summary: 'UAT v3 sweep' });
      const { body } = await call('GET', `/api/items/azure-sql-database/${item.id}/audit`);
      expect(body.entries?.length, n => n >= 1);
    });
    await step('POST + GET /api/items/.../share', async () => {
      const { body: post } = await call('POST', `/api/items/azure-sql-database/${item.id}/share`,
        { expiresInHours: 1 });
      expect(post.url, u => typeof u === 'string' && u.includes('/share/'));
      const { body: get } = await call('GET', `/api/items/azure-sql-database/${item.id}/share`);
      expect(get.shares?.length, n => n >= 1);
    });
    await step('GET /api/items/recent (displayName + lastTouchedAt)', async () => {
      const { body } = await call('GET', '/api/items/recent');
      const first = body.items?.[0];
      expect(first, f => f && f.displayName && f.lastTouchedAt,
        `missing fields: ${JSON.stringify(first)}`);
    });
    await step('POST /api/search/items (q=uat-sqldb)', async () => {
      const { body } = await call('POST', '/api/search/items', { q: 'uat-sqldb', top: 5 });
      expect(body.hits, h => Array.isArray(h));
    });
    await step('POST /api/admin/reindex-items (Chunk 8 backfill)', async () => {
      const { status, body } = await call('POST', '/api/admin/reindex-items');
      // 200 = indexed; 503 = LOOM_AI_SEARCH_SERVICE not set (honest fallback).
      expect(status, s => s === 200 || s === 503,
        `status=${status} body=${JSON.stringify(body).slice(0, 200)}`);
    });
    await step('POST /api/search/items reports source field', async () => {
      const { body } = await call('POST', '/api/search/items', { q: 'uat-sqldb', top: 5 });
      expect(body.source, src => src === 'aisearch' || src === 'cosmos',
        `source=${body.source}`);
    });
  }

  // ---- Chunk 5 workspace patch + delete ----
  await step('PATCH /api/workspaces/[id] (Chunk 5 general)', async () => {
    const { status, body } = await call('PATCH', `/api/workspaces/${ws.id}`,
      { description: 'updated via UAT v3' });
    expect(status, s => s === 200);
    expect(body.description, d => d === 'updated via UAT v3');
  });

  // ---- Chunk 5b permissions ----
  await step('POST + GET /api/workspaces/[id]/permissions (Chunk 5b)', async () => {
    const post = await call('POST', `/api/workspaces/${ws.id}/permissions`,
      { upn: 'uat-member@example.com', role: 'contributor' });
    expect(post.status, s => s === 201, `add status=${post.status}`);
    const { body } = await call('GET', `/api/workspaces/${ws.id}/permissions`);
    const found = (body.permissions || []).find((p) => p.upn === 'uat-member@example.com');
    expect(found?.role, r => r === 'contributor', 'role not contributor');
  });
  await step('DELETE /api/workspaces/[id]/permissions', async () => {
    const { status } = await call('DELETE',
      `/api/workspaces/${ws.id}/permissions?upn=uat-member@example.com`);
    expect(status, s => s === 200);
  });

  // ---- Chunk 5b git ----
  await step('POST + GET /api/workspaces/[id]/scm (Chunk 5b)', async () => {
    const put = await call('POST', `/api/workspaces/${ws.id}/scm`, {
      provider: 'github', repoUrl: 'https://github.com/example/repo', branch: 'main',
    });
    expect(put.status, s => s === 200, `post status=${put.status}`);
    const { body } = await call('GET', `/api/workspaces/${ws.id}/scm`);
    expect(body.git?.repoUrl, u => u === 'https://github.com/example/repo');
  });
  await step('DELETE /api/workspaces/[id]/scm', async () => {
    const { status } = await call('DELETE', `/api/workspaces/${ws.id}/scm`);
    expect(status, s => s === 200);
  });

  // ---- Chunk 5b OneLake (derived field) ----
  await step('GET /api/workspaces/[id] includes oneLake (derived)', async () => {
    const { body } = await call('GET', `/api/workspaces/${ws.id}`);
    // oneLake may be null when LOOM_ONELAKE_BASE not set — both shapes accepted.
    expect('oneLake' in body, present => present === true, 'oneLake field missing');
  });

  await step('DELETE /api/workspaces/[id] (Chunk 5 danger)', async () => {
    const { status } = await call('DELETE', `/api/workspaces/${ws.id}`);
    expect(status, s => s === 200 || s === 204);
  });

  summarize();
}

function summarize() {
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok);
  console.log(`\n=== ${pass}/${results.length} pass ===`);
  if (fail.length) {
    console.log('\nFailures:');
    for (const f of fail) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(2); });
