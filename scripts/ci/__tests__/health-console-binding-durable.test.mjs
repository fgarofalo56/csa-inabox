/**
 * Durable health console binding (#5346). The scheduled deploy-fiab-commercial re-rendered loom-console
 * from bicep and BLANKED LOOM_HEALTH_CP_URL / _AUDIENCE / _DEFAULT_STAMP_ID (revision --0001214), because
 * observabilityConfig.healthCp* defaulted empty and nothing resolved them. The fix has two halves, and each
 * is pinned by a value that breaks it (assertion-design.md):
 *
 *  1. scripts/csa-loom/resolve-health-console-binding.sh EXECUTED under bash with a stub `az`:
 *     - one app in rg-csa-loom-health-dev01-eastus2 -> exactly the three lines, stamp `dev01` (a regex that
 *       kept the region, or took the first hyphen segment, gives a different stamp -> RED);
 *     - zero apps -> NO KEY= line at all + a ::notice:: (a script that exports empties -> RED);
 *     - two apps -> exit 1 (a script that takes the first -> RED);
 *     - az error / garbage -> exit 1 and says UNKNOWN, never "found 0" (R7).
 *  2. WIRING: deploy-fiab-commercial.yml calls the script BEFORE the what-if and the apply, and every
 *     bicepparam carries the three readEnvironmentVariable lines. A workflow that drops the call, or a
 *     param file that drops a line, turns these RED.
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

// `cpJson` answers `az containerapp list`; `appJson` answers `az ad app list`. Either may be a shell
// snippet via the *Raw variants to simulate failures.
function run({ cpOut, cpFail, appOut, appFail }, env = {}, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'hcb-'));
  const d = dir.replace(/\\/g, '/');
  mkdirSync(join(dir, 'bin'));
  const az = `#!/bin/bash
echo "$*" >> "${d}/az-calls.log"
case "$*" in
  *"containerapp list"*) ${cpFail ? `echo "${cpFail}" >&2; exit 1` : `echo '${cpOut}'`};;
  *"ad app list"*) ${appFail ? `echo "${appFail}" >&2; exit 1` : `echo '${appOut}'`};;
  *) exit 0;;
esac
`;
  writeFileSync(join(dir, 'bin', 'az'), az);
  chmodSync(join(dir, 'bin', 'az'), 0o755);
  writeFileSync(join(dir, 'ghenv.txt'), '');
  const r = spawnSync('bash', ['-e', resolve(root, SCRIPT), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, GITHUB_ENV: `${d}/ghenv.txt`, HEALTH_CP_APP_CLIENT_ID: '', ...env },
  });
  const rd = (f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };
  return { ...r, out: `${r.stdout}\n${r.stderr}`, exported: rd('ghenv.txt'), calls: rd('az-calls.log') };
}

const one = JSON.stringify([{ rg: RG, fqdn: FQDN }]);

test('one control plane + one Entra app: exports exactly the three values, stamp parsed WITHOUT the region', () => {
  const r = run({ cpOut: one, appOut: JSON.stringify([APP]) });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.exported.split('\n').filter(Boolean), [
    `LOOM_HEALTH_CP_URL=https://${FQDN}`,
    `LOOM_HEALTH_CP_AUDIENCE=api://${APP}`,
    'LOOM_HEALTH_DEFAULT_STAMP_ID=dev01', // breaks if the region (-eastus2) leaks into the stamp
  ]);
});

test('the repo variable beats Entra and Entra is then never queried; --subscription reaches az', () => {
  const r = run({ cpOut: one, appOut: JSON.stringify([APP2]) }, { HEALTH_CP_APP_CLIENT_ID: APP }, ['--subscription', 'sub-123']);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.exported.split('\n').includes(`LOOM_HEALTH_CP_AUDIENCE=api://${APP}`), r.exported);
  assert.doesNotMatch(r.calls, /ad app list/);
  assert.match(r.calls, /containerapp list --subscription sub-123/);
});

test('ZERO control planes: exports NOTHING (not empties) and notices; LHDS not deployed is legitimate', () => {
  const r = run({ cpOut: '[]', appOut: JSON.stringify([APP]) });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.exported, '', 'a script that exports empty values would blank the console again');
  assert.match(r.out, /::notice::No loom-health-cp Container App/);
});

test('TWO control planes: FAILS rather than picking one', () => {
  const two = JSON.stringify([{ rg: RG, fqdn: FQDN }, { rg: 'rg-csa-loom-health-dev01-centralus', fqdn: 'x.example' }]);
  const r = run({ cpOut: two, appOut: JSON.stringify([APP]) });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /found 2 Container Apps named loom-health-cp/);
  assert.equal(r.exported, '');
});

test('two Entra apps FAIL; zero Entra apps warns and exports nothing', () => {
  const two = run({ cpOut: one, appOut: JSON.stringify([APP, APP2]) });
  assert.notEqual(two.status, 0);
  assert.match(two.out, /found 2 Entra apps/);
  assert.equal(two.exported, '');
  const zero = run({ cpOut: one, appOut: '[]' });
  assert.equal(zero.status, 0, zero.out);
  assert.match(zero.out, /::warning::/);
  assert.equal(zero.exported, '');
});

test('an az error says UNKNOWN (R7) for both reads, never "found 0"; nothing is exported', () => {
  const cp = run({ cpFail: 'Authorization failed', appOut: JSON.stringify([APP]) });
  assert.notEqual(cp.status, 0);
  assert.match(cp.out, /UNKNOWN/);
  assert.doesNotMatch(cp.out, /found 0|No loom-health-cp/);
  assert.equal(cp.exported, '');
  const ad = run({ cpOut: one, appFail: 'Insufficient privileges' });
  assert.notEqual(ad.status, 0);
  assert.match(ad.out, /UNKNOWN/);
  assert.equal(ad.exported, '');
});

test('unparseable output and a non-conforming resource group are UNKNOWN failures', () => {
  const garbage = run({ cpOut: '<html>502</html>', appOut: JSON.stringify([APP]) });
  assert.notEqual(garbage.status, 0);
  assert.match(garbage.out, /UNKNOWN/);
  const badRg = run({ cpOut: JSON.stringify([{ rg: 'rg-something-else', fqdn: FQDN }]), appOut: JSON.stringify([APP]) });
  assert.notEqual(badRg.status, 0);
  assert.match(badRg.out, /stamp id is UNKNOWN/);
  const noFqdn = run({ cpOut: JSON.stringify([{ rg: RG, fqdn: null }]), appOut: JSON.stringify([APP]) });
  assert.notEqual(noFqdn.status, 0);
  assert.match(noFqdn.out, /URL is UNKNOWN/);
});

// ── wiring ───────────────────────────────────────────────────────────────────────────────────────
test('deploy-fiab-commercial.yml calls the resolver BEFORE the what-if and the apply', () => {
  const wf = read('.github/workflows/deploy-fiab-commercial.yml');
  const call = wf.indexOf('bash scripts/csa-loom/resolve-health-console-binding.sh');
  const whatIf = wf.indexOf('- name: Bicep what-if (preview)');
  const apply = wf.indexOf('- name: Provision (idempotent)');
  assert.ok(call > 0, 'the workflow no longer calls resolve-health-console-binding.sh');
  assert.ok(whatIf > 0 && apply > 0);
  assert.ok(call < whatIf, 'the resolver must run before the what-if so preview and apply agree');
  assert.ok(call < apply, 'the resolver must run before the apply');
});

for (const lane of ['gcc', 'gcch', 'il5']) {
  test(`deploy-fiab-${lane}.yml calls the resolver before its what-if`, () => {
    const wf = read(`.github/workflows/deploy-fiab-${lane}.yml`);
    const call = wf.indexOf('bash scripts/csa-loom/resolve-health-console-binding.sh');
    const whatIf = wf.indexOf('- name: Bicep what-if');
    assert.ok(call > 0, `${lane}: resolver call missing`);
    assert.ok(whatIf > 0 && call < whatIf, `${lane}: resolver must precede the what-if`);
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
