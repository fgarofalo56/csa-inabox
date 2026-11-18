/**
 * deploy-health.yml auto-bind (#5346): the control plane audiences are RESOLVED, and the console is BOUND.
 *
 * Defect (run 44235231240): control_plane_audiences left empty gave a GREEN run with no control
 * plane and no TLS. These tests EXECUTE the two step scripts under bash with a stub `az`, so they fail
 * on behaviour, not on spelling. Breaking values (assertion-design.md):
 *   - resolve step, full run, no input, no variable, Entra finds ZERO apps: must exit non-zero. The
 *     old workflow (no resolution) would exit 0 with empty audiences -> test 1 RED.
 *   - Entra finds TWO apps: must exit non-zero (never guess) -> test 2 RED if it picks the first.
 *   - Entra finds one app X: audiences must be exactly `X,api://X` -> test 3 RED on any other shape.
 *   - input wins and az is NEVER called -> test 4 RED if the lookup runs first.
 *   - an `az ad app list` that errors must say UNKNOWN, not "found 0" (R7) -> test 5.
 *   - bind step: the three env vars written to the one console, with api:// audience preferred.
 *   - bind step: read-back that does not carry the value must FAIL (the write is not trusted).
 * STUB_AZ_REPO_ROOT points the suite at a sandbox copy for mutation runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.STUB_AZ_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const wf = readFileSync(resolve(root, '.github/workflows/deploy-health.yml'), 'utf8').replace(/\r\n/g, '\n');

function stepScript(name) {
  const start = wf.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `step ${name} not found`);
  const rest = wf.slice(start + 1);
  const next = rest.search(/\n {6}- name: |\n {6}# /);
  const block = next < 0 ? rest : rest.slice(0, next);
  const m = block.match(/\n {8}run: \|\n([\s\S]*)$/);
  assert.ok(m, `step ${name} has no run block`);
  return m[1].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
}

const APP = '11111111-2222-4333-8444-555555555555';
const APP2 = '66666666-7777-4888-8999-000000000000';

function sandbox(azBody, step, env, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dhab-'));
  mkdirSync(join(dir, 'temp'));
  mkdirSync(join(dir, 'bin'));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  writeFileSync(join(dir, 'bin', 'az'), `#!/bin/bash\necho "$*" >> "${dir.replace(/\\/g, '/')}/az-calls.log"\n${azBody}\n`);
  chmodSync(join(dir, 'bin', 'az'), 0o755);
  writeFileSync(join(dir, 'out.txt'), '');
  writeFileSync(join(dir, 'summary.md'), '');
  writeFileSync(join(dir, 'step.sh'), stepScript(step));
  const d = dir.replace(/\\/g, '/');
  const r = spawnSync('bash', ['-e', 'step.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, GITHUB_OUTPUT: `${d}/out.txt`, GITHUB_STEP_SUMMARY: `${d}/summary.md`, BOUNDARY: 'Commercial', ...env },
  });
  const read = (f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };
  return { ...r, out: `${r.stdout}\n${r.stderr}`, outputs: read('out.txt'), calls: read('az-calls.log'), summary: read('summary.md') };
}

const resolveStep = 'Resolve the control plane token audiences';
const base = { RUN_MODE: 'full', AUD_INPUT: '', CP_APP_VAR: '' };

test('full run, nothing supplied, Entra finds ZERO loom-health-cp apps: FAILS, never a green no-op', () => {
  const r = sandbox(`echo '[]'`, resolveStep, base);
  assert.notEqual(r.status, 0, 'an unresolvable audience on a full run must fail the step');
  assert.match(r.out, /::error::found 0 Entra apps named loom-health-cp/);
  assert.match(r.outputs, /resolved=false/);
  assert.doesNotMatch(r.outputs, /audiences=\S/);
});

test('two apps with the name: FAILS rather than guessing', () => {
  const r = sandbox(`echo '["${APP}","${APP2}"]'`, resolveStep, base);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /found 2 Entra apps/);
  assert.doesNotMatch(r.outputs, new RegExp(APP));
});

test('exactly one app: audiences are exactly <appId>,api://<appId>', () => {
  const r = sandbox(`echo '["${APP}"]'`, resolveStep, base);
  assert.equal(r.status, 0, r.out);
  assert.match(r.outputs, /resolved=true/);
  assert.ok(r.outputs.split('\n').includes(`audiences=${APP},api://${APP}`), `got: ${r.outputs}`);
  assert.match(r.calls, /ad app list --filter displayName eq 'loom-health-cp'/);
});

test('the dispatch input wins and Entra is never queried; the repo variable beats Entra', () => {
  const typed = sandbox(`echo '["${APP2}"]'`, resolveStep, { ...base, AUD_INPUT: 'api://typed' });
  assert.equal(typed.status, 0, typed.out);
  assert.ok(typed.outputs.split('\n').includes('audiences=api://typed'));
  assert.equal(typed.calls, '', 'az must not be called when the input is supplied');
  const viaVar = sandbox(`echo '["${APP2}"]'`, resolveStep, { ...base, CP_APP_VAR: APP });
  assert.equal(viaVar.status, 0, viaVar.out);
  assert.ok(viaVar.outputs.split('\n').includes(`audiences=${APP},api://${APP}`));
  assert.equal(viaVar.calls, '', 'the variable must beat the lookup');
});

test('an Entra read that ERRORS says UNKNOWN, not "found 0" (R7), and a non-GUID variable fails', () => {
  const r = sandbox(`echo 'Insufficient privileges' >&2; exit 1`, resolveStep, base);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /UNKNOWN/);
  assert.doesNotMatch(r.out, /found 0/);
  const bad = sandbox(`echo '[]'`, resolveStep, { ...base, CP_APP_VAR: 'not-a-guid' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.out, /is not a GUID/);
});

test('what-if with nothing resolvable WARNS and continues (applies nothing), outputs resolved=false', () => {
  const r = sandbox(`echo '[]'`, resolveStep, { ...base, RUN_MODE: 'whatif-only' });
  assert.equal(r.status, 0, 'a what-if is read-only and must not fail the run');
  assert.match(r.out, /::warning::found 0 Entra apps/);
  assert.match(r.outputs, /resolved=false/);
});

// ── bind step ────────────────────────────────────────────────────────────────────────────────────
const bindStep = 'Bind the health control plane into the console';
const deployed = JSON.stringify({
  healthControlPlaneState: { value: { deployed: true, fqdn: 'loom-health-cp.example.azurecontainerapps.io' } },
  healthStamp: { value: { stampName: 'dev01' } },
});
const bindEnv = { RUN_MODE: 'full', AUDIENCES: `${APP},api://${APP}` };
// Stub console: `list` returns an app with no health env; `update` records; `show` returns what the stub
// was told to (STATE file), so read-back can be made to lie.
function consoleAz(showJson, listEnv = '[]') {
  return `case "$*" in
  *"containerapp list"*) echo '[{"id":"/x","rg":"rg-admin","env":${listEnv}}]';;
  *"containerapp update"*) exit 0;;
  *"containerapp show"*) echo '${showJson}';;
  *) exit 0;;
esac`;
}
const goodShow = JSON.stringify([
  { name: 'LOOM_HEALTH_CP_URL', value: 'https://loom-health-cp.example.azurecontainerapps.io' },
  { name: 'LOOM_HEALTH_CP_AUDIENCE', value: `api://${APP}` },
  { name: 'LOOM_HEALTH_DEFAULT_STAMP_ID', value: 'dev01' },
]);

test('bind: writes the three vars to loom-console, api:// audience first, and reads them back', () => {
  const r = sandbox(consoleAz(goodShow), bindStep, bindEnv, { 'temp/outputs.json': deployed });
  assert.equal(r.status, 0, r.out);
  assert.match(r.calls, /containerapp update -n loom-console -g rg-admin --set-env-vars LOOM_HEALTH_CP_URL=https:\/\/loom-health-cp\.example\.azurecontainerapps\.io LOOM_HEALTH_CP_AUDIENCE=api:\/\/11111111-2222-4333-8444-555555555555 LOOM_HEALTH_DEFAULT_STAMP_ID=dev01 -o none/);
  assert.match(r.summary, /console bound/);
});

test('bind: a read-back that does not carry the value FAILS the step', () => {
  const lying = JSON.stringify([{ name: 'LOOM_HEALTH_CP_URL', value: 'https://stale' }]);
  const r = sandbox(consoleAz(lying), bindStep, bindEnv, { 'temp/outputs.json': deployed });
  assert.notEqual(r.status, 0, 'a write that is not read back must not pass');
  assert.match(r.out, /Read-back FAILED.*LOOM_HEALTH_CP_URL.*LOOM_HEALTH_CP_AUDIENCE.*LOOM_HEALTH_DEFAULT_STAMP_ID/);
});

test('bind: an already-bound console is not rewritten (no new revision)', () => {
  const same = JSON.parse(goodShow);
  const r = sandbox(consoleAz(goodShow, JSON.stringify(same)), bindStep, bindEnv, { 'temp/outputs.json': deployed });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.calls, /containerapp update/);
  assert.match(r.out, /nothing written/);
});

test('bind: control plane not deployed means nothing to bind, and az is never called', () => {
  const none = JSON.stringify({ healthControlPlaneState: { value: { deployed: false, reason: 'r' } }, healthStamp: { value: { stampName: 'dev01' } } });
  const r = sandbox(consoleAz(goodShow), bindStep, bindEnv, { 'temp/outputs.json': none });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.calls, '');
});

test('bind: two loom-console apps is ambiguous and fails; the update is not attempted', () => {
  const two = `case "$*" in *"containerapp list"*) echo '[{"id":"/a","rg":"a","env":[]},{"id":"/b","rg":"b","env":[]}]';; *) exit 0;; esac`;
  const r = sandbox(two, bindStep, bindEnv, { 'temp/outputs.json': deployed });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /Found 2 Container Apps named loom-console/);
  assert.doesNotMatch(r.calls, /containerapp update/);
});

test('R7: az exits 0 with GARBAGE output: the resolve step says UNKNOWN and never claims a count', () => {
  // Breaks if: jq fails on non-JSON and the message still asserts "found <n> Entra apps" (a count never established).
  const r = sandbox(`echo 'WARNING: not json at all'`, resolveStep, base);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /could not be parsed.*UNKNOWN/);
  assert.doesNotMatch(r.out, /found \d* ?Entra apps/);
});

test('R7: the bind step, az list exits 0 with GARBAGE: says UNKNOWN, no count claim, no update', () => {
  const garbage = `case "$*" in *"containerapp list"*) echo 'oops <html>';; *) exit 0;; esac`;
  const r = sandbox(garbage, bindStep, bindEnv, { 'temp/outputs.json': deployed });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /could not be parsed.*UNKNOWN/);
  assert.doesNotMatch(r.out, /Found \d* ?Container Apps/);
  assert.doesNotMatch(r.calls, /containerapp update/);
});
