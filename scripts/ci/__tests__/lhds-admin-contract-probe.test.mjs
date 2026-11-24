/**
 * Self-test for scripts/measure/health/lhds-admin-contract-probe.mjs (#5454, mode=admin-contract).
 *
 * The probe judges a live control plane, so every case runs it against an in-process fetch stub of the
 * CP admin routes + the public discovery host with ONE chosen behaviour. The correct stub is the control
 * (every check PASS, exit 0); each defect flag is the input that must turn exactly its named check red.
 * An always-green probe fails the defect cases; an always-red probe fails the control.
 *
 * Run: node --test scripts/ci/__tests__/lhds-admin-contract-probe.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, paired, exitOf, runAdminContract, OIDC_REQUIRED } from '../../measure/health/lhds-admin-contract-probe.mjs';
import { phaseCleanup } from '../../measure/health/lhds-edge-probe-run.mjs';

const CP = 'https://cp.example.test';
const ISSUER = 'https://pub.example.test/auth'; // a DIFFERENT host: discovery must go to the public issuer
const CP_TOKEN = 'cp-bearer-not-a-jwt';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FHIR_USER = /^(Practitioner|Patient|RelatedPerson|Person)\/[A-Za-z0-9.-]{1,64}$/;

function stub(d = {}) {
  const tenants = new Set(['ten-a', 'ten-b']);
  const maps = new Map();
  const clients = new Map();
  const seen = [];
  const R = (status, body, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
  const ok = (data, s = 200) => R(s, { ok: true, data });
  const bad = (s, code) => R(s, { ok: false, error: { code, message: code } });
  const fetchImpl = async (u, init = {}) => {
    const url = new URL(u);
    const m = init.method ?? 'GET';
    const auth = init.headers?.authorization;
    seen.push({ host: url.host, m, path: url.pathname, auth: !!auth });
    if (d.network) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (url.origin === CP && url.pathname === '/auth/.well-known/openid-configuration') return R(200, { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks.json` });
    if (url.origin === CP && url.pathname.startsWith('/api/health/auth/')) {
      if (auth !== `Bearer ${CP_TOKEN}`) return bad(401, 'unauthorized');
      if (d.forbidden) return bad(403, 'forbidden');
      const fl = /^\/api\/health\/auth\/tenants\/([a-z0-9-]+)\/fhir-users$/.exec(url.pathname);
      if (fl) return ok({ fhirUsers: [...maps.values()].filter((x) => x.tenant === fl[1] || d.listLeak) });
      const fu = /^\/api\/health\/auth\/tenants\/([a-z0-9-]+)\/fhir-users\/([^/]+)$/.exec(url.pathname);
      if (fu) {
        const [, t, oid] = fu;
        if (!GUID.test(oid) && !d.acceptNonGuid) return bad(400, 'bad_request');
        if (!tenants.has(t)) return bad(404, 'not_found');
        const key = d.crossTenantLeak ? oid : `${t}:${oid}`;
        if (m === 'GET') return maps.has(key) && !d.getBroken ? ok(maps.get(key)) : bad(404, 'not_found');
        if (m === 'DELETE') { if (!d.deleteNoop) maps.delete(key); return R(204); }
        const okRes = FHIR_USER.test(body.resource) && (!d.refuseDotSegment || !/\/\.\.?$/.test(body.resource));
        if (!okRes && !d.acceptAnyResource) return bad(400, 'bad_request');
        const doc = { tenant: t, oid, resource: body.resource };
        maps.set(key, doc);
        return ok(doc);
      }
      if (url.pathname === '/api/health/auth/clients' && m === 'GET') return ok({ clients: [...clients.values()] });
      if (url.pathname === '/api/health/auth/clients' && m === 'POST') {
        const c = { clientId: body.clientId, tenant: body.tenant, clientType: body.clientType, status: 'active' };
        clients.set(c.clientId, c);
        return ok(c, 201);
      }
      const cm = /^\/api\/health\/auth\/clients\/([^/]+)$/.exec(url.pathname);
      if (cm && m === 'PATCH') {
        const c = clients.get(cm[1]);
        if (!c) return bad(404, 'not_found');
        if ('launchUri' in body) {
          const v = body.launchUri;
          if (v !== null && !/^https:\/\//.test(v) && !d.acceptHttpLaunch) return bad(400, 'bad_request');
          if (v && c.clientType !== 'app' && !d.backendLaunch) return bad(400, 'bad_request');
          if (v === null) { if (!d.nullNoClear) delete c.launchUri; } else c.launchUri = v;
        }
        if (body.status) c.status = body.status;
        return ok({ ...c });
      }
      return bad(404, 'not_found');
    }
    if (url.origin === new URL(ISSUER).origin) {
      const t = /^\/auth\/([a-z0-9-]+)\/\.well-known\/(openid|smart)-configuration$/.exec(url.pathname);
      if (!t) return R(404, {});
      const cors = d.noCors ? {} : { 'access-control-allow-origin': '*' };
      if (!tenants.has(t[1]) && !d.catchAll) return R(400, { error: 'invalid_request', error_description: 'tenant is not available' }, cors);
      const iss = d.tenantlessIssuer ? ISSUER : `${ISSUER}/${t[1]}`;
      if (t[2] === 'openid') {
        const doc = { issuer: iss, authorization_endpoint: `${ISSUER}/${t[1]}/authorize`, token_endpoint: `${ISSUER}/${t[1]}/token`, jwks_uri: `${ISSUER}/jwks.json`,
          response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['ES384'] };
        if (d.dropField) delete doc[d.dropField];
        return R(200, doc, cors);
      }
      return R(200, { issuer: d.smartIssuer ?? iss, token_endpoint_auth_methods_supported: d.noNone ? ['private_key_jwt'] : ['private_key_jwt', 'none'] }, cors);
    }
    return R(404, {});
  };
  return { fetchImpl, maps, clients, seen };
}

async function run(d = {}, over = {}) {
  const st = stub(d);
  const lines = [];
  const r = await runAdminContract({ cpUrl: CP, cpToken: CP_TOKEN, a: 'ten-a', b: 'ten-b', issuerPath: '/auth', ownedFile: '', ...over },
    { fetchImpl: st.fetchImpl, sleep: async () => {}, print: (s) => lines.push(s) });
  return { ...r, st, lines, by: Object.fromEntries(r.results.map((x) => [x.name, x.verdict])) };
}

const ALL = ['fhir-user-put', 'fhir-user-get', 'fhir-user-list', 'fhir-user-cross-tenant-404', 'fhir-user-put-non-guid-400',
  'fhir-user-put-bad-type-400', 'fhir-user-put-dot-segment-400', 'fhir-user-delete-204', 'fhir-user-get-after-delete-404',
  'app-client-create', 'backend-client-create', 'launch-uri-set', 'launch-uri-listed', 'launch-uri-plain-http-400',
  'launch-uri-clear', 'launch-uri-cleared-listed', 'launch-uri-backend-400', 'oidc-discovery-issuer',
  'oidc-discovery-required-fields', 'oidc-discovery-cors', 'smart-config-auth-none', 'smart-config-issuer',
  'oidc-discovery-unknown-tenant-400'];

test('control: a correct CP + issuer passes every check, exit 0; mapping deleted and both clients disabled; no bearer to the public host', async () => {
  const r = await run({ refuseDotSegment: true });
  assert.deepEqual(r.by, Object.fromEntries(ALL.map((n) => [n, 'PASS'])), r.lines.join('\n'));
  assert.equal(r.exit, 0);
  assert.equal(r.st.maps.size, 0);
  assert.deepEqual([...r.st.clients.values()].map((c) => c.status), ['disabled', 'disabled']);
  assert.equal(r.st.seen.some((s) => s.host === 'pub.example.test' && s.auth), false);
  assert.equal(r.st.seen.some((s) => s.host === 'pub.example.test'), true); // positive half: discovery did go there
  assert.equal(r.lines.some((l) => l.includes(CP_TOKEN)), false);
  for (const l of r.lines.filter((x) => /^(PASS|FAIL|UNMEASURED) /.test(x))) assert.match(l, /^(PASS|FAIL|UNMEASURED) [a-z0-9-]+ \S/);
});

// Each defect -> the input that must turn exactly that check FAIL (and the run exit 1).
const DEFECTS = [
  [{ crossTenantLeak: true }, 'fhir-user-cross-tenant-404'],
  [{ acceptNonGuid: true }, 'fhir-user-put-non-guid-400'],
  [{ acceptAnyResource: true }, 'fhir-user-put-bad-type-400'],
  [{ refuseDotSegment: false }, 'fhir-user-put-dot-segment-400'], // the stub without refuseDotSegment mirrors FHIR_USER_RESOURCE on origin/main, which accepts `Patient/..`
  [{ deleteNoop: true }, 'fhir-user-get-after-delete-404'],
  [{ acceptHttpLaunch: true }, 'launch-uri-plain-http-400'],
  [{ nullNoClear: true }, 'launch-uri-clear'],
  [{ backendLaunch: true }, 'launch-uri-backend-400'],
  [{ tenantlessIssuer: true }, 'oidc-discovery-issuer'],
  [{ dropField: 'subject_types_supported' }, 'oidc-discovery-required-fields'],
  [{ noCors: true }, 'oidc-discovery-cors'],
  [{ noNone: true }, 'smart-config-auth-none'],
  [{ smartIssuer: ISSUER }, 'smart-config-issuer'],
  [{ catchAll: true }, 'oidc-discovery-unknown-tenant-400'],
];
for (const [d, name] of DEFECTS) {
  test(`defect ${JSON.stringify(d)} -> ${name} FAIL, exit 1`, async () => {
    const r = await run({ refuseDotSegment: true, ...d });
    assert.equal(r.by[name], 'FAIL', r.lines.join('\n'));
    assert.equal(r.exit, 1);
    assert.ok(r.lines.some((l) => l.startsWith(`FAIL ${name} HTTP `)), `the line names the observed status: ${r.lines.join('\n')}`);
  });
}

test('every OIDC-required field is checked: dropping any one of the 7 turns oidc-discovery-required-fields FAIL', async () => {
  assert.equal(OIDC_REQUIRED.length, 7);
  for (const f of OIDC_REQUIRED.filter((x) => x !== 'issuer')) {
    const r = await run({ refuseDotSegment: true, dropField: f });
    assert.equal(r.by['oidc-discovery-required-fields'], 'FAIL', f);
  }
});

test('paired control: if the tenant A read fails, a 404 on tenant B is UNMEASURED, never PASS (breaks if the pair is dropped)', async () => {
  const r = await run({ refuseDotSegment: true, getBroken: true });
  assert.equal(r.by['fhir-user-get'], 'FAIL');
  assert.equal(r.by['fhir-user-cross-tenant-404'], 'UNMEASURED');
  assert.equal(r.by['fhir-user-get-after-delete-404'], 'UNMEASURED');
});

test('a refused caller (403) is UNMEASURED for every admin check, not FAIL and not PASS; exit 2 is not claimed as a defect', async () => {
  const r = await run({ refuseDotSegment: true, forbidden: true });
  for (const n of ALL.filter((x) => !/^(oidc|smart)/.test(x))) assert.equal(r.by[n], 'UNMEASURED', n);
  assert.equal(r.by['oidc-discovery-issuer'], 'PASS'); // the public discovery needs no caller role
  assert.equal(r.exit, 2);
});

test('no response at all is UNMEASURED, exit 2 (R7: nothing established)', async () => {
  const r = await run({ network: true });
  assert.equal(r.exit, 2);
  assert.equal(r.results.some((x) => x.verdict === 'PASS' || x.verdict === 'FAIL'), false, r.lines.join('\n'));
});

test('evaluate/paired/exitOf: the breaking values', () => {
  assert.equal(evaluate('x', { status: 200, json: {} }, 404).verdict, 'FAIL'); // 200 where 404 is expected
  assert.equal(evaluate('x', { status: 404, json: {} }, 404).verdict, 'PASS');
  assert.equal(evaluate('x', { status: 200, json: {} }, 200, () => 'wrong body').verdict, 'FAIL');
  assert.equal(evaluate('x', { status: 401, json: {} }, 400).verdict, 'UNMEASURED');
  assert.equal(paired({ name: 'x', verdict: 'PASS', observed: '' }, { name: 'c', verdict: 'FAIL' }).verdict, 'UNMEASURED');
  assert.equal(paired({ name: 'x', verdict: 'FAIL', observed: '' }, { name: 'c', verdict: 'PASS' }).verdict, 'FAIL');
  assert.equal(exitOf([{ verdict: 'PASS' }, { verdict: 'UNMEASURED' }]), 2);
  assert.equal(exitOf([{ verdict: 'UNMEASURED' }, { verdict: 'FAIL' }]), 1);
  assert.equal(exitOf([{ verdict: 'PASS' }]), 0);
});

test('owned-file: the mapping and both clients are recorded, and cleanup DELETEs a recorded mapping under an owned tenant only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lhds-ac-'));
  try {
    const file = join(dir, 'owned.txt');
    const r = await run({ refuseDotSegment: true }, { ownedFile: file });
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.filter((l) => /^fhiruser:ten-a:[0-9a-f-]{36}$/.test(l)).length, 1);
    assert.equal(lines.filter((l) => /^client:ep-(app|be)-ten-a-/.test(l)).length, 2);
    assert.equal(r.exit, 0);
    // cleanup: ten-a owned (its mapping is deleted), a mapping under a NOT-owned tenant is left alone.
    const { appendFileSync } = await import('node:fs');
    appendFileSync(file, 'ten-a\nfhiruser:ten-z:11111111-1111-1111-1111-111111111111\n');
    const calls = [];
    const fetchImpl = async (u, init = {}) => { const p = new URL(u).pathname; calls.push(`${init.method ?? 'GET'} ${p}`);
      if (p === '/api/health/auth/clients') return new Response(JSON.stringify({ ok: true, data: { clients: [] } }), { status: 200 });
      if (/fhir-users/.test(p)) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ ok: false }), { status: 404 }); };
    const orig = console.log; console.log = () => {};
    try {
      await phaseCleanup({ cpUrl: CP, cpToken: CP_TOKEN, stamp: 'dev01', a: 'ten-a', b: 'ten-b', timeoutS: 5, ownedFile: file }, { fetchImpl });
    } finally { console.log = orig; }
    assert.equal(calls.filter((c) => /^DELETE \/api\/health\/auth\/tenants\/ten-a\/fhir-users\//.test(c)).length, 1);
    assert.equal(calls.some((c) => c.includes('ten-z')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
