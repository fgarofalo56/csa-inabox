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
  isFullyJudgedSurface,
  isProbedSurface,
  describeMeasurement,
  outcomeLabel,
  measurementBanner,
  notMeasuredCheckRun,
  NOT_MEASURED_CHECK_NAME,
  NOT_MEASURED_STATES,
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

test('FULLY DEFERRED receipt (150 questions answered, 0 judged) is deterministic-only, not judged', () => {
  // Breaks if the predicate counts ASKED questions (`questions > 0`) — the
  // exact defect: that predicate makes this receipt `judged` with 10/10.
  const m = classifyMeasurement(FULLY_DEFERRED);
  assert.equal(m.measurement, 'deterministic-only');
  assert.equal(m.probedSurfaces, 10, 'all 10 surfaces returned answers');
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

// Every probe call on the surface failed (the mixed 403/5xx shape from #2798):
// no row came back, so `questions: 0`, but 15 rows were attempted.
const allProbesFailed = (surface) => ({
  surface,
  questions: 0,
  retrievalHitRate: 0,
  groundingAvg: null,
  passRate: null,
  rowsAttempted: 15,
  probeErrors: { 403: 10, 502: 5 },
});
const SIX_JUDGED_FOUR_FAILED = {
  surfaces: SURFACES.map((s, i) => (i < 6 ? judged(s) : allProbesFailed(s))),
};

test('6 judged + 4 surfaces whose every probe failed is PARTIAL, never judged / PASS (#4865 review)', () => {
  // Breaking value: `questions: 0, rowsAttempted: 15`. Under the old
  // `qs(s) > 0` filter those 4 surfaces dropped out of BOTH sides of the
  // count, the run classified `judged` ("6 of 6"), and the label read PASS.
  const m = classifyMeasurement(SIX_JUDGED_FOUR_FAILED);
  assert.equal(isProbedSurface(allProbesFailed('kql')), true, 'rowsAttempted > 0 is a probed surface');
  assert.equal(m.measurement, 'partial');
  assert.equal(m.probedSurfaces, 10, 'the 4 failed surfaces are in the denominator');
  assert.equal(m.judgedSurfaces, 6);
  assert.deepEqual(m.unjudged, ['pipeline', 'rbac', 'warehouse', 'kql']);
  assert.match(describeMeasurement(m), /kql \(0 of 15 probed row\(s\) returned an answer\)/);
  const label = outcomeLabel({ category: 'success', measurement: m.measurement, reportedOnly: 'false', gateRc: '0' });
  assert.match(label, /— PARTIALLY MEASURED/);
  assert.notEqual(label, '### Copilot quality evals — PASS');
});

test('a surface with no rowsAttempted and questions: 0 is still not probed (positive pair)', () => {
  // Breaks if the probed predicate is widened to "any surface in the receipt":
  // a floored surface that was simply not in this run would then read as a
  // failed probe instead of being absent.
  assert.equal(isProbedSurface({ surface: 'kql', questions: 0 }), false);
  assert.equal(isProbedSurface({ surface: 'kql', questions: 0, rowsAttempted: 0 }), false);
  assert.equal(classifyMeasurement({ surfaces: [judged('admin'), { surface: 'kql', questions: 0 }] }).measurement, 'judged');
});

test('every surface probed and none answered is `none`, and says the surfaces WERE probed', () => {
  // Breaks if all-probes-failed is reported as deterministic-only (there is no
  // deterministic rate either: nothing came back), or if the sentence still
  // says "no surface asked a question" — the questions WERE asked.
  const m = classifyMeasurement({ surfaces: SURFACES.map(allProbesFailed) });
  assert.equal(m.measurement, 'none');
  assert.equal(m.probedSurfaces, 10);
  assert.equal(describeMeasurement(m), 'NOT MEASURED — no surface returned an answer (10 of 10 surface(s) in the receipt were probed).');
});

// The judge budget ran out mid-surface: one row scored, so groundingAvg is
// finite, but the evaluator's own coverage says 20% of judgeable rows.
const partlyJudged = (surface, judgeCoverage) => ({
  ...judged(surface),
  passPredicate: { id: 'deterministic+grounding', conjuncts: ['deterministic', 'grounding'], judgeCoverage, degraded: false },
});

test('judgeCoverage 0.2 on one surface makes the run PARTIAL, not "fully scored" (#4865 review)', () => {
  // Breaking value: `passPredicate.judgeCoverage: 0.2` with a finite
  // groundingAvg. The old predicate read only groundingAvg, so this receipt
  // was `judged` and printed "scored 150 of 150" — 12 of those 15 rows on
  // `kql` were never judged.
  const run = { surfaces: SURFACES.map((s) => (s === 'kql' ? partlyJudged(s, 0.2) : judged(s))) };
  const m = classifyMeasurement(run);
  assert.equal(isJudgedSurface(partlyJudged('kql', 0.2)), true, 'it does have a grounding score');
  assert.equal(isFullyJudgedSurface(partlyJudged('kql', 0.2)), false, 'but not a full one');
  assert.equal(m.measurement, 'partial');
  assert.equal(m.judgedSurfaces, 9);
  assert.equal(m.judgedQuestions, 135, '9 fully judged surfaces x 15; kql is not counted as scored');
  assert.deepEqual(m.unjudged, [], 'kql HAS a grounding score; it is listed as partly judged instead');
  assert.match(describeMeasurement(m), /Partly judged: kql \(judge coverage 20%\)/);
});

test('judgeCoverage 1 is fully judged, and a receipt without judgeCoverage keeps the old reading (positive pair)', () => {
  // Breaks if coverage is required to be PRESENT (pre-#2992 receipts would
  // all turn partial), or if the comparison is `> 1` / `=== undefined`.
  assert.equal(isFullyJudgedSurface(partlyJudged('kql', 1)), true);
  assert.equal(isFullyJudgedSurface(judged('kql')), true, 'no passPredicate at all');
  assert.equal(isFullyJudgedSurface(partlyJudged('kql', 0.999)), false, 'just below 1 is partial');
  assert.equal(classifyMeasurement({ surfaces: SURFACES.map((s) => partlyJudged(s, 1)) }).measurement, 'judged');
});

test('the NOT MEASURED sentence does not assert WHY the judge scored nothing', () => {
  // Breaking value: the previous sentence "The judge was deferred on every
  // surface", which the receipt cannot establish — a judge that errored on
  // every row, or rows that all auto-failed, produce the same groundingAvg:
  // null shape (deploy-integrity R7).
  const d = describeMeasurement(classifyMeasurement(FULLY_DEFERRED));
  assert.match(d, /^NOT MEASURED — /);
  assert.match(d, /The judge scored no question on any surface/);
  assert.match(d, /The receipt does not say why: a deferred judge .*, a judge call that failed on every row, or every row auto-failing/);
  assert.doesNotMatch(d, /was deferred on every surface/);
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
  assert.doesNotMatch(l, /REPORTED, NOT ENFORCED/, 'an enforced partial run is not called report-only');
});

test('a report-only PARTIAL run keeps the REPORTED, NOT ENFORCED tag and its gate rc', () => {
  // Breaking value: reportedOnly 'true' on a partial run. Before this fix the
  // partial branch returned first and the gate rc (here 1) was lost.
  const l = outcomeLabel({ category: 'success', measurement: 'partial', reportedOnly: 'true', gateRc: '1' });
  assert.match(l, /PARTIALLY MEASURED/);
  assert.match(l, /REPORTED, NOT ENFORCED \(gate rc=1\)/);
});

test('success over a judged, REPORT-ONLY run is REPORTED, NOT ENFORCED with the gate rc', () => {
  // Breaks if reportedOnly is ignored (would print PASS on a PR whose gate
  // regressed with rc=1 but was report-only).
  const l = outcomeLabel({ category: 'success', measurement: 'judged', reportedOnly: 'true', gateRc: '1' });
  assert.match(l, /REPORTED, NOT ENFORCED \(gate rc=1;/);
  assert.doesNotMatch(l, /— PASS/);
});

test('a judged, REPORT-ONLY run with gate rc 0 is still REPORTED, not PASS', () => {
  // Breaking value: gateRc '0'. A mutation that applies REPORTED only on a
  // non-zero rc (`reportedOnly === 'true' && gateRc !== '0'`) passes the rc=1
  // case above and prints PASS here.
  const l = outcomeLabel({ category: 'success', measurement: 'judged', reportedOnly: 'true', gateRc: '0' });
  assert.equal(l, '### Copilot quality evals — REPORTED, NOT ENFORCED (gate rc=0; an estate verdict, not a verdict on this diff)');
});

test('a judged run whose reportedOnly output is EMPTY is not PASS (fails closed)', () => {
  // Breaking value: reportedOnly ''. The old `String(reportedOnly) === 'true'`
  // test fell through to PASS for '' — an enforcement the gate never recorded.
  for (const ro of ['', undefined, 'yes']) {
    const l = outcomeLabel({ category: 'success', measurement: 'judged', reportedOnly: ro, gateRc: '0' });
    assert.match(l, /— JUDGED, ENFORCEMENT UNRECORDED \(gate rc=0;/, `reportedOnly=${JSON.stringify(ro)}`);
    assert.notEqual(l, '### Copilot quality evals — PASS');
  }
});

test('success over a judged, ENFORCED run is the only PASS', () => {
  // Positive pair: breaks if PASS becomes unreachable (every label demoted).
  assert.equal(
    outcomeLabel({ category: 'success', measurement: 'judged', reportedOnly: 'false', gateRc: '0' }),
    '### Copilot quality evals — PASS',
  );
});

test('failure over a JUDGED run is the only "real verdict" FAIL; no-verdict keeps its label', () => {
  // Positive pair for the failure tests below: breaks if the judged failure
  // loses "a real verdict", or if measurement is consulted before category
  // (a failure over a judged run would read PASS).
  assert.equal(
    outcomeLabel({ category: 'failure', measurement: 'judged', reportedOnly: 'false' }),
    '### Copilot quality evals — FAIL (a real verdict; see the eval job)',
  );
  assert.match(outcomeLabel({ category: 'no-verdict', measurement: 'judged', reportedOnly: 'false' }), /— NO VERDICT$/);
});

test('failure over a DETERMINISTIC-ONLY run is a judge/measurement failure, not "a real verdict" (#4865 review)', () => {
  // Breaking value: category 'failure' + measurement 'deterministic-only'.
  // The old label returned on `failure` before reading measurement and
  // printed "FAIL (a real verdict…)" over a run the judge scored nothing in —
  // the gate's own message for that run says "JUDGE failure, not a quality
  // regression".
  const l = outcomeLabel({ category: 'failure', measurement: 'deterministic-only', reportedOnly: 'false', gateRc: '1' });
  assert.match(l, /— FAIL, NOT MEASURED \(judge measurement: deterministic-only; the judge scored nothing, so this is a judge\/measurement failure, not a judged quality verdict/);
  assert.doesNotMatch(l, /a real verdict/);
});

test('failure over a PARTIAL run says it is not a full quality verdict (#4865 review)', () => {
  // Breaking value: category 'failure' + measurement 'partial' — same
  // short-circuit as above. The label does not claim the failure IS a judge
  // failure: on a partial run a judged surface can also have regressed, and
  // the receipt alone does not say which (deploy-integrity R7).
  const l = outcomeLabel({ category: 'failure', measurement: 'partial', reportedOnly: 'false', gateRc: '1' });
  assert.match(l, /— FAIL, PARTIALLY MEASURED \(the judge did not fully score every surface, so this is not a full quality verdict: the failure may be a judge\/measurement failure/);
  assert.doesNotMatch(l, /a real verdict/);
});

test('failure with no recorded measurement, and over `none`, are not "a real verdict" either', () => {
  // Breaking values: measurement '' (the evals job died before the gate step)
  // and 'none' (no surface returned an answer).
  assert.equal(
    outcomeLabel({ category: 'failure', measurement: '', reportedOnly: '', gateRc: '' }),
    '### Copilot quality evals — FAIL (the eval job failed before a judge measurement was recorded; see the eval job)',
  );
  assert.match(outcomeLabel({ category: 'failure', measurement: 'none' }), /— FAIL, NOT MEASURED \(judge measurement: none;/);
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
  // if GITHUB_OUTPUT gets the answered count where the judged count belongs.
  const dir = sandbox();
  try {
    const art = path.join(dir, 'eval-run.json');
    const outFile = path.join(dir, 'out');
    writeFileSync(art, JSON.stringify(FULLY_DEFERRED));
    writeFileSync(outFile, '');
    const r = capture(() => main(['--artifact', art, '--annotate'], { GITHUB_OUTPUT: outFile }));
    assert.equal(r.rc, 0);
    assert.match(r.out, /^::warning::eval measurement: NOT MEASURED — the grounding judge fully scored 0 of the 10 surface\(s\) that were probed \(10 in the receipt\); 0 of the 150 question\(s\) that returned an answer/m);
    const o = readFileSync(outFile, 'utf-8');
    assert.match(o, /^measurement=deterministic-only$/m);
    assert.match(o, /^judged_questions=0$/m);
    assert.match(o, /^total_questions=150$/m);
    // Breaks if measurement_text is dropped from GITHUB_OUTPUT (the neutral
    // check-run would then publish the fallback line, not the measurement),
    // or if it carries the JUDGED wording for a deferred receipt.
    assert.match(o, /^measurement_text=NOT MEASURED — the grounding judge fully scored 0 of the 10 surface\(s\) that were probed/m);
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
    assert.match(r.out, /eval measurement: JUDGED — the grounding judge fully scored 10 of the 10 surface\(s\) that were probed \(10 in the receipt\); 150 of the 150 question\(s\)/);
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

// ── the neutral "not measured" check-run ───────────────────────────────────

const SHA = 'a'.repeat(39) + 'b';

test('the check-run name is the exact literal tools/drain/gates.py reads', () => {
  // Breaks if the name is reworded here without the drain gate following:
  // gates.py would then read the renamed neutral check as ordinary clean
  // coverage. tools/drain/__tests__/test_gates.py lifts the same constant from
  // this module's source, so both sides are pinned to one string.
  assert.equal(NOT_MEASURED_CHECK_NAME, 'Copilot quality: not measured');
  assert.deepEqual([...NOT_MEASURED_STATES], ['deterministic-only', 'partial', 'none']);
});

test('every not-judged measurement gets a NEUTRAL, completed check-run carrying the measurement line', () => {
  // Breaks if the conclusion is anything but `neutral` (`success` would read
  // as a pass; `failure` would turn a PR check red), if the name drifts, or if
  // the summary drops the describeMeasurement line it was given.
  for (const measurement of ['deterministic-only', 'partial', 'none']) {
    const text = `${measurement === 'partial' ? 'PARTIALLY' : 'NOT'} MEASURED — fixture line for ${measurement}.`;
    const body = notMeasuredCheckRun({ measurement, text, headSha: SHA });
    assert.equal(body.name, 'Copilot quality: not measured', measurement);
    assert.equal(body.conclusion, 'neutral', measurement);
    assert.equal(body.status, 'completed', measurement);
    assert.equal(body.head_sha, SHA, measurement);
    assert.equal(body.output.title, measurement === 'partial' ? 'Partially measured' : 'Not measured');
    assert.ok(body.output.summary.startsWith(`**Judge measurement: ${measurement}.** ${text}\n\n`), body.output.summary);
    assert.match(body.output.summary, /not a quality verdict and not a pass/);
  }
});

test('a judged or unrecorded measurement publishes NO check-run (positive pair)', () => {
  // Breaks if the state filter is removed and a judged run also gets a
  // "not measured" check — the check would then be on every PR and say
  // nothing.
  for (const measurement of ['judged', '', undefined, 'unrecorded', 'JUDGED']) {
    assert.equal(notMeasuredCheckRun({ measurement, text: 'x', headSha: SHA }), null, String(measurement));
  }
});

test('a head sha that is not 40 hex characters throws instead of attaching to a wrong commit', () => {
  // Breaks if the sha check is dropped: an empty sha (no PR context) would be
  // POSTed and the API would reject it, or worse, a short sha would be sent.
  for (const headSha of ['', undefined, 'abc123', SHA.toUpperCase(), `${SHA}0`]) {
    assert.throws(() => notMeasuredCheckRun({ measurement: 'none', text: 'x', headSha }), /40-character hex/, String(headSha));
  }
});

test('an empty measurement line still yields a summary that names the measurement', () => {
  // Breaks if the fallback is removed (the summary would start with an empty
  // sentence) — the measurement_text output is empty when the gate step wrote
  // an older output set.
  const body = notMeasuredCheckRun({ measurement: 'none', text: '  ', headSha: SHA });
  assert.match(body.output.summary, /^\*\*Judge measurement: none\.\*\* The evals job recorded the measurement `none` but no description of it\./);
});

test('CLI --check-run prints the JSON body; refuses judged and a bad sha with exit 2 and no stdout', () => {
  // Breaks if the CLI wires --text / --head-sha to the wrong keys, or exits 0
  // with an empty body for a judged run (the workflow would POST an empty file).
  const ok = capture(() =>
    main(['--check-run', '--measurement', 'partial', '--text', 'PARTIALLY MEASURED — line.', '--head-sha', SHA], {}),
  );
  assert.equal(ok.rc, 0, ok.err);
  const body = JSON.parse(ok.out);
  assert.equal(body.conclusion, 'neutral');
  assert.equal(body.head_sha, SHA);
  assert.match(body.output.summary, /PARTIALLY MEASURED — line\./);

  const judged = capture(() => main(['--check-run', '--measurement', 'judged', '--text', 'x', '--head-sha', SHA], {}));
  assert.equal(judged.rc, 2);
  assert.equal(judged.out, '');
  assert.match(judged.err, /only for deterministic-only \/ partial \/ none; got "judged"/);

  const bad = capture(() => main(['--check-run', '--measurement', 'none', '--text', 'x', '--head-sha', 'abc'], {}));
  assert.equal(bad.rc, 2);
  assert.equal(bad.out, '');
  assert.match(bad.err, /40-character hex/);
});
