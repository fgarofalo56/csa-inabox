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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
const posixPath = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
import { mintTenantToken } from '../../measure/health/mint-tenant-token.mjs';
import {
  EXPECT, ENGINE_NAMESPACE, SERVICE_PORT, engineBase, judge, parseProbeLogs, phaseCleanup, phaseCreate, phaseProbe,
  renderProbeScript, validate, parseArgs, workloadName, RESULT_MAX_POLLS, RESULT_POLL_MS,
  judgeEngineImage, IMAGE_UNREADABLE, ENGINE_CONTAINER, enginePodSelector, IMAGE_REF_RE,
} from '../../measure/health/lhds-fhir-crud-probe-run.mjs';

const ISSUER = 'https://issuer-front-door.example.test/auth';
const CP_TOKEN = ['cp', 'bearer', 'sentinel'].join('-');
const SIG = ['access', 'signature', 'sentinel'].join('-');
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const ROOT = new URL('../../../', import.meta.url);
const src = (p) => readFileSync(new URL(p, ROOT), 'utf8');

/** In-memory control plane: discovery, client registry, token endpoint, tenants and jobs. No network. */
function cpFake(opts = {}) {
  const st = { regs: [], forms: [], patches: [], jobs: [], tenantPosts: [], clients: new Map(), gets: [], byId: new Map() };
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
      const id = `job-${String(st.jobs.length).padStart(32, '0')}`;
      // tenant.create carries the receipt the probe reads to find the CHAINED engine job (default: chained to job-<'e'*32>); opts.createReceipts overrides.
      const receipts = b.kind === 'tenant.create' ? (opts.createReceipts ?? [{ step: 'engine.chained', detail: `fhir-tenant.create job=job-${'e'.repeat(32)} created=true` }]) : [];
      st.byId.set(id, { id, state, receipts });
      return res(202, { ok: true, data: { id, state, receipts } });
    }
    const jm = /^\/api\/health\/jobs\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && jm) {
      if (jm[1] === `job-${'e'.repeat(32)}`) return res(200, { ok: true, data: { id: jm[1], state: opts.engineState ?? 'succeeded', receipts: [], ...(opts.engineState === 'failed' ? { error: { code: 'readback_mismatch', message: 'x' } } : {}) } });
      const j = st.byId.get(jm[1]);
      return j ? res(200, { ok: true, data: j }) : res(404, { ok: false });
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
  'PROBE step=g status=201 id=88 bare=yes', 'PROBE step=h status=200 id_match=yes', 'PROBE step=i status=404',
  // #5439: what each probed engine pod runs (the in-cluster script prints these before step a; judge() ignores them).
  `PROBE engine_image tenant=fc-a-1 digest=sha256:${'1'.repeat(64)}`, `PROBE engine_image tenant=fc-b-1 digest=sha256:${'1'.repeat(64)}`,
].join('\n');
const RUN_D = `sha256:${'1'.repeat(64)}`;
const OTHER_D = `sha256:${'2'.repeat(64)}`;
const verdictOf = (logs) => Object.fromEntries(judge(parseProbeLogs(logs)).results.map((r) => [r.step, r.verdict]));
const swap = (logs, from, to) => { assert.ok(logs.includes(from), `fixture drift: ${from} is not in the fixture`); return logs.replace(from, to); };

test('judge: the all-correct fixture passes every step and exits 0 (positive control: breaks if a correct run is reported as a failure)', () => {
  const v = judge(parseProbeLogs(ALL_OK));
  assert.deepEqual(v.results.map((r) => `${r.step}:${r.verdict}`),
    ['a:pass', 'b:pass', 'c:pass', 'd:pass', 'e:pass', 'f_ctrl:pass', 'f:pass', 'g:pass', 'h:pass', 'i:pass']);
  assert.equal(v.code, 0);
});

test('judge: EXPECT is a:200 b:401 c:201 d:200 e:403 f_ctrl:200 f:403 g:201 h:200 i:404 (breaks if any expected code is edited)', () => {
  assert.deepEqual({ ...EXPECT }, { a: 200, b: 401, c: 201, d: 200, e: 403, f_ctrl: 200, f: 403, g: 201, h: 200, i: 404 });
});

// #5489 bare-base steps. Each names the value that breaks it.
test('judge: (g) the #5489 defect (400 on the bare-base create) FAILS and names #5489; (h) and (i) are then not passes (breaks if a 400/404 at the bare base is unmeasured or a pass)', () => {
  const logs = swap(swap(ALL_OK, 'PROBE step=g status=201 id=88 bare=yes', 'PROBE step=g status=400 bare=no'), 'PROBE step=h status=200 id_match=yes\n', '');
  const v = judge(parseProbeLogs(logs));
  const g = v.results.find((r) => r.step === 'g');
  assert.equal(g.verdict, 'fail');
  assert.match(g.note, /#5489/);
  assert.equal(verdictOf(logs).h, 'unmeasured');
  assert.equal(verdictOf(logs).i, 'unmeasured'); // its 404 is what the defect produces for EVERY bare-base read
  assert.equal(v.code, 1);
  assert.equal(verdictOf(swap(ALL_OK, 'PROBE step=g status=201 id=88 bare=yes', 'PROBE step=g status=404 bare=no')).g, 'fail');
});

test('judge: (g) 201 whose Location carries a partition segment (bare=no) FAILS; 201 with no id FAILS (breaks if the Location shape is not checked)', () => {
  const v = judge(parseProbeLogs(swap(ALL_OK, 'bare=yes', 'bare=no')));
  assert.equal(v.results.find((r) => r.step === 'g').verdict, 'fail');
  assert.match(v.results.find((r) => r.step === 'g').note, /partition segment/);
  assert.equal(verdictOf(swap(ALL_OK, 'PROBE step=g status=201 id=88 bare=yes', 'PROBE step=g status=201 bare=yes')).g, 'fail');
  assert.equal(parseProbeLogs(ALL_OK).steps.g.bare, true); // positive: the parser reads bare=yes as true
});

test('judge: (g) 403 is a FAIL once (c) admitted the same writer, and UNMEASURED when (c) did not pass (breaks if a tenant-wide deny is blamed on the bare base)', () => {
  assert.equal(verdictOf(swap(ALL_OK, 'PROBE step=g status=201 id=88 bare=yes', 'PROBE step=g status=403 bare=no')).g, 'fail');
  const noC = swap(swap(ALL_OK, 'PROBE step=c status=201 id=77', 'PROBE step=c status=403'), 'PROBE step=g status=201 id=88 bare=yes', 'PROBE step=g status=403 bare=no');
  assert.equal(verdictOf(noC).g, 'unmeasured');
});

test('judge: (h) needs 200 AND the created id (breaks if a 200 with another Patient, or a 404, passes)', () => {
  assert.equal(verdictOf(swap(ALL_OK, 'PROBE step=h status=200 id_match=yes', 'PROBE step=h status=200 id_match=no')).h, 'fail');
  assert.equal(verdictOf(swap(ALL_OK, 'PROBE step=h status=200 id_match=yes', 'PROBE step=h status=404 id_match=no')).h, 'fail');
});

test('judge: (i) a 200 for the facility Patient at the bare base is a PARTITION LEAK; its 404 is evidence only after (d) and (h) passed (breaks if i accepts any 2xx or credits a 404 from a broken bare base)', () => {
  const leak = judge(parseProbeLogs(swap(ALL_OK, 'PROBE step=i status=404', 'PROBE step=i status=200')));
  assert.equal(leak.results.find((r) => r.step === 'i').verdict, 'fail');
  assert.match(leak.results.find((r) => r.step === 'i').note, /LEAK/);
  assert.equal(leak.code, 1);
  assert.equal(verdictOf(swap(ALL_OK, 'PROBE step=h status=200 id_match=yes', 'PROBE step=h status=200 id_match=no')).i, 'unmeasured');
  assert.equal(verdictOf(swap(ALL_OK, 'PROBE step=d status=200 id_match=yes', 'PROBE step=d status=200 id_match=no')).i, 'unmeasured');
  assert.equal(verdictOf(swap(ALL_OK, 'PROBE step=i status=404', 'PROBE step=i status=400')).i, 'fail');
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

/**
 * Two engines on loopback. `denyWriterOnA` simulates a PDP that refuses the writer. The bare base (/fhir/Patient...) is
 * the DEFAULT partition: its create is Patient 88, and the facility Patient 77 is 404 there. `bareDefect` answers the bare
 * base the way HAPI's own strategy did (#5489: POST 400, GET 404); `defaultLeak` serves the facility Patient at the bare base.
 */
function engines({ denyWriterOnA = false, leak = false, bareDefect = false, defaultLeak = false, locDefault = false } = {}) {
  const mk = (tenant) => new Promise((r) => {
    const srv = createServer((req, res) => {
      const send = (c, h = {}, b = '') => { res.writeHead(c, h); res.end(b); };
      if (req.url.endsWith('/metadata')) return send(200, {}, '{}');
      const auth = req.headers.authorization ?? '';
      if (!auth) return send(401);
      const [who, role] = auth.slice(7).split('|');
      if (who !== tenant && !leak) return send(403);
      if (req.url.startsWith('/fhir/Patient')) {
        if (bareDefect) return send(req.method === 'POST' ? 400 : 404);
        if (req.method === 'POST') return role === 'w' && !(denyWriterOnA && tenant === 'A') ? send(201, { location: `http://x/fhir/${locDefault ? 'DEFAULT/' : ''}Patient/88/_history/1` }, '{}') : send(403);
        if (req.url.includes('Patient/88')) return send(200, {}, '{"resourceType":"Patient","id":"88"}');
        if (req.url.includes('Patient/77')) return defaultLeak ? send(200, {}, '{"resourceType":"Patient","id":"77"}') : send(404);
        return send(200, {}, '{"resourceType":"Bundle"}');
      }
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
    // A STUB kubectl first on PATH (a workstation may have a real one pointed at a real cluster). Default: each engine runs RUN_D.
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'kubectl'), `#!/bin/sh\necho "$*" >> "${posixPath(dir)}/kubectl.log"\n${opts.kubectl ?? `printf 'acrx.azurecr.io/loom-health-fhir@${RUN_D}\\n'`}\n`);
    chmodSync(join(dir, 'bin', 'kubectl'), 0o755);
    const r = await new Promise((resolve) => {
      import('node:child_process').then(({ spawn }) => {
        const p = spawn('sh', ['probe.sh'], { cwd: dir, env: { ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}` } });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.on('close', (code) => resolve({ code, out }));
      });
    });
    return { ...r, kubectl: existsSync(join(dir, 'kubectl.log')) ? readFileSync(join(dir, 'kubectl.log'), 'utf8') : '' };
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('the generated script runs under sh+curl against two loopback engines: a correct system passes all ten steps, and ONLY PROBE lines are printed', { skip: !SH && 'sh or curl is not available' }, async () => {
  const r = await runScript({});
  assert.equal(r.code, 0);
  assert.ok(r.out.split('\n').filter(Boolean).every((l) => l.startsWith('PROBE ')), r.out);
  assert.equal(r.out.includes('Bearer'), false);
  const v = judge(parseProbeLogs(r.out));
  assert.deepEqual(v.results.map((x) => `${x.step}:${x.verdict}`),
    ['a:pass', 'b:pass', 'c:pass', 'd:pass', 'e:pass', 'f_ctrl:pass', 'f:pass', 'g:pass', 'h:pass', 'i:pass'], r.out);
  assert.equal(parseProbeLogs(r.out).steps.c.id, '77');
  assert.equal(parseProbeLogs(r.out).steps.g.id, '88');
  assert.equal(parseProbeLogs(r.out).steps.g.bare, true);
});

test('under sh+curl, an engine with the #5489 defect fails (g) and a DEFAULT that serves the facility Patient fails (i); (a)..(f) are unchanged (breaks if the script misreads either)', { skip: !SH && 'sh or curl is not available' }, async () => {
  const defect = judge(parseProbeLogs((await runScript({ bareDefect: true })).out));
  assert.deepEqual(defect.results.map((x) => `${x.step}:${x.verdict}`),
    ['a:pass', 'b:pass', 'c:pass', 'd:pass', 'e:pass', 'f_ctrl:pass', 'f:pass', 'g:fail', 'h:unmeasured', 'i:unmeasured']);
  assert.equal(defect.code, 1);
  const leaky = judge(parseProbeLogs((await runScript({ defaultLeak: true })).out));
  assert.equal(leaky.results.find((x) => x.step === 'i').verdict, 'fail');
  assert.equal(leaky.results.find((x) => x.step === 'g').verdict, 'pass');
  assert.equal(leaky.code, 1);
  // A create whose Location gained /DEFAULT (massageServerBaseUrl appending the partition) is read as bare=no by the script.
  const loc = (await runScript({ locDefault: true })).out;
  assert.match(loc, /^PROBE step=g status=201 id=88 bare=no$/m);
  assert.equal(judge(parseProbeLogs(loc)).results.find((x) => x.step === 'g').verdict, 'fail');
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

// az stops waiting at ~300 s and returns the IN-FLIGHT result with exit 0 (measured 2026-11-23; B3 run 45142805007).
test('phaseProbe: a Running invoke is polled with `az aks command result --command-id` until terminal, and its logs are judged (breaks if Running is read as "no logs")', async () => {
  const cp = cpFake();
  const root = mkdtempSync(join(tmpdir(), 'fcp-root-'));
  const calls = [];
  const sleeps = [];
  const exec = async (cmd, args) => {
    calls.push(args.slice(0, 3).join(' '));
    if (args[2] === 'invoke') return { code: 0, stdout: JSON.stringify({ id: 'abc123def4567890', provisioningState: 'Running', exitCode: null, logs: null }), stderr: '' };
    return { code: 0, stdout: JSON.stringify({ id: 'abc123def4567890', provisioningState: calls.length < 3 ? 'Running' : 'Succeeded', exitCode: 0, logs: calls.length < 3 ? null : ALL_OK }), stderr: '' };
  };
  try {
    const r = await capture(() => phaseProbe(probeCfg(), { ...cp.deps, exec, sleep: async (ms) => { sleeps.push(ms); }, tmpRoot: root }));
    // The old code stopped at the first answer: exit 2, UNMEASURED, and exactly 1 az call.
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /step c PASS expect=201 got=201/);
    assert.deepEqual(calls, ['aks command invoke', 'aks command result', 'aks command result']);
    assert.deepEqual(sleeps, [RESULT_POLL_MS, RESULT_POLL_MS]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('phaseProbe: a poll answer that is not JSON is reported as unparseable, never as the previous poll\'s state, and nothing is judged (breaks if stale state or logs survive the bad answer)', async () => {
  const cp = cpFake();
  const root = mkdtempSync(join(tmpdir(), 'fcp-root-'));
  const exec = async (cmd, args) => (args[2] === 'invoke'
    // The in-flight answer carries partial logs on purpose: a stale value would be judged as final.
    ? { code: 0, stdout: JSON.stringify({ id: 'abc123def4567890', provisioningState: 'Running', exitCode: null, logs: ALL_OK }), stderr: '' }
    : { code: 0, stdout: 'not json at all', stderr: '' });
  try {
    const r = await capture(() => phaseProbe(probeCfg(), { ...cp.deps, exec, sleep: async () => {}, tmpRoot: root }));
    assert.equal(r.code, 2, r.text);
    assert.match(r.text, /UNMEASURED: az aks command result returned no pod logs \(state=unparseable exitCode=none\)/);
    // Paired: the stale in-flight logs were NOT judged (no step verdict lines at all).
    assert.doesNotMatch(r.text, /step c (PASS|FAIL)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('phaseProbe: a command that never finishes is polled a BOUNDED number of times, then UNMEASURED naming the state ARM reported (breaks if it loops forever or claims "no logs" blind)', async () => {
  const cp = cpFake();
  const root = mkdtempSync(join(tmpdir(), 'fcp-root-'));
  let results = 0;
  const exec = async (cmd, args) => {
    if (args[2] === 'result') results += 1;
    return { code: 0, stdout: JSON.stringify({ id: 'abc123def4567890', provisioningState: 'Running', exitCode: null, logs: null }), stderr: '' };
  };
  try {
    const r = await capture(() => phaseProbe(probeCfg(), { ...cp.deps, exec, sleep: async () => {}, tmpRoot: root }));
    assert.equal(r.code, 2, r.text);
    assert.equal(results, RESULT_MAX_POLLS);
    // Names the subcommand whose answer it read (result, after polling) and the state ARM reported.
    assert.match(r.text, /UNMEASURED: az aks command result returned no pod logs \(state=Running exitCode=none\)/);
    assert.match(r.text, /VERDICT UNMEASURED/);
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

test('phaseCreate: both tenant.create jobs are submitted first; the probe submits NO fhir-tenant.create of its own, waits on the chained engine job, then adds the partition with configure; outputs are the non-secret owned slugs + issuer', async () => {
  const cp = cpFake();
  const file = ownFile();
  const r = await capture((out) => phaseCreate(crudCfg(file), { ...cp.deps, out }));
  assert.equal(r.code, 0, r.text);
  // Breaks if the probe submits its own fhir-tenant.create again (the live race, run 45312157616): that kind would appear here.
  assert.deepEqual(cp.st.jobs.map((j) => `${j.kind}:${j.subjectId}`), ['tenant.create:fc-a-1', 'tenant.create:fc-b-1', 'fhir-tenant.configure:fc-a-1', 'fhir-tenant.configure:fc-b-1']);
  assert.deepEqual(cp.st.jobs[2].input, { partitions: ['probe-site'] });
  const outs = readFileSync(`${file}.out`, 'utf8');
  assert.match(outs, /^issuer_url=https:\/\/issuer-front-door\.example\.test\/auth$/m);
  assert.match(outs, /^owned=fc-a-1,fc-b-1$/m);
  assert.equal(outs.includes(CP_TOKEN), false);
  assert.match(r.text, /chained engine job=job-e{32}/);
  assert.match(r.text, /partition configure jobs succeeded/);
});

test('phaseCreate: a failed CHAINED engine job is exit 1, prints the job state, and STILL publishes the owned slugs so cleanup can destroy them (breaks if the owned output is only written on success)', async () => {
  const cp = cpFake({ engineState: 'failed' });
  const file = ownFile();
  const r = await capture((out) => phaseCreate(crudCfg(file), { ...cp.deps, out }));
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /fhir-tenant\.create for fc-a-1 failed: readback_mismatch/);
  assert.match(readFileSync(`${file}.out`, 'utf8'), /^owned=fc-a-1,fc-b-1$/m);
  assert.equal(cp.st.jobs.some((j) => j.kind === 'fhir-tenant.configure'), false, 'no partition job after a failed engine job');
});

test('phaseCreate: engine.not_chained fails the run with the receipt reason and submits nothing further (breaks if the probe falls back to its own fhir-tenant.create)', async () => {
  const cp = cpFake({ createReceipts: [{ step: 'engine.not_chained', detail: 'fhir-tenant.create was NOT submitted: no host and PDP url' }] });
  const file = ownFile();
  const r = await capture((out) => phaseCreate(crudCfg(file), { ...cp.deps, out }));
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /did NOT chain an engine: engine\.not_chained: fhir-tenant\.create was NOT submitted: no host and PDP url/);
  assert.deepEqual(cp.st.jobs.map((j) => j.kind), ['tenant.create', 'tenant.create']);
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

// ── #5439: the image each probed engine RUNS, against the control plane's pin ─────────────────────────────────────────

const PIN_OF = (d) => `acrx.azurecr.io/loom-health-fhir@${d}`;
const engineLines = (a, b) => [`PROBE engine_image tenant=fc-a-1 ${a}`, `PROBE engine_image tenant=fc-b-1 ${b}`].join('\n');
const withEngines = (a, b) => ALL_OK.split('\n').filter((l) => !l.startsWith('PROBE engine_image')).join('\n') + '\n' + engineLines(a, b);
const img = (logs, pin) => judgeEngineImage(parseProbeLogs(logs), { tenants: ['fc-a-1', 'fc-b-1'], pin });

test('engine image: every engine on the pinned digest PASSES; one engine on another digest FAILS naming "engine <t> runs <x>, pinned <y>"', () => {
  assert.equal(img(ALL_OK, PIN_OF(RUN_D)).verdict, 'pass');
  const stale = img(withEngines(`digest=${OTHER_D}`, `digest=${RUN_D}`), PIN_OF(RUN_D));
  // Breaks if the comparison is dropped (pass) or compares the repository/tag instead of the digest.
  assert.equal(stale.verdict, 'fail');
  assert.equal(stale.note.split('. ')[0], `engine fc-a-1 runs ${OTHER_D}, pinned ${RUN_D}`);
  // A pod mid-roll (old AND new digest on one engine) is still stale: breaks if only the first imageID per tenant is judged.
  const roll = img(`${withEngines(`digest=${RUN_D}`, `digest=${RUN_D}`)}\nPROBE engine_image tenant=fc-b-1 digest=${OTHER_D}`, PIN_OF(RUN_D));
  assert.equal(roll.verdict, 'fail');
  assert.match(roll.note, /^engine fc-b-1 runs sha256:2{64}, pinned sha256:1{64}/);
});

test('engine image: an unreadable imageID is UNMEASURED with the true reason, never PASS (and a missing line is unmeasured too)', () => {
  for (const [why, text] of Object.entries(IMAGE_UNREADABLE)) {
    const r = img(withEngines(`unreadable=${why}`, `digest=${RUN_D}`), PIN_OF(RUN_D));
    // Breaks if an engine whose image could not be read is credited with the pin (pass).
    assert.equal(r.verdict, 'unmeasured', why);
    assert.ok(r.note.includes(`engine fc-a-1: ${text}`), r.note);
  }
  const none = img(ALL_OK.split('\n').filter((l) => !l.includes('tenant=fc-b-1')).join('\n'), PIN_OF(RUN_D));
  assert.equal(none.verdict, 'unmeasured');
  assert.match(none.note, /engine fc-b-1: no engine_image line for this tenant/);
  // A stale engine is a FAIL even when the OTHER engine is unreadable (the established mismatch is the stronger fact).
  assert.equal(img(withEngines(`digest=${OTHER_D}`, 'unreadable=forbidden'), PIN_OF(RUN_D)).verdict, 'fail');
});

test('engine image: a TAG pin or no pin is REPORTED (digests printed, nothing judged); readable imageIDs are required even then', () => {
  const tag = img(ALL_OK, 'acrx.azurecr.io/loom-health-fhir:v0.1');
  assert.equal(tag.verdict, 'reported');
  assert.match(tag.note, /engines run fc-a-1=sha256:1{64} fc-b-1=sha256:1{64}; the control plane pin is acrx\.azurecr\.io\/loom-health-fhir:v0\.1, a tag, so whether that is the current build is NOT judged/);
  assert.equal(img(ALL_OK, '').verdict, 'reported');
  assert.equal(img(withEngines('unreadable=no_pod', `digest=${RUN_D}`), '').verdict, 'unmeasured');
});

test('engine image lines: only the exact shape is read (a free-text or short digest line is ignored, so it cannot satisfy the check)', () => {
  const p = parseProbeLogs([`PROBE engine_image tenant=fc-a-1 digest=sha256:${'1'.repeat(63)}`, 'PROBE engine_image tenant=fc-a-1 unreadable=because I said so',
    `PROBE engine_image tenant=fc-a-1 digest=${RUN_D} extra`, `PROBE engine_image tenant=fc-b-1 digest=${RUN_D}`].join('\n'));
  assert.equal(p.engines['fc-a-1'], undefined);
  assert.deepEqual(p.engines['fc-b-1'], { digests: [RUN_D], unreadable: [] });
});

// phaseProbe wiring: the engine image line comes first, a stale engine makes g's failure attributable, and the exit code follows it.
async function probeWith(logs, pin) {
  const cp = cpFake();
  const root = mkdtempSync(join(tmpdir(), 'fcp-img-'));
  const exec = async () => ({ code: 0, stdout: JSON.stringify({ exitCode: 0, logs, provisioningState: 'Succeeded' }), stderr: '' });
  try { return await capture(() => phaseProbe(probeCfg({ enginePin: pin }), { ...cp.deps, exec, tmpRoot: root, out: undefined })); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('phaseProbe: a stale engine (run 45744072036 shape: g 400) is a named engine_image FAIL, and g carries the attribution, exit 1', async () => {
  const g400 = withEngines(`digest=${OTHER_D}`, `digest=${OTHER_D}`).replace('PROBE step=g status=201 id=88 bare=yes', 'PROBE step=g status=400 bare=no');
  const r = await probeWith(g400, PIN_OF(RUN_D));
  assert.equal(r.code, 1, r.text);
  const lines = r.text.split('\n');
  const iImg = lines.findIndex((l) => l.includes('step engine_image FAIL'));
  const iG = lines.findIndex((l) => /step g FAIL/.test(l));
  // Breaks if the image verdict is missing, printed after the steps, or g reads as a bare failure (no attribution).
  assert.ok(iImg >= 0 && iImg < iG, r.text);
  assert.match(lines[iImg], new RegExp(`engine fc-a-1 runs ${OTHER_D}, pinned ${RUN_D}`));
  assert.match(lines[iG], /NOT attributable to the pinned build: engine fc-a-1 runs sha256:2{64}, pinned sha256:1{64}/);
  // a..f still print their own verdicts unchanged (they passed): no attribution suffix on a pass.
  assert.match(r.text, /step a PASS expect=200 got=200 \[GET \/fhir\/metadata, no token\]$/m);
});

test('phaseProbe: a stale engine FAILS the run (exit 1) even when every step a..i passes (breaks if the exit code ignores the engine image)', async () => {
  // All ten steps pass here, so the step verdicts alone give exit 0: only the engine_image verdict can make this 1.
  const r = await probeWith(withEngines(`digest=${RUN_D}`, `digest=${OTHER_D}`), PIN_OF(RUN_D));
  assert.equal(judge(parseProbeLogs(ALL_OK)).code, 0, 'fixture: steps a..i alone must be a pass');
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /step engine_image FAIL .*engine fc-b-1 runs sha256:2{64}, pinned sha256:1{64}/);
  assert.match(r.text, /VERDICT FAIL/);
});

test('phaseProbe: the pinned digest running everywhere is PASS exit 0; an unreadable imageID turns an all-pass run into UNMEASURED exit 2', async () => {
  const ok = await probeWith(ALL_OK, PIN_OF(RUN_D));
  assert.equal(ok.code, 0, ok.text);
  assert.match(ok.text, /step engine_image PASS pin=sha256:1{64}/);
  assert.match(ok.text, /VERDICT PASS/);
  const unread = await probeWith(withEngines('unreadable=forbidden', `digest=${RUN_D}`), PIN_OF(RUN_D));
  // Breaks if an unreadable image is ignored (exit 0, VERDICT PASS).
  assert.equal(unread.code, 2, unread.text);
  assert.match(unread.text, /step engine_image UNMEASURED .*kubectl answered Forbidden/);
  assert.match(unread.text, /VERDICT UNMEASURED/);
});

test('validate: an engine-image pin that is not an image reference is refused; a digest or tag reference is accepted', () => {
  const base = { phase: 'probe', cpToken: 't', a: 'fc-a-1', b: 'fc-b-1', stamp: 'dev01', partition: 'probe-site', timeoutS: 60, aksRg: 'rg-x', aksName: 'aks-lhds-dev01', aksSub: '', retryS: 0 };
  assert.equal(validate({ ...base, enginePin: PIN_OF(RUN_D) }), null);
  assert.equal(validate({ ...base, enginePin: 'acrx.azurecr.io/loom-health-fhir:v0.1' }), null);
  assert.equal(validate({ ...base, enginePin: '' }), null);
  assert.match(validate({ ...base, enginePin: "x'; rm -rf /" }), /engine-image-pin/);
  assert.match(validate({ ...base, enginePin: `acrx.azurecr.io/x@sha256:${'1'.repeat(63)}` }), /engine-image-pin/);
  assert.equal(parseArgs(['--engine-image-pin', PIN_OF(RUN_D)], {}).enginePin, PIN_OF(RUN_D));
  // The pattern is the control plane's own (fhir-engine-config.ts IMAGE), lifted, not retyped.
  const cfg = src('apps/loom-health-cp/src/jobs/fhir-engine-config.ts');
  assert.equal(/const IMAGE = (\/.*\/);/.exec(cfg)?.[1], IMAGE_REF_RE.toString());
});

test('the engine pod selector and container are the ones the control plane renders (lifted from fhir-engine-host.ts)', () => {
  const host = src('apps/loom-health-cp/src/jobs/fhir-engine-host.ts');
  assert.ok(host.includes("labels: { app: name, 'azure.workload.identity/use': 'true', 'loom.health/tenant': cfg.tenantId }"), 'the engine pod template labels changed; update enginePodSelector');
  assert.equal(/name: '([a-z]+)',\r?\n\s+image: o\.image,/.exec(host)?.[1], ENGINE_CONTAINER);
  assert.equal(enginePodSelector('fc-a-1'), 'app=fhir-fc-a-1,loom.health/tenant=fc-a-1');
  const s = renderProbeScript({ tenantA: 'fc-a-1', tenantB: 'fc-b-1', partition: 'probe-site' });
  // The script's own selector is the same shape (breaks if the rendered kubectl line drifts from enginePodSelector).
  assert.equal(s.includes(`-l "${enginePodSelector('$1')}"`), true);
  assert.ok(s.includes(`containerStatuses[?(@.name=="${ENGINE_CONTAINER}")]`));
});

test('under sh+curl with a stub kubectl: each engine prints its running digest, read from the hapi container of the tenant\'s pods', { skip: !SH && 'sh or curl is not available' }, async () => {
  const r = await runScript({});
  assert.equal(r.code, 0);
  assert.ok(r.out.split('\n').filter(Boolean).every((l) => l.startsWith('PROBE ')), r.out);
  const p = parseProbeLogs(r.out);
  assert.deepEqual(p.engines, { 'fc-a-1': { digests: [RUN_D], unreadable: [] }, 'fc-b-1': { digests: [RUN_D], unreadable: [] } });
  assert.match(r.kubectl, /get pods -n loom-health -l app=fhir-fc-a-1,loom\.health\/tenant=fc-a-1 -o jsonpath=/);
  // The steps a..i are unchanged by the new lines.
  assert.equal(judge(p).code, 0);
});

test('under sh+curl: kubectl Forbidden -> unreadable=forbidden; kubectl failing otherwise -> kubectl_failed; no imageID -> no_pod; a tag imageID -> no_digest; none of kubectl\'s text is printed', { skip: !SH && 'sh or curl is not available' }, async () => {
  const cases = {
    forbidden: 'echo \'Error from server (Forbidden): pods is forbidden: User "x" cannot list resource "pods"\' >&2; exit 1',
    kubectl_failed: "echo 'error: You must be logged in to the server (Unauthorized)' >&2; exit 1",
    no_pod: 'exit 0',
    no_digest: "printf 'acrx.azurecr.io/loom-health-fhir:v0.1\\n'",
  };
  for (const [why, body] of Object.entries(cases)) {
    const r = await runScript({ kubectl: body });
    const p = parseProbeLogs(r.out);
    // Breaks if any of these is reported as a digest, or if kubectl's own words reach the output.
    assert.deepEqual(p.engines['fc-a-1'], { digests: [], unreadable: [why] }, `${why}: ${r.out}`);
    assert.ok(!/Forbidden|Unauthorized|cannot list/.test(r.out), r.out);
    assert.ok(r.out.split('\n').filter(Boolean).every((l) => l.startsWith('PROBE ')), r.out);
  }
});
