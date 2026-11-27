/**
 * Self-test for scripts/measure/health/lhds-fhiruser-map.mjs and .github/workflows/lhds-fhiruser-map.yml (Inferno
 * fhirUser one-off; the console surface is #5472).
 *
 * Every test names, in its title or a comment, the input that would break it (assertion-design.md). The load-bearing
 * ones (oid scrub, client disable) were run against a SANDBOX COPY with the defect applied (recorded in the PR body),
 * never against the tracked tree.
 *
 * Run: node --test scripts/ci/__tests__/lhds-fhiruser-map.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FHIR_ID, GRANT, GUID_RE, SYNTHETIC_IDENTIFIER_SYSTEM, SYNTHETIC_TAG, judgeMap, main, parseArgs, parseMapLogs, phaseCleanup,
  phaseMap, practitionerBody, renderMapScript, scrub, validate,
} from '../../measure/health/lhds-fhiruser-map.mjs';
import { engineBase } from '../../measure/health/lhds-fhir-crud-probe-run.mjs';

const ROOT = new URL('../../../', import.meta.url);
const src = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const ISSUER = 'https://issuer-front-door.example.test/auth';
// A synthetic oid, built so no literal GUID sits in the file. Lower-case hex letters make an UPPER-case echo differ from it.
const OID = ['abcdef01', 'abcd', '4bcd', '8bcd', 'abcdefabcdef'].join('-');
const CP_TOKEN = ['cp', 'bearer', 'sentinel'].join('-');
const TENANT = 'demo-loom-hea-ab3844';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FU_PATH = `/api/health/auth/tenants/${TENANT}/fhir-users/${OID}`;

/** In-memory control plane: tenant read, fhir-users GET/PUT, discovery, client registry, token endpoint, client PATCH/list. */
function cpFake(opts = {}) {
  const st = { regs: [], patches: [], puts: [], clients: new Map(opts.clients ?? []), mapping: opts.mapping };
  const res = (code, body) => ({ status: code, text: async () => JSON.stringify(body) });
  const fetchImpl = async (u, init = {}) => {
    const url = new URL(u);
    const method = init.method ?? 'GET';
    if (method === 'GET' && url.pathname === `/api/health/tenants/${TENANT}`) {
      return opts.tenantStatus ? res(opts.tenantStatus, { ok: false }) : res(200, { ok: true, data: { id: TENANT, stampId: opts.stampId ?? 'dev01', status: opts.tenantState ?? 'active' } });
    }
    if (url.pathname === FU_PATH && method === 'GET') {
      if (opts.mappingGet) return opts.mappingGet(st);
      return st.mapping ? res(200, { ok: true, data: { tenant: TENANT, oid: OID, resource: st.mapping, fhirUser: `https://fhir.example.test/dev01/${TENANT}/fhir/${st.mapping}` } }) : res(404, { ok: false, error: { code: 'not_found', message: 'fhirUser mapping not found' } });
    }
    if (url.pathname === FU_PATH && method === 'PUT') {
      const b = JSON.parse(init.body);
      st.puts.push(b);
      if (opts.putFail) return res(opts.putFail, { ok: false, error: { code: 'server_error', message: 'x' } });
      st.mapping = b.resource;
      return res(200, { ok: true, data: { tenant: TENANT, oid: OID, resource: b.resource } });
    }
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
      if (opts.patchFail) return res(500, { ok: false });
      const c = st.clients.get(pm[1]);
      if (c) c.status = 'disabled';
      return res(200, { ok: true, data: { status: 'disabled' } });
    }
    if (method === 'GET' && url.pathname === '/api/health/auth/clients') {
      if (opts.listFail) return res(500, { ok: false });
      return res(200, { ok: true, data: { clients: [...st.clients.values()] } });
    }
    const tm = /^\/auth\/([a-z0-9-]+)\/token$/.exec(url.pathname);
    if (method === 'POST' && tm) {
      const form = new URLSearchParams(init.body);
      const scope = opts.grantScope ?? form.get('scope');
      const token = `${b64u({ alg: 'ES384', typ: 'at+jwt' })}.${b64u({ iss: ISSUER, tenant: tm[1], exp: Math.floor(Date.now() / 1000) + 300, scope })}.sig-${tm[1]}`;
      return res(200, { access_token: token, token_type: 'bearer', expires_in: 300, scope });
    }
    return res(404, { ok: false });
  };
  return { st, deps: { fetchImpl, sleep: async () => {} } };
}

/** An az stub: records what each invoke attached (read from cwd), answers with `logs`. */
function azStub(logs, { code = 0, stderr = '' } = {}) {
  const seen = { calls: [] };
  const exec = async (cmd, args, o) => {
    seen.calls.push(args);
    seen.script = readFileSync(join(o.cwd, 'map.sh'), 'utf8');
    seen.hdr = readFileSync(join(o.cwd, 'hdr'), 'utf8');
    seen.body = JSON.parse(readFileSync(join(o.cwd, 'practitioner.json'), 'utf8'));
    seen.cwd = o.cwd;
    return { code, stdout: code === 0 ? JSON.stringify({ id: 'cmd-0001', provisioningState: 'Succeeded', exitCode: 0, logs }) : '', stderr };
  };
  return { seen, exec };
}

const base = (over = {}) => ({
  phase: 'map', cpUrl: 'https://cp.example.test', tenant: TENANT, stamp: 'dev01', displayName: 'LHDS Inferno Practitioner (synthetic)',
  runRef: '12345', issuerPath: '/auth', aksRg: 'rg-csa-loom-health-dev01-centralus', aksName: 'aks-lhds-dev01', aksSub: '', summaryFile: '',
  cpToken: CP_TOKEN, oid: OID, ...over,
});

async function run(fn) {
  const lines = [];
  const code = await fn((s) => lines.push(s));
  return { code, text: lines.join('\n') };
}
const withSummary = () => { const d = mkdtempSync(join(tmpdir(), 'fum-')); return { file: join(d, 'summary.md'), d }; };
const CREATED = 'MAP step=create status=201 id=4711 bare=yes\nMAP step=read status=200 id_match=yes\n';

// ---------------------------------------------------------------------------------------------------------------------
// the GUID guard

test('GUID guard: an empty, braced, short or non-hex oid is refused before any call; a GUID passes (breaks if GUID_RE is loosened to accept "{<guid>}" or "zzzz...")', () => {
  assert.equal(validate(base()), null, 'positive control: a well-formed oid must pass');
  assert.equal(validate(base({ oid: OID.toUpperCase() })), null, 'an upper-case GUID is still a GUID');
  for (const bad of ['', `{${OID}}`, OID.slice(1), OID.replace(/a/g, 'z'), `${OID}0`, OID.replace(/-/g, '')]) {
    const why = validate(base({ oid: bad }));
    assert.match(String(why), /LHDS_FHIRUSER_OID/, `oid ${JSON.stringify(bad)} must be refused`);
    // The refusal names the secret, never its value.
    if (bad) assert.equal(String(why).includes(bad), false);
  }
});

test('GUID guard via main(): a non-GUID oid exits 2 having contacted NOTHING (breaks if validate runs after the first fetch)', async () => {
  let calls = 0;
  const r = await run((out) => main(['--phase', 'map', '--cp-url', 'https://cp.example.test', '--tenant', TENANT, '--stamp', 'dev01', '--aks-rg', 'rg', '--aks-name', 'aks'],
    { LHDS_CP_TOKEN: CP_TOKEN, LHDS_FHIRUSER_OID: 'not-a-guid' }, { out, fetchImpl: async () => { calls += 1; throw new Error('contacted'); } }));
  assert.equal(r.code, 2);
  assert.equal(calls, 0);
  assert.match(r.text, /REFUSED \(input\)/);
});

test('the oid is read ONLY from env LHDS_FHIRUSER_OID: an --oid argument is ignored (breaks if parseArgs starts accepting the oid as an argument, which is visible)', () => {
  assert.equal(parseArgs(['--oid', OID], {}).oid, '');
  assert.equal(parseArgs([], { LHDS_FHIRUSER_OID: `${OID}\r\n` }).oid, OID);
});

test('FHIR_ID equals the control plane FHIR_ID (lifted from fhir-user.ts; breaks if either side drifts, e.g. ".." becomes an id)', () => {
  const m = /export const FHIR_ID = (\/.+\/);/.exec(src('apps/loom-health-cp/src/auth/fhir-user.ts'));
  assert.ok(m, 'FHIR_ID not found in fhir-user.ts');
  assert.equal(FHIR_ID.source, m[1].slice(1, -1));
  assert.equal(FHIR_ID.test('..'), false);
  assert.equal(FHIR_ID.test('4711'), true);
});

// ---------------------------------------------------------------------------------------------------------------------
// the idempotent "already mapped" path

test('already mapped and the Practitioner resolves: exit 0, NO PUT, the script was told the existing id, summary names it (breaks if a second Practitioner or a duplicate PUT is made)', async () => {
  const cp = cpFake({ mapping: 'Practitioner/900' });
  const az = azStub('MAP step=verify status=200 id_match=yes\n');
  const { file, d } = withSummary();
  try {
    const r = await run((out) => phaseMap(base({ summaryFile: file }), { ...cp.deps, exec: az.exec, out, tmpRoot: d }));
    assert.equal(r.code, 0, r.text);
    assert.equal(cp.st.puts.length, 0, 'an existing, resolving mapping must not be re-PUT');
    assert.match(az.seen.script, /^EXISTING='900'$/m);
    assert.match(readFileSync(file, 'utf8'), /fhirUser: Practitioner\/900\n- mapping=ok \(existing\)/);
    assert.deepEqual(cp.st.patches, [cp.st.regs[0].clientId], 'the temporary client is disabled on the success path too');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('already mapped but the Practitioner is gone (404): a new one is created and the mapping is REPLACED with it (breaks if a stale mapping is reported ok)', async () => {
  const cp = cpFake({ mapping: 'Practitioner/900' });
  const az = azStub(`MAP step=verify status=404 id_match=no\n${CREATED}`);
  const r = await run((out) => phaseMap(base(), { ...cp.deps, exec: az.exec, out, tmpRoot: tmpdir() }));
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(cp.st.puts, [{ resource: 'Practitioner/4711' }]);
});

test('already mapped, verify answers 403: FAIL, nothing created or PUT (breaks if any non-404/410 answer triggers a create)', async () => {
  const cp = cpFake({ mapping: 'Practitioner/900' });
  const r = await run((out) => phaseMap(base(), { ...cp.deps, exec: azStub('MAP step=verify status=403 id_match=no\n').exec, out, tmpRoot: tmpdir() }));
  assert.equal(r.code, 1);
  assert.equal(cp.st.puts.length, 0);
});

test('mapped to a Patient: REFUSED exit 1 before any client is registered (breaks if the tool overwrites a mapping it did not make)', async () => {
  const cp = cpFake({ mapping: 'Patient/5' });
  const r = await run((out) => phaseMap(base(), { ...cp.deps, exec: async () => { throw new Error('must not run'); }, out }));
  assert.equal(r.code, 1);
  assert.equal(cp.st.regs.length, 0);
  assert.equal(cp.st.puts.length, 0);
  assert.match(r.text, /not a Practitioner/);
});

// ---------------------------------------------------------------------------------------------------------------------
// the create + map path

test('not mapped: registers ONE client with exactly system/Practitioner.cr + fhir-data-writer, creates, PUTs {resource:"Practitioner/<id>"}, reads it back (breaks on a wider scope or a wrong body)', async () => {
  const cp = cpFake();
  const az = azStub(CREATED);
  const { file, d } = withSummary();
  try {
    const r = await run((out) => phaseMap(base({ summaryFile: file }), { ...cp.deps, exec: az.exec, out, tmpRoot: d }));
    assert.equal(r.code, 0, r.text);
    assert.equal(cp.st.regs.length, 1);
    assert.deepEqual(cp.st.regs[0].allowedScopes, ['system/Practitioner.cr']);
    assert.deepEqual(cp.st.regs[0].roleIds, ['fhir-data-writer']);
    assert.match(cp.st.regs[0].clientId, new RegExp(`^fu-${TENANT}-[0-9a-f]{8}$`));
    assert.deepEqual(cp.st.puts, [{ resource: 'Practitioner/4711' }]);
    assert.match(az.seen.script, /^EXISTING=''$/m);
    assert.equal(readFileSync(file, 'utf8'), `## lhds fhirUser map\n\n- tenant: ${TENANT}\n- fhirUser: Practitioner/4711\n- mapping=ok (created)\n`);
    // The token crossed as a file, never as an argument.
    assert.match(az.seen.hdr, /^Authorization: Bearer eyJ/);
    assert.equal(az.seen.calls.flat().some((x) => /Bearer|eyJ/.test(x)), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the Practitioner is SYNTHETIC: HTEST meta.tag, the synthetic identifier system, name.text = display name, no telecom/address/birthDate (breaks if a tag or the text is dropped)', async () => {
  const cp = cpFake();
  const az = azStub(CREATED);
  await run((out) => phaseMap(base({ displayName: 'Dr Test (synthetic)' }), { ...cp.deps, exec: az.exec, out, tmpRoot: tmpdir() }));
  assert.deepEqual(az.seen.body.meta.tag, [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST', display: 'test health data' }]);
  assert.deepEqual(SYNTHETIC_TAG.code, 'HTEST');
  assert.equal(az.seen.body.identifier[0].system, SYNTHETIC_IDENTIFIER_SYSTEM);
  assert.equal(az.seen.body.identifier[0].value, 'fhiruser-map-12345');
  assert.equal(az.seen.body.name[0].text, 'Dr Test (synthetic)');
  assert.deepEqual(Object.keys(az.seen.body).sort(), ['active', 'identifier', 'meta', 'name', 'resourceType']);
  assert.throws(() => practitionerBody({ displayName: 'x"};', runRef: '1' }), /allowed set/);
});

test('a mapping read-back that differs from the PUT reference FAILS exit 1 (breaks if the read-back is not compared)', async () => {
  // First GET: no mapping (404). Every later GET: Practitioner/1, i.e. the store did not keep what the PUT (4711) confirmed.
  let n = 0;
  const cp = cpFake({ mappingGet: () => (n++ === 0
    ? { status: 404, text: async () => '{"ok":false}' }
    : { status: 200, text: async () => JSON.stringify({ ok: true, data: { oid: OID, resource: 'Practitioner/1' } }) }) });
  const r = await run((out) => phaseMap(base(), { ...cp.deps, exec: azStub(CREATED).exec, out, tmpRoot: tmpdir() }));
  assert.deepEqual(cp.st.puts, [{ resource: 'Practitioner/4711' }], 'positive control: the PUT happened');
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /read-back does not equal Practitioner\/4711/);
});

test('a token whose scope is not exactly system/Practitioner.cr (system/*.cruds) stops before az, and the client is still disabled (breaks if the grant is not checked)', async () => {
  const cp = cpFake({ grantScope: 'system/*.cruds' });
  let ran = false;
  const r = await run((out) => phaseMap(base(), { ...cp.deps, exec: async () => { ran = true; return { code: 0, stdout: '{}' }; }, out }));
  assert.equal(r.code, 1);
  assert.equal(ran, false);
  assert.deepEqual(cp.st.patches, [cp.st.regs[0].clientId]);
});

// ---------------------------------------------------------------------------------------------------------------------
// the client is disabled on failure

test('client disabled on failure: az fails (exit 2), the create is refused (exit 1), the PUT fails (exit 1): in EVERY case the minted client is PATCHed disabled and no PUT is left half-done (breaks if the finally disable is removed)', async () => {
  for (const [label, az, opts, want] of [
    ['az exits 1', azStub('', { code: 1, stderr: 'ERROR: boom' }), {}, 2],
    ['create 403', azStub('MAP step=create status=403 bare=no\n'), {}, 1],
    ['PUT 500', azStub(CREATED), { putFail: 500 }, 1],
  ]) {
    const cp = cpFake(opts);
    const r = await run((out) => phaseMap(base(), { ...cp.deps, exec: az.exec, out, tmpRoot: tmpdir() }));
    assert.equal(r.code, want, `${label}: ${r.text}`);
    assert.equal(cp.st.regs.length, 1, label);
    assert.deepEqual(cp.st.patches, [cp.st.regs[0].clientId], `${label}: the client must be disabled`);
    assert.equal(cp.st.clients.get(cp.st.regs[0].clientId).status, 'disabled', label);
    assert.match(r.text, /disabled=true/, label);
  }
});

test('client disabled on failure: an exception thrown by az still disables the client and deletes the temp dir (breaks if the disable is only on the normal return path)', async () => {
  const cp = cpFake();
  let cwd;
  const r = await run((out) => phaseMap(base(), { ...cp.deps, exec: async (c, a, o) => { cwd = o.cwd; throw new Error('runner lost'); }, out, tmpRoot: tmpdir() }));
  assert.equal(r.code, 1);
  assert.deepEqual(cp.st.patches, [cp.st.regs[0].clientId]);
  assert.equal(spawnSync('node', ['-e', `process.exit(require('fs').existsSync(${JSON.stringify(cwd)})?1:0)`]).status, 0, 'temp dir must be deleted');
});

test('cleanup phase: disables ONLY active fu-<tenant>- clients of THIS tenant; ep- clients, other tenants and already-disabled ones are untouched (breaks if the filter is dropped)', async () => {
  const mk = (clientId, tenant, status = 'active') => [clientId, { clientId, tenant, status }];
  const cp = cpFake({ clients: [mk(`fu-${TENANT}-aaaa0001`, TENANT), mk(`fu-${TENANT}-aaaa0002`, TENANT, 'disabled'), mk(`ep-${TENANT}-aaaa0003`, TENANT), mk('fu-other-tenant-aaaa0004', 'other-tenant')] });
  const r = await run((out) => phaseCleanup(base({ phase: 'cleanup' }), { ...cp.deps, out }));
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(cp.st.patches, [`fu-${TENANT}-aaaa0001`]);
});

test('cleanup phase: a list failure or a disable the CP does not confirm is exit 1 and says a writer client may be active (breaks if either is swallowed)', async () => {
  const a = await run((out) => phaseCleanup(base({ phase: 'cleanup' }), { ...cpFake({ listFail: true }).deps, out }));
  assert.equal(a.code, 1);
  assert.match(a.text, /may still be ACTIVE/);
  const cp = cpFake({ patchFail: true, clients: [[`fu-${TENANT}-aaaa0001`, { clientId: `fu-${TENANT}-aaaa0001`, tenant: TENANT, status: 'active' }]] });
  const b = await run((out) => phaseCleanup(base({ phase: 'cleanup' }), { ...cp.deps, out }));
  assert.equal(b.code, 1);
  assert.match(b.text, /INCOMPLETE/);
});

// ---------------------------------------------------------------------------------------------------------------------
// the oid never appears in output

test('oid never in output: the CP echoes the oid in UPPER case in an error and in lower case in fhirUser; neither reaches stdout or the summary (breaks if scrub is removed or made case-sensitive)', async () => {
  const echo = (s) => ({ status: 500, text: async () => JSON.stringify({ ok: false, error: { code: 'server_error', message: `store failed for ${s}` } }) });
  // 1. error path: the mapping GET answers 500 naming the oid in upper case.
  const cp1 = cpFake({ mappingGet: () => echo(OID.toUpperCase()) });
  const r1 = await run((out) => phaseMap(base(), { ...cp1.deps, out }));
  assert.equal(r1.code, 2);
  assert.match(r1.text, /store failed for <redacted>/, 'positive control: the echoed error IS printed, scrubbed');
  // 2. success path: the read-back's fhirUser is fine, but the az stderr of a failing poll is not involved; the CP's data.oid is never printed.
  const cp2 = cpFake();
  const { file, d } = withSummary();
  try {
    const r2 = await run((out) => phaseMap(base({ summaryFile: file }), { ...cp2.deps, exec: azStub(CREATED).exec, out, tmpRoot: d }));
    assert.equal(r2.code, 0, r2.text);
    const all = `${r1.text}\n${r2.text}\n${readFileSync(file, 'utf8')}`.toLowerCase();
    assert.equal(all.includes(OID.toLowerCase()), false, 'the oid (any case) leaked');
    assert.equal(all.includes(OID.replace(/-/g, '').toLowerCase()), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('oid never in output: az stderr carrying the oid and the bearer is printed scrubbed (breaks if the az failure text is printed raw)', async () => {
  const cp = cpFake();
  const r = await run((out) => phaseMap(base(), { ...cp.deps, exec: azStub('', { code: 1, stderr: `ERROR near ${OID} with ${CP_TOKEN}` }).exec, out, tmpRoot: tmpdir() }));
  assert.equal(r.code, 2);
  assert.match(r.text, /ERROR near <redacted> with <redacted>/);
  assert.equal(r.text.includes(OID), false);
  assert.equal(r.text.includes(CP_TOKEN), false);
});

test('scrub removes a secret in every letter case and leaves other text (breaks on a case-sensitive split, input "ABCDEF01-...")', () => {
  assert.equal(scrub(`a ${OID.toUpperCase()} b ${OID} c`, [OID]), 'a <redacted> b <redacted> c');
  assert.equal(scrub('nothing here', [OID]), 'nothing here');
});

// ---------------------------------------------------------------------------------------------------------------------
// judge + the generated script

test('judgeMap: each outcome lands where its value says (201 bare=no FAIL, 403 FAIL without a claimed cause, 000 UNMEASURED, read id mismatch FAIL, all good created)', () => {
  const j = (t, e = '') => judgeMap(parseMapLogs(t), e);
  assert.deepEqual([j(CREATED).code, j(CREATED).kind, j(CREATED).id], [0, 'created', '4711']);
  assert.equal(j('MAP step=create status=201 id=4711 bare=no\nMAP step=read status=200 id_match=yes').code, 1);
  assert.equal(j('MAP step=create status=403 bare=no').code, 1);
  assert.match(j('MAP step=create status=403 bare=no').note, /not established/);
  assert.equal(j('MAP step=create status=000 bare=no').code, 2);
  assert.equal(j('MAP step=create status=201 id=4711 bare=yes\nMAP step=read status=200 id_match=no').code, 1);
  assert.equal(j('Authorization: Bearer x\nMAP step=create status=201 id=4711 bare=yes').code, 2, 'no read line = unmeasured; a non-MAP line is ignored');
  assert.equal(j('MAP step=verify status=410 id_match=no\n' + CREATED, '900').kind, 'created');
  assert.equal(j('MAP step=verify status=200 id_match=no', '900').code, 1);
});

test('renderMapScript: no secret in the text, token read from the header file, BARE base of the tenant engine, refuses an injected slug or id', () => {
  const s = renderMapScript({ tenant: TENANT, existingId: '900' });
  assert.equal(/Bearer/i.test(s), false);
  assert.ok(s.includes('-H "@hdr"'));
  assert.ok(s.includes(`BASE='${engineBase(TENANT)}'`));
  assert.ok(s.includes('req POST "$BASE/Practitioner" practitioner.json'), 'the create must be at the bare base, no partition segment');
  assert.throws(() => renderMapScript({ tenant: "x'; id #" }), /not a slug/);
  assert.throws(() => renderMapScript({ tenant: TENANT, existingId: "1'; rm" }), /not a FHIR id/);
});

const SH = spawnSync('sh', ['-c', 'command -v curl >/dev/null 2>&1 && echo ok']).stdout?.toString().trim() === 'ok';

/** One loopback engine. `existing` = ids that GET 200; POST creates 4711 with a Location at the bare base unless `segment`. */
function engine({ existing = [], segment = false, deny = false } = {}) {
  return new Promise((r) => {
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const send = (c, h = {}, b = '') => { res.writeHead(c, h); res.end(b); };
        if (req.headers.authorization !== 'Bearer tok') return send(401);
        if (deny) return send(403);
        if (req.method === 'POST' && req.url === '/fhir/Practitioner') {
          srv.posted = JSON.parse(body);
          return send(201, { location: `http://x/fhir/${segment ? 'DEFAULT/' : ''}Practitioner/4711/_history/1` }, '{}');
        }
        const m = /^\/fhir\/Practitioner\/([^/]+)$/.exec(req.url);
        if (req.method === 'GET' && m && (m[1] === '4711' && srv.posted || existing.includes(m[1]))) return send(200, {}, `{"resourceType":"Practitioner","id":"${m[1]}"}`);
        return send(404);
      });
    }).listen(0, '127.0.0.1', () => r(srv));
  });
}

async function runScript(engineOpts, existingId = '') {
  const srv = await engine(engineOpts);
  const dir = mkdtempSync(join(tmpdir(), 'fum-sh-'));
  try {
    writeFileSync(join(dir, 'map.sh'), renderMapScript({ tenant: TENANT, existingId }).replace(engineBase(TENANT), `http://127.0.0.1:${srv.address().port}/fhir`));
    writeFileSync(join(dir, 'hdr'), 'Authorization: Bearer tok\n');
    writeFileSync(join(dir, 'practitioner.json'), JSON.stringify(practitionerBody({ displayName: 'LHDS Inferno Practitioner (synthetic)', runRef: '1' })));
    const out = await new Promise((resolve) => {
      const p = spawn('sh', ['map.sh'], { cwd: dir });
      let o = '';
      p.stdout.on('data', (x) => { o += x; });
      p.on('close', () => resolve(o));
    });
    return { out, posted: srv.posted };
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('under sh+curl: not mapped creates 4711 at the bare base and reads it back; ONLY MAP lines print (breaks if the script misparses Location or prints a body)', { skip: !SH && 'sh or curl is not available' }, async () => {
  const r = await runScript({});
  assert.ok(r.out.split('\n').filter(Boolean).every((l) => l.startsWith('MAP ')), r.out);
  const v = judgeMap(parseMapLogs(r.out));
  assert.deepEqual([v.code, v.kind, v.id], [0, 'created', '4711'], r.out);
  assert.equal(r.posted.name[0].text, 'LHDS Inferno Practitioner (synthetic)');
});

test('under sh+curl: an existing resolving id posts NOTHING; a stale one (404) creates; a Location with a partition segment FAILS; a 403 engine FAILS (breaks if the verify branch falls through to create)', { skip: !SH && 'sh or curl is not available' }, async () => {
  const a = await runScript({ existing: ['900'] }, '900');
  assert.equal(a.posted, undefined, a.out);
  assert.equal(judgeMap(parseMapLogs(a.out), '900').kind, 'existing');
  const b = await runScript({}, '900');
  assert.equal(judgeMap(parseMapLogs(b.out), '900').kind, 'created', b.out);
  assert.equal(judgeMap(parseMapLogs((await runScript({ segment: true })).out)).code, 1);
  const d = await runScript({ deny: true }, '900');
  assert.equal(judgeMap(parseMapLogs(d.out), '900').code, 1);
  assert.equal(d.posted, undefined, 'a 403 verify must not fall through to a create');
});

// ---------------------------------------------------------------------------------------------------------------------
// the workflow

test('workflow: the oid comes ONLY from secrets.LHDS_FHIRUSER_OID, no input carries it, it is GUID-checked, and cleanup runs under always() (breaks if an oid input is added or the cleanup loses always())', () => {
  const wf = src('.github/workflows/lhds-fhiruser-map.yml');
  const inputs = /workflow_dispatch:\n {4}inputs:\n([\s\S]*?)\n\npermissions:/.exec(wf)?.[1] ?? '';
  assert.match(inputs, /tenant_id:/, 'positive control: the inputs block was found');
  assert.equal(/oid/i.test(inputs), false, 'no dispatch input may carry the oid');
  const refs = wf.match(/LHDS_FHIRUSER_OID: \$\{\{[^}]*\}\}/g) ?? [];
  assert.ok(refs.length >= 2);
  assert.ok(refs.every((x) => x === 'LHDS_FHIRUSER_OID: ${{ secrets.LHDS_FHIRUSER_OID }}'), refs.join(' | '));
  assert.ok(wf.includes('[[ "$LHDS_FHIRUSER_OID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]'));
  assert.equal(GUID_RE.source, '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', 'the workflow and the module check the same shape');
  assert.match(wf, /- name: Cleanup[^\n]*\n {8}if: always\(\) && steps\.require\.outcome == 'success'\n[\s\S]*--phase cleanup/);
  assert.equal(/echo[^\n]*\$\{?LHDS_FHIRUSER_OID/.test(wf), false, 'the oid is never echoed');
  assert.equal(/\$\{\{\s*inputs\./.test(wf.split('\njobs:')[1].replace(/^ {6}(TENANT|DISPLAY_NAME): \$\{\{ inputs\.[a-z_]+ \}\}$/gm, '')), false, 'inputs reach run: blocks only through env');
  assert.equal(/2>\/dev\/null/.test(wf), false);
  assert.equal(/az deployment/.test(wf), false);
  assert.match(wf, /^ {2}workflow_dispatch:/m);
  assert.equal(/^ {2}(push|schedule|pull_request):/m.test(wf), false);
  assert.equal(GRANT.scope, 'system/Practitioner.cr');
});
