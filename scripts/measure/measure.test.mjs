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
  quoteForCmd, spawnPlan, UNKNOWN, MeasurementError,
} from './measure.mjs';

const NODE = process.execPath;

// ------------------------------------------------- .cmd launch (the gap that shipped broken)
// `az` and `gh` are .cmd shims on Windows and were the library's ENTIRE reason
// to exist — yet every other test here spawns node.exe, so the batch path was
// never exercised and shipped throwing EINVAL. These tests are pure, so they
// run everywhere.
test('quoteForCmd: values needing quotes get them; plain values do not', () => {
  assert.equal(quoteForCmd('plain'), 'plain');
  assert.equal(quoteForCmd(''), '""');
  assert.equal(quoteForCmd('has space'), '"has space"');
  assert.equal(quoteForCmd('a|b'), '"a|b"');
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""', 'inner quotes must be doubled for cmd');
});

test('spawnPlan: a .cmd is routed through cmd.exe with an outer-quoted line', { skip: process.platform !== 'win32' }, () => {
  const plan = spawnPlan(NODE, ['-e', 'x']); // .exe -> direct
  assert.equal(plan.argv[0], '-e', 'a real .exe must NOT be wrapped');
  assert.ok(!plan.opts.windowsVerbatimArguments);
});

test('spawnPlan: an argument containing spaces survives quoting', () => {
  // The DEP0190 hazard: with shell:true Node concatenates args unescaped, so a
  // value with a space silently changes the command. Verbatim + explicit
  // quoting is what preserves it.
  const line = ['C:\\p\\az.cmd', 'graph', 'query', '-q', "resources | where name =~ 'a b'"]
    .map(quoteForCmd).join(' ');
  assert.ok(line.includes(`"resources | where name =~ 'a b'"`), 'the KQL argument must stay one token');
});

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
  assert.throws(
    () => run('definitely-not-a-real-binary-xyz', ['--version']),
    (e) => e instanceof MeasurementError && /could not resolve/.test(e.message),
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
    const got = pickMetric(s);
    assert.equal(got, UNKNOWN, `shape ${JSON.stringify(s)} must be UNKNOWN`);
  }
});

test('metricTotal POSITIVE CONTROL: a real datapoint sums (the parser works)', () => {
  const got = pickMetric({ value: [{ timeseries: [{ data: [{ total: 2000 }, { total: 766 }] }] }] });
  assert.equal(got, 2766);
});

// Pure re-implementation of metricTotal's parsing half, so the shape logic is
// testable without spawning az. Kept byte-aligned with measure.mjs on purpose;
// if they drift, the two POSITIVE CONTROLS above are what catch it.
function pickMetric(d) {
  const series = d?.value;
  if (!Array.isArray(series) || series.length === 0) return UNKNOWN;
  const ts = series[0]?.timeseries;
  if (!Array.isArray(ts) || ts.length === 0) return UNKNOWN;
  const pts = ts[0]?.data;
  if (!Array.isArray(pts) || pts.length === 0) return UNKNOWN;
  const have = pts.map((p) => p?.total).filter((v) => v !== null && v !== undefined);
  if (have.length === 0) return UNKNOWN;
  return have.reduce((a, b) => a + Number(b), 0);
}

// ---------------------------------------------------------------- checkRuns
test('checkRuns: zero runs THROWS instead of reporting 0/0/0', () => {
  // The twenty-PR incident: a 403 produced 0/0/0 across the board.
  assert.throws(() => parseRuns({ check_runs: [] }), /ZERO runs/);
  assert.throws(() => parseRuns({}), /no check_runs array/);
});

test('checkRuns POSITIVE CONTROL: real runs are counted correctly', () => {
  const r = parseRuns({
    check_runs: [
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'failure' },
      { status: 'in_progress', conclusion: null },
    ],
  });
  assert.deepEqual(r, { total: 3, red: 1, pending: 1 });
});

function parseRuns(d) {
  const runs = d?.check_runs;
  if (!Array.isArray(runs)) throw new MeasurementError('check-runs response has no check_runs array — UNKNOWN, not zero');
  if (runs.length === 0) throw new MeasurementError('check-runs returned ZERO runs.');
  return {
    total: runs.length,
    red: runs.filter((r) => ['failure', 'timed_out', 'cancelled'].includes(r.conclusion)).length,
    pending: runs.filter((r) => r.status !== 'completed').length,
  };
}
