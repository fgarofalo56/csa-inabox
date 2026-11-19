/**
 * Durable health console binding (#5346). The scheduled deploy-fiab-commercial re-rendered loom-console
 * from bicep and BLANKED LOOM_HEALTH_CP_URL / _AUDIENCE / _DEFAULT_STAMP_ID (revision --0001214), because
 * observabilityConfig.healthCp* defaulted empty and nothing resolved them. Each half of the fix is pinned
 * by a value that breaks it (assertion-design.md):
 *
 *  1. scripts/csa-loom/resolve-health-console-binding.sh EXECUTED under bash with a stub `az`:
 *     - one app in rg-csa-loom-health-dev01-eastus2 -> exactly the three lines, stamp `dev01`, `resolved`;
 *     - zero apps -> NO KEY= line + notice + `absent`;
 *     - it must NEVER fail the deploy it runs ahead of (R1): two apps / az error / garbage all exit 0, emit
 *       ::error:: with UNKNOWN text and `health_binding=unknown` (a script that exits 1 -> RED);
 *     - PRESERVE: when the lookup is unknown but the live console carries values, exactly those values
 *       are exported and the state is `preserved` (a script that exports nothing -> RED).
 *  2. WIRING: each lane calls the resolver BEFORE its what-if/apply, with no `if:` skipping it on the
 *     normal path, and a post-apply step FAILS the run on `unknown`; every bicepparam carries the three
 *     readEnvironmentVariable lines.
 * STUB_AZ_REPO_ROOT points the suite at a sandbox copy for mutation runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.STUB_AZ_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n');
const SCRIPT = 'scripts/csa-loom/resolve-health-console-binding.sh';
const APP = '11111111-2222-4333-8444-555555555555';
const APP2 = '66666666-7777-4888-8999-000000000000';
const FQDN = 'loom-health-cp.internal.example-1.eastus2.azurecontainerapps.io';
const RG = 'rg-csa-loom-health-dev01-eastus2';

// cpOut/cpFail answer the loom-health-cp `containerapp list`; consOut/consFail answer the loom-console
// `containerapp list`; appOut/appFail answer `az ad app list`.
function run({ cpOut, cpFail, appOut, appFail, consOut, consFail }, env = {}, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'hcb-'));
  const d = dir.replace(/\\/g, '/');
  mkdirSync(join(dir, 'bin'));
  const az = `#!/bin/bash
echo "$*" >> "${d}/az-calls.log"
case "$*" in
  *"containerapp list"*"loom-console"*) ${consFail ? `echo "${consFail}" >&2; exit 1` : `echo '${consOut ?? '[]'}'`};;
  *"containerapp list"*) ${cpFail ? `echo "${cpFail}" >&2; exit 1` : `echo '${cpOut}'`};;
  *"ad app list"*) ${appFail ? `echo "${appFail}" >&2; exit 1` : `echo '${appOut}'`};;
  *) exit 0;;
esac
`;
  writeFileSync(join(dir, 'bin', 'az'), az);
  chmodSync(join(dir, 'bin', 'az'), 0o755);
  writeFileSync(join(dir, 'ghenv.txt'), '');
  writeFileSync(join(dir, 'ghout.txt'), '');
  const r = spawnSync('bash', ['-e', resolve(root, SCRIPT), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, GITHUB_ENV: `${d}/ghenv.txt`, GITHUB_OUTPUT: `${d}/ghout.txt`, HEALTH_CP_APP_CLIENT_ID: '', ...env },
  });
  const rd = (f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };
  const outputs = rd('ghout.txt');
  const state = (outputs.match(/^health_binding=(.*)$/m) ?? [])[1];
  return { ...r, out: `${r.stdout}\n${r.stderr}`, exported: rd('ghenv.txt'), outputs, state, calls: rd('az-calls.log') };
}

const one = JSON.stringify([{ rg: RG, fqdn: FQDN }]);
const two = JSON.stringify([{ rg: RG, fqdn: FQDN }, { rg: 'rg-csa-loom-health-dev01-centralus', fqdn: 'x.example' }]);
const liveConsole = JSON.stringify([{ env: [
  { name: 'LOOM_HEALTH_CP_URL', value: 'https://live.example' },
  { name: 'LOOM_HEALTH_CP_AUDIENCE', value: 'api://live-aud' },
  { name: 'LOOM_HEALTH_DEFAULT_STAMP_ID', value: 'live01' },
  { name: 'OTHER', value: 'ignored' },
] }]);
const blankConsole = JSON.stringify([{ env: [{ name: 'LOOM_HEALTH_CP_URL', value: '' }] }]);
const lines = (s) => s.split('\n').filter(Boolean);

test('one control plane + one Entra app: exports exactly the three values (stamp WITHOUT the region), state resolved', () => {
  const r = run({ cpOut: one, appOut: JSON.stringify([APP]) });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(lines(r.exported), [
    `LOOM_HEALTH_CP_URL=https://${FQDN}`,
    `LOOM_HEALTH_CP_AUDIENCE=api://${APP}`,
    'LOOM_HEALTH_DEFAULT_STAMP_ID=dev01', // breaks if the region (-eastus2) leaks into the stamp
  ]);
  assert.equal(r.state, 'resolved');
});

test('the repo variable beats Entra and Entra is then never queried; --subscription reaches az', () => {
  const r = run({ cpOut: one, appOut: JSON.stringify([APP2]) }, { HEALTH_CP_APP_CLIENT_ID: APP }, ['--subscription', 'sub-123']);
  assert.equal(r.status, 0, r.out);
  assert.ok(lines(r.exported).includes(`LOOM_HEALTH_CP_AUDIENCE=api://${APP}`), r.exported);
  assert.doesNotMatch(r.calls, /ad app list/);
  assert.match(r.calls, /containerapp list --subscription sub-123/);
});

test('ZERO control planes: exports NOTHING (not empties), notices, state absent, exit 0', () => {
  const r = run({ cpOut: '[]', appOut: JSON.stringify([APP]) });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.exported, '', 'a script that exports empty values would blank the console again');
  assert.match(r.out, /::notice::No loom-health-cp Container App/);
  assert.equal(r.state, 'absent');
});

test('TWO control planes must NOT fail the deploy: exit 0, ::error:: UNKNOWN text, state unknown, nothing exported', () => {
  const r = run({ cpOut: two, appOut: JSON.stringify([APP]) });
  assert.equal(r.status, 0, 'a non-zero exit here would kill the whole daily admin-plane deploy (R1)');
  assert.match(r.out, /::error::Found 2 Container Apps named loom-health-cp/);
  assert.equal(r.state, 'unknown');
  assert.match(r.outputs, /health_binding_reason=Found 2 Container Apps/);
  assert.equal(r.exported, '');
});

test('an az error is UNKNOWN (R7), never "found 0", never fatal; both the CP read and the Entra read', () => {
  const cp = run({ cpFail: 'Authorization failed', appOut: JSON.stringify([APP]) });
  assert.equal(cp.status, 0, cp.out);
  assert.match(cp.out, /UNKNOWN/);
  assert.doesNotMatch(cp.out, /found 0|No loom-health-cp/);
  assert.equal(cp.state, 'unknown');
  assert.equal(cp.exported, '');
  const ad = run({ cpOut: one, appFail: 'Insufficient privileges' });
  assert.equal(ad.status, 0, ad.out);
  assert.match(ad.out, /::error::Could not read Entra.*UNKNOWN/);
  assert.equal(ad.state, 'unknown');
  assert.equal(ad.exported, '', 'the CP URL must not be exported alone when the audience is unknown');
});

test('two Entra apps and zero Entra apps are both unknown + exit 0; garbage / bad RG / no FQDN likewise', () => {
  const twoApps = run({ cpOut: one, appOut: JSON.stringify([APP, APP2]) });
  assert.equal(twoApps.status, 0);
  assert.match(twoApps.out, /Found 2 Entra apps/);
  assert.equal(twoApps.state, 'unknown');
  const zeroApps = run({ cpOut: one, appOut: '[]' });
  assert.equal(zeroApps.status, 0);
  assert.equal(zeroApps.state, 'unknown');
  const garbage = run({ cpOut: '<html>502</html>', appOut: JSON.stringify([APP]) });
  assert.equal(garbage.status, 0);
  assert.match(garbage.out, /UNKNOWN/);
  assert.equal(garbage.state, 'unknown');
  const badRg = run({ cpOut: JSON.stringify([{ rg: 'rg-something-else', fqdn: FQDN }]), appOut: JSON.stringify([APP]) });
  assert.equal(badRg.status, 0);
  assert.match(badRg.out, /stamp id is UNKNOWN/);
  const noFqdn = run({ cpOut: JSON.stringify([{ rg: RG, fqdn: null }]), appOut: JSON.stringify([APP]) });
  assert.equal(noFqdn.status, 0);
  assert.match(noFqdn.out, /URL is UNKNOWN/);
  for (const r of [badRg, noFqdn]) { assert.equal(r.state, 'unknown'); assert.equal(r.exported, ''); }
});

test('PRESERVE: lookup UNKNOWN but the live console carries values -> exactly those are exported, state preserved, warning not error', () => {
  const r = run({ cpOut: two, appOut: JSON.stringify([APP]), consOut: liveConsole });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(lines(r.exported), [
    'LOOM_HEALTH_CP_URL=https://live.example',
    'LOOM_HEALTH_CP_AUDIENCE=api://live-aud',
    'LOOM_HEALTH_DEFAULT_STAMP_ID=live01',
  ]);
  assert.equal(r.state, 'preserved');
  assert.match(r.out, /::warning::Found 2 Container Apps/);
  assert.doesNotMatch(r.out, /::error::/);
  // Entra failing preserves too, and a blank live value is NOT exported.
  const ad = run({ cpOut: one, appFail: 'boom', consOut: blankConsole });
  assert.equal(ad.state, 'unknown', 'an empty live value is nothing to preserve');
  assert.equal(ad.exported, '');
});

test('PRESERVE read also failing leaves state unknown and exports nothing', () => {
  const r = run({ cpFail: 'down', appOut: JSON.stringify([APP]), consFail: 'also down' });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.state, 'unknown');
  assert.equal(r.exported, '');
});

test('bad arguments are the ONLY non-zero exit', () => {
  const r = run({ cpOut: one, appOut: '[]' }, {}, ['--bogus']);
  assert.equal(r.status, 2);
});

// ── wiring ───────────────────────────────────────────────────────────────────────────────────────
const LANES = [
  { lane: 'commercial', resolver: '- name: Resolve the console health binding (#5346)', whatIf: '- name: Bicep what-if (preview)', apply: '- name: Provision (idempotent)' },
  { lane: 'gcc', whatIf: '- name: Bicep what-if', apply: '- name: Provision' },
  { lane: 'gcch', whatIf: '- name: Bicep what-if', apply: '- name: Provision (with full Gov dispatch)', pausedGuard: true },
  { lane: 'il5', whatIf: '- name: Bicep what-if (IL5 params)', apply: '- name: Teardown -> redeploy -> smoke (full mode only)' },
];
for (const { lane, whatIf, apply, pausedGuard } of LANES) {
  test(`deploy-fiab-${lane}.yml: resolver step runs before what-if + apply, is not skipped on the normal path, and a post-apply step keys off its output`, () => {
    const wf = read(`.github/workflows/deploy-fiab-${lane}.yml`);
    const name = '      - name: Resolve the console health binding (#5346)\n';
    const start = wf.indexOf(name); // anchored to the STEP header line, not a comment that mentions the script
    assert.ok(start > 0, `${lane}: resolver step missing`);
    const nextStep = wf.indexOf('\n      - name: ', start + 10);
    const block = wf.slice(start, nextStep);
    assert.match(block, /\n {8}id: health_binding\n/, `${lane}: the step needs id health_binding for the post-apply check`);
    assert.ok(block.includes('bash scripts/csa-loom/resolve-health-console-binding.sh'), `${lane}: the step does not call the script`);
    const ifLines = block.split('\n').filter((l) => /^ {8}if:/.test(l));
    if (pausedGuard) assert.deepEqual(ifLines, ["        if: steps.adx_preflight.outputs.estate_paused != 'true'"], 'gcch may skip ONLY on a declared-paused estate');
    else assert.deepEqual(ifLines, [], `${lane}: an if: on the resolver step could skip it on the normal path`);
    const w = wf.indexOf(`\n      ${whatIf}`, start);
    const a = wf.indexOf(`\n      ${apply}`, start);
    assert.ok(w > start, `${lane}: no what-if step after the resolver`);
    assert.ok(a > start, `${lane}: no apply step after the resolver`);
    // post-apply failure step
    const fail = wf.indexOf('      - name: Fail the run if the console health binding is UNKNOWN (#5346)\n');
    assert.ok(fail > a, `${lane}: the UNKNOWN check must come after the apply`);
    const fblock = wf.slice(fail, wf.indexOf('\n      - name: ', fail + 10));
    assert.match(fblock, /if: \$\{\{ always\(\) && steps\.health_binding\.outputs\.health_binding == 'unknown' \}\}/);
    assert.match(fblock, /exit 1/);
  });
}

test('every bicepparam carries all three readEnvironmentVariable lines inside observabilityConfig', () => {
  const dir = resolve(root, 'platform/fiab/bicep/params');
  const files = readdirSync(dir).filter((f) => f.endsWith('.bicepparam') && /^param observabilityConfig = \{/m.test(read(`platform/fiab/bicep/params/${f}`)));
  // Literal floor: the seven boundaries known at authoring time. A new file with an observabilityConfig is covered too.
  for (const f of ['commercial', 'commercial-full', 'gcc-high', 'il5', 'gcc', 'dod', 'tenant-dmlz']) {
    assert.ok(files.includes(`${f}.bicepparam`), `${f}.bicepparam no longer defines observabilityConfig`);
  }
  for (const f of files) {
    const s = read(`platform/fiab/bicep/params/${f}`);
    const block = s.match(/^param observabilityConfig = \{[\s\S]*?^\}/m)[0];
    for (const [key, env] of [['healthCpUrl', 'LOOM_HEALTH_CP_URL'], ['healthCpAudience', 'LOOM_HEALTH_CP_AUDIENCE'], ['healthDefaultStampId', 'LOOM_HEALTH_DEFAULT_STAMP_ID']]) {
      assert.ok(block.includes(`${key}: readEnvironmentVariable('${env}', '')`), `${f}: observabilityConfig.${key} no longer reads ${env}`);
    }
  }
});
