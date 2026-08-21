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
  formatAnnotation,
  formatStderr,
  armDrilldown,
  USAGE_EXIT,
} from '../deploy-retry.mjs';
import { classify, classifyLeaves, TAXONOMY } from '../deploy-classify.mjs';
import {
  streamWrites,
  stripComments,
  unboundedWrites,
  callCount,
  forbiddenPublishers,
  inheritedStreamSpawns,
  CONTROL_SOURCE_CRLF,
} from './_publication-surfaces.mjs';

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

/**
 * The env every spawned child gets. NODE_TEST_CONTEXT is STRIPPED (#3829 round
 * 4): these children stand in for real CI invocations, and inheriting the
 * test-runner marker let `if (!process.env.NODE_TEST_CONTEXT) return text;`
 * inside redact() survive the entire suite — a redactor that only redacts while
 * it can see it is being tested is the purest gate-that-cannot-fail.
 * scripts/ci/__tests__/node-test-suites.test.mjs deletes it for the same reason.
 */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runRetry(extraArgs, cmd) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs, '--', ...cmd], {
    encoding: 'utf8',
    env: childEnv(),
  });
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

// The RoleAssignmentExists leaf, verbatim from deploy-fiab-commercial run
// 31780698652 (2026-08-14). ARM enforces uniqueness on the (scope, principalId,
// roleDefinitionId) TRIPLE, not on the NAME, so an AcrPull grant already held
// for uami-loom-directlake under a CLI-minted name blocked the create the
// template makes under its own deterministic name — on every run, forever.
const ROLE_ASSIGNMENT_EXISTS =
  'RoleAssignmentExists: The role assignment already exists. The ID of the existing role assignment is ' +
  "0a2b7dc58eb449709418694f83a6c164. [Microsoft.Authorization/roleAssignments '54ecee13-3330-50e1-9ba9-314abdca3540']";

test('EMBEDDED CONTROL: the measured leaf still classifies as config.role-assignment-exists', () => {
  // Without this the three tests below could all pass against a signal that no
  // longer matches the text ARM actually emits — a remediation keyed to a
  // signal nothing produces is the hollow-gate shape this repo keeps hitting.
  const d = classify(ROLE_ASSIGNMENT_EXISTS);
  assert.equal(d.signalId, 'config.role-assignment-exists');
  assert.equal(d.retryable, false, 'retrying a deterministic leaf cannot go green — the name must converge');
});

test('planRemediation converges a RoleAssignmentExists instead of printing a delete command', () => {
  const plan = planRemediation(classify(ROLE_ASSIGNMENT_EXISTS), ROLE_ASSIGNMENT_EXISTS);
  assert.equal(plan.kind, 'converge-role-assignment');
  // The EXISTING assignment ARM named — never the name the template asked for.
  assert.equal(plan.assignmentName, '0a2b7dc58eb449709418694f83a6c164');
  assert.ok(plan.argv.includes('--apply'), 'the platform performs it; a dry run would leave the deploy red');
  assert.ok(plan.argv.includes('0a2b7dc58eb449709418694f83a6c164'));
  assert.ok(
    !plan.argv.includes('54ecee13-3330-50e1-9ba9-314abdca3540'),
    'deleting the name the TEMPLATE wants would be deleting the wrong thing',
  );
  assert.match(plan.argv[1], /converge-role-assignment\.mjs$/);
  assert.equal(path.isAbsolute(plan.argv[1]), true, 'a cwd-relative path is how a remediation becomes MODULE_NOT_FOUND');
});

test('planRemediation refuses to GUESS which assignment to DELETE when ARM named none', () => {
  const err = 'RoleAssignmentExists: The role assignment already exists.';
  const plan = planRemediation(classify(err), err);
  assert.equal(plan.kind, 'converge-role-assignment');
  assert.equal(plan.assignmentName, null);
  assert.equal(plan.argv, null, 'nothing is deleted on a name that was never established');
});

test('planRemediation scopes the converge to the subscription the drill-down read', () => {
  const plan = planRemediation(classify(ROLE_ASSIGNMENT_EXISTS), ROLE_ASSIGNMENT_EXISTS, { subscription: 'dlz-sub' });
  assert.ok(plan.argv.includes('--subscription'));
  assert.ok(plan.argv.includes('dlz-sub'));
});

test('the remediation must be planned from the DRILL-DOWN text, not from stderr alone', () => {
  // On run 31780698652 `az deployment sub create` wrote only bicep linter
  // warnings and "At least one resource deployment operation failed" to stderr.
  // The assignment id lives exclusively in the ARM leaf the drill-down fetched,
  // so planning from stderr alone yields a plan that can do nothing.
  const STDERR_ONLY =
    'WARNING: platform/fiab/bicep/main.bicep(14,7) : Warning no-unused-params: Parameter "environment" is ' +
    'declared but never used.\nERROR: At least one resource deployment operation failed.';
  const d = classify(ROLE_ASSIGNMENT_EXISTS); // the diagnosis comes from the LEAF
  assert.equal(planRemediation(d, STDERR_ONLY).argv, null, 'stderr alone carries no id — nothing may be deleted');
  assert.ok(planRemediation(d, `${STDERR_ONLY}\n${ROLE_ASSIGNMENT_EXISTS}`).argv, 'the combined text does');
});

test('SOURCE ASSERTION — the call site passes the combined classify input, not lastStderr', () => {
  // Behavioural proof of the call site needs a live ARM drill-down, which is not
  // available here; this is deliberately a source-level check and is labelled as
  // one rather than implying an end-to-end receipt (R7). It exists so a revert
  // to `planRemediation(diagnosis, lastStderr)` cannot pass silently — that
  // single argument is the difference between the platform converging the
  // collision and reporting that it could not read an id.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /planRemediation\(diagnosis,\s*classifyInput,/);
  assert.doesNotMatch(src, /planRemediation\(diagnosis,\s*lastStderr\)/);
});

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

// ── THE PUBLICATION BOUNDARIES (#3829) ───────────────────────────────────────
//
// This script writes to THREE surfaces, and on a PUBLIC repo all three are
// publicly readable:
//
//   1. STDOUT  — the Actions annotation log (`::error::` / `::warning::` /
//                `::notice::`), redacted in formatAnnotation().
//   2. deploy-failure.json — which .github/scripts/deploy-notify-failure.mjs
//                renders into an ISSUE, redacted over the whole serialization.
//   3. STDERR  — the Actions RUN LOG. Round 1 of this fix missed it, on the
//                reasoning that the captured stderr FILE stays on the runner.
//                True of the file; FALSE of the stream. Measured at that head, a
//                `flexibleServers/administrators` leaf put `<server>/<oid>` on
//                stderr twice, unredacted, from two COMPOSED lines:
//                renderLeaves() and the per-leaf classification block.
//
// On #3817 a raw Entra object id reached the issue body. `redact()` was applied
// to `leaf.message` and `evidence.line` at their composition sites, but THREE
// artifact fields embedded a leaf's `resourceName` untouched — `whyStopped`
// (= decision.reason), `leafClasses[].resourceName`, and
// `armDrilldown.leaves[].resourceName`.
//
// The fix redacts ONCE per boundary, so these are written against the property
// ("nothing GUID-shaped leaves this process on a published surface") rather than
// against the fields that happened to leak. Every GUID here is obviously
// synthetic.

/** The assertion under test — the issue's own pattern, verbatim. */
const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SYNTHETIC_OID = '11111111-2222-3333-4444-555555555555';
const SYNTHETIC_SERVER = 'psql-loom-weave-default-abc123';
/** What the id must become, in place — never dropped. */
const REDACTED_LEAF_NAME = `${SYNTHETIC_SERVER}/<guid>`;

/**
 * A fake `az` that prints one failed ARM operation whose targetResource carries
 * `<server>/<objectId>` — the #3817 leaf class. Injected through LOOM_AZ_BIN,
 * so the REAL process does the real drill-down, classification, annotation and
 * artifact write; nothing here models the code under test.
 *
 * The target type is NOT microsoft.resources/deployments, so the walk does not
 * recurse and the shim is called exactly once.
 */
function fakeAzEmitting(dir, ops) {
  const payload = path.join(dir, 'az-ops.json');
  fs.writeFileSync(payload, JSON.stringify(ops), 'utf8');
  if (process.platform === 'win32') {
    const p = path.join(dir, 'fake-az.cmd');
    fs.writeFileSync(p, `@echo off\r\ntype "${payload}"\r\n`, 'utf8');
    return p;
  }
  const p = path.join(dir, 'fake-az.sh');
  fs.writeFileSync(p, `#!/bin/sh\ncat '${payload}'\n`, 'utf8');
  fs.chmodSync(p, 0o755);
  return p;
}

/** One failed operation on the #3817 leaf shape, with the given leaf detail. */
function leakyOps({ code, message }) {
  return [
    {
      operationId: 'DEADBEEF',
      properties: {
        provisioningState: 'Failed',
        statusCode: 'Conflict',
        targetResource: {
          id: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-x/providers/Microsoft.DBforPostgreSQL/flexibleServers/administrators',
          resourceType: 'Microsoft.DBforPostgreSQL/flexibleServers/administrators',
          resourceName: `${SYNTHETIC_SERVER}/${SYNTHETIC_OID}`,
        },
        statusMessage: {
          error: {
            code: 'ResourceDeploymentFailure',
            message: 'At least one resource deployment operation failed.',
            details: [{ code, message, details: null }],
          },
        },
      },
    },
  ];
}

const LEAKY_OPS = leakyOps({
  code: 'SomeCodeNobodyHasEverSeen',
  message: `The administrator ${SYNTHETIC_OID} could not be written to ${SYNTHETIC_SERVER}.`,
});

/** The same leaf, but with a message the taxonomy DOES name — class `capacity`. */
const LEAKY_OPS_CLASSIFIED = leakyOps({
  code: 'CapacityNotAvailable',
  message: 'Capacity is not available in this region/zone. Please retry after some time.',
});

/** Drive the real script over a fake-az fixture and hand back every surface. */
function runWithFakeAz(ops, extraArgs = []) {
  const dir = scratchDir();
  const counter = path.join(dir, 'n');
  fs.writeFileSync(counter, '');
  const artifact = path.join(dir, 'deploy-failure.json');
  const az = fakeAzEmitting(dir, ops);

  const r = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--class-allow', 'transient',
      '--max-attempts', '1',
      '--backoff', '0',
      '--jitter', '0',
      '--step', 'az deployment sub create',
      '--artifact', artifact,
      '--arm-deployment', 'csa-loom-ci-1',
      '--arm-scope', 'sub',
      ...extraArgs,
      '--',
      ...alwaysFails(counter, MYSTERY),
    ],
    { encoding: 'utf8', env: childEnv({ LOOM_AZ_BIN: az }) },
  );
  return { r, artifact, raw: fs.readFileSync(artifact, 'utf8') };
}

test('ACCEPTANCE — the ARTIFACT is redacted on a path that never sets LOOM_AZ_BIN (#3829 round 4)', () => {
  // EVERY other GUID-carrying artifact assertion in this file reaches the
  // artifact through runWithFakeAz(), which sets LOOM_AZ_BIN. That made
  //
  //     const safe = process.env.LOOM_AZ_BIN ? redact(json) : json;
  //
  // invisible: a redaction that only applies when a test harness is driving it.
  // This test takes the OTHER route to the same write — no --arm-deployment, so
  // no ARM drill-down, so `az` is never resolved and LOOM_AZ_BIN is never set.
  //
  // THE POISONED FIELD IS `--step`, AND THAT CHOICE IS THE WHOLE TEST. The first
  // cut poisoned the child's stderr, which lands in `established[].line` — and
  // that field carries its own per-site `redact(e.line)`, so TWO redactors sat
  // on the path and the mutation above stayed GREEN at 50/50. Measured, not
  // assumed (csa_loom_mutation_that_does_not_move_the_verdict). `step` is
  // operator-supplied text written to the artifact with NO per-site call, so it
  // is covered by the whole-artifact boundary and by nothing else.
  const dir = scratchDir();
  const counter = path.join(dir, 'n');
  fs.writeFileSync(counter, '');
  const artifact = path.join(dir, 'deploy-failure.json');
  const poisonedStep = `az deployment sub create as ${SYNTHETIC_OID}`;

  // Non-degenerate: the INPUT must carry a GUID, or "no GUID in the artifact"
  // is satisfied by an artifact that never contained one.
  assert.match(poisonedStep, GUID_RE, 'the fixture does not carry a GUID');
  assert.equal(process.env.LOOM_AZ_BIN, undefined, 'this test must run with LOOM_AZ_BIN UNSET');

  const r = runRetry(
    ['--class-allow', 'transient', '--max-attempts', '1', '--backoff', '0', '--jitter', '0',
      '--step', poisonedStep, '--artifact', artifact],
    alwaysFails(counter, QUOTA),
  );
  assert.notEqual(r.status, 0, `a quota failure must not be retried into success; stderr=${r.stderr}`);
  assert.ok(fs.existsSync(artifact), 'the artifact was not written, so this test proves nothing');

  const raw = fs.readFileSync(artifact, 'utf8');
  // The artifact really did capture the poisoned field — otherwise vacuous.
  assert.match(raw, /"step":/, 'the artifact has no step field to carry the poison');
  assert.match(raw, /az deployment sub create as/, 'the artifact did not capture the poisoned step');
  assert.doesNotMatch(raw, GUID_RE, 'a GUID reached the deploy-failure.json a PUBLIC issue is built from');
  assert.match(raw, /az deployment sub create as <guid>/, 'redacted in place, not dropped');
  assert.doesNotThrow(() => JSON.parse(raw), 'the redaction broke the JSON');
});

test('POSITIVE CONTROL — the GUID assertion FIRES on the pre-fix leaf composition', () => {
  // A redaction assertion whose fixture contains no GUID passes forever while
  // proving nothing. Prove it CAN fail before trusting it to pass: run the real
  // decideRetryForLeaves over the leaky leaf and confirm the raw reason — the
  // exact string that was published as `whyStopped` — trips the matcher.
  const leafDiagnoses = classifyLeaves([
    {
      code: 'SomeCodeNobodyHasEverSeen',
      message: 'the widget frobnicator declined',
      resourceType: 'Microsoft.DBforPostgreSQL/flexibleServers/administrators',
      resourceName: `${SYNTHETIC_SERVER}/${SYNTHETIC_OID}`,
    },
  ]);
  const d = decideRetryForLeaves({ ...leafBudget, leafDiagnoses });
  assert.equal(d.retry, false);
  assert.match(d.reason, GUID_RE, 'the composed reason DOES embed the object id — this is the #3829 source');
  assert.equal(GUID_RE.test(redact(d.reason)), false, 'and redact() removes it — so the matcher can go green too');
});

test('ACCEPTANCE — no GUID reaches the artifact, the annotations OR stderr, end to end (#3829)', () => {
  const { r, raw } = runWithFakeAz(LEAKY_OPS);

  assert.notEqual(r.status, 0, 'the failure must still be RED — redaction must not swallow the verdict');

  // NON-DEGENERATE, WITHOUT PINNING THE SECRET. Round 1 keyed this control to
  // the leaked value itself (`assert.match(r.stderr, GUID_RE)`), so closing the
  // leak broke the guard — a control must not be keyed to the thing being
  // removed. It is keyed instead to two things that are NOT the secret: the
  // drill-down really ran, and the leaf name really reached the output, in its
  // redacted form. Either one going missing means the walk was empty and the
  // "no GUID" assertions below would be the zero-population false pass.
  assert.match(r.stderr, /ARM drill-down/, 'the drill-down must have run');
  assert.ok(
    r.stderr.includes(REDACTED_LEAF_NAME),
    'the leaf name must reach stderr REDACTED IN PLACE — if it is absent entirely the walk read nothing',
  );
  assert.match(r.stderr, /per-leaf classification/, 'the per-leaf block — the second composed stderr site — must have run');

  // BOUNDARY 1 — the artifact, which the notifier posts to a PUBLIC issue.
  assert.doesNotMatch(raw, GUID_RE, 'deploy-failure.json still carries a GUID (#3829)');

  // BOUNDARY 2 — the Actions annotations, which are public on a public repo.
  assert.doesNotMatch(r.stdout, GUID_RE, 'an Actions annotation still carries a GUID (#3829)');

  // BOUNDARY 3 — STDERR, i.e. the Actions RUN LOG. This is the one round 1
  // missed: `renderLeaves()` interpolated `l.resourceName` verbatim and the
  // per-leaf classification block interpolated `l.leaf.resourceName` verbatim,
  // and both are written straight to process.stderr.
  assert.doesNotMatch(r.stderr, GUID_RE, 'the Actions RUN LOG still carries a GUID on stderr (#3829 round 2)');

  // REDACTED, NOT DROPPED. A run that simply lost these fields would also
  // contain no GUID and would be a false pass, while destroying the diagnostic
  // R6 requires. Each must survive with `<guid>` substituted IN PLACE.
  const a = JSON.parse(raw);
  assert.match(a.whyStopped, new RegExp(REDACTED_LEAF_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(a.leafClasses[0].resourceName, REDACTED_LEAF_NAME, 'the leaf name must be redacted in place, not removed');
  assert.equal(a.armDrilldown.leaves[0].resourceName, REDACTED_LEAF_NAME);
  assert.equal(a.armDrilldown.status, 'found');
  assert.equal(a.class, 'unknown', 'the classification is unchanged by redaction');
});

test('ACCEPTANCE — the artifact is redacted at a NON-`unknown` class too (#3829 round 2)', () => {
  // The round-1 suite carried exactly one artifact test with a GUID in it, and
  // its class was `unknown`; the only other artifact test used `transient` and
  // had no GUID anywhere. So scoping the artifact redaction to
  // `diagnosis.class === 'unknown'` left the whole suite GREEN (measured: 39/39)
  // while every permission-, capacity- and config-classified leaf still
  // published its id. Same leaf, same `<server>/<oid>` name, a message the
  // taxonomy DOES name — so the class is `capacity`, not `unknown`.
  const { r, raw } = runWithFakeAz(LEAKY_OPS_CLASSIFIED);
  const a = JSON.parse(raw);

  // Non-degenerate in the direction that matters: this really is NOT `unknown`,
  // or the case would be indistinguishable from the test above.
  assert.notEqual(a.class, 'unknown', 'the fixture must classify to a NAMED class or it does not test the scoping');
  assert.equal(a.class, 'capacity');
  assert.equal(a.leafClasses[0].class, 'capacity');

  assert.doesNotMatch(raw, GUID_RE, 'the artifact publishes a GUID whenever the class is not `unknown` (#3829)');
  assert.doesNotMatch(r.stdout, GUID_RE, 'a non-`unknown` annotation still carries a GUID');
  assert.doesNotMatch(r.stderr, GUID_RE, 'a non-`unknown` run log still carries a GUID');
  // …and REDACTED, not dropped.
  assert.equal(a.leafClasses[0].resourceName, REDACTED_LEAF_NAME);
  assert.match(a.whyStopped, /capacity/);
});

// ── formatAnnotation(): every LEVEL, not just `error` ─────────────────────────
//
// The annotation redaction is level-blind and must stay so:
// `ghAnnotate('warning', …drill.rendered)` and the retry-progress notices go to
// the same public log an `::error::` does. Scoping the redaction to
// `level === 'error'` left the round-1 suite GREEN at 39/39, because it
// exercised exactly one level.
//
// This is a DIRECT test of the boundary rather than an end-to-end one, and
// deliberately: upstream composition sites redact as well, so an end-to-end
// assertion would stay green with this redaction deleted and would therefore be
// measuring the wrong control (csa_loom_mutation_that_does_not_move_the_verdict).

test('MUTATION-VISIBLE — EVERY annotation level is redacted, not just `error`', () => {
  const poisoned = `deploy-retry: blocked on '${SYNTHETIC_SERVER}/${SYNTHETIC_OID}'`;
  // Non-degenerate: the input really carries the id.
  assert.match(poisoned, GUID_RE, 'the annotation input must carry a GUID or this proves nothing');

  for (const level of ['error', 'warning', 'notice']) {
    const line = formatAnnotation(level, poisoned);
    assert.ok(line.startsWith(`::${level}::`), `the ${level} annotation must keep its level prefix`);
    assert.doesNotMatch(line, GUID_RE, `a ::${level}:: annotation published a GUID (#3829)`);
    // REDACTED, not dropped — the annotation is still the diagnostic it was.
    assert.ok(line.includes(REDACTED_LEAF_NAME), `the ::${level}:: annotation lost its subject entirely`);
  }
});

test('formatAnnotation keeps its other contracts: one line, and never blank', () => {
  const multi = formatAnnotation('error', 'line one\nline two\r\nline three');
  assert.equal(multi.split('\n').length, 2, 'a multi-line message must render as ONE annotation');
  assert.match(multi, /line one%0Aline two%0Aline three/);
  // A non-string must not silently become a blank `::error::` — redact() returns
  // '' for a non-string, which is why String() comes first.
  assert.match(formatAnnotation('error', { toString: () => 'an object message' }), /an object message/);
});

// ── THE RUN LOG IS A DIFFERENT SURFACE FROM THE ANNOTATION (#3829 round 5) ────
//
// Guarding `::error::` does NOT cover a raw byte landing in the log. Round 2
// covered the stderr STREAM field by field — `redact(l.leaf.resourceName)` on a
// line whose neighbouring interpolations (`l.leaf.code`, the signal id) sat raw —
// and the usage refusals, the drill-down banner and the "stderr was EMPTY" block
// had no redaction at all. formatStderr() is that surface's boundary, and the
// per-site call on the per-leaf line has been REMOVED so that this boundary is
// the only redactor on that path and a pass-through mutation is visible end to
// end as well as here.

test('MUTATION-VISIBLE — formatStderr() is the boundary for the RUN LOG', () => {
  const poisoned = `deploy-retry: blocked on '${SYNTHETIC_SERVER}/${SYNTHETIC_OID}'`;
  assert.match(poisoned, GUID_RE, 'the input must carry a GUID or this proves nothing');
  const out = formatStderr(poisoned);
  assert.doesNotMatch(out, GUID_RE, 'the stderr boundary published a GUID (#3829 round 5)');
  assert.ok(out.includes(REDACTED_LEAF_NAME), 'redacted in place — the line lost its subject entirely');
  // String() first, for the reason formatAnnotation() does it: a refusal that
  // printed nothing would be a worse failure than the one it was reporting.
  assert.equal(formatStderr(42), '42');
  assert.equal(formatStderr(undefined), 'undefined');
});

const RETRY_SRC = fs.readFileSync(SCRIPT, 'utf8');

/**
 * The named functions a write in deploy-retry.mjs may hand its argument to: two
 * redaction boundaries and ONE disclosed-exception marker.
 */
const RETRY_BOUNDARIES = ['formatAnnotation', 'formatStderr', 'unredactedByDesign'];

/**
 * How many DISCLOSED EXCEPTIONS this file is allowed. Pinned, so a fifth cannot
 * appear without moving a number a reviewer reads:
 *
 *   1. runTee()      the child's stdout, streamed live
 *   2. per attempt   the child's stderr, echoed back
 *   3. final failure the child's stderr, echoed in full
 *   4. final failure the child's stdout TAIL, when its stderr came back empty
 *
 * All four are the same argument — `stdio: inherit` parity, R7: rewriting a
 * command's own output makes the wrapper's log disagree with the command's.
 */
const RETRY_DISCLOSED_EXCEPTIONS = 4;

test('STRUCTURAL — EVERY write to a public stream crosses a boundary or a COUNTED exception', () => {
  const writes = streamWrites(RETRY_SRC);

  // Non-degenerate: the enumerator found writes on BOTH streams. Zero, or one
  // stream, would mean the matcher drifted rather than that the file stopped
  // publishing (guard_with_zero_population_needs_embedded_control).
  assert.ok(writes.length >= 6, `expected >=6 stream writes, found ${writes.length} — the enumerator drifted`);
  assert.ok(writes.some((w) => w.stream === 'stdout'), 'no stdout write found — the enumerator is stdout-blind');
  assert.ok(writes.some((w) => w.stream === 'stderr'), 'no stderr write found — the enumerator is stderr-blind');

  assert.deepEqual(
    unboundedWrites(RETRY_SRC, RETRY_BOUNDARIES).map((w) => `${w.line}: ${w.arg.split('\n')[0]}`),
    [],
    'a write to a PUBLIC stream bypasses both the redaction boundary and the disclosed-exception marker (#3829)',
  );

  assert.equal(
    callCount(RETRY_SRC, 'unredactedByDesign'),
    RETRY_DISCLOSED_EXCEPTIONS,
    'the number of UNREDACTED publications changed — every one is a deliberate carve-out and must be argued, ' +
      'not inherited (see rule 6 (b) in deploy-retry.mjs)',
  );

  // The surfaces that reach a stream WITHOUT `process.<stream>.write`.
  assert.deepEqual(forbiddenPublishers(RETRY_SRC), [], 'a publication shape with no boundary to attach to');
});

test('SELF-DEFENCE — the surface enumerator can actually detect an unbounded write', () => {
  const found = unboundedWrites(CONTROL_SOURCE_CRLF, RETRY_BOUNDARIES.concat('formatStdout'));
  assert.equal(found.length, 2, `expected the control's 2 violations, found ${found.length}`);
  assert.ok(found.some((w) => w.arg.startsWith('`deploy:')), 'a bare template-literal write was not detected');
  assert.ok(
    found.some((w) => w.arg.startsWith('redact(')),
    'a PER-SITE redact() was not detected — one boundary per surface is the rule; a per-field call is the defect',
  );
  assert.equal(streamWrites(CONTROL_SOURCE_CRLF).length, 5, 'the control source lost a write to CRLF handling');

  // The comment stripper is load-bearing: this file's header documents its write
  // sites in prose, so counting comments would inflate every number above.
  const occurrences = (s, needle) => s.split(needle).length - 1;
  assert.ok(
    occurrences(RETRY_SRC, 'process.stderr.write()') + occurrences(RETRY_SRC, 'unredactedByDesign()') >= 1,
    'the header no longer names its own write sites — this control has lost its population',
  );
  assert.equal(
    occurrences(stripComments(RETRY_SRC), 'process.stderr.write()'),
    0,
    'the stripper left header prose in the executable source — every count above is inflated',
  );
  // …and it does NOT strip real code. Both directions, or it is not a control.
  assert.match(stripComments(RETRY_SRC), /process\.stdout\.write\(formatAnnotation\(level, message\)\)/, 'the stripper ate real code');
});

test('STRUCTURAL — the inherited-stream surface is ENUMERATED, not invisible', () => {
  // THE SURFACE NO WRITE-BASED ASSERTION CAN SEE. `stdio: [_,'inherit',_]` hands
  // the child THIS process's stdout fd: its bytes reach the same public run log
  // with no `process.stdout.write` in this file at all. Round 4's
  // `process\.stdout\.write` regex was blind to it by construction, and so is
  // streamWrites() — which is exactly why it gets its own enumeration rather
  // than being assumed covered by the one above.
  const inherited = inheritedStreamSpawns(RETRY_SRC);
  assert.equal(
    inherited.length,
    1,
    'the set of spawns that publish through an INHERITED stream changed. Each one hands a child this ' +
      "process's public log with no boundary in this file; see rule 6 (e). Adding one is a decision, not a detail: " +
      `found ${JSON.stringify(inherited)}`,
  );
  assert.deepEqual(inherited[0].inherits, ['stdout'], 'the remediation child now also inherits STDERR — a second surface');

  // Non-degenerate, from the other direction: runTee()'s `['inherit','pipe','pipe']`
  // must NOT be counted. Slot 0 is stdin and is not a publication surface, and a
  // matcher that flagged it would be noise the next author silences.
  assert.match(RETRY_SRC, /stdio: \['inherit', 'pipe', 'pipe'\]/, 'runTee no longer inherits stdin — this control lost its subject');
  assert.equal(
    inheritedStreamSpawns("spawn(c, a, { stdio: ['inherit', 'pipe', 'pipe'] });").length,
    0,
    'an inherited STDIN was counted as a publication surface',
  );
  // …and the shapes that ARE surfaces are detected, each on its own slot.
  assert.deepEqual(inheritedStreamSpawns("x({ stdio: ['ignore', 'inherit', 'pipe'] })")[0].inherits, ['stdout']);
  assert.deepEqual(inheritedStreamSpawns("x({ stdio: ['ignore', 'pipe', 'inherit'] })")[0].inherits, ['stderr']);
  assert.deepEqual(inheritedStreamSpawns('x({ stdio: ["ignore", "inherit", "inherit"] })')[0].inherits, ['stdout', 'stderr']);

  // The disclosure is really IN the source, not only here. A residual named in a
  // test nobody reads is the same unstated assumption round 3 shipped.
  assert.match(RETRY_SRC, /A FIFTH PUBLICATION SURFACE/, 'the inherited-stream disclosure was removed from deploy-retry.mjs');
  assert.match(RETRY_SRC, /converge-role-assignment\.mjs/, 'the disclosure no longer names WHOSE boundary those bytes are');
});

test('R7 — the redactor\'s stated count of UNREDACTED publications equals the measured one', () => {
  // The specific defect this PR committed four times is a COUNT stated as
  // established and never measured: "the four surfaces #3829 enumerated", "no
  // per-variable redaction left in this file", "what it still does NOT match" —
  // each true of what its author had looked at and false of the file. So the one
  // number round 5 adds to a header is measured here rather than asserted there.
  const redactSrc = fs.readFileSync(path.resolve(import.meta.dirname, '..', '_azure-redact.mjs'), 'utf8');
  const WORDS = { ZERO: 0, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8 };
  const declared = /THE ([A-Z]+) USES TODAY/.exec(redactSrc);
  assert.ok(declared, '_azure-redact.mjs no longer states how many unredacted publications exist');
  assert.ok(declared[1] in WORDS, `unparseable count "${declared[1]}" in _azure-redact.mjs`);

  const files = [
    path.resolve(import.meta.dirname, '..', 'deploy-retry.mjs'),
    path.resolve(import.meta.dirname, '..', 'deploy-arm-errors.mjs'),
    path.resolve(import.meta.dirname, '..', '..', '..', '.github', 'scripts', 'deploy-notify-failure.mjs'),
  ];
  // Non-degenerate: every file this sums really exists, or the total is a zero
  // that would agree with almost any claim.
  for (const f of files) assert.ok(fs.existsSync(f), `${f} is missing — the sum below would be silently short`);
  const measured = files.reduce((n, f) => n + callCount(fs.readFileSync(f, 'utf8'), 'unredactedByDesign'), 0);

  assert.equal(
    measured,
    WORDS[declared[1]],
    `_azure-redact.mjs says ${declared[1]} unredacted publications; the three deploy scripts contain ${measured}`,
  );
});

test('DISCLOSED EXCEPTION — the CHILD\'s own bytes reach the run log verbatim, and the ARTIFACT still does not', () => {
  // The carve-out is real and it is pinned in BOTH directions, because a future
  // reader is equally likely to "fix" it as to widen it. Redacting the child's
  // own output would break the `stdio: inherit` parity R7 requires — the
  // wrapper's log would disagree with the command's — so this asserts that the
  // id DOES reach stderr, and that the boundaries around it still hold.
  const dir = scratchDir();
  const counter = path.join(dir, 'n');
  fs.writeFileSync(counter, '');
  const artifact = path.join(dir, 'deploy-failure.json');
  // A quota denial (never retried, so exactly one attempt) whose own stderr
  // carries the synthetic id ON THE SIGNAL LINE — the shape `az` itself would
  // produce, and the only shape that reaches the artifact, since the taxonomy
  // keeps the MATCHED line as evidence rather than the whole stream.
  const childStderr =
    'ERROR: QuotaExceeded: standardDDSv5Family Cores, Location: centralus, Current Limit: 200, ' +
    `Current Usage: 196 — requested by principal ${SYNTHETIC_OID} on ${SYNTHETIC_SERVER}\n`;

  const r = runRetry(
    ['--class-allow', 'transient', '--max-attempts', '1', '--backoff', '0', '--jitter', '0', '--artifact', artifact],
    alwaysFails(counter, childStderr),
  );
  assert.notEqual(r.status, 0, 'a quota denial must still be RED');

  // THE DISCLOSURE, asserted rather than described: the child's own bytes are
  // echoed unchanged, so the id is in the public run log. If this ever goes red
  // because someone routed the echo through formatStderr(), that is a BEHAVIOUR
  // change to the parity contract and needs its own argument — not a silent fix.
  assert.match(r.stderr, GUID_RE, 'the child-output carve-out changed; see rule 6 (b) in deploy-retry.mjs');
  assert.match(r.stderr, /full captured stderr/, 'the final stderr block did not run');

  // …and the carve-out is BOUNDED. Everything this script composes ITSELF is
  // still redacted, and the artifact a PUBLIC issue is built from is clean.
  // (`established[].line` also carries a per-site redact() as defence in depth,
  // so this pins the OUTPUT rather than which of the two redactors did it — the
  // `--step` test above is the one that isolates the artifact boundary.)
  const raw = fs.readFileSync(artifact, 'utf8');
  assert.match(raw, /"established"/, 'the artifact captured no evidence, so "no GUID" would be vacuous');
  assert.match(raw, /principal <guid>/, 'the child stderr reached the artifact but was not redacted in place');
  assert.doesNotMatch(raw, GUID_RE, 'a GUID reached the deploy-failure.json a PUBLIC issue is built from');
  assert.doesNotMatch(r.stdout, GUID_RE, 'a GUID reached an Actions ANNOTATION — the annotation boundary leaked');
});

// ── redact(): the residuals, measured rather than assumed ────────────────────
//
// Round 1 stated the residual as "a GUID glued to word chars on BOTH sides
// survives `\b`". Measured against the real redact(), that was wrong in the
// direction that matters: it was EITHER side, and `_` is a word character, so
// `admin_<guid>` — the shape of an ARM deployment name and of a role-assignment
// name this repo generates — leaked. The boundary is now hex-adjacency, which is
// a strict superset of `\b`.

test('redact() strips a GUID glued to word characters on EITHER side (#3829 round 2)', () => {
  const cases = [
    ['glued BOTH sides', `x${SYNTHETIC_OID}x`],
    ['glued LEFT only', `x${SYNTHETIC_OID} end`],
    ['glued RIGHT only', `start ${SYNTHETIC_OID}x`],
    ['underscore prefix', `_${SYNTHETIC_OID}`],
    ['underscore suffix', `${SYNTHETIC_OID}_`],
    ['ARM deployment-name shape', `admin_${SYNTHETIC_OID}`],
    ['dash-delimited (already worked)', `deploy-${SYNTHETIC_OID}`],
    ['slash-delimited (already worked)', `${SYNTHETIC_SERVER}/${SYNTHETIC_OID}`],
  ];
  for (const [why, input] of cases) {
    // Non-degenerate per case: the INPUT must trip the matcher.
    assert.match(input, GUID_RE, `${why}: the fixture does not contain a GUID`);
    assert.doesNotMatch(redact(input), GUID_RE, `${why}: redact() left the id in place`);
    assert.match(redact(input), /<guid>/, `${why}: the id must be REPLACED, not deleted`);
  }
});

test('redact() does NOT invent matches in legitimate text (no false positives)', () => {
  // Widening the boundary is only safe if the things it newly matches are still
  // GUIDs. The remaining guard is a negative LOOKAHEAD on hex, so the only
  // inputs it can newly touch are full 8-4-4-4-12 tokens NOT followed by a hex
  // character. Everything below must survive byte-for-byte.
  const legitimate = [
    'commit f172a1c0dc3e4b5a9f8e7d6c5b4a39281706f5e4 — a 40-hex git sha',
    'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'csa-inabox 0.99.1 / node v22.14.0 / 2026-08-21T14:03:59Z',
    'Microsoft.DBforPostgreSQL/flexibleServers/administrators',
    'rg-csa-loom-admin-centralus / psql-loom-ducklake-k6mvh5sm6z7do',
    'ERROR: (SomeCodeNobodyHasEverSeen) the widget frobnicator declined',
    'The ID of the existing role assignment is 11112222333344445555666677778888.',
    // NOTE — this last one is RESIDUAL 2, not merely "not a false positive". It
    // is a hex-adjacent GUID and it SURVIVES; see the test below and the
    // disclosure in _azure-redact.mjs. Do not read this corpus as evidence that
    // trailing hex-adjacency is safe — it is the documented cost of the
    // surviving lookahead.
    '11111111-2222-3333-4444-555555555555abc (trailing hex, not a GUID token)',
  ];
  for (const s of legitimate) {
    assert.equal(redact(s), s, `redact() rewrote legitimate text: ${JSON.stringify(s)}`);
  }

  // THE ROW THAT LEFT THIS CORPUS, AND WHY (#3829 round 5). Round 2 added
  //
  //   'abcdef11111111-2222-3333-4444-555555555555 (a longer hex run, not a GUID token)'
  //
  // and round 4's header then cited it as the cost of narrowing — a fixture this
  // branch introduced, used as the obstacle it could not move. Measured:
  //
  //   git show 608a36af:scripts/ci/__tests__/deploy-retry.test.mjs \
  //     | grep -c abcdef11111111   -> 0   RC=1     (absent from the merge base)
  //   git show <head>:… | grep -c abcdef11111111   -> 1   RC=0
  //
  // Dropping the LOOKBEHIND costs exactly this row and closes three residual-2
  // cases including `uami-loom-directlake<guid>`, a REAL Loom-shaped name. A
  // 14-hex first group now reads back as `abcdef<guid>`: over-redacting a
  // diagnostic is recoverable, publishing an object id into a public repo's
  // permanent history is not. Asserted in its new direction rather than deleted,
  // so the trade stays visible.
  assert.equal(
    redact(`abcdef${SYNTHETIC_OID}`),
    'abcdef<guid>',
    'the round-5 narrowing regressed — a 9+-hex first group is no longer redacted',
  );
});

test('RESIDUAL 2 — a GUID followed by a HEX character survives, and that is DISCLOSED (#3829 round 5)', () => {
  // Not an accident and not a silent gap: it is the exact cost of the negative
  // LOOKAHEAD that closed the `\b` residual in round 2 and was kept in round 5.
  // Round 3's header said "what it still does NOT match, deliberately: an
  // undashed 32-hex run" — as though that were the whole list. It was not, and
  // stating an unmeasured enumeration as complete is the R7 defect this test
  // exists to prevent recurring. Pinned so the module header and the behaviour
  // cannot drift apart: if someone narrows the lookahead later, this test goes
  // red and they MUST update the disclosure rather than leave a stale claim.
  const survives = [
    ['hex suffix', `${SYNTHETIC_OID}f`],
    ['hex-word suffix', `${SYNTHETIC_OID}abc`],
  ];
  for (const [why, input] of survives) {
    assert.match(input, GUID_RE, `${why}: the fixture must carry a GUID or this proves nothing`);
    assert.equal(redact(input), input, `${why}: behaviour changed — UPDATE THE DISCLOSURE in _azure-redact.mjs`);
  }

  // THE THREE ROUND-5 CLOSED, pinned in their new direction. These were LEAKS
  // under the lookbehind and are the reason it was dropped; if the lookbehind
  // ever comes back this goes red rather than quietly re-opening a live hole.
  for (const [why, input, expected] of [
    ['single hex letter prefix', `f${SYNTHETIC_OID}`, 'f<guid>'],
    ['hex-word prefix', `abcdef${SYNTHETIC_OID}`, 'abcdef<guid>'],
    // The one that argued loudest for narrowing: a real Loom-shaped name whose
    // last character happens to be hex, concatenated with NO separator.
    ['Loom-shaped name ending in a hex letter', `uami-loom-directlake${SYNTHETIC_OID}`, 'uami-loom-directlake<guid>'],
  ]) {
    assert.match(input, GUID_RE, `${why}: the fixture must carry a GUID or this proves nothing`);
    assert.equal(redact(input), expected, `${why}: the round-5 narrowing regressed — this shape leaks again`);
  }

  // CONTROL, in the direction that matters most: a NON-hex neighbour is still
  // redacted. Without this the assertions above would also pass on a redact()
  // that had stopped working entirely.
  for (const [why, input] of [
    ['non-hex letter prefix', `x${SYNTHETIC_OID}`],
    ['underscore prefix', `admin_${SYNTHETIC_OID}`],
    ['underscore BOTH sides', `_${SYNTHETIC_OID}_`],
    ['dash prefix', `uami-loom-directlake-${SYNTHETIC_OID}`],
    ['slash prefix', `${SYNTHETIC_SERVER}/${SYNTHETIC_OID}`],
  ]) {
    assert.doesNotMatch(redact(input), GUID_RE, `${why}: the redaction regressed`);
  }

  // …and the disclosure is really IN the module, not only in this test. A
  // residual named in a test nobody reads is the same unstated assumption.
  const header = fs.readFileSync(path.resolve(import.meta.dirname, '..', '_azure-redact.mjs'), 'utf8');
  assert.match(header, /adjacent to a HEX character/i, '_azure-redact.mjs no longer discloses residual 2');
  assert.match(header, /undashed 32-hex/i, '_azure-redact.mjs no longer discloses residual 1');
});

test('redact() leaves the UNDASHED 32-hex role-assignment id alone — #3439 depends on it', () => {
  // ARM prints the blocking assignment as 32 undashed hex, and
  // planRemediation() reads it back out to converge the grant automatically.
  // Redacting it would disable a working auto-remediation to hide a resource
  // NAME. This is a deliberate residual, so it is pinned rather than left to
  // drift.
  const armText =
    'RoleAssignmentExists: The role assignment already exists. The ID of the existing role assignment ' +
    'is 11112222333344445555666677778888.';
  assert.equal(redact(armText), armText);
  const plan = planRemediation({ signalId: 'config.role-assignment-exists' }, redact(armText));
  assert.equal(plan.assignmentName, '11112222333344445555666677778888', 'redaction must not break the #3439 converger');
  assert.ok(Array.isArray(plan.argv), 'the remediation must still be executable after redaction');
});

test('redact() is IDEMPOTENT — the three layers cannot corrupt each other', () => {
  // Load-bearing, and now more so than in round 1: a leaf name is redacted at
  // its composition site, again over the serialized artifact, and a third time
  // at the issue poster. If a second pass rewrote a `<guid>` placeholder the
  // stacking would mangle the diagnostic, so pin it rather than assert it in a
  // comment.
  const inputs = [
    `${SYNTHETIC_SERVER}/${SYNTHETIC_OID}`,
    `admin_${SYNTHETIC_OID}`,
    `/subscriptions/${SYNTHETIC_OID}/resourceGroups/rg-csa-loom-admin-centralus`,
    `x${SYNTHETIC_OID}x and ${SYNTHETIC_OID}`,
  ];
  for (const s of inputs) {
    const once = redact(s);
    assert.equal(redact(once), once, `redact() is not idempotent for ${JSON.stringify(s)}`);
    assert.equal(redact(redact(once)), once, 'a third pass must also be a no-op');
    assert.doesNotMatch(once, GUID_RE, 'and the first pass must actually have removed the id');
  }
});

// ── redact() IS SIZE-INDEPENDENT: the PROPERTY, not a sample ─────────────────
//
// Round 2 pinned this at ONE size (~6.1 KB). A point is not the property: with
//
//     if (text.length > 20000) return text;
//
// inserted into redact(), all three consuming suites stayed GREEN — 90/90,
// retry RC=0, arm RC=0, notify RC=0. And the gap is REACHABLE, not theoretical.
// Measured on real renderLeaves() output with the #3817 leaf shape:
//
//     leaves= 20  bytes=  8179   >20KB? false
//     leaves= 40  bytes= 16299   >20KB? false
//     leaves= 60  bytes= 24419   >20KB? true
//     leaves=120  bytes= 48800   >20KB? true
//
// A 60-leaf ARM failure — exactly the "full ARM operation dump" _azure-redact's
// header says a cap would leak — clears 20 KB. So the assertion is now the
// property, from two directions: BEHAVIOURAL across three orders of magnitude
// (any cap between ~1 KB and ~1 MB goes red), and STRUCTURAL (a cap of ANY
// magnitude goes red, including one outside the sampled range).

/**
 * `minBytes` of leaf-shaped text carrying exactly one GUID per line, with a GUID
 * in both the first and the last line — so a head-only or truncating redactor is
 * caught as well as a size cap.
 */
function poisonedText(minBytes) {
  const line = (i) => `  ResourceDeploymentFailure: leaf ${i} on ${SYNTHETIC_SERVER}/${SYNTHETIC_OID} — ${'x'.repeat(160)}`;
  const guids = Math.max(2, Math.ceil(minBytes / (line(0).length + 1)));
  return { text: Array.from({ length: guids }, (_, i) => line(i)).join('\n'), guids };
}

test('redact() has NO size cap — the count of redactions equals the count injected, from 1 KB to 1 MB', () => {
  for (const minBytes of [1024, 64 * 1024, 1024 * 1024]) {
    const { text, guids } = poisonedText(minBytes);
    const label = `${Math.round(text.length / 1024)} KB`;

    // Non-degenerate, at BOTH ends of the buffer: a fixture whose GUIDs all sit
    // in the first KB could not tell a size cap from a working redactor.
    assert.ok(text.length >= minBytes, `${label}: fixture is smaller than requested (${text.length} < ${minBytes})`);
    assert.match(text.slice(0, 300), GUID_RE, `${label}: the fixture must carry a GUID early`);
    assert.match(text.slice(-300), GUID_RE, `${label}: the fixture must carry a GUID late`);

    const out = redact(text);
    assert.doesNotMatch(out, GUID_RE, `${label}: redact() stopped redacting above some size (#3829 round 3)`);
    assert.equal(
      (out.match(/<guid>/g) ?? []).length,
      guids,
      `${label}: expected ${guids} redactions, so a partial pass is not mistaken for a clean one`,
    );
    // REDACTED, not TRUNCATED — a redactor that returned only the head would
    // also contain no GUID and would be a false pass. The output length is
    // EXACTLY the input minus what the substitutions remove (36 → 6 per GUID),
    // so nothing else was dropped either.
    assert.match(out.slice(-300), /<guid>/, `${label}: the tail of the input did not survive`);
    assert.equal(
      out.length,
      text.length - guids * (SYNTHETIC_OID.length - '<guid>'.length),
      `${label}: the output is not the input with the ids substituted — something was dropped or truncated`,
    );
  }
});

test('SELF-DEFENCE — redact() contains no length comparison at all, at any magnitude', () => {
  // The behavioural test above spans 1 KB–1 MB, which catches any cap a real
  // implementation would pick — but not, say, a 4 MB one. This closes that,
  // structurally: _azure-redact.mjs's header states the contract as "no length
  // cap and there must never be one", so the source may not compare a length.
  const src = redact.toString();
  const CAP_RE = /\.length\s*[<>]=?/;

  // The guard must be able to FIRE, or it is a zero-population assertion that
  // protects nothing. Prove it against the verbatim mutation shape first.
  const capped = "function redact(text) {\n  if (text.length > 20000) return text;\n  return text;\n}";
  assert.match(capped, CAP_RE, 'the cap matcher must detect the mutation it exists to catch');
  assert.equal(CAP_RE.test('function redact(text) { return text.replace(/x/g, "y"); }'), false, 'and must not fire on the clean shape');

  // Non-degenerate: we are reading the REAL function, not an empty string.
  assert.match(src, /replace/, 'redact.toString() did not return the implementation');
  assert.doesNotMatch(src, CAP_RE, 'redact() compares a length — a size cap leaks the biggest inputs (#3829 round 3)');
});


test('the artifact stays VALID JSON after the boundary redaction', () => {
  // Redacting the serialized artifact is only safe if it cannot corrupt the
  // encoding: the replacements contain no quote or backslash, so parsing must
  // still succeed and the structure must be intact.
  const dir = scratchDir();
  const counter = path.join(dir, 'n');
  fs.writeFileSync(counter, '');
  const artifact = path.join(dir, 'deploy-failure.json');

  const r = runRetry(
    ['--class-allow', 'transient', '--max-attempts', '2', '--backoff', '0', '--jitter', '0', '--artifact', artifact],
    alwaysFails(counter, TRANSIENT),
  );
  assert.notEqual(r.status, 0);
  const a = JSON.parse(fs.readFileSync(artifact, 'utf8'));
  assert.equal(a.schemaVersion, 1);
  assert.equal(a.class, 'transient');
  assert.equal(a.attempts.length, 2);
  assert.ok(a.established.length > 0, 'evidence survives redaction');
  assert.match(a.whyStopped, /budget exhausted/, 'the reason survives redaction');
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
