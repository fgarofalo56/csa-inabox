/**
 * THE JUDGEMENT, AND THE FAILURE IT MUST NOT MISTAKE FOR A PASS (#4046).
 *
 * `check-merged-prs-had-check-runs.mjs` reports on ONE number: how many check
 * runs GitHub holds for a merged PR's head. That makes its whole verdict
 * "an API gave me a non-zero number", and the interesting failure is not a PR
 * that merged blind — it is a QUERY that returns zero because it is broken. Both
 * read `0`, and only one of them is a defect in this repository.
 *
 * So the tests below drive the guard's predicates with an INJECTED reader:
 *
 *   truthful reader   -> controls pass, so a zero elsewhere means a zero
 *   broken reader (0) -> the COVERED control FAILS, so the run refuses
 *
 * The live arm — the same two controls against the real API — runs inside the
 * guard itself on every invocation, so it is not duplicated here; these tests
 * exist to prove the refusal logic, which the live arm can never exercise while
 * the API is healthy.
 *
 * Run: node --test scripts/ci/__tests__/check-merged-prs-had-check-runs.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Import for the predicates only. The module says so on stderr and audits
// nothing, so this cannot be mistaken for a live run.
process.env.LOOM_MERGED_PR_AUDIT_IMPORT_ONLY = '1';
const { CONTROLS, isBlind, runControls, report, main } = await import('../check-merged-prs-had-check-runs.mjs');

/** The readings measured against the live API on 2026-09-06. */
const TRUTHFUL = {
  '6b27f125acadcca9b8a1996002b69d53e183055d': 0,
  '904ae9ae815233325e76b0d265ba9080441e9005': 72,
};

const truthfulReader = (sha) => {
  if (!(sha in TRUTHFUL)) throw new Error(`no recorded reading for ${sha}`);
  return TRUTHFUL[sha];
};

test('zero check runs is the defect; one is enough to say something graded it', () => {
  assert.equal(isBlind(0), true);
  assert.equal(isBlind(1), false);
  assert.equal(isBlind(72), false);
});

test('the controls pin BOTH arms: a known-blind head and a known-covered one', () => {
  const blind = CONTROLS.filter((c) => c.expectFlagged);
  const covered = CONTROLS.filter((c) => !c.expectFlagged);
  assert.equal(blind.length, 1, 'without a blind control the guard has never been shown to fire');
  assert.equal(covered.length, 1, 'without a covered control a broken query reads as a clean audit');
  assert.equal(blind[0].pr, 3678);
  assert.equal(covered[0].pr, 4082);
});

test('with the truthful readings the controls pass, so a zero elsewhere means a zero', () => {
  assert.deepEqual(runControls(truthfulReader), []);
});

test('a query path that returns 0 for EVERYTHING is refused, not reported clean', () => {
  const failures = runControls(() => 0);
  assert.ok(failures.length > 0, 'a broken reader must not produce an empty failure list');
  assert.ok(
    failures.some((f) => f.includes('904ae9ae815233325e76b0d265ba9080441e9005')),
    'the COVERED control is the one that has to notice — got: ' + failures.join(' / '),
  );
});

test('a read that THROWS is a read failure, never a zero', () => {
  const failures = runControls(() => {
    throw new Error('gh api FAILED: HTTP 401');
  });
  assert.equal(failures.length, CONTROLS.length);
  assert.ok(failures.every((f) => f.includes('HTTP 401')), 'the underlying reason must survive into the report');
});

test('the comparison is what fires: mutating it to `< 0` un-flags the blind head', () => {
  // The mutation the PR body records, reproduced in-process. `isBlind` is the
  // single place the judgement lives, so this is the whole of it.
  const mutated = (count) => count < 0;
  assert.equal(mutated(0), false, 'the mutated predicate stops seeing the defect');
  assert.equal(isBlind(0), true, 'and the real one still sees it');
});

test('report() exits non-zero on a blind PR and zero on a covered one', () => {
  const blind = [{ number: 3678, headSha: '6b27f125acadcca9b8a1996002b69d53e183055d', count: 0, flagged: true, mergedAt: '2026-08-17T09:17:23Z' }];
  const covered = [{ number: 4082, headSha: '904ae9ae815233325e76b0d265ba9080441e9005', count: 72, flagged: false, mergedAt: '2026-08-28T03:13:44Z' }];
  assert.equal(report(blind), 1);
  assert.equal(report(covered), 0);
});

// ── main()'s REACTION to a control failure, which nothing used to witness ────
//
// Every test above drives a helper. The independent review of #4347 showed that
// is not enough: deleting only `process.exitCode = 1; return;` from main() —
// leaving runControls entirely intact — kept this suite at 7/7 while the guard
// printed "embedded control(s) passed" over 992 bytes of control failures and
// exited 0. The two tests below drive main() itself, so that mutation now has
// somewhere to land.

/** Runs `fn` with console + process.exitCode captured and then restored. */
function capture(fn) {
  const out = [];
  const err = [];
  const realLog = console.log;
  const realErr = console.error;
  const realCode = process.exitCode;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  process.exitCode = 0;
  let exitCode;
  try {
    fn();
  } finally {
    exitCode = process.exitCode;
    console.log = realLog;
    console.error = realErr;
    // Restore, or a refusal under test would fail the test RUN itself.
    process.exitCode = realCode === undefined ? 0 : realCode;
  }
  return { out, err, exitCode };
}

test('main() REFUSES when the controls fail: non-zero exit, and NO "controls passed" line', () => {
  // The broken-query failure mode: a reader that returns 0 for everything, so
  // the COVERED control fails. Nothing here touches the network.
  const { out, err, exitCode } = capture(() => main(() => 0, ['--controls-only']));

  assert.equal(exitCode, 1, 'a run whose controls failed must exit non-zero, not 0');
  assert.ok(
    !out.some((l) => l.includes('control(s) passed')),
    'the guard must not claim the controls passed when they failed — got: ' + out.join(' / '),
  );
  assert.ok(
    err.some((l) => l.includes('refuses to report an audit')),
    'the refusal must be stated on stderr — got: ' + err.join(' / '),
  );
  assert.ok(
    err.some((l) => l.includes('904ae9ae815233325e76b0d265ba9080441e9005')),
    'and it must carry the failing control, not a generic message',
  );
});

test('main() with a truthful reader states the controls passed and does NOT set a failing exit', () => {
  // The other direction: without this arm the test above would also pass on a
  // guard that refused unconditionally.
  const { out, err, exitCode } = capture(() => main(truthfulReader, ['--controls-only']));

  assert.equal(exitCode, 0, 'healthy controls must not produce a failing exit');
  assert.ok(
    out.some((l) => l.includes(`${CONTROLS.length} embedded control(s) passed`)),
    'a healthy run has to say so, or a zero below it means nothing — got: ' + out.join(' / '),
  );
  assert.equal(err.length, 0, 'nothing should be reported on stderr — got: ' + err.join(' / '));
});
