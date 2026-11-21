/**
 * Self-test for scripts/measure/health/mint-tenant-token.mjs and lhds-edge-probe-run.mjs (#5410).
 *
 * Each case stands up an in-process stub control plane + authorization server + edge. The stub
 * AS really verifies the ES384 client assertion against the JWK that was registered (signature,
 * iss/sub, aud, exp window, jti) as the real server does (apps/loom-health-cp/src/auth/backend-auth.ts),
 * so a mint that signs the wrong thing is refused by the stub, not waved through. Keys are generated
 * at runtime: no static JWK fixture exists in this file.
 *
 * Every test names, in its title or a comment, the input that would break it.
 *
 * Run: node --test scripts/ci/__tests__/lhds-mint-tenant-token.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cli, mintTenantToken, discoverIssuer, redact, classifyStatus, MintError, checkClaims } from '../../measure/health/mint-tenant-token.mjs';
import { phaseProbe } from '../../measure/health/lhds-edge-probe-run.mjs';

// The DISCOVERED issuer is deliberately NOT the stub's own address (the real one will be a Front Door host).
const ISSUER = 'https://issuer-front-door.example.test/auth';
const CP_TOKEN = ['cp', 'bearer', 'sentinel'].join('-');
const ACCESS_SIG = ['access', 'signature', 'sentinel'].join('-');
const SCRIPT = fileURLToPath(new URL('../../measure/health/mint-tenant-token.mjs', import.meta.url));
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function stub(opts = {}) {
  const st = { regCalls: 0, tokenCalls: 0, clients: new Map(), assertions: [], tokens: [], auds: [], edgeSeen: [] };
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const send = (code, body, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(body)); };
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/auth/.well-known/openid-configuration') return send(200, { issuer: opts.issuer ?? ISSUER, jwks_uri: `${ISSUER}/jwks.json` });
      if (url.pathname === '/api/health/auth/clients' && req.method === 'POST') {
        st.regCalls += 1;
        if (req.headers.authorization !== `Bearer ${CP_TOKEN}` || opts.regStatus === 403) return send(403, { ok: false, error: { code: 'forbidden', message: 'caller is not allowlisted' } });
        if (opts.regFlaky && st.regCalls <= opts.regFlaky) return send(503, { ok: false, error: { code: 'unavailable', message: 'try later' } });
        if (opts.regAlways503) return send(503, { ok: false, error: { code: 'unavailable', message: 'down' } });
        const b = JSON.parse(raw);
        st.clients.set(b.clientId, { ...b, status: 'active' });
        return send(201, { ok: true, data: { ...b, status: 'active' } });
      }
      const pm = /^\/api\/health\/auth\/clients\/([^/]+)$/.exec(url.pathname);
      if (pm && req.method === 'PATCH') {
        const c = st.clients.get(pm[1]);
        if (!c) return send(404, { ok: false, error: { code: 'not_found', message: 'client' } });
        c.status = JSON.parse(raw).status;
        return send(200, { ok: true, data: { ...c } });
      }
      if (url.pathname === '/api/health/auth/clients' && req.method === 'GET') return send(200, { ok: true, data: { clients: [...st.clients.values()] } });
      const tm = /^\/auth\/([a-z0-9-]+)\/token$/.exec(url.pathname);
      if (tm && req.method === 'POST') {
        st.tokenCalls += 1;
        const p = new URLSearchParams(raw);
        const a = p.get('client_assertion') ?? '';
        st.assertions.push(a);
        const refuse = () => send(401, { error: 'invalid_client', error_description: 'client authentication failed' });
        try {
          const [h, b, s] = a.split('.');
          const head = JSON.parse(Buffer.from(h, 'base64url').toString());
          const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
          const client = st.clients.get(claims.iss);
          if (!client || client.status !== 'active' || client.tenant !== tm[1]) return refuse();
          const jwk = client.jwks.keys.find((k) => k.kid === head.kid);
          const ok = head.alg === 'ES384' && head.typ === 'JWT' && jwk
            && verify('sha384', Buffer.from(`${h}.${b}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
          st.auds.push(claims.aud);
          const nowS = Math.floor(Date.now() / 1000);
          // aud must be the DISCOVERED issuer's token URL, exactly as the real AS compares it.
          if (!ok || claims.sub !== claims.iss || claims.aud !== `${ISSUER}/${tm[1]}/token` || !claims.jti || claims.exp <= nowS || claims.exp - nowS > 300) return refuse();
          if (opts.tokenDefect) return refuse();
        } catch { return refuse(); }
        const payload = { iss: ISSUER, tenant: opts.wrongTenantClaim ? 'someone-else' : tm[1], exp: Math.floor(Date.now() / 1000) + 300, scope: 'system/*.rs' };
        const token = `${b64u({ alg: 'ES384', typ: 'at+jwt' })}.${b64u(payload)}.${ACCESS_SIG}`;
        st.tokens.push(token);
        return send(200, { access_token: token, token_type: 'bearer', expires_in: 300, scope: 'system/*.rs' });
      }
      // the edge: /<tenant>/fhir/metadata
      const em = /^\/([a-z0-9-]+)\/fhir\/metadata$/.exec(url.pathname);
      if (em) {
        const t = (req.headers.authorization ?? '').replace('Bearer ', '');
        const claim = JSON.parse(Buffer.from(t.split('.')[1] ?? '', 'base64url').toString() || '{}').tenant;
        st.edgeSeen.push(em[1]);
        if (opts.edgeStatus === 401) return send(401, {});
        if (claim !== em[1]) return send(403, {});
        st.edgeCount = st.edgeCount ?? new Map();
        st.edgeCount.set(em[1], (st.edgeCount.get(em[1]) ?? 0) + 1);
        // per-tenant quota of 3/min, like the fragment: matches probeCfg quota
        if (st.edgeCount.get(em[1]) > 3) return send(429, {}, { 'retry-after': '30' });
        return send(opts.edgeStatus ?? 200, {});
      }
      return send(404, { ok: false, error: { code: 'not_found', message: 'no route' } });
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, st, url: `http://127.0.0.1:${srv.address().port}` })));
}

const noSleep = { sleep: async () => {} };
const cfg = (url, over = {}) => ({ cpUrl: url, cpToken: CP_TOKEN, tenant: 'ten-a', issuerPath: '/auth', ...noSleep, ...over });

test('assertion aud is built from the DISCOVERED issuer: a token minted against the stub only exists if aud != the CP address', async () => {
  const { srv, st, url } = await stub();
  try {
    const m = await mintTenantToken(cfg(url));
    // Breaks if aud were built from the CP URL / stamp fqdn: the stub would answer 401 and mint would throw.
    assert.deepEqual(st.auds, [`${ISSUER}/ten-a/token`]);
    assert.notEqual(st.auds[0], `${url}/auth/ten-a/token`);
    assert.equal(m.issuer, ISSUER);
    assert.equal(m.claims.tenantOk, true);
    assert.equal(m.claims.issOk, true);
    assert.equal(m.claims.expOk, true);
    assert.equal(m.scope, 'system/*.rs');
  } finally { srv.close(); }
});

test('a discovered issuer of a DIFFERENT host changes aud (breaks if the issuer is cached/hardcoded)', async () => {
  const other = 'https://another-edge.example.test/auth';
  const { srv, st, url } = await stub({ issuer: other });
  try {
    // The stub AS insists on ISSUER, so the mint must be refused: proving aud follows discovery, not a constant.
    await assert.rejects(mintTenantToken(cfg(url)), (e) => e instanceof MintError && e.cls === 'defect' && e.exit === 1);
    assert.deepEqual(st.auds, [`${other}/ten-a/token`]);
  } finally { srv.close(); }
});

test('claim checks: a token whose tenant claim is another tenant is FAIL exit 1 (breaks if tenant is not compared)', async () => {
  const { srv, st, url } = await stub({ wrongTenantClaim: true });
  try {
    const lines = [];
    const code = await cli(['--cp-url', url, '--tenant', 'ten-a'], { LHDS_CP_TOKEN: CP_TOKEN }, (l) => lines.push(l), noSleep);
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /tenant_claim_matches=false/);
    assert.match(lines.join('\n'), /VERDICT FAIL/);
    assert.equal([...st.clients.values()][0].status, 'disabled'); // cleanup ran on the failure path too
  } finally { srv.close(); }
});

test('checkClaims: expired exp and wrong issuer each flip their own boolean', () => {
  const tok = (p) => `${b64u({ alg: 'x' })}.${b64u(p)}.sig`;
  const nowMs = 1_000_000_000_000;
  const good = checkClaims(tok({ tenant: 't', iss: 'https://i/auth/', exp: nowMs / 1000 + 10, scope: 's' }), { tenant: 't', issuer: 'https://i/auth', nowMs });
  assert.deepEqual([good.tenantOk, good.issOk, good.expOk, good.scope], [true, true, true, 's']);
  const bad = checkClaims(tok({ tenant: 't', iss: 'https://evil/auth', exp: nowMs / 1000 - 1 }), { tenant: 't', issuer: 'https://i/auth', nowMs });
  assert.deepEqual([bad.tenantOk, bad.issOk, bad.expOk], [true, false, false]);
});

test('permission: a 403 on registration is class permission, exit 2, and is NOT retried (breaks if 403 is retried)', async () => {
  const { srv, st, url } = await stub({ regStatus: 403 });
  try {
    await assert.rejects(mintTenantToken(cfg(url)), (e) => e.cls === 'permission' && e.exit === 2 && /HealthCP\.Admin/.test(e.message));
    assert.equal(st.regCalls, 1);
  } finally { srv.close(); }
});

test('transient: two 503s then success mints (breaks if no retry); a permanent 503 stops at exactly 3 attempts, class transient, exit 2 (breaks if unbounded or mis-classed)', async () => {
  const flaky = await stub({ regFlaky: 2 });
  try {
    const m = await mintTenantToken(cfg(flaky.url));
    assert.equal(flaky.st.regCalls, 3);
    assert.equal(m.claims.tenantOk, true);
  } finally { flaky.srv.close(); }
  const down = await stub({ regAlways503: true });
  try {
    await assert.rejects(mintTenantToken(cfg(down.url)), (e) => e.cls === 'transient' && e.exit === 2);
    assert.equal(down.st.regCalls, 3);
    assert.equal(down.st.tokenCalls, 0);
  } finally { down.srv.close(); }
});

test('defect: the AS refusing a client it just accepted is class defect, exit 1, and the client is disabled', async () => {
  const { srv, st, url } = await stub({ tokenDefect: true });
  try {
    await assert.rejects(mintTenantToken(cfg(url)), (e) => e.cls === 'defect' && e.exit === 1);
    assert.equal([...st.clients.values()][0].status, 'disabled');
  } finally { srv.close(); }
});

test('config: a 21-char tenant is refused before ANY network call (breaks if the slug cap is not enforced)', async () => {
  let calls = 0;
  await assert.rejects(mintTenantToken(cfg('http://127.0.0.1:1', { tenant: 'a'.repeat(21), fetchImpl: async () => { calls += 1; throw new Error('no'); } })), (e) => e.cls === 'config' && e.exit === 2);
  assert.equal(calls, 0);
});

test('discovery: a non-https, non-loopback issuer is refused (breaks if any scheme is accepted)', async () => {
  const { srv, url } = await stub({ issuer: 'http://evil.example.test/auth' });
  try {
    await assert.rejects(discoverIssuer(cfg(url)), (e) => e.cls === 'defect' && /not https/.test(e.message));
  } finally { srv.close(); }
});

test('classifyStatus: 401/403 permission, 404 config, 503 and network transient, 418 defect', () => {
  assert.deepEqual([401, 403, 404, 503, 'network-error', 418].map(classifyStatus), ['permission', 'permission', 'config', 'transient', 'transient', 'defect']);
});

test('redact masks a JWT-shaped string (breaks if error text can carry a token)', () => {
  const jwt = `${Buffer.from('{"alg":"x"}').toString('base64url')}.${b64u({ a: 1, tenant: 'secret' })}.${ACCESS_SIG}`;
  const r = redact(`bad thing ${jwt} end`);
  assert.equal(r.includes(ACCESS_SIG), false);
  assert.match(r, /<jwt>/); // positive: the surrounding text survives
  assert.match(r, /bad thing/);
});

test('the real CLI never prints token or key material, and DOES print the verdict (breaks if a token/assertion/CP bearer reaches stdout/stderr, or if output is silent)', async () => {
  const { srv, st, url } = await stub();
  try {
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, [SCRIPT, '--cp-url', url, '--tenant', 'ten-a'], { env: { PATH: process.env.PATH, LHDS_CP_TOKEN: CP_TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
      let o = ''; let e = '';
      p.stdout.on('data', (d) => { o += d; });
      p.stderr.on('data', (d) => { e += d; });
      p.on('close', (code) => resolve({ code, o, e }));
    });
    const all = `${r.o}\n${r.e}`;
    assert.equal(r.code, 0, all);
    assert.equal(st.tokens.length, 1);
    assert.equal(all.includes(ACCESS_SIG), false);
    assert.equal(all.includes(st.tokens[0]), false);
    assert.equal(all.includes(st.tokens[0].split('.')[1]), false); // payload segment
    assert.equal(all.includes(st.assertions[0]), false);
    assert.equal(all.includes(st.assertions[0].split('.')[2]), false); // assertion signature
    assert.equal(all.includes(CP_TOKEN), false);
    assert.equal(/"d"\s*:/.test(all), false); // no private JWK member
    assert.match(all, /VERDICT PASS tenant=ten-a/);
    assert.match(all, /tenant_claim_matches=true iss_matches_discovered_issuer=true exp_in_future=true/);
    assert.match(all, /client_disabled=true/);
    assert.equal(st.clients.get([...st.clients.keys()][0]).status, 'disabled');
  } finally { srv.close(); }
});

// ---- orchestrator: phaseProbe (mint both, optionally probe in-process) ----
const probeCfg = (url, over = {}) => ({ cpUrl: url, cpToken: CP_TOKEN, a: 'ten-a', b: 'ten-b', mode: 'probe', edge: url, quota: 3, issuerPath: '/auth', ...over });

async function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { return { code: await fn(), text: lines.join('\n') }; } finally { console.log = orig; }
}

test('phaseProbe mode=probe: edge 404 on the positive control passes auth with a note, exit 0, both clients disabled, no token in output', async () => {
  const { srv, st, url } = await stub({ edgeStatus: 404 });
  try {
    const r = await capture(() => phaseProbe(probeCfg(url), noSleep));
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /positive-control PASS: .*answered 404: passed auth; backend not serving/);
    assert.match(r.text, /cross-tenant-403 PASS/);
    assert.equal(st.tokens.some((t) => r.text.includes(t)), false);
    assert.equal(r.text.includes(ACCESS_SIG), false);
    assert.deepEqual([...st.clients.values()].map((c) => c.status), ['disabled', 'disabled']);
  } finally { srv.close(); }
});

test('phaseProbe mode=probe: edge 401 on the positive control is UNMEASURED exit 2 (breaks if 401 counts as a pass)', async () => {
  const { srv, url } = await stub({ edgeStatus: 401 });
  try {
    const r = await capture(() => phaseProbe(probeCfg(url), noSleep));
    assert.equal(r.code, 2, r.text);
    assert.match(r.text, /positive-control UNMEASURED/);
    assert.match(r.text, /VERDICT UNMEASURED/);
  } finally { srv.close(); }
});

test('phaseProbe mode=mint-only: mints and verifies both tenants without touching the edge (breaks if the edge is called)', async () => {
  const { srv, st, url } = await stub();
  try {
    const r = await capture(() => phaseProbe(probeCfg(url, { mode: 'mint-only', edge: '' }), noSleep));
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(st.edgeSeen, []);
    assert.match(r.text, /VERDICT PASS tenant=ten-a/);
    assert.match(r.text, /VERDICT PASS tenant=ten-b/);
    assert.match(r.text, /VERDICT PASS mode=mint-only/);
  } finally { srv.close(); }
});

// ---- ownership: cleanup destroys ONLY slugs this run created (201) ----
import { phaseCreate, phaseCleanup, readOwned } from '../../measure/health/lhds-edge-probe-run.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** fetch spy: tenants POST answers per `post`, GET tenant exists, destroy job succeeds immediately. */
function cpSpy(post) {
  const calls = [];
  const fetchImpl = async (u, init = {}) => {
    const url = new URL(u);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    const res = (code, body) => ({ status: code, text: async () => JSON.stringify(body) });
    if (method === 'POST' && url.pathname === '/api/health/tenants') return res(post[JSON.parse(init.body).id] ?? 201, { ok: true, data: {} });
    if (method === 'POST' && url.pathname === '/api/health/jobs') {
      const b = JSON.parse(init.body);
      return res(202, { ok: true, data: { id: `job-${'a'.repeat(32)}`, state: b.kind === 'tenant.destroy' ? 'succeeded' : 'queued', receipts: [] } });
    }
    if (method === 'GET' && url.pathname.startsWith('/api/health/tenants/')) return res(200, { ok: true, data: { stampId: 'dev01', status: 'active' } });
    if (method === 'GET' && url.pathname === '/api/health/auth/clients') return res(200, { ok: true, data: { clients: [] } });
    return res(404, { ok: false });
  };
  return { fetchImpl, calls };
}
const ownCfg = (file) => ({ cpUrl: 'https://cp.example.test', cpToken: CP_TOKEN, stamp: 'dev01', a: 'ep-a-1', b: 'ep-b-1', quota: 30, timeoutS: 5, ownedFile: file });
const destroyDeps = (spy) => ({ fetchImpl: spy.fetchImpl, sleep: async () => {}, out: () => {} });
const jobPosts = (calls) => calls.filter((c) => c === 'POST /api/health/jobs').length;

test('a 409 on create for tenant A fails the run, never marks A owned, and cleanup does NOT destroy A (breaks on the old rule: destroy anything whose GET is not 404)', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'own-')), 'owned.txt');
  const spy = cpSpy({ 'ep-a-1': 409 });
  const cr = await capture(() => phaseCreate(ownCfg(file), { fetchImpl: spy.fetchImpl, sleep: async () => {} }));
  assert.equal(cr.code, 1);
  assert.match(cr.text, /COLLISION: tenant ep-a-1 already exists/);
  assert.equal(readOwned(file).has('ep-a-1'), false);
  const cl = await capture(() => phaseCleanup(ownCfg(file), { fetchImpl: spy.fetchImpl, sleep: async () => {}, destroyDeps: destroyDeps(spy) }));
  assert.equal(jobPosts(spy.calls), 0); // no tenant.create (create stopped at A) and no tenant.destroy for A
  assert.match(cl.text, /tenant ep-a-1 was not created by this run/);
  assert.equal(cl.code, 0);
});

test('positive control: a tenant that returned 201 IS owned and cleanup DOES destroy it (breaks if cleanup destroys nothing); the 409 sibling is spared', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'own-')), 'owned.txt');
  const spy = cpSpy({ 'ep-b-1': 409 });
  const cr = await capture(() => phaseCreate(ownCfg(file), { fetchImpl: spy.fetchImpl, sleep: async () => {} }));
  assert.equal(cr.code, 1);
  assert.deepEqual([...readOwned(file)], ['ep-a-1']);
  const cl = await capture(() => phaseCleanup(ownCfg(file), { fetchImpl: spy.fetchImpl, sleep: async () => {}, destroyDeps: destroyDeps(spy) }));
  assert.equal(jobPosts(spy.calls), 2); // tenant.create for A + tenant.destroy for A; none for B
  assert.match(cl.text, /tenant ep-b-1 was not created by this run/);
});

test('readOwned: a missing file or no path means nothing is owned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lhds-owned-'));
  try {
    assert.equal(readOwned(join(dir, 'missing-owned.txt')).size, 0); // the dir exists, the file does not
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(readOwned('').size, 0);
});
