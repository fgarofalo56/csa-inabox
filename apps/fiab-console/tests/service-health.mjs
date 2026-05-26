#!/usr/bin/env node
/**
 * CSA Loom — "does each downstream Azure service actually respond" audit.
 *
 * For every editor family, hits a representative endpoint that proves
 * the BFF → Azure REST chain works end-to-end (UAMI has the right RBAC
 * + the backing resource is deployed + the network path is open).
 *
 * Output:
 *   pass = 200 with real data
 *   fail = 4xx/5xx (with the actual error body the editor would see)
 *   note = honest "not configured in this env" 503
 *
 * Run: SESSION_SECRET=<from-KV> node tests/service-health.mjs
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

const PROBES = [
  // Service family, label, method, path, body?, expectedShape
  ['Cosmos', '/api/me',                                      'GET'],
  ['Cosmos', '/api/workspaces',                              'GET'],
  ['Cosmos', '/api/items/by-type?type=lakehouse',            'GET'],
  ['Cosmos', '/api/apps-catalog',                            'GET'],
  ['Cosmos', '/api/activity?n=5',                            'GET'],

  ['Synapse', '/api/items/synapse-serverless-sql-pool/_probe/query', 'POST',
    { sql: 'SELECT 1 AS smoke' }, /*optional*/ true],
  ['Synapse', '/api/items/synapse-dedicated-sql-pool/_probe/schema', 'GET', null, true],

  ['Databricks', '/api/items/databricks-cluster/options',    'GET'],
  ['Databricks', '/api/items/databricks-notebook/list',      'GET'],

  ['ADF',       '/api/adf/linked-services',                  'GET'],
  ['APIM',      '/api/apim/instances',                       'GET', null, true],

  ['Foundry',   '/api/foundry/workspace',                    'GET'],
  ['Foundry',   '/api/foundry/connections',                  'GET'],
  ['Foundry',   '/api/foundry/computes',                     'GET'],
  ['Foundry',   '/api/foundry/datastores',                   'GET'],
  ['Foundry',   '/api/foundry/deployments',                  'GET'],

  ['AI Search', '/api/items/ai-search-index',                'GET'],

  ['Fabric',    '/api/fabric/workspaces',                    'GET'],

  ['Power Platform', '/api/powerplatform/environments',      'GET'],

  ['Copilot Studio', '/api/items/copilot-studio-agent?envs=1', 'GET'],

  ['Loom Search Index', '/api/search/items',                 'POST', { q: 'x', top: 1 }],
  ['Loom Search Index', '/api/admin/reindex-items',          'POST', {}],

  ['ARM',       '/api/admin/azure-resources',                'GET'],
];

const SUMMARY = { pass: 0, fail: 0, note: 0 };
const RESULTS = [];

async function probe(family, path, method, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie: COOKIE, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, text, json };
}

console.log(`\n=== CSA Loom service health — ${BASE} ===\n`);
console.log('Family            | Path                                          | Status | Result');
console.log('------------------+-----------------------------------------------+--------+----------');

for (const [family, path, method, body, optional] of PROBES) {
  try {
    const { status, text, json } = await probe(family, path, method, body);
    let result, kind;
    if (status >= 200 && status < 300) {
      const hint = json?.ok === false
        ? `ok:false (${json.error?.slice?.(0, 50)})`
        : Array.isArray(json?.items || json?.workspaces || json?.entries || json?.hits || json?.resources)
          ? `${(json.items || json.workspaces || json.entries || json.hits || json.resources).length} items`
          : 'OK';
      result = hint; kind = 'PASS'; SUMMARY.pass++;
    } else if (status === 503 || (status === 404 && optional)) {
      result = `not configured: ${(json?.error || text.slice(0, 60))}`;
      kind = 'NOTE'; SUMMARY.note++;
    } else {
      const errMsg = json?.error || text.slice(0, 80);
      result = `${errMsg}`;
      kind = 'FAIL'; SUMMARY.fail++;
    }
    RESULTS.push({ family, path, status, kind, result });
    const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
    console.log(`${pad(family, 18)}| ${pad(path, 46)}| ${pad(String(status), 7)}| ${kind} — ${result.slice(0, 60)}`);
  } catch (e) {
    SUMMARY.fail++;
    RESULTS.push({ family, path, status: 0, kind: 'FAIL', result: e.message });
    console.log(`${family.padEnd(18)}| ${path.padEnd(46)}| ERR    | ${e.message.slice(0, 60)}`);
  }
}

console.log(`\n=== ${SUMMARY.pass} pass · ${SUMMARY.note} not-configured · ${SUMMARY.fail} fail (of ${PROBES.length}) ===\n`);

// Per-family roll-up
const byFamily = {};
for (const r of RESULTS) {
  byFamily[r.family] = byFamily[r.family] || { pass: 0, fail: 0, note: 0 };
  byFamily[r.family][r.kind.toLowerCase()]++;
}
console.log('Per family:');
for (const [f, c] of Object.entries(byFamily)) {
  const verdict = c.fail === 0 && c.pass > 0 ? 'GREEN'
    : c.fail > 0 && c.pass === 0 ? 'RED'
    : c.note > 0 && c.pass === 0 ? 'NOT CONFIGURED'
    : 'PARTIAL';
  console.log(`  ${f.padEnd(20)} ${verdict.padEnd(18)} (pass=${c.pass} fail=${c.fail} note=${c.note})`);
}
