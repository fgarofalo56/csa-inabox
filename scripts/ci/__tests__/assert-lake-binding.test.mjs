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
import { readFileSync, readdirSync } from 'node:fs';
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
  deployAdminPlane,
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

// ===========================================================================
// PR #3703 review — three false-refusal / false-claim paths the first revision
// would have shipped. Each is a state where the guard said NO about something
// that cannot produce the harm it guards, which is how a P0 fix turns into a
// nightly hard-failure.
// ===========================================================================

test('REVIEW-1: a BOUND binding proceeds even when the estate read FAILED', () => {
  // The first revision tested `estate.status === 'unknown'` BEFORE
  // `binding.bound`, so one transient Resource Graph 503 hard-failed the whole
  // P0 reconcile on a run whose adopt plan already carried `storage-adls` —
  // a run provably about to EMIT the seven vars, not remove them.
  const bound = composeLakeBinding({
    adoptPlan: { 'storage-adls': { mode: 'adopt', target: { name: 'saloomdefaulttr4nm4dcgsq' } } },
    topology: 'tenant',
  });
  assert.equal(bound.bound, true, 'precondition: this plan must produce a bound binding');
  const v = verdict(bound, { status: 'unknown', reason: 'transient ARG 503' }, { topology: 'tenant' });
  assert.equal(v.code, EXIT.OK, v.message);
  assert.doesNotMatch(v.message, /EMPTY/,
    'the refusal text claimed the binding was empty — false when it is bound (deploy-integrity R7)');
});

test('REVIEW-1 CONTROL: an EMPTY binding with an unreadable estate still REFUSES', () => {
  // The fix must not have turned the guard off. This is the state where the
  // estate read is genuinely load-bearing.
  const empty = composeLakeBinding({ adoptPlan: {}, topology: 'tenant' });
  assert.equal(empty.bound, false);
  const v = verdict(empty, { status: 'unknown', reason: 'ARG 503' }, { topology: 'tenant' });
  assert.equal(v.code, EXIT.UNKNOWN, v.message);
});

test('REVIEW-5: dlz-attach deploys no admin plane, so an empty binding is not destructive', () => {
  // main.bicep:1114 `deployAdminPlane = effectiveTopology != 'dlz-attach'`, and
  // both `resource adminPlaneRg` (1149) and `module adminPlane` (1159) are gated
  // on it. The console env array is never re-rendered, so nothing can be removed.
  assert.equal(deployAdminPlane('dlz-attach'), false);
  assert.equal(deployAdminPlane('tenant'), true);
  assert.equal(deployAdminPlane('single-sub'), true);

  const empty = composeLakeBinding({ adoptPlan: {}, topology: 'dlz-attach' });
  assert.equal(empty.bound, false, 'precondition: dlz-attach does not take the single-DLZ branch');
  for (const estate of [{ status: 'present', accounts: ['sa1'] }, { status: 'unknown', reason: 'x' }]) {
    const v = verdict(empty, estate, { topology: 'dlz-attach' });
    assert.equal(v.code, EXIT.OK, `dlz-attach + estate=${estate.status}: ${v.message}`);
  }
});

test('REVIEW-5 CONTROL: the SAME empty binding on `tenant` is still DESTRUCTIVE', () => {
  // Proves the dlz-attach exemption is keyed on the topology and has not
  // weakened the case the guard exists for.
  const empty = composeLakeBinding({ adoptPlan: {}, topology: 'tenant' });
  const v = verdict(empty, { status: 'present', accounts: ['sa1'] }, { topology: 'tenant' });
  assert.equal(v.code, EXIT.DESTRUCTIVE, v.message);
});

test('an UNCLASSIFIED estate status never becomes a confident verdict', () => {
  // `not-read` is produced when the estate read is skipped as irrelevant. If it
  // ever leaked into the destructive branch, the earlier code would have
  // returned DESTRUCTIVE — a verdict asserted from a read that never happened.
  const empty = composeLakeBinding({ adoptPlan: {}, topology: 'tenant' });
  const v = verdict(empty, { status: 'not-read' }, { topology: 'tenant' });
  assert.equal(v.code, EXIT.UNKNOWN, v.message);
  assert.match(v.message, /INTERNAL/);
});

test('the embedded controls cover the review cases, and still all pass', () => {
  const { total, failures } = verifyControls();
  assert.deepEqual(failures, [], failures.join('\n'));
  assert.ok(total >= 10, `expected the fixture set to have grown past 8, got ${total}`);
});

// ── #3317: the SAME adopt-plan binding shape, for Service Bus and Batch ──────
//
// The lake defect above (#3701/#3327) was one instance of a class: a console
// coordinate derived from the single-sub NAMING CONVENTION alone, on an estate
// where `useSingleDlz` is false. Service Bus and Azure Batch were two more.
// These cases model main.bicep's composition for both and tie the model to the
// template, so the mirror cannot drift away from what actually deploys.

const MAIN_BICEP = readFileSync(path.join(REPO_ROOT, 'platform', 'fiab', 'bicep', 'main.bicep'), 'utf8');
const ADMIN_PLANE_BICEP = readFileSync(
  path.join(REPO_ROOT, 'platform', 'fiab', 'bicep', 'modules', 'admin-plane', 'main.bicep'),
  'utf8',
);
const DISCOVER_SH = readFileSync(
  path.join(REPO_ROOT, 'scripts', 'csa-loom', 'discover-dlz-adopt-plan.sh'),
  'utf8',
);

/** Every params file Loom actually ships, with the topology it pins. */
function shippedTopologies() {
  const dir = path.join(REPO_ROOT, 'platform', 'fiab', 'bicep', 'params');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.bicepparam'))
    .map((f) => {
      const text = readFileSync(path.join(dir, f), 'utf8');
      return {
        file: f,
        topology: effectiveTopology({
          topology: '',
          paramTopology: paramValue(text, 'topology'),
          deploymentMode: '',
          paramDeploymentMode: paramValue(text, 'deploymentMode'),
        }),
      };
    });
}

/**
 * What `byoExisting.serviceBusNamespace` composes to (main.bicep).
 *
 * Adopt-first, convention as fallback. The convention branch produces a literal
 * this side CAN compute (`sbns-loom-default-<region>`), unlike the lake's
 * uniqueString, so it is returned rather than reported as unknown.
 */
function composeServiceBusBinding({ adoptPlan, topology, deployServiceBus = true, location = 'centralus' }) {
  const adopted = adoptName(adoptPlan, 'servicebus');
  if (adopted) return { bound: true, name: adopted, source: 'adopt-plan' };
  if (useSingleDlz(topology) && deployServiceBus) {
    return { bound: true, name: `sbns-loom-default-${location}`, source: 'single-dlz-convention' };
  }
  return { bound: false, name: '', source: 'none' };
}

/** What `byoExisting.batchAccount` composes to (main.bicep). */
function composeBatchBinding({ adoptPlan, topology, batchEnabled = true }) {
  const adopted = adoptName(adoptPlan, 'batch');
  if (adopted) return { bound: true, name: adopted, source: 'adopt-plan' };
  if (useSingleDlz(topology) && batchEnabled) {
    return { bound: true, name: null, source: 'single-dlz-convention' };
  }
  return { bound: false, name: '', source: 'none' };
}

/** A DLZ the discovery script would emit — same rg/sub for every key, as it does. */
const SVC_PLAN = {
  servicebus: { mode: 'adopt', target: { name: 'sb-loom-tr4nm4dcgsq', rg: 'rg-csa-loom-dlz-default-centralus', sub: 'SUB-DLZ' } },
  batch: { mode: 'adopt', target: { name: 'batchloomtr4nm4dcgsq', rg: 'rg-csa-loom-dlz-default-centralus', sub: 'SUB-DLZ' } },
};

test('#3317 THE DEFECT: with no adopt plan, BOTH bind empty on every shipped params file', () => {
  const shipped = shippedTopologies();
  assert.ok(shipped.length >= 5, `expected the shipped params set, found ${shipped.length}`);
  const bindable = shipped.filter((s) => useSingleDlz(s.topology));
  assert.deepEqual(
    bindable.map((s) => s.file),
    [],
    'precondition: NO shipped params file is single-sub, so the convention branch never fires',
  );
  for (const { file, topology } of shipped) {
    assert.equal(composeServiceBusBinding({ adoptPlan: {}, topology }).name, '', `${file}: LOOM_SERVICEBUS_NAMESPACE`);
    assert.equal(composeBatchBinding({ adoptPlan: {}, topology }).name, '', `${file}: LOOM_BATCH_ACCOUNT`);
  }
});

test('#3317 THE FIX: an adopt plan binds both on every shipped params file', () => {
  for (const { file, topology } of shippedTopologies()) {
    const sb = composeServiceBusBinding({ adoptPlan: SVC_PLAN, topology });
    const batch = composeBatchBinding({ adoptPlan: SVC_PLAN, topology });
    assert.equal(sb.name, 'sb-loom-tr4nm4dcgsq', `${file}: Service Bus`);
    assert.equal(sb.source, 'adopt-plan', `${file}: must come from the plan, not a convention`);
    assert.equal(batch.name, 'batchloomtr4nm4dcgsq', `${file}: Batch`);
    assert.equal(batch.source, 'adopt-plan', `${file}: must come from the plan, not a convention`);
  }
});

test('#3317 mode=create is still create — an adopt plan cannot be faked by a legacy target', () => {
  const created = { servicebus: { mode: 'create', target: { name: 'sb-x' } }, batch: { target: { name: 'b-x' } } };
  assert.equal(composeServiceBusBinding({ adoptPlan: created, topology: 'tenant' }).name, '');
  assert.equal(composeBatchBinding({ adoptPlan: created, topology: 'tenant' }).name, '');
});

test('#3317 single-sub keeps its convention fallback — the fix is additive, not a replacement', () => {
  assert.equal(
    composeServiceBusBinding({ adoptPlan: {}, topology: 'single-sub' }).source,
    'single-dlz-convention',
  );
  assert.equal(composeBatchBinding({ adoptPlan: {}, topology: 'single-sub' }).source, 'single-dlz-convention');
});

// ── ties: the model above must describe the template that actually deploys ───

test('#3317 TIE: main.bicep composes both coordinates adopt-first', () => {
  for (const key of ['servicebus', 'batch']) {
    assert.match(
      MAIN_BICEP,
      new RegExp(`adoptName\\(adopt, '${key}'\\)`),
      `main.bicep must read the adopt plan for '${key}' — without it the binding is convention-only and renders '' on every shipped boundary`,
    );
  }
  // The RG must travel with the name, or the console names a real resource in
  // the wrong resource group.
  assert.match(MAIN_BICEP, /adoptRg\(adopt, 'servicebus'\)/);
  assert.match(MAIN_BICEP, /adoptSub\(adopt, 'servicebus'\)/);
  assert.match(MAIN_BICEP, /adoptRg\(adopt, 'batch'\)/);
});

test('#3317 TIE: admin-plane honours the adopted Service Bus RG/sub instead of assuming the DLZ', () => {
  assert.doesNotMatch(
    ADMIN_PLANE_BICEP,
    /^var effServiceBusRg\s+= loomDlzRg$/m,
    'effServiceBusRg must not be an unconditional loomDlzRg — an adopted namespace lives where the plan says',
  );
  assert.match(ADMIN_PLANE_BICEP, /var effServiceBusRg\s+= !empty\(loomServiceBusRgIn\)/);
  assert.match(ADMIN_PLANE_BICEP, /var effServiceBusSub\s+= !empty\(loomServiceBusSubIn\)/);
  // Batch already honoured byoExisting.batchRg; pin that it still does.
  assert.match(ADMIN_PLANE_BICEP, /var loomBatchRg\s+= !empty\(byoExisting\.\?batchRg \?\? ''\)/);
});

test('#3317 TIE: the discovery script emits both keys, read BY RESOURCE TYPE', () => {
  assert.match(DISCOVER_SH, /add "servicebus"/, 'the plan must carry a servicebus key');
  assert.match(DISCOVER_SH, /add "batch"/, 'the plan must carry a batch key');
  // By type, never by a derived name: the live namespace is sb-loom-<hash>,
  // which the sbns-loom-default-<region> convention would never have matched.
  assert.match(DISCOVER_SH, /--resource-type Microsoft\.ServiceBus\/namespaces/);
  assert.match(DISCOVER_SH, /--resource-type Microsoft\.Batch\/batchAccounts/);
});

