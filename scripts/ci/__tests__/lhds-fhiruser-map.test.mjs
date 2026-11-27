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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FHIR_ID, GRANT, GUID_RE, SYNTHETIC_IDENTIFIER_SYSTEM, SYNTHETIC_TAG, judgeMap, main, parseArgs, parseMapLogs, phaseCleanup,
  phaseMap, practitionerBody, renderMapScript, scrub, validate, CLIENT_LIST_CAP, readClientFile, syntheticIdentifierValue,
  SEED_GRANT, SYNTHETIC_PATIENT_IDENTIFIER_SYSTEM, judgeSeed, parseSeedLogs, patientBody, roleIdsFrom,
} from '../../measure/health/lhds-fhiruser-map.mjs';
import { engineBase } from '../../measure/health/lhds-fhir-crud-probe-run.mjs';

const ROOT = new URL('../../../', import.meta.url);
// CRLF-normalised, so a source-lifting assertion reads the same on a Windows autocrlf checkout.
const src = (p) => readFileSync(new URL(p, ROOT), 'utf8').replace(/\r\n/g, '\n');
const ISSUER = 'https://issuer-front-door.example.test/auth';
// A synthetic oid, built so no literal GUID sits in the file. Lower-case hex letters make an UPPER-case echo differ from it.
const OID = ['abcdef01', 'abcd', '4bcd', '8bcd', 'abcdefabcdef'].join('-');
const CP_TOKEN = ['cp', 'bearer', 'sentinel'].join('-');
const TENANT = 'demo-loom-hea-ab3844';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FU_PATH = `/api/health/auth/tenants/${TENANT}/fhir-users/${OID}`;
const BIND_PATH = `/api/health/auth/tenants/${TENANT}/bindings`;
// Synthetic group ids, built (not literal GUIDs). GROUP is upper-case on input to show it is compared case-insensitively.
const GROUP = ['0123abcd', 'ef01', '4abc', '8def', '0123456789ab'].join('-');
const OTHER_GROUP = ['fedc0123', 'ab01', '4abc', '8def', 'ba9876543210'].join('-');

/** In-memory control plane: tenant read, fhir-users GET/PUT, discovery, client registry, token endpoint, client PATCH/list. */
function cpFake(opts = {}) {
  const st = { regs: [], patches: [], puts: [], bindingPuts: [], clients: new Map(opts.clients ?? []), mapping: opts.mapping, bindings: opts.bindings };
  const res = (code, body) => ({ status: code, text: async () => JSON.stringify(body) });
  const fetchImpl = async (u, init = {}) => {
    const url = new URL(u);
    const method = init.method ?? 'GET';
    if (url.pathname === BIND_PATH && method === 'GET') {
      if (opts.bindingsGetFail) return res(opts.bindingsGetFail, { ok: false, error: { code: 'server_error', message: 'x' } });
      // As server.ts: a tenant with no binding doc answers bindings [] and v1Scopes TRUE (the schema default).
      return res(200, { ok: true, data: st.bindings ?? { tenant: TENANT, bindings: [], v1Scopes: true } });
    }
    if (url.pathname === BIND_PATH && method === 'PUT') {
      const b = JSON.parse(init.body);
      st.bindingPuts.push(b);
      st.bindings = { id: `binding-${TENANT}`, kind: 'binding', tenant: TENANT, ...b };
      return res(200, { ok: true, data: st.bindings });
    }
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
    seen.patient = existsSync(join(o.cwd, 'patient.json')) ? JSON.parse(readFileSync(join(o.cwd, 'patient.json'), 'utf8')) : undefined;
    seen.cwd = o.cwd;
    return { code, stdout: code === 0 ? JSON.stringify({ id: 'cmd-0001', provisioningState: 'Succeeded', exitCode: 0, logs }) : '', stderr };
  };
  return { seen, exec };
}

const base = (over = {}) => ({
  phase: 'map', cpUrl: 'https://cp.example.test', tenant: TENANT, stamp: 'dev01', displayName: 'LHDS Inferno Practitioner (synthetic)',
  replaceMissing: 'false', issuerPath: '/auth', aksRg: 'rg-csa-loom-health-dev01-centralus', aksName: 'aks-lhds-dev01', aksSub: '', summaryFile: '', clientFile: '',
  bindGroupId: '', bindRole: 'fhir-smart-user', setV2Scopes: 'false', seedPatient: 'false', roleMap: '',
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

test('mapped Practitioner is gone (404), DEFAULT: REFUSED exit 1, no PUT, the script was told not to create (breaks if a missing target is replaced without replace_missing)', async () => {
  const cp = cpFake({ mapping: 'Practitioner/900' });
  // Even if the pod (wrongly) printed a create, the judge must refuse without the flag.
  const az = azStub(`MAP step=verify status=404 id_match=no\n${CREATED}`);
  const r = await run((out) => phaseMap(base(), { ...cp.deps, exec: az.exec, out, tmpRoot: tmpdir() }));
  assert.equal(r.code, 1, r.text);
  assert.deepEqual(cp.st.puts, []);
  assert.equal(cp.st.mapping, 'Practitioner/900', 'the mapping is unchanged');
  assert.match(az.seen.script, /^REPLACE_MISSING='no'$/m);
  assert.match(r.text, /REFUSED: the mapping points at Practitioner\/900, which answers 404[\s\S]*replace_missing=true/);
});

test('mapped Practitioner is gone (404), replace_missing=true: a new one is created and the mapping is REPLACED with it (positive control for the refusal above)', async () => {
  const cp = cpFake({ mapping: 'Practitioner/900' });
  const az = azStub(`MAP step=verify status=404 id_match=no\n${CREATED}`);
  const r = await run((out) => phaseMap(base({ replaceMissing: 'true' }), { ...cp.deps, exec: az.exec, out, tmpRoot: tmpdir() }));
  assert.equal(r.code, 0, r.text);
  assert.match(az.seen.script, /^REPLACE_MISSING='yes'$/m);
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
  // STABLE per tenant (no run id): a re-run's conditional create must match it.
  assert.equal(az.seen.body.identifier[0].value, `fhiruser-map-${TENANT}`);
  assert.ok(az.seen.script.includes(`INE='If-None-Exist: identifier=${SYNTHETIC_IDENTIFIER_SYSTEM}|fhiruser-map-${TENANT}'`), 'the create is conditional on that identifier');
  assert.equal(az.seen.body.name[0].text, 'Dr Test (synthetic)');
  assert.deepEqual(Object.keys(az.seen.body).sort(), ['active', 'identifier', 'meta', 'name', 'resourceType']);
  assert.throws(() => practitionerBody({ displayName: 'x"};', tenant: TENANT }), /allowed set/);
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

const mkClient = (clientId, tenant, status = 'active') => [clientId, { clientId, tenant, status }];
const clientFile = (lines) => { const d = mkdtempSync(join(tmpdir(), 'fum-cf-')); const f = join(d, 'clients.txt'); if (lines) writeFileSync(f, lines.map((x) => `${x}\n`).join('')); return { f, d }; };

test('the map phase records `pending` BEFORE the mint and the client id right after it (breaks if the id is only known in memory, so a killed run leaves cleanup nothing to disable)', async () => {
  const cp = cpFake();
  const { f, d } = clientFile();
  let atExec;
  try {
    const exec = async (cmd, args, o) => { atExec = readFileSync(f, 'utf8'); return azStub(CREATED).exec(cmd, args, o); };
    const r = await run((out) => phaseMap(base({ clientFile: f }), { ...cp.deps, exec, out, tmpRoot: d }));
    assert.equal(r.code, 0, r.text);
    assert.equal(atExec, `pending\n${cp.st.regs[0].clientId}\n`, 'the id is on disk before the engine is contacted');
    assert.deepEqual(readClientFile(f), { pending: true, ids: [cp.st.regs[0].clientId] });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('cleanup phase: PATCH-disables exactly the RECORDED id(s) and never lists, even with 600 older clients (breaks if cleanup goes back to a list sweep that the 500 cap hides fu- behind)', async () => {
  const id = `fu-${TENANT}-aaaa0001`;
  const older = Array.from({ length: 600 }, (_, i) => mkClient(`ep-x-${String(i).padStart(4, '0')}`, 'x', 'disabled'));
  const cp = cpFake({ clients: [...older, mkClient(id, TENANT)] });
  let listed = 0;
  const fetchImpl = async (u, init) => { if (new URL(u).pathname === '/api/health/auth/clients' && (init?.method ?? 'GET') === 'GET') listed += 1; return cp.deps.fetchImpl(u, init); };
  const { f, d } = clientFile(['pending', id]);
  try {
    const r = await run((out) => phaseCleanup(base({ phase: 'cleanup', clientFile: f }), { ...cp.deps, fetchImpl, out }));
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(cp.st.patches, [id]);
    assert.equal(cp.st.clients.get(id).status, 'disabled');
    assert.equal(listed, 0);
    assert.match(r.text, /confirmed disabled/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('cleanup phase: a recorded id the CP does not confirm disabled is exit 1 and says it may be ACTIVE (breaks if the PATCH answer is not checked)', async () => {
  const id = `fu-${TENANT}-aaaa0001`;
  const cp = cpFake({ patchFail: true, clients: [mkClient(id, TENANT)] });
  const { f, d } = clientFile([id]);
  try {
    const r = await run((out) => phaseCleanup(base({ phase: 'cleanup', clientFile: f }), { ...cp.deps, out }));
    assert.equal(r.code, 1);
    assert.match(r.text, /NOT confirmed: the client may still be ACTIVE[\s\S]*INCOMPLETE/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('cleanup phase: `pending` with no id + a TRUNCATED 500-entry list is UNMEASURED exit 1, never "complete" (breaks if a capped page reads as proof no fu- client is active)', async () => {
  const page = Array.from({ length: CLIENT_LIST_CAP }, (_, i) => mkClient(`ep-x-${String(i).padStart(4, '0')}`, 'x', 'disabled'));
  const cp = cpFake({ clients: page });
  const { f, d } = clientFile(['pending']);
  try {
    const r = await run((out) => phaseCleanup(base({ phase: 'cleanup', clientFile: f }), { ...cp.deps, out }));
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /UNMEASURED: the client list returned 500 entries/);
    assert.equal(/cleanup complete/.test(r.text), false);
    // Positive control: the SAME pending record over a 499-entry page (one fewer) is a full list and exits 0.
    const r2 = await run((out) => phaseCleanup(base({ phase: 'cleanup', clientFile: f }), { ...cpFake({ clients: page.slice(1) }).deps, out }));
    assert.equal(r2.code, 0, r2.text);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('cleanup phase: `pending` with no id + a full (<500) list disables ONLY active fu-<tenant>- clients of this tenant (breaks if the fallback filter is dropped)', async () => {
  const cp = cpFake({ clients: [mkClient(`fu-${TENANT}-aaaa0001`, TENANT), mkClient(`fu-${TENANT}-aaaa0002`, TENANT, 'disabled'), mkClient(`ep-${TENANT}-aaaa0003`, TENANT), mkClient('fu-other-tenant-aaaa0004', 'other-tenant')] });
  const { f, d } = clientFile(['pending']);
  try {
    const r = await run((out) => phaseCleanup(base({ phase: 'cleanup', clientFile: f }), { ...cp.deps, out }));
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(cp.st.patches, [`fu-${TENANT}-aaaa0001`]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('cleanup phase: no record at all = nothing requested, exit 0 with no call; a list failure in the fallback is exit 1 (breaks if either is swallowed or inverted)', async () => {
  let calls = 0;
  const none = await run((out) => phaseCleanup(base({ phase: 'cleanup', clientFile: clientFile().f }), { fetchImpl: async () => { calls += 1; throw new Error('x'); }, out }));
  assert.equal(none.code, 0);
  assert.equal(calls, 0);
  const { f, d } = clientFile(['pending']);
  try {
    const a = await run((out) => phaseCleanup(base({ phase: 'cleanup', clientFile: f }), { ...cpFake({ listFail: true }).deps, out }));
    assert.equal(a.code, 1);
    assert.match(a.text, /may still be ACTIVE/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('SIGTERM during the engine call: the client is disabled BEFORE exit(143) (breaks if onSig exits without the bounded disable; the finally does not run on process.exit)', async () => {
  const cp = cpFake();
  let exited;
  let patchedAtExit;
  const exec = async () => {
    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50)); // let the async handler finish its PATCH
    return { code: 0, stdout: JSON.stringify({ id: 'cmd-1', provisioningState: 'Succeeded', logs: CREATED }), stderr: '' };
  };
  const r = await run((out) => phaseMap(base(), { ...cp.deps, exec, out, tmpRoot: tmpdir(), exit: (n) => { exited = n; patchedAtExit = [...cp.st.patches]; } }));
  assert.equal(exited, 143);
  assert.deepEqual(patchedAtExit, [cp.st.regs[0].clientId], 'the PATCH happened before exit was called');
  assert.match(r.text, /signal: client fu-[^ ]+ disabled=true/);
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

test('oid never in output: an oid straddling the 200-char error cut leaves NO fragment, because errText scrubs BEFORE truncating (breaks if it truncates first: "abcdef01-a" would survive)', async () => {
  // 190 chars of padding, then the oid: a truncate-first errText keeps chars 190..199 = the first 10 of the oid.
  const pad = 'x'.repeat(190);
  assert.equal(`${pad}${OID}`.slice(0, 200).slice(190), OID.slice(0, 10), 'fixture arithmetic: the cut falls inside the oid');
  const cp = cpFake({ mappingGet: () => ({ status: 500, text: async () => JSON.stringify({ ok: false, error: { code: 'server_error', message: `${pad}${OID} trailing` } }) }) });
  const r = await run((out) => phaseMap(base(), { ...cp.deps, out }));
  assert.equal(r.code, 2);
  assert.match(r.text, /x{190}<redacted>/, 'positive control: the message is printed, with the oid scrubbed');
  assert.equal(r.text.toLowerCase().includes(OID.slice(0, 8)), false, 'no oid fragment may survive the cut');
});

// Found by this test on 2026-11-27: the refusal used redact(type, 20) BEFORE say() scrubbed, so 20 chars of the oid
// printed. Every CP/ARM-supplied redact now scrubs first; say()'s own scrub is defence in depth (an equivalent mutant on
// every current path: removing it turns nothing red, disclosed per assertion-design.md).
test('oid never in output: a mapped resource whose TYPE segment is the oid (UPPER case) is refused with NO oid fragment (breaks if that site truncates before scrubbing: "ABCDEF01-ABCD-4BCD-8" leaks)', async () => {
  const cp = cpFake({ mapping: `${OID.toUpperCase()}/1` });
  const r = await run((out) => phaseMap(base(), { ...cp.deps, out }));
  assert.equal(r.code, 1);
  assert.match(r.text, /mapped on [^ ]+ to a <redacted>, not a Practitioner/, 'positive control: the refusal names the (scrubbed) type');
  assert.equal(r.text.toLowerCase().includes(OID.toLowerCase()), false);
});

test('scrub removes a secret in every letter case and leaves other text (breaks on a case-sensitive split, input "ABCDEF01-...")', () => {
  assert.equal(scrub(`a ${OID.toUpperCase()} b ${OID} c`, [OID]), 'a <redacted> b <redacted> c');
  assert.equal(scrub('nothing here', [OID]), 'nothing here');
});

// ---------------------------------------------------------------------------------------------------------------------
// judge + the generated script

test('judgeMap: each outcome lands where its value says (201 bare=no FAIL, 403 FAIL without a claimed cause, 000 UNMEASURED, read id mismatch FAIL, all good created)', () => {
  const j = (t, e = '', rm = false) => judgeMap(parseMapLogs(t), e, rm);
  assert.deepEqual([j(CREATED).code, j(CREATED).kind, j(CREATED).id], [0, 'created', '4711']);
  assert.equal(j('MAP step=create status=201 id=4711 bare=no\nMAP step=read status=200 id_match=yes').code, 1);
  assert.equal(j('MAP step=create status=403 bare=no').code, 1);
  assert.match(j('MAP step=create status=403 bare=no').note, /not established/);
  assert.equal(j('MAP step=create status=000 bare=no').code, 2);
  assert.equal(j('MAP step=create status=201 id=4711 bare=yes\nMAP step=read status=200 id_match=no').code, 1);
  assert.equal(j('Authorization: Bearer x\nMAP step=create status=201 id=4711 bare=yes').code, 2, 'no read line = unmeasured; a non-MAP line is ignored');
  assert.equal(j('MAP step=verify status=410 id_match=no\n' + CREATED, '900', true).kind, 'created');
  assert.equal(j('MAP step=verify status=410 id_match=no\n' + CREATED, '900').code, 1, 'without replaceMissing a 410 target is refused');
  assert.equal(j('MAP step=create status=200 id=4711 bare=yes\nMAP step=read status=200 id_match=yes').kind, 'reused');
  assert.equal(j('MAP step=create status=412 bare=no').code, 1);
  assert.equal(j('MAP step=verify status=200 id_match=no', '900').code, 1);
});

test('renderMapScript: no secret in the text, token read from the header file, BARE base of the tenant engine, refuses an injected slug or id', () => {
  const s = renderMapScript({ tenant: TENANT, existingId: '900' });
  assert.equal(/Bearer/i.test(s), false);
  assert.ok(s.includes('-H "@hdr"'));
  assert.ok(s.includes(`BASE='${engineBase(TENANT)}'`));
  assert.ok(s.includes('req POST "$BASE/$RT" "$2"') && /^RT=Practitioner$/m.test(s) && s.includes('create_read MAP practitioner.json'), 'the create must be at the bare base, no partition segment');
  assert.match(s, /^SEED='no'$/m, 'without seed the Patient block is off');
  assert.match(renderMapScript({ tenant: TENANT, seed: true }), /^SEED='yes'$/m);
  assert.throws(() => renderMapScript({ tenant: "x'; id #" }), /not a slug/);
  assert.throws(() => renderMapScript({ tenant: TENANT, existingId: "1'; rm" }), /not a FHIR id/);
});

const SH = spawnSync('sh', ['-c', 'command -v curl >/dev/null 2>&1 && echo ok']).stdout?.toString().trim() === 'ok';

/**
 * One loopback engine with HAPI's conditional-create semantics: POST with `If-None-Exist: identifier=<sys>|<val>` answers
 * 200 + the Location of the stored match, else stores a new Practitioner (4711, 4712, ...) and answers 201. `existing` =
 * extra ids that GET 200. `segment` puts a partition segment in the Location. `deny` = 403 on everything.
 */
function engine({ existing = [], segment = false, deny = false } = {}) {
  return new Promise((r) => {
    const store = new Map(); // id -> resource
    const pstore = new Map(); // Patient id (9001, 9002, ...) -> resource, the same conditional-create semantics
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        // Loopback-only HAPI stand-in. Every response is typed FHIR JSON (never HTML), as a real engine's is.
        const send = (c, h = {}, b = '') => { res.writeHead(c, { 'content-type': 'application/fhir+json', ...h }); res.end(b); };
        if (req.headers.authorization !== 'Bearer tok') return send(401);
        if (deny) return send(403);
        const loc = (id, type = 'Practitioner') => ({ location: `http://x/fhir/${segment ? 'DEFAULT/' : ''}${type}/${id}/_history/1` });
        if (req.method === 'POST' && req.url === '/fhir/Patient') {
          const p = JSON.parse(body);
          srv.pposts = (srv.pposts ?? 0) + 1;
          srv.pINE = [...(srv.pINE ?? []), String(req.headers['if-none-exist'] ?? '')];
          const want = /^identifier=([^|]+)\|(.+)$/.exec(String(req.headers['if-none-exist'] ?? ''));
          const hit = want && [...pstore].find(([, x]) => x.identifier?.some((i) => i.system === want[1] && i.value === want[2]));
          if (hit) return send(200, loc(hit[0], 'Patient'), '{}');
          const id = String(9001 + pstore.size);
          pstore.set(id, p);
          return send(201, loc(id, 'Patient'), '{}');
        }
        const pm = /^\/fhir\/Patient\/([^/]+)$/.exec(req.url);
        if (req.method === 'GET' && pm && pstore.has(pm[1])) return send(200, {}, `{"resourceType":"Patient","id":"${pm[1]}"}`);
        if (req.method === 'POST' && req.url === '/fhir/Practitioner') {
          const p = JSON.parse(body);
          srv.posts = (srv.posts ?? 0) + 1;
          const want = /^identifier=([^|]+)\|(.+)$/.exec(String(req.headers['if-none-exist'] ?? ''));
          const hit = want && [...store].find(([, x]) => x.identifier?.some((i) => i.system === want[1] && i.value === want[2]));
          if (hit) return send(200, loc(hit[0]), '{}');
          const id = String(4711 + store.size);
          store.set(id, p);
          return send(201, loc(id), '{}');
        }
        const m = /^\/fhir\/Practitioner\/([^/]+)$/.exec(req.url);
        if (req.method === 'GET' && m && (store.has(m[1]) || existing.includes(m[1]))) return send(200, {}, `{"resourceType":"Practitioner","id":"${m[1]}"}`);
        return send(404);
      });
    }).listen(0, '127.0.0.1', () => { srv.store = store; srv.pstore = pstore; r(srv); });
  });
}

async function runScript(engineOpts, existingId = '', { srv: shared, replaceMissing = false, seed = false } = {}) {
  const srv = shared ?? await engine(engineOpts);
  const dir = mkdtempSync(join(tmpdir(), 'fum-sh-'));
  try {
    writeFileSync(join(dir, 'map.sh'), renderMapScript({ tenant: TENANT, existingId, replaceMissing, seed }).replace(engineBase(TENANT), `http://127.0.0.1:${srv.address().port}/fhir`));
    writeFileSync(join(dir, 'hdr'), 'Authorization: Bearer tok\n');
    writeFileSync(join(dir, 'practitioner.json'), JSON.stringify(practitionerBody({ displayName: 'LHDS Inferno Practitioner (synthetic)', tenant: TENANT })));
    if (seed) writeFileSync(join(dir, 'patient.json'), JSON.stringify(patientBody({ tenant: TENANT })));
    const out = await new Promise((resolve) => {
      const p = spawn('sh', ['map.sh'], { cwd: dir });
      let o = '';
      p.stdout.on('data', (x) => { o += x; });
      p.on('close', () => resolve(o));
    });
    return { out, posts: srv.posts ?? 0, posted: srv.store.get('4711') };
  } finally { if (!shared) srv.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('under sh+curl: a SECOND run reuses the SAME Practitioner (conditional create answers 200), so the engine holds exactly one (breaks if the identifier is per-run or If-None-Exist is dropped: the second run makes 4712)', { skip: !SH && 'sh or curl is not available' }, async () => {
  const srv = await engine({});
  try {
    const first = await runScript({}, '', { srv });
    const v1 = judgeMap(parseMapLogs(first.out));
    assert.deepEqual([v1.code, v1.kind, v1.id], [0, 'created', '4711'], first.out);
    const second = await runScript({}, '', { srv });
    const v2 = judgeMap(parseMapLogs(second.out));
    assert.deepEqual([v2.code, v2.kind, v2.id], [0, 'reused', '4711'], second.out);
    assert.equal(srv.posts, 2, 'positive control: the second run DID post (so the reuse is the conditional create, not a skip)');
    assert.equal(srv.store.size, 1, 'exactly one synthetic Practitioner');
    assert.equal(srv.store.get('4711').identifier[0].value, syntheticIdentifierValue(TENANT));
  } finally { srv.close(); }
});

test('under sh+curl: not mapped creates 4711 at the bare base and reads it back; ONLY MAP lines print (breaks if the script misparses Location or prints a body)', { skip: !SH && 'sh or curl is not available' }, async () => {
  const r = await runScript({});
  assert.ok(r.out.split('\n').filter(Boolean).every((l) => l.startsWith('MAP ')), r.out);
  const v = judgeMap(parseMapLogs(r.out));
  assert.deepEqual([v.code, v.kind, v.id], [0, 'created', '4711'], r.out);
  assert.equal(r.posted.name[0].text, 'LHDS Inferno Practitioner (synthetic)');
});

test('under sh+curl: an existing resolving id posts NOTHING; a stale one (404) posts NOTHING by default and creates only with replaceMissing; a partition-segment Location FAILS; a 403 engine FAILS (breaks if the verify branch falls through to create)', { skip: !SH && 'sh or curl is not available' }, async () => {
  const a = await runScript({ existing: ['900'] }, '900');
  assert.equal(a.posts, 0, a.out);
  assert.equal(judgeMap(parseMapLogs(a.out), '900').kind, 'existing');
  const stale = await runScript({}, '900');
  assert.equal(stale.posts, 0, `a missing target must not be replaced without the flag: ${stale.out}`);
  assert.equal(judgeMap(parseMapLogs(stale.out), '900').code, 1);
  const b = await runScript({}, '900', { replaceMissing: true });
  assert.equal(b.posts, 1, b.out);
  assert.equal(judgeMap(parseMapLogs(b.out), '900', true).kind, 'created', b.out);
  assert.equal(judgeMap(parseMapLogs((await runScript({ segment: true })).out)).code, 1);
  const d = await runScript({ deny: true }, '900', { replaceMissing: true });
  assert.equal(judgeMap(parseMapLogs(d.out), '900', true).code, 1);
  assert.equal(d.posts, 0, 'a 403 verify must not fall through to a create');
});

// ---------------------------------------------------------------------------------------------------------------------
// the workflow

test('workflow: the oid comes ONLY from secrets.LHDS_FHIRUSER_OID, no input carries it, it is GUID-checked, and cleanup runs under always() (breaks if an oid input is added or the cleanup loses always())', () => {
  const wf = src('.github/workflows/lhds-fhiruser-map.yml');
  const inputs = /workflow_dispatch:\n {4}inputs:\n([\s\S]*?)\n\npermissions:/.exec(wf)?.[1] ?? '';
  assert.match(inputs, /tenant_id:/, 'positive control: the inputs block was found');
  assert.equal(/oid/i.test(inputs), false, 'no dispatch input may carry the oid');
  // The secret is bound in EXACTLY the two steps that need it, by name, and nowhere else.
  const steps = wf.split(/\n {6}- (?=name: |uses: )/).slice(1);
  const withOid = steps.filter((s) => /LHDS_FHIRUSER_OID: \$\{\{/.test(s)).map((s) => /^name: ([^\n]+)/.exec(s)?.[1]);
  assert.deepEqual(withOid, [
    'Validate inputs and the oid secret (the oid is never printed)',
    'Create (or verify) the synthetic Practitioner and map the oid to it',
  ]);
  const refs = wf.match(/LHDS_FHIRUSER_OID: \$\{\{[^}]*\}\}/g) ?? [];
  assert.equal(refs.length, 2);
  assert.ok(refs.every((x) => x === 'LHDS_FHIRUSER_OID: ${{ secrets.LHDS_FHIRUSER_OID }}'), refs.join(' | '));
  const cleanupStep = steps.find((s) => s.startsWith('name: Cleanup'));
  assert.ok(cleanupStep && !cleanupStep.includes('LHDS_FHIRUSER_OID'), 'the cleanup step needs no oid');
  // replace_missing is a boolean input defaulting to false, and both phases share the recorded client file.
  assert.match(inputs, / {6}replace_missing:\n[^\n]*\n {8}type: boolean\n {8}default: false/);
  assert.equal((wf.match(/--client-file "\$RUNNER_TEMP\/lhds-fhiruser-map-clients\.txt"/g) ?? []).length, 2);
  assert.ok(wf.includes('[[ "$LHDS_FHIRUSER_OID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]'));
  assert.equal(GUID_RE.source, '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', 'the workflow and the module check the same shape');
  assert.match(wf, /- name: Cleanup[^\n]*\n {8}if: always\(\) && steps\.require\.outcome == 'success'\n[\s\S]*--phase cleanup/);
  assert.equal(/echo[^\n]*\$\{?LHDS_FHIRUSER_OID/.test(wf), false, 'the oid is never echoed');
  assert.equal(/\$\{\{\s*inputs\./.test(wf.split('\njobs:')[1].replace(/^ {6}(TENANT|DISPLAY_NAME|REPLACE_MISSING|BIND_GROUP_ID|BIND_ROLE|SET_V2_SCOPES|SEED_PATIENT): \$\{\{ inputs\.[a-z0-9_]+ \}\}$/gm, '')), false, 'inputs reach run: blocks only through env');
  assert.equal(/2>\/dev\/null/.test(wf), false);
  assert.equal(/az deployment/.test(wf), false);
  assert.match(wf, /^ {2}workflow_dispatch:/m);
  assert.equal(/^ {2}(push|schedule|pull_request):/m.test(wf), false);
  assert.equal(GRANT.scope, 'system/Practitioner.cr');
});

test('workflow: bind_group_id / bind_role / set_v2_scopes / seed_patient are inputs with safe defaults and reach the script as args (breaks if seed or set_v2_scopes default true, or an input is not passed)', () => {
  const wf = src('.github/workflows/lhds-fhiruser-map.yml');
  const inputs = /workflow_dispatch:\n {4}inputs:\n([\s\S]*?)\n\npermissions:/.exec(wf)?.[1] ?? '';
  assert.match(inputs, / {6}bind_group_id:\n[^\n]*\n {8}type: string\n {8}default: ''/);
  assert.match(inputs, / {6}bind_role:\n[^\n]*\n {8}type: string\n {8}default: fhir-smart-user/);
  assert.match(inputs, / {6}set_v2_scopes:\n[^\n]*\n {8}type: boolean\n {8}default: false/);
  assert.match(inputs, / {6}seed_patient:\n[^\n]*\n {8}type: boolean\n {8}default: false/);
  assert.ok(wf.includes('--bind-group-id "$BIND_GROUP_ID" --bind-role "$BIND_ROLE" --set-v2-scopes "$SET_V2_SCOPES" --seed-patient "$SEED_PATIENT"'));
  assert.equal(parseArgs([], {}).bindRole, 'fhir-smart-user', 'the module default matches the input default');
});

// ---------------------------------------------------------------------------------------------------------------------
// role binding (--bind-group-id)

const PRIOR = Object.freeze({ groupId: OTHER_GROUP, roleId: 'fhir-data-reader' });
const SEEDED = 'SEED step=create status=201 id=9001 bare=yes\nSEED step=read status=200 id_match=yes\n';
/** Records the order of CP calls, so "before the mint" is a fact the test reads, not an assumption. */
const traced = (cp) => { const calls = []; return { calls, deps: { ...cp.deps, fetchImpl: async (u, init) => { calls.push(`${init?.method ?? 'GET'} ${new URL(u).pathname}`); return cp.deps.fetchImpl(u, init); } } }; };

test('bind role is validated FROM role-scope-map.v1.json: a role only a temp map names passes, a real role that map lacks is refused (breaks if validate checks a transcribed list)', () => {
  const d = mkdtempSync(join(tmpdir(), 'fum-roles-'));
  try {
    const f = join(d, 'roles.json');
    writeFileSync(f, JSON.stringify({ version: 'test', roles: [{ id: 'zz-only-in-this-file' }] }));
    assert.equal(validate(base({ bindGroupId: GROUP, bindRole: 'zz-only-in-this-file', roleMap: f })), null, 'a role ONLY the file names must pass');
    assert.match(String(validate(base({ bindGroupId: GROUP, bindRole: 'fhir-smart-user', roleMap: f }))), /not a role id in role-scope-map/);
    assert.match(String(validate(base({ bindGroupId: GROUP, roleMap: join(d, 'absent.json') }))), /could not read the role map/, 'an unreadable map refuses, never passes');
  } finally { rmSync(d, { recursive: true, force: true }); }
  const real = JSON.parse(src('apps/loom-health-cp/src/auth/role-scope-map.v1.json')).roles.map((r) => r.id);
  assert.deepEqual([...roleIdsFrom()].sort(), [...real].sort(), 'the default path reads the control plane file');
  assert.equal(validate(base({ bindGroupId: GROUP })), null, 'fhir-smart-user is in the real file');
  assert.match(String(validate(base({ bindGroupId: GROUP, bindRole: 'fhir-smart-userx' }))), /not a role id/);
  assert.match(String(validate(base({ bindGroupId: `{${GROUP}}` }))), /bind-group-id must be a GUID/);
  assert.equal(validate(base({ bindRole: 'fhir-smart-userx' })), null, 'no group = no binding requested, the role is not consulted');
});

test('bind MERGES, never replaces: the prior {OTHER_GROUP, fhir-data-reader} is kept, the pair appended (group lower-cased), v1Scopes:false, BEFORE the mint (breaks if the PUT sends only the new pair: OTHER_GROUP is dropped)', async () => {
  const cp = cpFake({ bindings: { tenant: TENANT, bindings: [PRIOR], v1Scopes: false } });
  const t = traced(cp);
  const { file, d } = withSummary();
  try {
    const r = await run((out) => phaseMap(base({ bindGroupId: GROUP.toUpperCase(), summaryFile: file }), { ...t.deps, exec: azStub(CREATED).exec, out, tmpRoot: d }));
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(cp.st.bindingPuts, [{ bindings: [PRIOR, { groupId: GROUP, roleId: 'fhir-smart-user' }], v1Scopes: false }]);
    assert.ok(t.calls.indexOf(`PUT ${BIND_PATH}`) < t.calls.indexOf('POST /api/health/auth/clients'), t.calls.join(' | '));
    assert.equal(t.calls.filter((x) => x === `GET ${BIND_PATH}`).length, 2, 'read once, read back once');
    assert.match(r.text, /VERDICT OK map=MAPPED bind=BOUND seed=not-requested/);
    assert.match(readFileSync(file, 'utf8'), new RegExp(`- binding: group ${GROUP} -> fhir-smart-user \\(BOUND, v1Scopes=false\\)\\n$`));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('bind: the pair already present with v1Scopes:false is UNCHANGED, no PUT (breaks if it is appended again: a 3-entry PUT)', async () => {
  const cp = cpFake({ mapping: 'Practitioner/900', bindings: { tenant: TENANT, bindings: [PRIOR, { groupId: GROUP, roleId: 'fhir-smart-user' }], v1Scopes: false } });
  const r = await run((out) => phaseMap(base({ bindGroupId: GROUP.toUpperCase() }), { ...cp.deps, exec: azStub('MAP step=verify status=200 id_match=yes\n').exec, out, tmpRoot: tmpdir() }));
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(cp.st.bindingPuts, []);
  assert.match(r.text, /VERDICT OK map=UNCHANGED bind=UNCHANGED seed=not-requested/);
});

test('bind: v1Scopes:true + OTHER bindings is REFUSED before any client or PUT; set_v2_scopes=true performs the flip (breaks if v1 is flipped silently)', async () => {
  const doc = () => ({ tenant: TENANT, bindings: [PRIOR], v1Scopes: true });
  const cp = cpFake({ bindings: doc() });
  const r = await run((out) => phaseMap(base({ bindGroupId: GROUP }), { ...cp.deps, exec: async () => { throw new Error('must not run'); }, out }));
  assert.equal(r.code, 1, r.text);
  assert.deepEqual(cp.st.bindingPuts, []);
  assert.equal(cp.st.regs.length, 0, 'nothing minted');
  assert.match(r.text, /REFUSED: the bindings of [^ ]+ have v1Scopes=true and 1 other binding\(s\)[\s\S]*EVERY SMART authorize[\s\S]*set_v2_scopes=true/);
  assert.match(r.text, /VERDICT FAIL map=not-run bind=FAIL seed=not-requested/);
  // Positive control: the same doc with the flag is written, the prior kept, v1Scopes false.
  const cp2 = cpFake({ bindings: doc() });
  const r2 = await run((out) => phaseMap(base({ bindGroupId: GROUP, setV2Scopes: 'true' }), { ...cp2.deps, exec: azStub(CREATED).exec, out, tmpRoot: tmpdir() }));
  assert.equal(r2.code, 0, r2.text);
  assert.deepEqual(cp2.st.bindingPuts, [{ bindings: [PRIOR, { groupId: GROUP, roleId: 'fhir-smart-user' }], v1Scopes: false }]);
  assert.match(r2.text, /v1Scopes switched true->false/);
});

test('bind: a tenant with NO binding doc (GET answers v1Scopes:true, []) is written with v1Scopes:FALSE and no refusal (breaks if the GET value is echoed back: v1 would turn ON)', async () => {
  const cp = cpFake();
  const r = await run((out) => phaseMap(base({ bindGroupId: GROUP }), { ...cp.deps, exec: azStub(CREATED).exec, out, tmpRoot: tmpdir() }));
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(cp.st.bindingPuts, [{ bindings: [{ groupId: GROUP, roleId: 'fhir-smart-user' }], v1Scopes: false }]);
});

test('bind: a read-back that lost a prior binding (a concurrent writer) FAILS; a bindings GET 500 is UNMEASURED before any mint (breaks if the read-back checks only the new pair)', async () => {
  const cp = cpFake({ bindings: { tenant: TENANT, bindings: [PRIOR], v1Scopes: false } });
  const deps = { ...cp.deps, fetchImpl: async (u, init) => { const x = await cp.deps.fetchImpl(u, init); if ((init?.method ?? 'GET') === 'PUT' && new URL(u).pathname === BIND_PATH) cp.st.bindings = { ...cp.st.bindings, bindings: cp.st.bindings.bindings.slice(1) }; return x; } };
  const r = await run((out) => phaseMap(base({ bindGroupId: GROUP }), { ...deps, exec: async () => { throw new Error('must not run'); }, out }));
  assert.equal(r.code, 1, r.text);
  assert.equal(cp.st.bindingPuts.length, 1, 'positive control: the PUT happened');
  assert.match(r.text, /pair=true v1Scopes=false lost_prior=1/);
  const cp2 = cpFake({ bindingsGetFail: 500 });
  const r2 = await run((out) => phaseMap(base({ bindGroupId: GROUP }), { ...cp2.deps, out }));
  assert.equal(r2.code, 2, r2.text);
  assert.equal(cp2.st.regs.length, 0);
  assert.match(r2.text, /VERDICT UNMEASURED map=not-run bind=UNMEASURED/);
});

// ---------------------------------------------------------------------------------------------------------------------
// synthetic Patient (--seed-patient)

test('seed: the client scope is widened to EXACTLY system/Practitioner.cr + system/Patient.cr ONLY when seeding; patient.json crosses as a file; summary and output name Patient/9001 (breaks if the widened grant is used without seed, or not with it)', async () => {
  const cp = cpFake();
  const az = azStub(`${CREATED}${SEEDED}`);
  const { file, d } = withSummary();
  try {
    const r = await run((out) => phaseMap(base({ seedPatient: 'true', summaryFile: file }), { ...cp.deps, exec: az.exec, out, tmpRoot: d }));
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(cp.st.regs[0].allowedScopes, ['system/Practitioner.cr', 'system/Patient.cr']);
    assert.deepEqual(SEED_GRANT.roleIds, ['fhir-data-writer'], 'the role is not widened');
    assert.ok(az.seen.calls[0].join(' ').includes('--file patient.json'));
    assert.match(az.seen.script, /^SEED='yes'$/m);
    assert.match(r.text, /seeded patient: Patient\/9001 \(SEEDED\)/);
    assert.match(r.text, /VERDICT OK map=MAPPED bind=not-requested seed=SEEDED/);
    assert.match(readFileSync(file, 'utf8'), /- mapping=ok \(created\)\n- Patient: Patient\/9001 \(SEEDED\)\n$/);
  } finally { rmSync(d, { recursive: true, force: true }); }
  // Without seed: the narrow grant, no patient.json, the script's Patient block off.
  const cp2 = cpFake();
  const az2 = azStub(CREATED);
  const r2 = await run((out) => phaseMap(base(), { ...cp2.deps, exec: az2.exec, out, tmpRoot: tmpdir() }));
  assert.equal(r2.code, 0, r2.text);
  assert.deepEqual(cp2.st.regs[0].allowedScopes, ['system/Practitioner.cr']);
  assert.equal(az2.seen.patient, undefined);
  assert.equal(az2.seen.calls[0].includes('patient.json'), false);
  assert.match(az2.seen.script, /^SEED='no'$/m);
});

test('seed: a token that lacks system/Patient.cr while seeding stops before az (breaks if the grant check ignores the widened set)', async () => {
  const cp = cpFake({ grantScope: 'system/Practitioner.cr' });
  let ran = false;
  const r = await run((out) => phaseMap(base({ seedPatient: 'true' }), { ...cp.deps, exec: async () => { ran = true; return { code: 0, stdout: '{}' }; }, out }));
  assert.equal(r.code, 1, r.text);
  assert.equal(ran, false);
  assert.match(r.text, /not exactly system\/Practitioner\.cr system\/Patient\.cr/);
});

test('seed: the Patient is SYNTHETIC (HTEST tag, fixed synthetic name, stable identifier, no telecom/address/birthDate); a seed 403 FAILS the run while the mapping still lands (breaks if a PHI-shaped field is added or a seed failure reads as OK)', async () => {
  const p = patientBody({ tenant: TENANT });
  assert.deepEqual(Object.keys(p).sort(), ['active', 'identifier', 'meta', 'name', 'resourceType']);
  assert.deepEqual(p.meta.tag, [{ ...SYNTHETIC_TAG }]);
  assert.deepEqual(p.identifier, [{ system: 'urn:loom:lhds:synthetic-patient', value: `fhiruser-map-${TENANT}` }]);
  assert.equal(p.name[0].text, 'Synthetic InfernoPatient');
  const cp = cpFake();
  const az = azStub(`${CREATED}SEED step=create status=403 bare=no\n`);
  const r = await run((out) => phaseMap(base({ seedPatient: 'true' }), { ...cp.deps, exec: az.exec, out, tmpRoot: tmpdir() }));
  assert.deepEqual(az.seen.patient, p);
  assert.equal(r.code, 1, r.text);
  assert.deepEqual(cp.st.puts, [{ resource: 'Practitioner/4711' }]);
  assert.match(r.text, /VERDICT FAIL map=MAPPED bind=not-requested seed=FAIL/);
  assert.equal(judgeSeed(parseSeedLogs('MAP step=create status=201 id=4711 bare=yes')).code, 2, 'a MAP line is not a SEED line');
  assert.equal(judgeSeed(parseSeedLogs(SEEDED.replace('bare=yes', 'bare=no'))).code, 1);
});

test('under sh+curl: seeding twice reuses the SAME Patient via If-None-Exist on the synthetic-patient identifier; the Practitioner identifier is NOT used for it (breaks if the Patient POST carries the Practitioner INE: the second run makes 9002)', { skip: !SH && 'sh or curl is not available' }, async () => {
  const srv = await engine({});
  try {
    const first = await runScript({}, '', { srv, seed: true });
    assert.deepEqual([judgeSeed(parseSeedLogs(first.out)).kind, judgeSeed(parseSeedLogs(first.out)).id], ['created', '9001'], first.out);
    const second = await runScript({}, '', { srv, seed: true });
    const v2 = judgeSeed(parseSeedLogs(second.out));
    assert.deepEqual([v2.code, v2.kind, v2.id], [0, 'reused', '9001'], second.out);
    assert.equal(srv.pposts, 2, 'positive control: the second run DID post');
    assert.equal(srv.pstore.size, 1);
    assert.deepEqual([...new Set(srv.pINE)], [`identifier=${SYNTHETIC_PATIENT_IDENTIFIER_SYSTEM}|fhiruser-map-${TENANT}`]);
    assert.equal(srv.store.size, 1, 'the Practitioner block still made exactly one Practitioner');
    assert.ok(second.out.split('\n').filter(Boolean).every((l) => /^(MAP|SEED) /.test(l)), second.out);
  } finally { srv.close(); }
});

test('under sh+curl: the Patient block runs after an existing, resolving Practitioner too, and NOT at all without seed (breaks if the verify early-exit skips the seed, or seed runs unasked)', { skip: !SH && 'sh or curl is not available' }, async () => {
  const srv = await engine({ existing: ['900'] });
  try {
    const a = await runScript({}, '900', { srv, seed: true });
    assert.equal(judgeMap(parseMapLogs(a.out), '900').kind, 'existing', a.out);
    assert.equal(srv.posts ?? 0, 0, 'no Practitioner posted');
    assert.equal(srv.pposts, 1, a.out);
    const b = await runScript({}, '900', { srv });
    assert.equal(srv.pposts, 1, `no Patient post without seed: ${b.out}`);
  } finally { srv.close(); }
});
