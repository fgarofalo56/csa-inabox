/**
 * assert-lake-binding.test.mjs — the deploy must refuse to DELETE the lake
 * wiring off a console that has a lake (#3701).
 *
 * MUTATION-PROVED. Every assertion is exercised in both directions: the shape
 * that must PASS and the shape that must FAIL. The defect this guards was green
 * for three consecutive nightly runs, so "it passed" is not evidence of
 * anything on its own (`csa_loom_gates_that_cannot_fail`).
 *
 * The live-read path is driven through an INJECTED runner rather than a stub of
 * the code under test, so what is exercised is the real classification of a real
 * `az graph query` result shape — including the shapes that must come back
 * UNKNOWN rather than "no lake" (`csa_loom_unknown_as_negative_class`).
 *
 * Run: node --test scripts/ci/__tests__/assert-lake-binding.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT,
  HNS_QUERY,
  adoptName,
  useSingleDlz,
  effectiveTopology,
  paramValue,
  composeLakeBinding,
  verdict,
  verifyControls,
  readEstateLakes,
} from '../assert-lake-binding.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'ci', 'assert-lake-binding.mjs');

/** The live Commercial estate as run 31898068403 measured it. */
const LIVE_PLAN = {
  'storage-adls': {
    mode: 'adopt',
    target: { name: 'saloomdefaulttr4nm4dcgsq', rg: 'rg-csa-loom-dlz-default-centralus', sub: 'SUB-DLZ' },
  },
  synapse: { mode: 'adopt', target: { name: 'syn-loom-default-centralus' } },
};

// ── the embedded controls ───────────────────────────────────────────────────

test('the script carries controls, and they all pass', () => {
  const { total, failures } = verifyControls();
  assert.equal(failures.length, 0, `controls disagreed: ${failures.join('; ')}`);
  assert.ok(total >= 8, `expected >= 8 control fixtures, found ${total} — the control set was gutted`);
});

// ── mirroring main.bicep ────────────────────────────────────────────────────

test('adoptName mirrors bicep: only mode=adopt yields a name', () => {
  assert.equal(adoptName(LIVE_PLAN, 'storage-adls'), 'saloomdefaulttr4nm4dcgsq');
  assert.equal(adoptName({ 'storage-adls': { mode: 'create', target: { name: 'sa' } } }, 'storage-adls'), '');
  assert.equal(adoptName({ 'storage-adls': { target: { name: 'sa' } } }, 'storage-adls'), '', 'a missing mode defaults to create');
  assert.equal(adoptName({}, 'storage-adls'), '');
  assert.equal(adoptName(null, 'storage-adls'), '');
});

test('useSingleDlz mirrors main.bicep:1116-1119 for every topology', () => {
  assert.equal(useSingleDlz('single-sub'), true);
  assert.equal(useSingleDlz('tenant'), false, 'tenant sets deployLandingZones=false — this is the #3701 branch');
  assert.equal(useSingleDlz('dlz-attach'), false);
  assert.equal(useSingleDlz('multi-sub'), false);
});

test('an empty workflow topology leaves the param file value standing', () => {
  // The compose step only appends `--parameters topology=…` when the env var is
  // non-empty, and it is empty on a schedule. So the nightly deploys 'tenant'.
  assert.equal(
    effectiveTopology({ topology: '', paramTopology: 'tenant', deploymentMode: 'single-sub', paramDeploymentMode: 'single-sub' }),
    'tenant',
  );
  assert.equal(
    effectiveTopology({ topology: 'dlz-attach', paramTopology: 'tenant' }),
    'dlz-attach',
    'an explicit topology overrides the param file',
  );
  assert.equal(
    effectiveTopology({ topology: '', paramTopology: '', deploymentMode: '', paramDeploymentMode: 'single-sub' }),
    'single-sub',
    'with no topology anywhere, bicep falls through to deploymentMode',
  );
});

test('paramValue reads the real commercial.bicepparam, and fails to invent one', () => {
  const text = "param deploymentMode = 'single-sub'\n\nparam topology = 'tenant'\n";
  assert.equal(paramValue(text, 'topology'), 'tenant');
  assert.equal(paramValue(text, 'deploymentMode'), 'single-sub');
  assert.equal(paramValue(text, 'notAParam'), null);
  assert.equal(paramValue('', 'topology'), null);
});

// ── the verdict ─────────────────────────────────────────────────────────────

test('THE #3701 NIGHTLY: empty plan + tenant + an estate that HAS a lake is DESTRUCTIVE', () => {
  const v = verdict(composeLakeBinding({ adoptPlan: {}, topology: 'tenant' }), {
    status: 'present',
    accounts: ['saloomdefaulttr4nm4dcgsq'],
  });
  assert.equal(v.code, EXIT.DESTRUCTIVE);
  assert.ok(/LOOM_BRONZE_URL/.test(v.message), 'the refusal must name what would be deleted');
  assert.ok(/saloomdefaulttr4nm4dcgsq/.test(v.message), 'the refusal must name the lake it measured');
});

test('THE CONTROL: the same estate with the lake ADOPTED passes', () => {
  // Run 31898068403 (dispatch) vs 31870181337/31932209496/32004118361 (schedule).
  // Same code, same estate; only the adopt plan differs. The verdict must move.
  const v = verdict(composeLakeBinding({ adoptPlan: LIVE_PLAN, topology: 'tenant' }), {
    status: 'present',
    accounts: ['saloomdefaulttr4nm4dcgsq'],
  });
  assert.equal(v.code, EXIT.OK);
});

test('GREENFIELD is unaffected: empty plan + no lake in the estate is consistent', () => {
  const v = verdict(composeLakeBinding({ adoptPlan: {}, topology: 'tenant' }), { status: 'absent', accounts: [] });
  assert.equal(v.code, EXIT.OK);
});

test('single-sub still binds via the convention branch, so an empty plan is not destructive', () => {
  const v = verdict(composeLakeBinding({ adoptPlan: {}, topology: 'single-sub' }), {
    status: 'present',
    accounts: ['saloomdefaultabc'],
  });
  assert.equal(v.code, EXIT.OK);
});

test('an UNREADABLE estate is UNKNOWN and refuses — never rendered as "no lake"', () => {
  const v = verdict(composeLakeBinding({ adoptPlan: {}, topology: 'tenant' }), {
    status: 'unknown',
    reason: 'az graph query exited 1: AuthorizationFailed',
  });
  assert.equal(v.code, EXIT.UNKNOWN);
  assert.ok(/UNKNOWN, not "no lake"/.test(v.message));
  assert.ok(/AuthorizationFailed/.test(v.message), 'the cause must be carried, not swallowed (R7)');
});

// ── the live read ───────────────────────────────────────────────────────────

test('the HNS query scopes to Loom resource groups and to HNS accounts only', () => {
  assert.match(HNS_QUERY, /isHnsEnabled == true/);
  assert.match(HNS_QUERY, /rg-csa-loom-/);
  assert.match(HNS_QUERY, /microsoft\.storage\/storageaccounts/i);
});

test('readEstateLakes filters to the estate region, and reports UNKNOWN honestly', () => {
  const rows = [
    { name: 'saloomdefaulttr4nm4dcgsq', location: 'centralus', resourceGroup: 'rg-csa-loom-dlz-default-centralus' },
    { name: 'saloomotherestate', location: 'eastus2', resourceGroup: 'rg-csa-loom-dlz-default-eastus2' },
  ];
  const ok = (payload) => () => ({ status: 0, stdout: JSON.stringify(payload), stderr: '' });

  assert.deepEqual(readEstateLakes('centralus', ok({ data: rows })), {
    status: 'present',
    accounts: ['saloomdefaulttr4nm4dcgsq'],
  });
  assert.deepEqual(readEstateLakes('westus3', ok({ data: rows })), { status: 'absent', accounts: [] });

  // A failed query is UNKNOWN and carries the stderr — the exact class of bug
  // deploy-integrity R7 exists for.
  const failed = readEstateLakes('centralus', () => ({ status: 1, stdout: '', stderr: 'AuthorizationFailed' }));
  assert.equal(failed.status, 'unknown');
  assert.match(failed.reason, /AuthorizationFailed/);

  // Not-JSON and no-`data` are UNKNOWN too, never "absent".
  assert.equal(readEstateLakes('centralus', () => ({ status: 0, stdout: 'not json', stderr: '' })).status, 'unknown');
  assert.equal(readEstateLakes('centralus', () => ({ status: 0, stdout: '{"nope":1}', stderr: '' })).status, 'unknown');
});

// ── the CLI ─────────────────────────────────────────────────────────────────

/** Run the real script; returns {code, stdout, stderr} without throwing. */
function runCli(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

test('the CLI refuses without a region rather than measuring a different estate', () => {
  const r = runCli(['--adopt-json', '{}']);
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.stderr, /--region is required/);
});

test('the CLI refuses malformed --adopt-json as a DEFECT, not as an empty plan', () => {
  const r = runCli(['--region', 'centralus', '--adopt-json', '{not json']);
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.stderr, /not valid JSON/);
});

test('the CLI has a discovery floor on the param file', () => {
  const r = runCli(['--region', 'centralus', '--adopt-json', '{}', '--param-file', SCRIPT]);
  assert.equal(r.code, EXIT.UNKNOWN);
  assert.match(r.stderr, /DISCOVERY FLOOR/);
});

test('the real commercial.bicepparam still pins the topology this check reasons about', () => {
  // If someone changes `param topology`, the #3701 branch analysis changes with
  // it. This is the coupling made explicit rather than left as an assumption.
  const text = readFileSync(
    path.join(REPO_ROOT, 'platform', 'fiab', 'bicep', 'params', 'commercial.bicepparam'), 'utf8',
  );
  const t = paramValue(text, 'topology');
  assert.ok(t, 'commercial.bicepparam no longer declares `param topology` — re-derive the branch analysis');
  assert.equal(useSingleDlz(t), false,
    `commercial.bicepparam pins topology='${t}'. useSingleDlz is now ${useSingleDlz(t)}; if that ever ` +
    'becomes true the adopt plan stops being the only source of loomStorageAccount and this guard ' +
    'needs revisiting.');
});
