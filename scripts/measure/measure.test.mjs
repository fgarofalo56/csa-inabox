#!/usr/bin/env node
/**
 * selftest.mjs — proves every guard in measure.mjs can actually FIRE.
 *
 * Run: node --test scripts/measure/selftest.mjs
 *
 * Each test names the real 2026-08-23 incident it would have prevented, and the
 * suite carries POSITIVE CONTROLS so it cannot pass vacuously — the failure this
 * whole module exists to prevent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  run, runJson, metricTotal, checkRuns, measureWithControl,
  parseMetricSeries, parseCheckRuns, parseHollowness, canonicalBinary,
  UNKNOWN, MeasurementError, SELF_NODE,
} from './measure.mjs';

// A Symbol, not `process.execPath`. This suite used to pass the real path, and
// serving that ONE need is why measure.mjs accepted arbitrary paths at all --
// the hole that let `/tmp/evil/gh.cmd` through the allowlist (see the
// bypass tests below). A Symbol cannot carry a tainted string, so the test's
// need is met without the door being open.
const NODE = SELF_NODE;

// NOTE: the .cmd launch path — the quoting, the batch-shim decision, the ARM-id
// passthrough — is tested in cmd-quote.test.mjs, against the pure module. It is
// not reachable from here: every test below spawns node.exe, which is exactly
// why that branch shipped broken once.

// ---------------------------------------------------------------- R1 / R2
test('POSITIVE CONTROL: a succeeding command returns its output (suite is not vacuous)', () => {
  const r = run(NODE, ['-e', 'process.stdout.write("alive")']);
  assert.equal(r.rc, 0);
  assert.equal(r.stdout, 'alive');
});

test('R1: a non-zero command THROWS — it never yields a value', () => {
  assert.throws(
    () => run(NODE, ['-e', 'process.stderr.write("boom"); process.exit(3)']),
    (e) => e instanceof MeasurementError && /exited 3/.test(e.message) && /boom/.test(e.message),
  );
});

test('R2: the status reported is the SUBJECT\'s, not a wrapper\'s', () => {
  // The original bug: `R=$(az ... | tr -d '\r'); RC=$?` reads tr's status.
  // spawnSync has no pipeline, so a failing subject cannot be masked.
  let captured = null;
  try { run(NODE, ['-e', 'process.exit(42)']); } catch (e) { captured = e.detail.status; }
  assert.equal(captured, 42, 'must surface 42, not 0 from a downstream filter');
});

test('R1: a command that cannot launch THROWS (never a silent zero)', () => {
  // This used to accept any of four different messages, because an unknown name
  // reached a different guard on win32 (PATH scan), on linux (spawn ENOENT), and
  // through the explicit-path branch. That branch is gone, so the allowlist is
  // now the FIRST thing every name meets on every platform and the message is
  // deterministic. Asserting the specific one is stronger, and it is only safe
  // to assert because the divergence was removed rather than papered over.
  assert.throws(
    () => run('definitely-not-a-real-binary-xyz', ['--version']),
    (e) => e instanceof MeasurementError
        && /not an allowed binary/.test(e.message)
        && /definitely-not-a-real-binary-xyz/.test(e.message),
  );
});

test('the allowlist refuses an unknown binary BEFORE any resolution or spawn', () => {
  // The allowlist is the door: `bin` is a string literal at every call site
  // today, and this keeps it that way if one ever becomes argv- or env-derived.
  assert.throws(
    () => run('curl', ['--version']),
    (e) => e instanceof MeasurementError && /not an allowed binary/.test(e.message),
  );
});

test('POSITIVE CONTROL: the allowlist is not refusing EVERYTHING', () => {
  // Without this, the test above would still pass if canonicalBinary threw
  // unconditionally — a guard with a 100% refusal rate blocks nothing useful
  // and would take the whole toolkit down silently.
  const r = run(NODE, ['-e', 'process.stdout.write("ok")']);
  assert.equal(r.stdout, 'ok', 'SELF_NODE must still launch this process\'s own node');
});

// ------------------------------------------------- the 2026-08-24 bypass class
test('BYPASS: a path whose BASENAME is allowlisted is REFUSED', () => {
  // The live hole, exactly as it was exploitable: the old guard tested
  // `path.basename(bin)` -> 'gh.cmd' -> strip ext -> 'gh' -> ALLOWED, and then
  // spawned the WHOLE STRING. One attacker-writable directory plus one file
  // named after any allowlisted binary was the entire exploit.
  //
  // Validating a PROJECTION of the input and then using the ORIGINAL is the
  // shape; the fix is that nothing derived from `bin` can become the executable.
  //
  // NB: the first fixture deliberately does NOT live under /tmp. It is never
  // written -- it is asserted to be REFUSED -- but check-temp-artifact-safety
  // matches the literal, not the intent, and a required check does not care
  // that a string is only ever an argument to assert.throws().
  for (const evil of [
    '/opt/evil/gh.cmd',
    'C:\\evil\\gh.cmd',
    './az',
    '../../node',
    'evil/git',
  ]) {
    assert.throws(
      () => run(evil, ['--version']),
      (e) => e instanceof MeasurementError
          && /not an allowed binary/.test(e.message)
          && /paths are not accepted/.test(e.message),
      `${evil} must be refused FOR BEING A PATH`,
    );
  }
});

test('BYPASS: the rejection reason is "it is a path", not "it does not exist"', () => {
  // The old message said the path "does not exist" — true, and precisely the
  // bug: it implied the SAME path would have been fine had it existed. It would
  // have been. An error must not imply a rule the code does not enforce.
  const real = process.execPath; // an existing, legitimate, allowlisted-basename path
  assert.throws(
    () => run(real, ['-e', 'process.stdout.write("pwned")']),
    (e) => e instanceof MeasurementError && /paths are not accepted/.test(e.message),
    'an EXISTING path must be refused too, or the guard is just an existence check',
  );
});

test('TAINT: canonicalBinary returns the TABLE literal, never the caller string', () => {
  // The headline invariant of the whole rewrite. Every other bypass test asserts
  // that bad input is REFUSED -- none of them notices if an ACCEPTED input is
  // passed straight through, because a refusal happens either way. So
  // `return ALLOWED_BINARIES[key]` could become `return bin` and the entire
  // suite stayed green. That is the one line the security fix exists to protect.
  //
  // Identity is not enough here: 'gh' === 'gh' whichever branch runs. The test
  // has to use an input that DIFFERS from its canonical form, so the only way to
  // pass is to have actually gone through the table.
  assert.equal(canonicalBinary('GH'), 'gh');
  assert.equal(canonicalBinary('Az'), 'az');
  assert.equal(canonicalBinary('GIT'), 'git');
  assert.notEqual(canonicalBinary('GH'), 'GH', 'the caller string must not survive');
});

test('BYPASS: inherited Object properties are not allowlist entries', () => {
  // `ALLOWED_BINARIES` is a null-prototype object read through Object.hasOwn.
  // With a plain `{}` and an `in`/truthy test, 'constructor' and '__proto__'
  // would both hit and resolve to something spawnable-looking.
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.throws(
      () => run(key, ['--version']),
      (e) => e instanceof MeasurementError && /not an allowed binary/.test(e.message),
      `${key} must not inherit its way onto the allowlist`,
    );
  }
});

test('BYPASS: a non-string binary is refused rather than coerced', () => {
  for (const junk of [null, undefined, 42, {}, ['gh'], Symbol('gh')]) {
    assert.throws(
      () => run(junk, ['--version']),
      (e) => e instanceof MeasurementError && /must be a bare allowed name/.test(e.message),
      `${String(junk)} must be refused`,
    );
  }
});

test('SELF_NODE errors report a readable label, not a TypeError', () => {
  // `${symbol}` throws "Cannot convert a Symbol value to a string". Every throw
  // site on the SELF_NODE path interpolates the binary name, so without a
  // display helper the reported failure would be the REPORTER's own crash and
  // the real one would be lost.
  assert.throws(
    () => run(NODE, ['-e', 'process.exit(9)']),
    (e) => e instanceof MeasurementError
        && /exited 9/.test(e.message)
        && /node \(/.test(e.message),
  );
  assert.throws(
    () => runJson(NODE, ['-e', 'process.stdout.write("")']),
    (e) => e instanceof MeasurementError && /NO output/.test(e.message) && /node \(/.test(e.message),
  );
});

// ---------------------------------------------------------------- R4
test('R4: empty stdout is UNKNOWN, not an empty object', () => {
  assert.throws(
    () => runJson(NODE, ['-e', 'process.stdout.write("")']),
    (e) => /NO output/.test(e.message) && /UNKNOWN/.test(e.message),
  );
});

test('R4: unparseable output THROWS rather than defaulting', () => {
  assert.throws(
    () => runJson(NODE, ['-e', 'process.stdout.write("<html>429</html>")']),
    (e) => /not JSON/.test(e.message),
  );
});

// ---------------------------------------------------------------- R5, the core guard
test('R5: a ZERO subject is REFUSED when the control is also zero', () => {
  // This is precisely the seven-apps incident: subject 0, control 0, because
  // the query never ran. Reporting "0 requests" there was the defect.
  assert.throws(
    () => measureWithControl({
      label: 'loom-activator requests',
      subject: () => 0,
      control: () => 0,
      controlLabel: 'loom-console requests',
    }),
    (e) => e instanceof MeasurementError && /CONTROL .* returned 0/.test(e.message),
  );
});

test('R5: a control that THROWS blocks the measurement', () => {
  assert.throws(
    () => measureWithControl({
      label: 'subject',
      subject: () => 0,
      control: () => { throw new MeasurementError('403 rate limit'); },
    }),
    (e) => /CONTROL .* FAILED/.test(e.message) && /403/.test(e.message),
  );
});

test('R5: an UNKNOWN subject is refused even with a healthy control', () => {
  assert.throws(
    () => measureWithControl({ label: 's', subject: () => UNKNOWN, control: () => 2766 }),
    (e) => /UNKNOWN/.test(e.message) && /NOT zero/.test(e.message),
  );
});

test('R5 POSITIVE CONTROL: a real zero IS reportable when the control proves the query works', () => {
  // The discriminating case: same zero, but now the control says the path is live.
  const r = measureWithControl({
    label: 'loom-activator requests',
    subject: () => 0,
    control: () => 2766,
    controlLabel: 'loom-console requests',
  });
  assert.equal(r.value, 0);
  assert.equal(r.control.value, 2766);
});

test('R5: a non-zero subject still passes through', () => {
  const r = measureWithControl({ label: 's', subject: () => 17, control: () => 1 });
  assert.equal(r.value, 17);
});

// ---------------------------------------------------------------- metricTotal
// These exercise `parseMetricSeries` -- the REAL parsing half of metricTotal,
// exported for exactly this reason. An earlier version of this file carried a
// local copy instead, and the copy drifted: it read `p?.total` only, so the
// aggregation branch below had never once been executed. A test asserting
// against its own reimplementation tests the reimplementation.
test('metricTotal: no series / no timeseries / no datapoints => UNKNOWN, never 0', () => {
  // Shapes an az metrics response takes when the query effectively found nothing.
  const shapes = [
    {},
    { value: [] },
    { value: [{ timeseries: [] }] },
    { value: [{ timeseries: [{ data: [] }] }] },
    { value: [{ timeseries: [{ data: [{ total: null }] }] }] },
  ];
  for (const s of shapes) {
    const got = parseMetricSeries(s);
    assert.equal(got, UNKNOWN, `shape ${JSON.stringify(s)} must be UNKNOWN`);
  }
});

test('metricTotal POSITIVE CONTROL: a real datapoint sums (the parser works)', () => {
  const got = parseMetricSeries({ value: [{ timeseries: [{ data: [{ total: 2000 }, { total: 766 }] }] }] });
  assert.equal(got, 2766);
});

test('metricTotal: a NON-Total aggregation reads its own key (the drifted branch)', () => {
  // The copy this replaced returned UNKNOWN here, because it only ever looked
  // at `p.total`. Production keys off the aggregation name. Every caller that
  // passes aggregation:'Average' was reading UNKNOWN-vs-42 untested.
  const d = { value: [{ timeseries: [{ data: [{ average: 12 }, { average: 30 }] }] }] };
  assert.equal(parseMetricSeries(d, 'Average'), 42);
  // ...and with the default aggregation the same payload has no `total` key,
  // so it is honestly UNKNOWN rather than silently 0.
  assert.equal(parseMetricSeries(d), UNKNOWN);
});

test('metricTotal: `total` remains the fallback when the aggregation key is absent', () => {
  const d = { value: [{ timeseries: [{ data: [{ total: 7 }] }] }] };
  assert.equal(parseMetricSeries(d, 'Maximum'), 7);
});

// ---------------------------------------------------------------- checkRuns
// Against the REAL `parseCheckRuns`. The copy this replaced folded `cancelled`
// INTO `red` -- asserting the opposite convention from the code it covered --
// and had no truncation refusal at all, which is the important one.
test('checkRuns: zero runs THROWS instead of reporting 0/0/0', () => {
  // The twenty-PR incident: a 403 produced 0/0/0 across the board.
  assert.throws(() => parseCheckRuns([{ check_runs: [] }]), /ZERO runs/);
  assert.throws(() => parseCheckRuns([{}]), /no check_runs array/);
});

test('checkRuns POSITIVE CONTROL: real runs are counted correctly', () => {
  const r = parseCheckRuns([{
    check_runs: [
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'failure' },
      { status: 'in_progress', conclusion: null },
    ],
  }]);
  assert.equal(r.total, 3);
  assert.equal(r.red, 1);
  assert.equal(r.pending, 1);
});

test('checkRuns: `cancelled` is its OWN count, never folded into red', () => {
  // cancelled == UNKNOWN, not a failure. Folding it into `red` makes a re-runnable
  // check look like a real failure; ignoring it entirely (drain-status did this)
  // makes an all-cancelled PR read as READY. It needs its own column.
  const r = parseCheckRuns([{
    check_runs: [
      { status: 'completed', conclusion: 'cancelled' },
      { status: 'completed', conclusion: 'cancelled' },
      { status: 'completed', conclusion: 'success' },
    ],
  }]);
  assert.equal(r.red, 0, 'cancelled must NOT count as red');
  assert.equal(r.cancelled, 2);
  assert.equal(r.pending, 0);
});

test('checkRuns: a SHORT read against a declared total is REFUSED, not reported', () => {
  // The saturated-page incident: 100 of 137 fetched, and the missing vitest
  // check on page 2 read as "no vitest check on this SHA".
  assert.throws(
    () => parseCheckRuns([{ total_count: 137, check_runs: [{ status: 'completed', conclusion: 'success' }] }]),
    /TRUNCATED: fetched 1 of 137/,
  );
});

test('checkRuns POSITIVE CONTROL: a COMPLETE multi-page read is accepted', () => {
  // Proves the truncation guard is not simply refusing everything.
  const page = (n, c) => ({ total_count: 3, check_runs: Array.from({ length: n }, () => ({ status: 'completed', conclusion: c })) });
  const r = parseCheckRuns([page(2, 'success'), page(1, 'failure')]);
  assert.equal(r.total, 3);
  assert.equal(r.red, 1);
  assert.equal(r.declaredTotal, 3);
});

test('checkRuns: a page with no array THROWS even when earlier pages were fine', () => {
  assert.throws(
    () => parseCheckRuns([{ total_count: 5, check_runs: [{ status: 'completed', conclusion: 'success' }] }, { message: 'Not Found' }]),
    /no check_runs array/,
  );
});

// ------------------------------------------------------------ hollowness
test('hollowness: a green job whose every substantive step SKIPPED is hollow', () => {
  // The live case: `vitest (node 20)` reported success with "Run vitest" skipped,
  // because the diff touched no console files. Branch protection accepted it.
  const r = parseHollowness({
    conclusion: 'success',
    steps: [
      { name: 'Set up job', conclusion: 'success' },
      { name: 'Run actions/checkout@v4', conclusion: 'success' },
      { name: 'Install deps', conclusion: 'skipped' },
      { name: 'Run vitest', conclusion: 'skipped' },
      { name: 'Complete job', conclusion: 'success' },
    ],
  });
  assert.equal(r.hollow, true);
  assert.equal(r.ran, 0);
  assert.equal(r.skipped, 2);
});

test('hollowness POSITIVE CONTROL: a job that actually ran is NOT hollow', () => {
  // Without this, `hollow: false` would satisfy the test above's sibling and the
  // whole check could be hard-wired to one answer.
  const r = parseHollowness({
    conclusion: 'success',
    steps: [
      { name: 'Set up job', conclusion: 'success' },
      { name: 'Run vitest', conclusion: 'success' },
    ],
  });
  assert.equal(r.hollow, false);
  assert.equal(r.ran, 1);
});

test('hollowness: a job with NO steps is UNKNOWN — it throws rather than guessing', () => {
  assert.throws(() => parseHollowness({ conclusion: 'success', steps: [] }), /no steps/);
  assert.throws(() => parseHollowness({}), /no steps/);
});
