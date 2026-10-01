/**
 * eval-measurement.test.mjs — #4346: a green eval run must say whether the
 * grounding judge scored anything.
 *
 * Every test names the input that breaks it (assertion-design.md). The
 * fixtures are the receipt shapes measured on 2026-09-30:
 *   - FULLY DEFERRED: 10 surfaces, every one with questions > 0 and
 *     `groundingAvg: null` (runs after ~14:13 UTC, judge cap spent). The old
 *     gate logged "surfaces actually measured: 10" and the summary said PASS.
 *   - PARTIAL: schedule run 36734057169, 6 of 10 surfaces judged.
 *   - JUDGED: the runs after UTC midnight.
 *
 * Mutation arms run against a sandbox copy are listed in the PR body; the
 * comment on each test names the mutation it kills.
 *
 * Run: node --test scripts/ci/__tests__/eval-measurement.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  classifyMeasurement,
  isJudgedSurface,
  outcomeLabel,
  measurementBanner,
  main,
} from '../eval-measurement.mjs';

const SURFACES = ['admin', 'catalog', 'copilot', 'governance', 'lakehouse', 'notebook', 'pipeline', 'rbac', 'warehouse', 'kql'];

const deferred = (surface, questions = 15) => ({
  surface,
  questions,
  retrievalHitRate: 0.8,
  groundingAvg: null,
  passRate: null,
  deterministicPassRate: 0.73,
});
const judged = (surface, questions = 15, groundingAvg = 4.6) => ({
  surface,
  questions,
  retrievalHitRate: 0.8,
  groundingAvg,
  passRate: 0.86,
  deterministicPassRate: 0.73,
});

const FULLY_DEFERRED = { surfaces: SURFACES.map((s) => deferred(s)) };
const PARTIAL = { surfaces: SURFACES.map((s, i) => (i < 6 ? judged(s) : deferred(s))) };
const ALL_JUDGED = { surfaces: SURFACES.map((s) => judged(s)) };

// ── classification ──────────────────────────────────────────────────────────

test('FULLY DEFERRED receipt (150 questions asked, 0 judged) is deterministic-only, not judged', () => {
  // Breaks if the predicate counts ASKED questions (`questions > 0`) — the
  // exact defect: that predicate makes this receipt `judged` with 10/10.
  const m = classifyMeasurement(FULLY_DEFERRED);
  assert.equal(m.measurement, 'deterministic-only');
  assert.equal(m.scoredSurfaces, 10, 'all 10 surfaces asked questions');
  assert.equal(m.judgedSurfaces, 0, 'and the judge scored none of them');
  assert.equal(m.totalQuestions, 150);
  assert.equal(m.judgedQuestions, 0);
});

test('PARTIAL receipt (6 of 10 judged, as run 36734057169) is partial and names the 4 unjudged', () => {
  // Breaks if partial collapses into judged (`judged.length > 0` → judged) or
  // into deterministic-only (`judged.length < scored.length` checked first).
  const m = classifyMeasurement(PARTIAL);
  assert.equal(m.measurement, 'partial');
  assert.equal(m.judgedSurfaces, 6);
  assert.equal(m.judgedQuestions, 90, '6 × 15');
  assert.deepEqual(m.unjudged, SURFACES.slice(6), 'indices 6..9: pipeline, rbac, warehouse, kql');
  assert.deepEqual(m.unjudged, ['pipeline', 'rbac', 'warehouse', 'kql']);
});

test('ALL JUDGED receipt is judged', () => {
  // Positive pair for the two above: breaks if the predicate rejects a real
  // finite score (e.g. requires passRate === null, or inverts the check).
  const m = classifyMeasurement(ALL_JUDGED);
  assert.equal(m.measurement, 'judged');
  assert.equal(m.judgedQuestions, 150);
});

test('groundingAvg: 0 IS judged — the judge ran and scored every answer zero', () => {
  // Breaks on the falsy-zero mutation `if (s.groundingAvg)`: that calls a
  // real 0.0 score "not judged", and a catastrophically bad run reads as
  // "nothing measured" instead of a quality result.
  assert.equal(isJudgedSurface(judged('rbac', 8, 0)), true);
  const m = classifyMeasurement({ surfaces: [judged('rbac', 8, 0)] });
  assert.equal(m.measurement, 'judged');
  assert.equal(m.judgedQuestions, 8);
});

test('a non-null passRate with a null groundingAvg is NOT judged (older images wrote the deterministic rate there)', () => {
  // Breaks if the predicate reads `passRate` instead of / in addition to
  // `groundingAvg` as the judged signal.
  const legacy = { surface: 'admin', questions: 15, groundingAvg: null, passRate: 0.73 };
  assert.equal(isJudgedSurface(legacy), false);
  assert.equal(classifyMeasurement({ surfaces: [legacy] }).measurement, 'deterministic-only');
});

test('a finite groundingAvg on a surface with questions: 0 is NOT judged', () => {
  // Breaks if the `questions > 0` half of the predicate is dropped.
  const s = { surface: 'kql', questions: 0, groundingAvg: 4.9, passRate: 1 };
  assert.equal(isJudgedSurface(s), false);
  assert.equal(classifyMeasurement({ surfaces: [s] }).measurement, 'none');
});

test('a non-numeric groundingAvg ("deferred", NaN) is NOT judged', () => {
  // Breaks if the predicate is `groundingAvg != null` (a string passes it).
  assert.equal(isJudgedSurface({ surface: 'a', questions: 3, groundingAvg: 'deferred' }), false);
  assert.equal(isJudgedSurface({ surface: 'a', questions: 3, groundingAvg: Number.NaN }), false);
});

test('empty surfaces → none; a receipt with no surfaces array THROWS rather than reporting none', () => {
  // The throw breaks if `run.surfaces ?? []` is introduced: a receipt that
  // could not be read would then report "none" — a claim the code never
  // established (deploy-integrity R7).
  assert.equal(classifyMeasurement({ surfaces: [] }).measurement, 'none');
  assert.throws(() => classifyMeasurement({}), /no `surfaces` array/);
  assert.throws(() => classifyMeasurement(null), /no `surfaces` array/);
});

// ── the job-summary label ───────────────────────────────────────────────────

test('success over a deterministic-only run is labelled NOT MEASURED, never PASS', () => {
  // Breaks on restoring the unconditional `success → PASS` label (the defect
  // that printed "Copilot quality evals — PASS" over 0 judged questions).
  const l = outcomeLabel({ category: 'success', measurement: 'deterministic-only', reportedOnly: 'true', gateRc: '1' });
  assert.match(l, /NOT MEASURED/);
  assert.doesNotMatch(l, /— PASS/);
});

test('success with NO recorded measurement (output missing) is NOT MEASURED, not PASS', () => {
  // Breaks if a missing measurement output defaults to PASS — e.g. the evals
  // job died before the gate step and the output is ''.
  const l = outcomeLabel({ category: 'success', measurement: '', reportedOnly: '', gateRc: '' });
  assert.match(l, /NOT MEASURED \(judge measurement: unrecorded/);
  assert.doesNotMatch(l, /— PASS/);
});

test('success over a partial run is PARTIALLY MEASURED', () => {
  // Breaks if partial is folded into either PASS or NOT MEASURED.
  const l = outcomeLabel({ category: 'success', measurement: 'partial', reportedOnly: 'false', gateRc: '0' });
  assert.match(l, /PARTIALLY MEASURED/);
});

test('success over a judged, REPORT-ONLY run is REPORTED, NOT ENFORCED with the gate rc', () => {
  // Breaks if reportedOnly is ignored (would print PASS on a PR whose gate
  // regressed with rc=1 but was report-only).
  const l = outcomeLabel({ category: 'success', measurement: 'judged', reportedOnly: 'true', gateRc: '1' });
  assert.match(l, /REPORTED, NOT ENFORCED \(gate rc=1;/);
  assert.doesNotMatch(l, /— PASS/);
});

test('success over a judged, ENFORCED run is the only PASS', () => {
  // Positive pair: breaks if PASS becomes unreachable (every label demoted).
  assert.equal(
    outcomeLabel({ category: 'success', measurement: 'judged', reportedOnly: 'false', gateRc: '0' }),
    '### Copilot quality evals — PASS',
  );
});

test('failure and no-verdict keep their own labels regardless of measurement', () => {
  // Breaks if measurement is consulted before category (a failure over a
  // judged run would read PASS).
  assert.match(outcomeLabel({ category: 'failure', measurement: 'judged', reportedOnly: 'false' }), /— FAIL/);
  assert.match(outcomeLabel({ category: 'no-verdict', measurement: 'judged', reportedOnly: 'false' }), /— NO VERDICT/);
});

// ── CLI ─────────────────────────────────────────────────────────────────────

function sandbox() {
  return mkdtempSync(path.join(tmpdir(), 'eval-measurement-'));
}

function capture(fn) {
  const out = [];
  const err = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    return { rc: fn(), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = ol;
    console.error = oe;
  }
}

test('CLI --annotate writes outputs and a ::warning:: for a fully deferred receipt', () => {
  // Breaks if the warning is gated on the wrong state (e.g. `=== 'none'`), or
  // if GITHUB_OUTPUT gets the asked count where the judged count belongs.
  const dir = sandbox();
  try {
    const art = path.join(dir, 'eval-run.json');
    const outFile = path.join(dir, 'out');
    writeFileSync(art, JSON.stringify(FULLY_DEFERRED));
    writeFileSync(outFile, '');
    const r = capture(() => main(['--artifact', art, '--annotate'], { GITHUB_OUTPUT: outFile }));
    assert.equal(r.rc, 0);
    assert.match(r.out, /^::warning::eval measurement: NOT MEASURED — the grounding judge scored 0 of 150/m);
    const o = readFileSync(outFile, 'utf-8');
    assert.match(o, /^measurement=deterministic-only$/m);
    assert.match(o, /^judged_questions=0$/m);
    assert.match(o, /^total_questions=150$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --annotate stays silent (no ::warning::) on a judged receipt', () => {
  // Positive pair for the warning: breaks if the warning fires unconditionally,
  // which would teach readers to ignore it.
  const dir = sandbox();
  try {
    const art = path.join(dir, 'eval-run.json');
    writeFileSync(art, JSON.stringify(ALL_JUDGED));
    const r = capture(() => main(['--artifact', art, '--annotate'], {}));
    assert.equal(r.rc, 0);
    assert.match(r.out, /eval measurement: JUDGED — the grounding judge scored 150 of 150/);
    assert.doesNotMatch(r.out, /::warning::/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --prepend-to puts the banner ABOVE the existing summary, and creates the file if absent', () => {
  // Breaks if it appends instead of prepends, or overwrites the summary.
  const dir = sandbox();
  try {
    const art = path.join(dir, 'eval-run.json');
    const md = path.join(dir, 'eval-summary.md');
    writeFileSync(art, JSON.stringify(FULLY_DEFERRED));
    writeFileSync(md, '## existing gate table\n');
    assert.equal(capture(() => main(['--artifact', art, '--prepend-to', md], {})).rc, 0);
    const text = readFileSync(md, 'utf-8');
    assert.ok(text.startsWith(measurementBanner(classifyMeasurement(FULLY_DEFERRED))), 'banner is first');
    assert.ok(text.endsWith('## existing gate table\n'), 'prior summary kept intact, after the banner');

    const fresh = path.join(dir, 'new.md');
    assert.equal(existsSync(fresh), false);
    capture(() => main(['--artifact', art, '--prepend-to', fresh], {}));
    assert.match(readFileSync(fresh, 'utf-8'), /Eval measurement: deterministic-only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 2 on a missing or unparseable artifact, and writes NO measurement output', () => {
  // Breaks if a read failure falls through to a default measurement.
  const dir = sandbox();
  try {
    const outFile = path.join(dir, 'out');
    writeFileSync(outFile, '');
    const missing = capture(() => main(['--artifact', path.join(dir, 'nope.json')], { GITHUB_OUTPUT: outFile }));
    assert.equal(missing.rc, 2);
    assert.match(missing.err, /could not read a measurement/);
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    assert.equal(capture(() => main(['--artifact', bad], { GITHUB_OUTPUT: outFile })).rc, 2);
    assert.equal(readFileSync(outFile, 'utf-8'), '', 'no measurement= line on a read failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --label prints the outcome heading', () => {
  // Breaks if the CLI wires --measurement/--reported-only to the wrong keys
  // (e.g. reported-only dropped → PASS here instead of REPORTED).
  const r = capture(() =>
    main(['--label', '--category', 'success', '--measurement', 'judged', '--reported-only', 'true', '--gate-rc', '0'], {}),
  );
  assert.equal(r.rc, 0);
  assert.match(r.out, /REPORTED, NOT ENFORCED \(gate rc=0;/);
});
