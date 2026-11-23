/**
 * Self-test for scripts/measure/health/lhds-fhir-crud-probe-run.mjs and the optional grant parameters of
 * mint-tenant-token.mjs (#5422 decision 12, LHDS W2-2b B3). Sits beside lhds-mint-tenant-token.test.mjs (same runner).
 *
 * Every test names, in its title or a comment, the input that would break it. The load-bearing ones were run against a
 * SANDBOX COPY with the defect applied (recorded in the PR body), never against the tracked tree.
 *
 * Run: node --test scripts/ci/__tests__/lhds-fhir-crud-probe.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintTenantToken } from '../../measure/health/mint-tenant-token.mjs';
import {
  EXPECT, ENGINE_NAMESPACE, SERVICE_PORT, engineBase, judge, parseProbeLogs, phaseCleanup, phaseCreate, phaseProbe,
  renderProbeScript, validate, parseArgs, workloadName,
} from '../../measure/health/lhds-fhir-crud-probe-run.mjs';

const ISSUER = 'https://issuer-front-door.example.test/auth';
const CP_TOKEN = ['cp', 'bearer', 'sentinel'].join('-');
const SIG = ['access', 'signature', 'sentinel'].join('-');
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const ROOT = new URL('../../../', import.meta.url);
const src = (p) => readFileSync(new URL(p, ROOT), 'utf8');

/** In-memory control plane: discovery, client registry, token endpoint, tenants and jobs. No network. */
function cpFake(opts = {}) {
  const st = { regs: [], forms: [], patches: [], jobs: [], tenantPosts: [], clients: new Map(), gets: [] };
  const res = (code, body) => ({ status: code, text: async () => JSON.stringify(body) });
  const fetchImpl = async (u, init = {}) => {
    const url = new URL(u);
    const method = init.method ?? 'GET';
    if (url.pathname === '/auth/.well-known/openid-configuration') return res(200, { issuer: ISSUER });
    if (method === 'POST' && url.pathname === '/api/health/auth/clients') {
      const b = JSON.parse(init.body);
      st.regs.push(b);
      st.clients.set(b.clientId, { ...b, status: 'active' });
      return res(201, { ok: true, data: b });
    }
    const pm = /^\/api\/health\/auth\/clients\/([^/]+)$/.exec(url.pathname);
    if (pm && method === 'PATCH') {
      st.patches.push(pm[1]);
      const c = st.clients.get(pm[1]);
      if (c) c.status = 'disabled';
      return res(200, { ok: true, data: { status: 'disabled' } });
    }
    if (method === 'GET' && url.pathname === '/api/health/auth/clients') return res(200, { ok: true, data: { clients: [...st.clients.values()] } });
    const tm = /^\/auth\/([a-z0-9-]+)\/token$/.exec(url.pathname);
    if (method === 'POST' && tm) {
      const form = new URLSearchParams(init.body);
      st.forms.push(Object.fromEntries(form));
      const scope = opts.scopeFor ? opts.scopeFor(tm[1], form.get('scope')) : form.get('scope');
      const payload = { iss: ISSUER, tenant: tm[1], exp: Math.floor(Date.now() / 1000) + 300, scope };
      const token = `${b64u({ alg: 'ES384', typ: 'at+jwt' })}.${b64u(payload)}.${SIG}-${tm[1]}`;
      return res(200, { access_token: token, token_type: 'bearer', expires_in: 300, scope });
    }
    if (method === 'POST' && url.pathname === '/api/health/tenants') {
      const b = JSON.parse(init.body);
      st.tenantPosts.push(b.id);
      return res(opts.tenantStatus?.[b.id] ?? 201, { ok: true, data: {} });
    }
    if (method === 'POST' && url.pathname === '/api/health/jobs') {
      const b = JSON.parse(init.body);
      st.jobs.push(b);
      const state = opts.jobState?.(b) ?? 'succeeded';
      return res(202, { ok: true, data: { id: `job-${'a'.repeat(32)}`, state, receipts: [] } });
    }
    if (method === 'GET' && url.pathname.startsWith('/api/health/tenants/')) { st.gets.push(url.pathname); return res(200, { ok: true, data: { stampId: 'dev01', status: 'active' } }); }
    return res(404, { ok: false });
  };
  return { st, fetchImpl, deps: { fetchImpl, sleep: async () => {}, now: () => 0 } };
}

async function capture(fn) {
  const lines = [];
  const out = (s) => lines.push(s);
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { return { code: await fn(out), text: lines.join('\n') }; } finally { console.log = orig; }
}

// ---------------------------------------------------------------------------------------------------------------------
// mint-tenant-token.mjs: optional grant parameters

test('mint defaults are UNCHANGED: reader role, system/*.rs, prefix ep (breaks if a default becomes system/*.cruds or the writer role: the edge probe would mint a writer)', async () => {
  const cp = cpFake();
  const m = await mintTenantToken({ ...cp.deps, cpUrl: 'https://cp.example.test', cpToken: CP_TOKEN, tenant: 'ten-a', issuerPath: '/auth' });
  assert.deepEqual(cp.st.regs[0].allowedScopes, ['system/*.rs']);
  assert.deepEqual(cp.st.regs[0].roleIds, ['fhir-data-reader']);
  assert.equal(cp.st.forms[0].scope, 'system/*.rs');
  assert.match(m.clientId, /^ep-ten-a-[0-9a-f]{8}$/);
  assert.equal(m.scope, 'system/*.rs');
});

test('mint writer grant: allowedScopes, roleIds, scope and prefix are what the caller passed (breaks if a parameter is ignored and the default is sent)', async () => {
  const cp = cpFake();
  const m = await mintTenantToken({ ...cp.deps, cpUrl: 'https://cp.example.test', cpToken: CP_TOKEN, tenant: 'ten-a', issuerPath: '/auth',
    allowedScopes: ['system/*.cruds'], roleIds: ['fhir-data-writer'], scope: 'system/*.cruds', clientPrefix: 'fc' });
  assert.deepEqual(cp.st.regs[0].allowedScopes, ['system/*.cruds']);
  assert.deepEqual(cp.st.regs[0].roleIds, ['fhir-data-writer']);
  assert.equal(cp.st.forms[0].scope, 'system/*.cruds');
  assert.match(m.clientId, /^fc-ten-a-[0-9a-f]{8}$/);
});

test('mint refuses a malformed grant before any network call (breaks if an empty roleIds or a spaced prefix reaches the control plane)', async () => {
  for (const bad of [{ roleIds: [] }, { allowedScopes: [] }, { clientPrefix: 'Bad Prefix' }, { scope: '' }]) {
    const cp = cpFake();
    await assert.rejects(() => mintTenantToken({ ...cp.deps, cpUrl: 'https://cp.example.test', cpToken: CP_TOKEN, tenant: 'ten-a', ...bad }), /must (be|match)/);
    assert.equal(cp.st.regs.length, 0, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// the probe-output parser and the per-step verdicts

const ALL_OK = [
  'PROBE tool sleep=yes', 'PROBE step=a status=200', 'PROBE step=b status=401', 'PROBE step=c_try n=1 status=201',
  'PROBE step=c status=201 id=77', 'PROBE step=d status=200 id_match=yes', 'PROBE step=e status=403',
  'PROBE step=f_ctrl status=200', 'PROBE step=f status=403',
].join('\n');
const verdictOf = (logs) => Object.fromEntries(judge(parseProbeLogs(logs)).results.map((r) => [r.step, r.verdict]));
const swap = (logs, from, to) => { assert.ok(logs.includes(from), `fixture drift: ${from} is not in the fixture`); return logs.replace(from, to); };

test('judge: the all-correct fixture passes every step and exits 0 (positive control: breaks if a correct run is reported as a failure)', () => {
  const v = judge(parseProbeLogs(ALL_OK));
  assert.deepEqual(v.results.map((r) => `${r.step}:${r.verdict}`), ['a:pass', 'b:pass', 'c:pass', 'd:pass', 'e:pass', 'f_ctrl:pass', 'f:pass']);
  assert.equal(v.code, 0);
});

test('judge: EXPECT is a:200 b:401 c:201 d:200 e:403 f_ctrl:200 f:403 (breaks if any expected code is edited)', () => {
  assert.deepEqual({ ...EXPECT }, { a: 200, b: 401, c: 201, d: 200, e: 403, f_ctrl: 200, f: 403 });
});

test('judge: a 403 where 201 is expected for (c) FAILS the create, and (d)/(e) are then NOT passes (breaks if a denied create is reported as success)', () => {
  const logs = swap(swap(ALL_OK, 'PROBE step=c status=201 id=77', 'PROBE step=c status=403'), 'PROBE step=d status=200 id_match=yes\n', '');
  const v = verdictOf(logs);
  assert.equal(v.c, 'fail');
  assert.equal(v.d, 'unmeasured');
  assert.equal(v.e, 'unmeasured'); // its 403 is not evidence while the create did not pass
  assert.equal(judge(parseProbeLogs(logs)).code, 1);
  assert.match(judge(parseProbeLogs(logs)).results.find((r) => r.step === 'c').note, /NOT established|not established/);
});

test('judge: a 201 where 403 is expected for (e) is a CROSS-TENANT LEAK and FAILS (breaks if e only checks "not 500" or counts any 2xx as fine)', () => {
  const v = judge(parseProbeLogs(swap(ALL_OK, 'PROBE step=e status=403', 'PROBE step=e status=201')));
  assert.equal(v.results.find((r) => r.step === 'e').verdict, 'fail');
  assert.match(v.results.find((r) => r.step === 'e').note, /LEAK/);
  assert.equal(v.code, 1);
  assert.equal(verdictOf(swap(ALL_OK, 'PROBE step=e status=403', 'PROBE step=e status=200')).e, 'fail');
});

test('judge: (e) 403 is a PASS only after (c) and (d) passed; with a bad (d) it is unmeasured (breaks if a PDP that denies everything is credited with the cross-tenant control)', () => {
  const v = verdictOf(swap(ALL_OK, 'PROBE step=d status=200 id_match=yes', 'PROBE step=d status=200 id_match=no'));
  assert.equal(v.d, 'fail');
  assert.equal(v.e, 'unmeasured');
});

test('judge: (f) 403 is a PASS only when the reader positive control (f_ctrl) was 200; f_ctrl 403 makes f unmeasured; a reader that CREATES (201) fails', () => {
  assert.equal(verdictOf(ALL_OK).f, 'pass');
  const noCtrl = verdictOf(swap(ALL_OK, 'PROBE step=f_ctrl status=200', 'PROBE step=f_ctrl status=403'));
  assert.equal(noCtrl.f_ctrl, 'fail');
  assert.equal(noCtrl.f, 'unmeasured');
  assert.equal(verdictOf(swap(ALL_OK, 'PROBE step=f status=403', 'PROBE step=f status=201')).f, 'fail');
});

test('judge: d needs the returned id to equal the created one (breaks if a 200 with a different Patient is accepted)', () => {
  assert.equal(verdictOf(swap(ALL_OK, 'id_match=yes', 'id_match=no')).d, 'fail');
});

test('judge: a 201 with no Location id fails c, and a wrong no-token status fails b (401 expected, 200 is a PASS-through of the auth check)', () => {
  assert.equal(verdictOf(swap(ALL_OK, 'PROBE step=c status=201 id=77', 'PROBE step=c status=201')).c, 'fail');
  assert.equal(verdictOf(swap(ALL_OK, 'PROBE step=b status=401', 'PROBE step=b status=201')).b, 'fail');
  assert.equal(verdictOf(swap(ALL_OK, 'PROBE step=a status=200', 'PROBE step=a status=401')).a, 'fail');
});

test('judge: 000 (no connection) and a missing step are UNMEASURED exit 2, never a pass and never a defect (R7)', () => {
  const v = judge(parseProbeLogs(swap(ALL_OK, 'PROBE step=a status=200', 'PROBE step=a status=000')));
  assert.equal(v.results[0].verdict, 'unmeasured');
  assert.equal(v.code, 2);
  const none = judge(parseProbeLogs(''));
  assert.equal(none.code, 2);
  assert.ok(none.results.every((r) => r.verdict === 'unmeasured'));
});

test('judge: c still 403 after the retries fails with a message that does NOT claim a cause; c 503 is unmeasured (breaks if a persistent 403 is called "bundle not loaded")', () => {
  const logs = [ALL_OK.split('\n').slice(0, 3).join('\n'), 'PROBE step=c_try n=1 status=403', 'PROBE step=c_try n=2 status=403', 'PROBE step=c status=403'].join('\n');
  const c = judge(parseProbeLogs(logs)).results.find((r) => r.step === 'c');
  assert.equal(c.verdict, 'fail');
  assert.match(c.note, /403 on all 2 attempt/);
  assert.match(c.note, /not established/);
  const c503 = judge(parseProbeLogs(logs.replace('step=c status=403', 'step=c status=503'))).results.find((r) => r.step === 'c');
  assert.equal(c503.verdict, 'unmeasured');
});

test('parseProbeLogs ignores every line that is not an exact PROBE line, so a header or token in pod logs is never read back (breaks if the parser is a loose substring match)', () => {
  const tok = `eyJhbGciOi.${b64u({ tenant: 'x' })}.${SIG}`;
  const logs = `Authorization: Bearer ${tok}\nPROBE step=a status=200 trailing=${tok}\nPROBE step=zz status=200\nPROBE step=b status=401\n`;
  const p = parseProbeLogs(logs);
  assert.deepEqual(Object.keys(p.steps), ['b']); // the 'a' line carries extra text and is dropped; an unknown step is dropped
  assert.equal(JSON.stringify(p).includes(SIG), false);
});

// ---------------------------------------------------------------------------------------------------------------------
// the probe script, and its contact points with the engine source

test('the Service coordinates are the ones the control plane creates (lifted from fhir-engine-host.ts and fhir-tenant-config.ts, not retyped)', () => {
  const host = src('apps/loom-health-cp/src/jobs/fhir-engine-host.ts');
  assert.equal(Number(/export const SERVICE_PORT = (\d+);/.exec(host)?.[1]), SERVICE_PORT);
  assert.equal(/export const ENGINE_NAMESPACE = '([^']+)';/.exec(host)?.[1], ENGINE_NAMESPACE);
  const cfgSrc = src('apps/loom-health-cp/src/jobs/fhir-tenant-config.ts');
  assert.ok(cfgSrc.includes('workloadName: `fhir-${slug}`'), 'fhirNames().workloadName changed; update workloadName() here');
  assert.equal(workloadName('fc-a-1'), 'fhir-fc-a-1');
  assert.equal(engineBase('fc-a-1'), 'http://fhir-fc-a-1.loom-health.svc.cluster.local:80/fhir');
});

test('the expected statuses are pinned to the engine and PDP source: no bearer = AuthenticationException (401), any PDP deny = ForbiddenOperationException (403), tenant-mismatch and scope-denied exist', () => {
  const java = src('apps/loom-health-fhir/plugin/src/main/java/ai/loom/health/fhir/pdp/LoomPdpInterceptor.java');
  assert.ok(/"deny", "no-token", "", 401, TokenView\.EMPTY\)\);\s*throw new AuthenticationException/.test(java), 'the no-token branch no longer throws AuthenticationException with 401');
  assert.ok(/throw new ForbiddenOperationException\("Access denied"\)/.test(java));
  assert.ok(/opType == RestOperationTypeEnum\.METADATA/.test(java), 'metadata is no longer the exempt route');
  const rego = src('apps/loom-health-pdp/policies/lhds/authz/authz.rego');
  assert.ok(rego.includes('"tenant-mismatch" if not tenant_ok'));
  assert.ok(rego.includes('else := "scope-denied"'));
  // HAPI maps AuthenticationException -> 401 and ForbiddenOperationException -> 403: the plugin's own test asserts the 403 on the wire.
  assert.ok(/assertEquals\("403", r\[0\]/.test(src('apps/loom-health-fhir/plugin/src/test/java/ai/loom/health/fhir/InterceptorTest.java')));
});

test('renderProbeScript embeds no secret and reads tokens from header files only (breaks if a token placeholder or a "Bearer" literal is added to the script text)', () => {
  const s = renderProbeScript({ tenantA: 'fc-a-1', tenantB: 'fc-b-1', partition: 'probe-site' });
  assert.ok(s.includes('-H "@$hdr"'), 'tokens must be read with curl -H @file');
  assert.equal(/Bearer/i.test(s), false);
  assert.ok(s.includes(engineBase('fc-a-1')) && s.includes(engineBase('fc-b-1')));
  assert.throws(() => renderProbeScript({ tenantA: "x'; id #", tenantB: 'fc-b-1', partition: 'probe-site' }), /not a tenant slug/);
  assert.throws(() => renderProbeScript({ tenantA: 'fc-a-1', tenantB: 'fc-b-1', partition: "p'; rm" }), /facility name/);
});

const SH = spawnSync('sh', ['-c', 'command -v curl >/dev/null 2>&1 && echo ok']).stdout?.toString().trim() === 'ok';

/** Two engines on loopback. `denyWriterOnA` simulates a PDP that refuses the writer. */
function engines({ denyWriterOnA = false, leak = false } = {}) {
  const mk = (tenant) => new Promise((r) => {
    const srv = createServer((req, res) => {
      const send = (c, h = {}, b = '') => { res.writeHead(c, h); res.end(b); };
      if (req.url.endsWith('/metadata')) return send(200, {}, '{}');
      const auth = req.headers.authorization ?? '';
      if (!auth) return send(401);
      const [who, role] = auth.slice(7).split('|');
      if (who !== tenant && !leak) return send(403);
      if (req.method === 'POST') return role === 'w' && !(denyWriterOnA && tenant === 'A') ? send(201, { location: 'http://x/fhir/probe-site/Patient/77/_history/1' }, '{}') : send(403);
      if (req.url.includes('Patient/77')) return send(200, {}, '{"resourceType":"Patient","id":"77"}'); // no trailing newline, as HAPI sends it
      return send(200, {}, '{"resourceType":"Bundle"}');
    }).listen(0, '127.0.0.1', () => r(srv));
  });
  return Promise.all([mk('A'), mk('B')]);
}

async function runScript(opts) {
  const [a, b] = await engines(opts);
  const dir = mkdtempSync(join(tmpdir(), 'fcp-sh-'));
  try {
    let s = renderProbeScript({ tenantA: 'fc-a-1', tenantB: 'fc-b-1', partition: 'probe-site', retrySeconds: 0 });
    s = s.replace(engineBase('fc-a-1'), `http://127.0.0.1:${a.address().port}/fhir`).replace(engineBase('fc-b-1'), `http://127.0.0.1:${b.address().port}/fhir`);
    writeFileSync(join(dir, 'probe.sh'), s);
    writeFileSync(join(dir, 'hdrA'), 'Authorization: Bearer A|w\n');
    writeFileSync(join(dir, 'hdrB'), 'Authorization: Bearer B|r\n');
    const r = await new Promise((resolve) => {
      import('node:child_process').then(({ spawn }) => {
        const p = spawn('sh', ['probe.sh'], { cwd: dir });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.on('close', (code) => resolve({ code, out }));
      });
    });
    return r;
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('the generated script runs under sh+curl against two loopback engines: a correct system passes all seven steps, and ONLY PROBE lines are printed', { skip: !SH && 'sh or curl is not available' }, async () => {
  const r = await runScript({});
  assert.equal(r.code, 0);
  assert.ok(r.out.split('\n').filter(Boolean).every((l) => l.startsWith('PROBE ')), r.out);
  assert.equal(r.out.includes('Bearer'), false);
  const v = judge(parseProbeLogs(r.out));
  assert.deepEqual(v.results.map((x) => x.verdict), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass'], r.out);
  assert.equal(parseProbeLogs(r.out).steps.c.id, '77');
});

test('under sh+curl, a writer the engine REFUSES fails (c) and a leaky engine fails (e) (breaks if the script reports the wrong code for either)', { skip: !SH && 'sh or curl is not available' }, async () => {
  const denied = judge(parseProbeLogs((await runScript({ denyWriterOnA: true })).out));
  assert.equal(denied.results.find((x) => x.step === 'c').verdict, 'fail');
  assert.equal(denied.code, 1);
  const leaky = judge(parseProbeLogs((await runScript({ leak: true })).out));
  assert.equal(leaky.results.find((x) => x.step === 'e').verdict, 'fail');
  assert.equal(leaky.code, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// phaseProbe: tokens in files, never on a command line or in output

const probeCfg = (over = {}) => ({ cpUrl: 'https://cp.example.test', cpToken: CP_TOKEN, stamp: 'dev01', a: 'fc-a-1', b: 'fc-b-1', partition: 'probe-site',
  issuerPath: '/auth', aksRg: 'rg-x', aksName: 'aks-lhds-dev01', aksSub: '', retryS: 0, ...over });

test('phaseProbe: tokens go ONLY into 0600 files (writer for A, reader for B), never into az args; stdout carries step lines and no token; the temp dir is deleted; both clients disabled', async () => {
  const cp = cpFake();
  const root = mkdtempSync(join(tmpdir(), 'fcp-root-'));
  const seen = {};
  const exec = async (cmd, args, o) => {
    seen.cmd = cmd; seen.args = args; seen.cwd = o.cwd;
    seen.files = readdirSync(o.cwd).sort();
    seen.hdrA = readFileSync(join(o.cwd, 'hdrA'), 'utf8');
    seen.hdrB = readFileSync(join(o.cwd, 'hdrB'), 'utf8');
    seen.script = readFileSync(join(o.cwd, 'probe.sh'), 'utf8');
    if (process.platform !== 'win32') seen.modes = ['hdrA', 'hdrB', 'probe.sh'].map((f) => (statSync(join(o.cwd, f)).mode & 0o777).toString(8));
    // A pod that misbehaves and echoes the writer token: it must still never reach stdout.
    return { code: 0, stdout: JSON.stringify({ exitCode: 0, logs: `${ALL_OK}\n${seen.hdrA}` }), stderr: '' };
  };
  try {
    const r = await capture(() => phaseProbe(probeCfg(), { ...cp.deps, exec, tmpRoot: root, out: undefined }));
    assert.equal(r.code, 0, r.text);
    const tokA = /Bearer (\S+)/.exec(seen.hdrA)[1];
    const tokB = /Bearer (\S+)/.exec(seen.hdrB)[1];
    // A swapped pair is the defect this catches: hdrA must carry tenant A's token, hdrB tenant B's.
    assert.equal(JSON.parse(Buffer.from(tokA.split('.')[1], 'base64url')).tenant, 'fc-a-1');
    assert.equal(JSON.parse(Buffer.from(tokB.split('.')[1], 'base64url')).tenant, 'fc-b-1');
    assert.deepEqual(cp.st.regs.map((x) => [x.tenant, x.roleIds[0], x.allowedScopes[0]]), [['fc-a-1', 'fhir-data-writer', 'system/*.cruds'], ['fc-b-1', 'fhir-data-reader', 'system/*.rs']]);
    assert.deepEqual(seen.files, ['hdrA', 'hdrB', 'probe.sh']);
    assert.deepEqual(seen.args.filter((x) => x === '--file').length, 3);
    assert.equal(seen.args.join(' ').includes(tokA) || seen.args.join(' ').includes(tokB) || /Bearer/.test(seen.args.join(' ')), false, 'a token reached the az command line');
    assert.equal(seen.script.includes(SIG), false);
    if (seen.modes) assert.deepEqual(seen.modes, ['600', '600', '600']);
    // output: positive (step lines present) PAIRED with the absence of every secret
    assert.match(r.text, /step a PASS expect=200 got=200/);
    assert.match(r.text, /step e PASS expect=403 got=403/);
    assert.match(r.text, /VERDICT PASS/);
    for (const secret of [tokA, tokB, CP_TOKEN, SIG]) assert.equal(r.text.includes(secret), false, `a secret reached stdout: ${secret.slice(0, 12)}`);
    assert.equal(existsSync(seen.cwd), false, 'the temp dir was not deleted');
    assert.equal(cp.st.patches.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('phaseProbe: an az failure whose stderr carries a token is UNMEASURED exit 2, scrubbed, and the temp dir is still deleted (breaks if stderr is printed raw)', async () => {
  const cp = cpFake();
  const root = mkdtempSync(join(tmpdir(), 'fcp-root-'));
  let cwd; let tokA;
  const exec = async (cmd, args, o) => { cwd = o.cwd; tokA = /Bearer (\S+)/.exec(readFileSync(join(o.cwd, 'hdrA'), 'utf8'))[1]; return { code: 1, stdout: '', stderr: `ERROR: bad request near Authorization: Bearer ${tokA}` }; };
  try {
    const r = await capture(() => phaseProbe(probeCfg(), { ...cp.deps, exec, tmpRoot: root }));
    assert.equal(r.code, 2, r.text);
    assert.match(r.text, /UNMEASURED: az aks command invoke exited 1/);
    assert.equal(r.text.includes(tokA), false);
    assert.equal(existsSync(cwd), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('phaseProbe: a token whose scope is not exactly what was asked (a reader that came back with cruds) stops the run with exit 1 and az is never called (breaks if the grant is not checked)', async () => {
  const cp = cpFake({ scopeFor: (tenant, asked) => (tenant === 'fc-b-1' ? 'system/*.cruds' : asked) });
  let called = false;
  const r = await capture(() => phaseProbe(probeCfg(), { ...cp.deps, exec: async () => { called = true; return { code: 0, stdout: '{}', stderr: '' }; } }));
  assert.equal(r.code, 1, r.text);
  assert.equal(called, false);
  assert.match(r.text, /reader tenant=fc-b-1 scope_is_exactly_requested=false/);
  assert.equal(cp.st.patches.length, 2, 'clients must still be disabled');
});

// ---------------------------------------------------------------------------------------------------------------------
// phaseCreate and phaseCleanup

const ownFile = () => join(mkdtempSync(join(tmpdir(), 'fcp-own-')), 'owned.txt');
const crudCfg = (file, over = {}) => ({ cpUrl: 'https://cp.example.test', cpToken: CP_TOKEN, stamp: 'dev01', a: 'fc-a-1', b: 'fc-b-1', partition: 'probe-site',
  issuerPath: '/auth', timeoutS: 5, ownedFile: file, outputsFile: `${file}.out`, ...over });

test('phaseCreate: both tenant.create jobs are submitted before any fhir-tenant.create, each fhir-tenant.create carries the partition, and the outputs are the non-secret owned slugs + issuer', async () => {
  const cp = cpFake();
  const file = ownFile();
  const r = await capture((out) => phaseCreate(crudCfg(file), { ...cp.deps, out }));
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(cp.st.jobs.map((j) => `${j.kind}:${j.subjectId}`), ['tenant.create:fc-a-1', 'tenant.create:fc-b-1', 'fhir-tenant.create:fc-a-1', 'fhir-tenant.create:fc-b-1']);
  assert.deepEqual(cp.st.jobs[2].input, { partitions: ['probe-site'] });
  const outs = readFileSync(`${file}.out`, 'utf8');
  assert.match(outs, /^issuer_url=https:\/\/issuer-front-door\.example\.test\/auth$/m);
  assert.match(outs, /^owned=fc-a-1,fc-b-1$/m);
  assert.equal(outs.includes(CP_TOKEN), false);
  assert.match(r.text, /both fhir-tenant\.create jobs succeeded/);
});

test('phaseCreate: a failed fhir-tenant.create is exit 1, prints the job state, and STILL publishes the owned slugs so cleanup can destroy them (breaks if the owned output is only written on success)', async () => {
  const cp = cpFake({ jobState: (b) => (b.kind === 'fhir-tenant.create' ? 'failed' : 'succeeded') });
  const file = ownFile();
  const r = await capture((out) => phaseCreate(crudCfg(file), { ...cp.deps, out }));
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /fhir-tenant\.create for fc-a-1 is failed/);
  assert.match(readFileSync(`${file}.out`, 'utf8'), /^owned=fc-a-1,fc-b-1$/m);
});

test('phaseCreate: a 409 on tenant A fails the run and A is NEVER recorded as owned (breaks if a pre-existing tenant is adopted)', async () => {
  const cp = cpFake({ tenantStatus: { 'fc-a-1': 409 } });
  const file = ownFile();
  const r = await capture((out) => phaseCreate(crudCfg(file), { ...cp.deps, out }));
  assert.equal(r.code, 1);
  assert.match(r.text, /COLLISION: tenant fc-a-1 already exists/);
  assert.match(readFileSync(`${file}.out`, 'utf8'), /^owned=$/m);
  assert.equal(cp.st.jobs.length, 0);
});

test('phaseCleanup: destroys then tears down ONLY the owned tenant; the un-owned sibling gets neither (breaks on a cleanup that destroys every tenant named on the command line)', async () => {
  const cp = cpFake();
  const file = ownFile();
  writeFileSync(file, 'fc-a-1\n'); // fc-b-1 is deliberately NOT owned
  const r = await capture((out) => phaseCleanup(crudCfg(file), { ...cp.deps, out, destroyDeps: { fetchImpl: cp.fetchImpl, sleep: async () => {}, out: () => {} } }));
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(cp.st.jobs.map((j) => `${j.kind}:${j.subjectId}`), ['tenant.destroy:fc-a-1', 'fhir-tenant.teardown:fc-a-1']);
  assert.deepEqual(cp.st.jobs[1].input, { confirmTenantId: 'fc-a-1' });
  assert.match(r.text, /tenant fc-b-1 was not created by this run \(no ownership record\): NOT destroying it/);
});

test('phaseCleanup: positive control, both owned tenants are destroyed and torn down, destroy BEFORE teardown (breaks if teardown is submitted first: it refuses unless the tenant is destroying)', async () => {
  const cp = cpFake();
  const file = ownFile();
  writeFileSync(file, 'fc-a-1\nfc-b-1\n');
  const r = await capture((out) => phaseCleanup(crudCfg(file), { ...cp.deps, out, destroyDeps: { fetchImpl: cp.fetchImpl, sleep: async () => {}, out: () => {} } }));
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(cp.st.jobs.map((j) => j.kind), ['tenant.destroy', 'fhir-tenant.teardown', 'tenant.destroy', 'fhir-tenant.teardown']);
});

test('phaseCleanup: a teardown that FAILS makes cleanup exit 1 and says the engine may be leaked (breaks if a failed teardown is swallowed)', async () => {
  const cp = cpFake({ jobState: (b) => (b.kind === 'fhir-tenant.teardown' ? 'failed' : 'succeeded') });
  const file = ownFile();
  writeFileSync(file, 'fc-a-1\n');
  const r = await capture((out) => phaseCleanup(crudCfg(file), { ...cp.deps, out, destroyDeps: { fetchImpl: cp.fetchImpl, sleep: async () => {}, out: () => {} } }));
  assert.equal(r.code, 1);
  assert.match(r.text, /may be LEAKED/);
});

test('phaseCleanup: only fc- clients of owned tenants are disabled (breaks if an ep- client or an un-owned tenant client is touched)', async () => {
  const cp = cpFake();
  cp.st.clients.set('fc-fc-a-1-aa', { clientId: 'fc-fc-a-1-aa', tenant: 'fc-a-1', status: 'active' });
  cp.st.clients.set('ep-fc-a-1-bb', { clientId: 'ep-fc-a-1-bb', tenant: 'fc-a-1', status: 'active' });
  cp.st.clients.set('fc-fc-b-1-cc', { clientId: 'fc-fc-b-1-cc', tenant: 'fc-b-1', status: 'active' });
  const file = ownFile();
  writeFileSync(file, 'fc-a-1\n');
  await capture((out) => phaseCleanup(crudCfg(file), { ...cp.deps, out, destroyDeps: { fetchImpl: cp.fetchImpl, sleep: async () => {}, out: () => {} } }));
  assert.deepEqual(cp.st.patches, ['fc-fc-a-1-aa']);
});

test('validate: a tenant pair that is not distinct slugs, the reserved partition, and a missing aks target are refused before any call', () => {
  const ok = { ...parseArgs(['--phase', 'probe', '--cp-url', 'https://cp.example.test', '--stamp', 'dev01', '--tenant-a', 'fc-a-1', '--tenant-b', 'fc-b-1', '--aks-rg', 'rg-x', '--aks-name', 'aks-lhds-dev01'], { LHDS_CP_TOKEN: CP_TOKEN }) };
  assert.equal(validate(ok), null);
  assert.match(validate({ ...ok, b: 'fc-a-1' }), /distinct/);
  assert.match(validate({ ...ok, partition: 'default' }), /facility name/);
  assert.match(validate({ ...ok, aksRg: '' }), /aks-rg/);
  assert.match(validate({ ...ok, cpToken: '' }), /bearer/);
});

// ---------------------------------------------------------------------------------------------------------------------
// review should-fixes

test('phaseCreate: the owned slug is in the outputs file BEFORE the waits, so a wait that throws (cancel / lost runner) still leaves it (breaks if ownership is emitted only in a finally)', async () => {
  const cp = cpFake({ jobState: () => 'queued' });
  const file = ownFile();
  // The snapshot is taken INSIDE the first wait, i.e. before any finally could have run.
  let snap;
  const sleep = async () => { snap = readFileSync(`${file}.out`, 'utf8'); throw new Error('runner lost'); };
  await assert.rejects(() => phaseCreate(crudCfg(file), { ...cp.deps, sleep, out: () => {} }), /runner lost/);
  assert.match(snap, /^owned=fc-a-1,fc-b-1$/m);
});

test('phaseCreate: after only the FIRST 201 the output already holds that slug and not the second (cumulative emit; breaks if nothing is written until both exist)', async () => {
  const cp = cpFake({ tenantStatus: { 'fc-b-1': 500 } });
  const file = ownFile();
  const r = await capture((out) => phaseCreate(crudCfg(file), { ...cp.deps, out }));
  assert.equal(r.code, 1);
  assert.match(readFileSync(`${file}.out`, 'utf8'), /^owned=fc-a-1$/m);
});

test('judge: (e) 403 with a FAILED f_ctrl is NOT a pass even though c and d passed (breaks if e ignores engine-B admission: 403 could mean B is not homed)', () => {
  const v = verdictOf(swap(ALL_OK, 'PROBE step=f_ctrl status=200', 'PROBE step=f_ctrl status=403'));
  assert.equal(v.c, 'pass');
  assert.equal(v.d, 'pass');
  assert.equal(v.f_ctrl, 'fail');
  assert.equal(v.e, 'unmeasured');
  assert.equal(verdictOf(ALL_OK).e, 'pass'); // positive control: all three controls passing still passes e
});

test('mint: a hyphenated clientPrefix (accepted by the CLI before) still mints, and an over-long or hyphen-edged one is refused (breaks if the prefix regex excludes hyphens)', async () => {
  const cp = cpFake();
  const m = await mintTenantToken({ ...cp.deps, cpUrl: 'https://cp.example.test', cpToken: CP_TOKEN, tenant: 'ten-a', issuerPath: '/auth', clientPrefix: 'edge-probe' });
  assert.match(m.clientId, /^edge-probe-ten-a-[0-9a-f]{8}$/);
  assert.ok(m.clientId.length <= 64);
  for (const bad of ['-x', 'x-', 'a'.repeat(21), 'Up', 'a b']) {
    await assert.rejects(() => mintTenantToken({ ...cpFake().deps, cpUrl: 'https://cp.example.test', cpToken: CP_TOKEN, tenant: 'ten-a', clientPrefix: bad }), /clientPrefix/, bad);
  }
});
