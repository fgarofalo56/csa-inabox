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
  backoffMs,
  parseDuration,
  planRemediation,
  parseArgs,
  redact,
  USAGE_EXIT,
} from '../deploy-retry.mjs';
import { classify, TAXONOMY } from '../deploy-classify.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '..', 'deploy-retry.mjs');

function tmpdir() {
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
  const dir = tmpdir();
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
  const dir = tmpdir();
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
  const dir = tmpdir();
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
  const dir = tmpdir();
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
  const dir = tmpdir();
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
  const dir = tmpdir();
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
  const dir = tmpdir();
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
    path.join(tmpdir(), 'definitely-not-a-real-binary'),
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
