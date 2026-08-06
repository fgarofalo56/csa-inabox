/**
 * deploy-retry.test.mjs — proves the retry harness CAN FAIL.
 *
 * A retry loop is only a gate if exhausting it is red. The specific mutation
 * proof deploy-integrity.md R6 demands is here as
 * "a permanently-failing TRANSIENT dependency still goes RED after the budget":
 * that is the case a naive `for attempt in 1 2 3; do … done` gets right by
 * accident and a `|| true` gets wrong silently.
 *
 * The child commands are real processes (node -e) writing real stderr, so this
 * exercises spawn, capture, classification and exit propagation end to end —
 * not a mocked stand-in that models the code rather than reality
 * (csa_loom_fixtures_that_model_the_code).
 *
 * Run: node --test scripts/ci/__tests__/deploy-retry.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  decideRetry,
  decideRetryForLeaves,
  effectiveBackoffBase,
  backoffMs,
  parseDuration,
  planRemediation,
  parseArgs,
  redact,
  armDrilldown,
  USAGE_EXIT,
} from '../deploy-retry.mjs';
import { classify, classifyLeaves, TAXONOMY } from '../deploy-classify.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '..', 'deploy-retry.mjs');

// NOTE: deliberately NOT named `tmpdir` — a local helper with that name shadows
// `os.tmpdir` to every reader AND to scripts/ci/check-temp-artifact-safety.mjs,
// which then flags `path.join(scratchDir(), '<const>')` as a shared-temp-root write.
// It is a fresh mkdtemp directory; the name now says so.
function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-retry-test-'));
}

/**
 * A child that always fails with the given stderr, and records each invocation
 * so the test can assert HOW MANY TIMES it actually ran.
 */
function alwaysFails(counterFile, stderr) {
  return [
    process.execPath,
    '-e',
    `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counterFile)},'x');` +
      `process.stderr.write(${JSON.stringify(stderr)});process.exit(1);`,
  ];
}

/** A child that fails `failTimes` times, then succeeds. */
function failsThenSucceeds(counterFile, stderr, failTimes) {
  return [
    process.execPath,
    '-e',
    `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counterFile)},'x');` +
      `const n=fs.readFileSync(${JSON.stringify(counterFile)},'utf8').length;` +
      `if(n<=${failTimes}){process.stderr.write(${JSON.stringify(stderr)});process.exit(1);}` +
      `process.exit(0);`,
  ];
}

function runRetry(extraArgs, cmd) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs, '--', ...cmd], { encoding: 'utf8' });
}

const TRANSIENT = 'ERROR: (ContainerAppOperationInProgress) There is an active provisioning operation.\n';
const QUOTA =
  'ERROR: QuotaExceeded: standardDDSv5Family Cores, Location: centralus, Current Limit: 200, Current Usage: 196\n';
const MYSTERY = 'ERROR: (SomeCodeNobodyHasEverSeen) the widget frobnicator declined\n';

// ── THE MUTATION PROOF: the retry must be able to fail ───────────────────────

test('MUTATION PROOF — a permanently-failing TRANSIENT dependency goes RED after the budget', () => {
  const dir = scratchDir();
  const counter = path.join(dir, 'n');
  fs.writeFileSync(counter, '');
  const artifact = path.join(dir, 'deploy-failure.json');

  const r = runRetry(
    [
      '--class-allow', 'transient',
      '--max-attempts', '4',
      '--backoff', '0',      // no wall-clock cost in the test; the DECISION is what is under test
      '--jitter', '0',
      '--step', 'roll',
      '--artifact', artifact,
    ],
    alwaysFails(counter, TRANSIENT),
  );

  assert.notEqual(r.status, 0, 'exhausting the budget MUST be red');
  assert.equal(r.status, TAXONOMY.classes.transient.exitCode, 'exit code carries the class');
  assert.equal(fs.readFileSync(counter, 'utf8').length, 4, 'ran exactly --max-attempts times');
  assert.match(r.stdout, /retry budget exhausted after 4 attempt/);

  const a = JSON.parse(fs.readFileSync(artifact, 'utf8'));
  assert.equal(a.class, 'transient');
  assert.equal(a.attempts.length, 4);
  assert.match(a.whyStopped, /budget exhausted/);
  assert.ok(a.established.length > 0, 'the artifact records what was ESTABLISHED');
});

test('MUTATION PROOF — the wall-clock budget also fails closed', () => {
  const dir = scratchDir();
  const counter = path.join(dir, 'n');
  fs.writeFileSync(counter, '');

  // 1s backoff against a 1ms wall clock: the FIRST failure must stop, because
  // elapsed + next delay already exceeds the budget.
  const r = runRetry(
    ['--class-allow', 'transient', '--max-attempts', '99', '--backoff', '1', '--jitter', '0', '--wall-clock', '1ms'],
    alwaysFails(counter, TRANSIENT),
  );

  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(counter, 'utf8').length, 1);
  assert.match(r.stdout, /wall-clock budget exhausted/);
});

// ── THE HAPPY PATH COSTS NOTHING ─────────────────────────────────────────────

test('happy path — one invocation, zero sleeps, exit 0, no artifact written', () => {
  const dir = scratchDir();
  const counter = path.join(dir, 'n');
  const artifact = path.join(dir, 'deploy-failure.json');
  fs.writeFileSync(counter, '');

  const t0 = Date.now();
  const r = runRetry(
    ['--class-allow', 'transient', '--max-attempts', '6', '--backoff', '30', '--artifact', artifact],
    failsThenSucceeds(counter, TRANSIENT, 0),
  );
  const elapsed = Date.now() - t0;

  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(counter, 'utf8').length, 1, 'exactly one invocation');
  assert.ok(elapsed < 5000, `happy path took ${elapsed}ms — a 30s backoff must not be paid on success`);
  assert.equal(fs.existsSync(artifact), false, 'no failure artifact on success');
});

test('a transient failure that clears is retried and then succeeds', () => {
  const dir = scratchDir();
  const counter = path.join(dir, 'n');
  fs.writeFileSync(counter, '');

  const r = runRetry(
    ['--class-allow', 'transient', '--max-attempts', '5', '--backoff', '0', '--jitter', '0'],
    failsThenSucceeds(counter, TRANSIENT, 2),
  );

  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(counter, 'utf8').length, 3, 'two failures then one success');
  assert.match(r.stdout, /succeeded on attempt 3/);
});

// ── QUOTA IS NEVER RETRIED, AND THE MESSAGE SAYS "QUOTA" ─────────────────────

test('MUTATION PROOF — a quota denial is attempted ONCE and the message names quota', () => {
  const dir = scratchDir();
  const counter = path.join(dir, 'n');
  const artifact = path.join(dir, 'deploy-failure.json');
  fs.writeFileSync(counter, '');

  const r = runRetry(
    // transient IS allowed — proving the refusal comes from CLASSIFICATION, not
    // from an empty allow-list.
    ['--class-allow', 'transient,eventual-consistency', '--max-attempts', '6', '--backoff', '0', '--artifact', artifact],
    alwaysFails(counter, QUOTA),
  );

  assert.equal(fs.readFileSync(counter, 'utf8').length, 1, 'a quota denial must NOT be retried');
  assert.equal(r.status, TAXONOMY.classes.quota.exitCode);
  assert.match(r.stdout, /quota/i, 'the final message names the cause');
  assert.match(r.stdout, /not in --class-allow|not retryable/);

  const a = JSON.parse(fs.readFileSync(artifact, 'utf8'));
  assert.equal(a.class, 'quota');
  assert.equal(a.attempts.length, 1);
});

test('MUTATION PROOF — an UNCLASSIFIABLE failure is attempted once and asserts no cause', () => {
  const dir = scratchDir();
  const counter = path.join(dir, 'n');
  fs.writeFileSync(counter, '');

  const r = runRetry(
    ['--class-allow', 'transient', '--max-attempts', '6', '--backoff', '0'],
    alwaysFails(counter, MYSTERY),
  );

  assert.equal(fs.readFileSync(counter, 'utf8').length, 1);
  assert.equal(r.status, TAXONOMY.classes.unknown.exitCode);
  assert.match(r.stdout, /could not classify/i);
  assert.doesNotMatch(r.stdout, /does not exist/i);
});

test('the FULL stderr is echoed on final failure — never truncated, never swallowed', () => {
  const dir = scratchDir();
  const counter = path.join(dir, 'n');
  fs.writeFileSync(counter, '');
  const noisy = `${QUOTA}line-A-marker\nline-B-marker\n`;

  const r = runRetry(['--class-allow', 'transient', '--backoff', '0'], alwaysFails(counter, noisy));
  assert.match(r.stderr, /full captured stderr/);
  assert.match(r.stderr, /line-A-marker/);
  assert.match(r.stderr, /line-B-marker/);
});

test('a missing binary is a failure, not a silent success', () => {
  const r = runRetry(['--class-allow', 'transient', '--backoff', '0'], [
    path.join(scratchDir(), 'definitely-not-a-real-binary'),
  ]);
  assert.notEqual(r.status, 0);
});

// ── PURE DECISION FUNCTION ───────────────────────────────────────────────────

test('decideRetry — unknown never retries, whatever the allow-list says', () => {
  const d = classify(MYSTERY);
  const r = decideRetry({
    diagnosis: d,
    attempt: 1,
    maxAttempts: 10,
    classAllow: ['unknown', 'transient'],
    elapsedMs: 0,
    wallClockMs: 0,
  });
  assert.equal(r.retry, false);
  assert.match(r.reason, /could not be classified/);
});

test('decideRetry — a non-retryable class is refused even if it is allow-listed', () => {
  const d = classify(QUOTA);
  const r = decideRetry({
    diagnosis: d,
    attempt: 1,
    maxAttempts: 10,
    classAllow: ['quota'],
    elapsedMs: 0,
    wallClockMs: 0,
  });
  assert.equal(r.retry, false);
  assert.match(r.reason, /not retryable in the taxonomy/);
});

test('decideRetry — a retryable, allowed class inside budget retries', () => {
  const d = classify(TRANSIENT);
  const r = decideRetry({
    diagnosis: d,
    attempt: 1,
    maxAttempts: 6,
    classAllow: ['transient'],
    elapsedMs: 0,
    wallClockMs: 600_000,
    nextDelayMs: 30_000,
  });
  assert.equal(r.retry, true);
});

test('parseDuration understands the forms the workflows use', () => {
  assert.equal(parseDuration('20m'), 1_200_000);
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('45'), 45_000);
  assert.equal(parseDuration('1ms'), 1);
  assert.throws(() => parseDuration('soon'));
});

test('backoffMs — jitter only ever adds, and 0 base means no sleep at all', () => {
  assert.equal(backoffMs(0, 0.5, () => 1), 0);
  assert.equal(backoffMs(30, 0, () => 1), 30_000);
  assert.equal(backoffMs(30, 0.3, () => 0), 30_000);
  assert.equal(backoffMs(30, 0.3, () => 1), 39_000);
});

test('parseArgs rejects an unknown flag rather than ignoring it', () => {
  assert.throws(() => parseArgs(['--not-a-flag', 'x']), /unknown argument/);
});

test('CLI usage errors exit 2, distinct from every class exit code', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--class-allow', 'transient'], { encoding: 'utf8' });
  assert.equal(r.status, USAGE_EXIT);
  assert.match(r.stderr, /no command given/);
  const classCodes = Object.values(TAXONOMY.classes).map((c) => c.exitCode);
  assert.equal(classCodes.includes(USAGE_EXIT), false);
});

// ── PLATFORM-PERFORMED REMEDIATION (auto-bind-by-default §5) ─────────────────

test('planRemediation extracts the provider namespace and builds the real command', () => {
  const err = "ERROR: (MissingSubscriptionRegistration) The subscription is not registered to use namespace 'Microsoft.Kusto'.";
  const plan = planRemediation(classify(err), err);
  assert.equal(plan.kind, 'register-provider');
  assert.equal(plan.namespace, 'Microsoft.Kusto');
  assert.deepEqual(plan.argv, ['az', 'provider', 'register', '--namespace', 'Microsoft.Kusto', '--wait']);
});

test('planRemediation refuses to GUESS a namespace it could not read', () => {
  const err = 'ERROR: (MissingSubscriptionRegistration) the subscription is not registered.';
  const plan = planRemediation(classify(err), err);
  assert.equal(plan.namespace, null);
  assert.equal(plan.argv, null, 'no command is built from a namespace that was never established');
});

test('planRemediation performs nothing for classes the platform must not touch unattended', () => {
  assert.equal(planRemediation(classify(QUOTA), QUOTA), null);
  assert.equal(planRemediation(classify(TRANSIENT), TRANSIENT), null);
  assert.equal(planRemediation(classify(MYSTERY), MYSTERY), null);
});

// ── REDACTION ────────────────────────────────────────────────────────────────

test('redact strips subscription ids and bare GUIDs from anything committed or annotated', () => {
  const out = redact(
    'scope /subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/rg-csa-loom-admin-centralus',
  );
  assert.doesNotMatch(out, /11111111-2222/);
  assert.match(out, /rg-csa-loom-admin-centralus/, 'the useful last segment survives');
});

// ── ARM DRILL-DOWN WIRING (issue #3039) ──────────────────────────────────────
//
// deploy-arm-errors.test.mjs proves the walk itself. These prove the WIRING:
// that a found leaf reaches the classifier, and — the part that matters — that
// a drill-down which reads nothing cannot upgrade an unclassified failure into
// anything at all.

const ARM_FIXTURES = path.resolve(import.meta.dirname, '..', '__fixtures__', 'arm-ops-31069329802');

function armFixtureRunner(args) {
  const isGroup = args[2] === 'group';
  const name = args[args.indexOf('--name') + 1];
  const rg = isGroup ? args[args.indexOf('-g') + 1] : null;
  const p = path.join(ARM_FIXTURES, isGroup ? `group--${rg}--${name}.json` : `sub--${name}.json`);
  if (!fs.existsSync(p)) return { status: 1, stdout: '', stderr: `ERROR: (DeploymentNotFound) Deployment '${name}' could not be found.` };
  return { status: 0, stdout: fs.readFileSync(p, 'utf8'), stderr: '' };
}

test('armDrilldown is inert unless --arm-deployment is given', () => {
  assert.equal(armDrilldown(parseArgs(['--', 'az', 'x'])), null);
});

test('a FOUND drill-down is the text that reaches the classifier', () => {
  const args = parseArgs(['--arm-deployment', 'csa-loom-ci-31069329802', '--arm-scope', 'sub', '--', 'az']);
  const d = armDrilldown(args, armFixtureRunner);
  assert.equal(d.result.status, 'found');
  assert.ok(d.classifyText.length > 0);
  assert.equal(classify(`${MYSTERY}\n${d.classifyText}`).class, 'config');
});

test('MUTATION PROOF — a drill-down that reads NOTHING contributes nothing, and unknown stays unknown', () => {
  const args = parseArgs(['--arm-deployment', 'no-such-deployment', '--arm-scope', 'sub', '--', 'az']);
  const d = armDrilldown(args, armFixtureRunner); // fixture miss -> az DeploymentNotFound
  assert.equal(d.result.status, 'unreadable');
  assert.equal(d.classifyText, '', 'an unreadable drill-down must not reach the classifier');
  // The R7 trap this guards: az's OWN failure text matches a taxonomy signal.
  assert.equal(
    classify(d.rendered).signalId,
    'config.resource-group-not-found',
    "az's not-found text does match a signal — which is exactly why it must never be fed in",
  );
  // …and because classifyText is empty, the real verdict is untouched.
  assert.equal(classify(`${MYSTERY}${d.classifyText}`).class, 'unknown');
});

test('MUTATION PROOF — an EMPTY operation list also contributes nothing', () => {
  const args = parseArgs(['--arm-deployment', 'd', '--arm-scope', 'sub', '--', 'az']);
  const d = armDrilldown(args, () => ({ status: 0, stdout: '[]', stderr: '' }));
  assert.equal(d.result.status, 'none');
  assert.equal(d.classifyText, '');
  assert.equal(classify(`${MYSTERY}${d.classifyText}`).class, 'unknown');
});

test('the drill-down flags parse, and an unknown arm flag is still rejected', () => {
  const a = parseArgs([
    '--arm-deployment', 'd', '--arm-scope', 'group', '--arm-resource-group', 'rg',
    '--arm-subscription', 's', '--', 'az',
  ]);
  assert.equal(a.armDeployment, 'd');
  assert.equal(a.armScope, 'group');
  assert.equal(a.armResourceGroup, 'rg');
  assert.equal(a.armSubscription, 's');
  assert.throws(() => parseArgs(['--arm-nope', 'x']), /unknown argument/);
});

// ── D6: the per-leaf decision (run 31100384405) ──────────────────────────────
// THE MUTATION PROOF the task demands. The two leaves below are the REAL
// drilled leaves of that run: one capacity (retryable), one defect
// (deterministic). The old whole-input classify collapsed them to `defect` and
// the capacity leaf was never retried NOR reported retryable. These tests go
// red if per-leaf classification is broken back to the concatenated form
// (verified by mutation: routing decideRetryForLeaves through
// worstLeafDiagnosis alone flips 'capacity-only set is retried' red).

const LEAF_CAPACITY = {
  code: 'CapacityNotAvailable',
  message: 'Capacity is not available in this region/zone. Please retry after some time.',
  resourceType: 'Microsoft.DBforPostgreSQL/flexibleServers',
  resourceName: 'psql-loom-ducklake-k6mvh5sm6z7do',
};
const LEAF_DEFECT = {
  code: 'InvalidTemplate',
  message:
    "Unable to process template language expressions for resource '…/azure-api.net/A/apim-csa-loom-centralus'. 'The language expression property '0' can't be evaluated.'",
  resourceType: 'Microsoft.Network/privateDnsZones/A',
  resourceName: 'azure-api.net/apim-csa-loom-centralus',
};

const CLASS_ALLOW = ['transient', 'eventual-consistency', 'capacity'];
const leafBudget = { attempt: 1, maxAttempts: 4, classAllow: CLASS_ALLOW, elapsedMs: 0, wallClockMs: 0 };

test('D6: a capacity-only leaf set IS retried (the leaf run 31100384405 never retried)', () => {
  const d = decideRetryForLeaves({ ...leafBudget, leafDiagnoses: classifyLeaves([LEAF_CAPACITY]) });
  assert.equal(d.retry, true, 'a lone retryable capacity leaf must be retried');
});

test('D6: capacity + defect => NOT retried, the defect is named, AND the capacity leaf is still reported retryable', () => {
  const d = decideRetryForLeaves({ ...leafBudget, leafDiagnoses: classifyLeaves([LEAF_CAPACITY, LEAF_DEFECT]) });
  assert.equal(d.retry, false, 'a deterministic leaf makes the whole re-deploy futile');
  assert.match(d.reason, /InvalidTemplate.*defect/, 'the refusal must name the blocking leaf and its class');
  assert.match(d.reason, /CapacityNotAvailable.*capacity/, 'the retryable leaf must stay VISIBLE in the refusal');
  assert.match(d.reason, /ARE retryable/, 'the refusal must say the capacity leaf is retryable, not bury it');
});

test('D6: an unknown leaf fails the whole set closed', () => {
  const junk = { code: 'Gibberish', message: 'nothing matches this', resourceType: null, resourceName: null };
  const d = decideRetryForLeaves({ ...leafBudget, leafDiagnoses: classifyLeaves([LEAF_CAPACITY, junk]) });
  assert.equal(d.retry, false);
  assert.match(d.reason, /could not be classified/);
});

test('D6: leaf retries still exhaust their budget — the retry CAN fail (R6)', () => {
  const dx = classifyLeaves([LEAF_CAPACITY]);
  const exhausted = decideRetryForLeaves({ ...leafBudget, leafDiagnoses: dx, attempt: 4 });
  assert.equal(exhausted.retry, false);
  assert.match(exhausted.reason, /budget exhausted/);
  const wallClocked = decideRetryForLeaves({
    ...leafBudget,
    leafDiagnoses: dx,
    elapsedMs: 60_000,
    wallClockMs: 61_000,
    nextDelayMs: 5_000,
  });
  assert.equal(wallClocked.retry, false);
  assert.match(wallClocked.reason, /wall-clock/);
});

test('D6: an empty leaf set refuses to decide rather than inventing a verdict', () => {
  const d = decideRetryForLeaves({ ...leafBudget, leafDiagnoses: [] });
  assert.equal(d.retry, false);
  assert.match(d.reason, /no ARM leaves/);
});

test('D6: a capacity leaf elevates the backoff base to the taxonomy 300s; non-retryable leaves do not', () => {
  const cap = classifyLeaves([LEAF_CAPACITY]);
  assert.equal(effectiveBackoffBase(45, cap), TAXONOMY.classes.capacity.defaultBackoffSeconds);
  assert.ok(effectiveBackoffBase(45, cap) >= 300, 'Azure said "after some time" — a 45s cadence is not that');
  const defect = classifyLeaves([LEAF_DEFECT]);
  assert.equal(effectiveBackoffBase(45, defect), 45, 'a non-retryable leaf must not inflate the backoff');
  assert.equal(effectiveBackoffBase(600, cap), 600, 'an operator-widened base is never shrunk');
});
