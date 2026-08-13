/**
 * run-outcome.test.mjs — the mutation table for #3368.
 *
 * A guard that cannot fail is worse than none (csa_loom_gates_that_measure_nothing,
 * and the proto-pollution test that could never fail). So this suite does not
 * merely assert that the classifier RUNS: for every state that matters it
 * asserts the verdict CHANGES, and it reproduces the two defects verbatim to
 * show the old predicate and the new one disagree on exactly the inputs the
 * incident turned on.
 *
 * Run: node --test scripts/ci/__tests__/run-outcome.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyOutcome,
  isGenuineFailure,
  hasVerdict,
  rollUp,
  cliDecision,
} from '../run-outcome.mjs';

// ── THE MUTATION TABLE ───────────────────────────────────────────────────────
//
// input → category, genuineFailure, verdict. Every row is a state GitHub can
// actually produce. If a future edit collapses two of them, at least one row
// here changes and the suite goes red.

const TABLE = [
  // raw                 category      genuineFailure  verdict
  ['success', 'success', false, true],
  ['failure', 'failure', true, true],
  ['timed_out', 'failure', true, true],
  ['startup_failure', 'failure', true, true],
  ['cancelled', 'no-verdict', false, false],
  ['canceled', 'no-verdict', false, false], // the American spelling GitHub uses in some payloads
  ['skipped', 'no-verdict', false, false],
  ['neutral', 'no-verdict', false, false],
  ['stale', 'no-verdict', false, false],
  ['action_required', 'no-verdict', false, false],
  ['in_progress', 'pending', false, false],
  ['queued', 'pending', false, false],
  ['waiting', 'pending', false, false],
  [null, 'pending', false, false],
  [undefined, 'pending', false, false],
  ['', 'pending', false, false],
  ['   ', 'pending', false, false],
  ['SUCCESS', 'success', false, true], // case is not a state
  ['Cancelled', 'no-verdict', false, false],
  ['some_new_github_state', 'unknown', false, false],
];

test('MUTATION TABLE — every GitHub outcome maps to its own category, and none collapse', () => {
  for (const [raw, category, genuine, verdict] of TABLE) {
    const c = classifyOutcome(raw);
    assert.equal(c.category, category, `${JSON.stringify(raw)} → category`);
    assert.equal(c.genuineFailure, genuine, `${JSON.stringify(raw)} → genuineFailure`);
    assert.equal(c.verdict, verdict, `${JSON.stringify(raw)} → verdict`);
    assert.equal(isGenuineFailure(raw), genuine, `${JSON.stringify(raw)} → isGenuineFailure`);
    assert.equal(hasVerdict(raw), verdict, `${JSON.stringify(raw)} → hasVerdict`);
  }
});

test('the five states named in #3368 are FIVE distinct categories, not two', () => {
  // The acceptance criterion, stated as an assertion: success / failure /
  // cancelled / in-progress / null must not be collapsible into pass+fail.
  const cats = ['success', 'failure', 'cancelled', 'in_progress', null].map((r) => classifyOutcome(r).category);
  assert.deepEqual(cats, ['success', 'failure', 'no-verdict', 'pending', 'pending']);
  // …and cancelled is on neither side of the pass/fail line.
  const cancelled = classifyOutcome('cancelled');
  assert.equal(cancelled.genuineFailure, false, 'cancelled must not read as failed');
  assert.equal(cancelled.verdict, false, 'cancelled must not read as passed either');
});

test('an unrecognised outcome is UNKNOWN — never guessed into failure or success', () => {
  // GitHub can add a conclusion at any time. Folding it into `failure` would
  // manufacture the false P0 this module exists to stop; folding it into
  // `success` would hide a real one. It gets its own category and says so.
  const c = classifyOutcome('quantum_superposed');
  assert.equal(c.category, 'unknown');
  assert.equal(c.genuineFailure, false);
  assert.equal(c.verdict, false);
  assert.match(c.label, /does not recognise/);
});

test('R7 — every label is TRUE for its state, and none of them says "failed" for a cancellation', () => {
  assert.match(classifyOutcome('cancelled').label, /produced NO verdict/);
  assert.doesNotMatch(classifyOutcome('cancelled').label, /\bfailed\b/);
  assert.doesNotMatch(classifyOutcome('skipped').label, /\bfailed\b/);
  assert.doesNotMatch(classifyOutcome(null).label, /\bfailed\b/);
  assert.match(classifyOutcome('failure').label, /genuinely failed/);
});

// ── THE TWO DEFECTS, REPRODUCED ──────────────────────────────────────────────

test('DEFECT 1 REPRODUCED — `!= success` and the new predicate DISAGREE on cancelled/skipped', () => {
  // full-app-deploy-commercial.yml:1193 was
  //     needs.redeploy-with-apps.result != 'success' || needs.build.result == 'failure'
  // inside an `if: always()` job. Run 31710130307 concluded `cancelled` and it
  // filed #3356 as a P0. This is that predicate against this one.
  const oldPredicate = (r) => r !== 'success';
  const newPredicate = (r) => isGenuineFailure(r);

  // Where they agree — the fix must not stop filing on real failures.
  assert.equal(oldPredicate('failure'), true);
  assert.equal(newPredicate('failure'), true);
  assert.equal(oldPredicate('success'), false);
  assert.equal(newPredicate('success'), false);

  // Where they DISAGREE — precisely the incident, and a `skipped` sibling.
  for (const r of ['cancelled', 'skipped', null, '']) {
    assert.equal(oldPredicate(r), true, `old predicate fires on ${JSON.stringify(r)} (the bug)`);
    assert.equal(newPredicate(r), false, `new predicate must NOT fire on ${JSON.stringify(r)}`);
  }
});

test('DEFECT 2 REPRODUCED — a queue-displaced evals job is no-verdict, distinct from BOTH pass and fail', () => {
  // The `evals` job carries `concurrency: {group: copilot-quality-evals-estate,
  // cancel-in-progress: false}`. GitHub keeps one pending run per group and
  // cancels the older pending one, so the displaced job's result is `cancelled`
  // with zero steps executed. A reviewer must be able to tell that from a
  // genuine red.
  const displaced = classifyOutcome('cancelled');
  const genuine = classifyOutcome('failure');
  const passed = classifyOutcome('success');
  assert.notEqual(displaced.category, genuine.category);
  assert.notEqual(displaced.category, passed.category);
  assert.equal(displaced.category, 'no-verdict');
});

// ── ROLL-UP (the trivy / sbom / dbt shape: several shards, one check) ────────

test('rollUp is worst-first — one genuine failure outranks a cancelled sibling', () => {
  assert.equal(rollUp(['failure', 'cancelled']).category, 'failure');
  assert.equal(rollUp(['cancelled', 'failure']).category, 'failure');
  assert.equal(rollUp(['success', 'success']).category, 'success');
  assert.equal(rollUp(['success', 'cancelled']).category, 'no-verdict');
  assert.equal(rollUp(['success', 'in_progress']).category, 'pending');
  assert.equal(rollUp(['cancelled', 'in_progress']).category, 'no-verdict');
  assert.equal(rollUp(['success', 'weird_new_state']).category, 'unknown');
  // An empty roll-up is PENDING, not success. "I measured nothing" must never
  // present as "everything passed".
  assert.equal(rollUp([]).category, 'pending');
  assert.equal(rollUp([]).verdict, false);
});

// ── THE CLI EXIT CONTRACT, BOTH MODES ────────────────────────────────────────

test('MUTATION — default mode: only a GENUINE failure exits non-zero', () => {
  const code = (results, requireVerdict = false) => cliDecision({ results, requireVerdict, what: 'x' }).code;
  assert.equal(code(['success']), 0);
  assert.equal(code(['failure']), 1);
  assert.equal(code(['timed_out']), 1);
  assert.equal(code(['cancelled']), 0, 'a cancellation is logged, never escalated');
  assert.equal(code(['skipped']), 0);
  assert.equal(code(['']), 0);
  assert.equal(code(['unrecognised']), 0);
});

test('MUTATION — --require-verdict fails CLOSED on every non-verdict, and says so truthfully', () => {
  const d = (results) => cliDecision({ results, requireVerdict: true, what: 'trivy-fs' });
  assert.equal(d(['success']).code, 0);
  assert.equal(d(['failure']).code, 1);
  // Fail closed — a cancelled scan must never count as a pass…
  assert.equal(d(['cancelled']).code, 1);
  assert.equal(d(['skipped']).code, 1);
  assert.equal(d(['']).code, 1);
  assert.equal(d(['unrecognised']).code, 1);
  // …but the MESSAGE must not claim it failed. That is the R7 half of the fix:
  // the exit status is unchanged from the code this replaces; the claim is not.
  const cancelled = d(['cancelled']);
  assert.match(cancelled.annotation, /it did NOT fail/);
  assert.match(cancelled.annotation, /produced NO verdict/);
  assert.doesNotMatch(cancelled.annotation, /gate failed/);
  // A genuine failure still says failed, plainly.
  assert.match(d(['failure']).annotation, /genuinely failed/);
});

test('the two modes differ ONLY on the absence of a verdict', () => {
  for (const r of ['success', 'failure', 'timed_out']) {
    assert.equal(
      cliDecision({ results: [r], requireVerdict: false, what: null }).code,
      cliDecision({ results: [r], requireVerdict: true, what: null }).code,
      `${r} must not depend on the mode`,
    );
  }
  for (const r of ['cancelled', 'skipped', '', 'unrecognised']) {
    assert.notEqual(
      cliDecision({ results: [r], requireVerdict: false, what: null }).code,
      cliDecision({ results: [r], requireVerdict: true, what: null }).code,
      `${r} must depend on the mode`,
    );
  }
});

test('no --result at all is a USAGE error (exit 2), not a silent pass', () => {
  // A check invoked without the thing it is meant to classify must not report a
  // verdict it never computed.
  const d = cliDecision({ results: [], requireVerdict: false, what: null });
  assert.equal(d.code, 2);
  assert.match(d.annotation, /Refusing to classify nothing/);
});

test('the CLI names the subject and every part, so the annotation is auditable', () => {
  const d = cliDecision({ results: ['success', 'cancelled'], requireVerdict: true, what: 'trivy CRITICAL gate' });
  assert.match(d.line, /trivy CRITICAL gate/);
  assert.match(d.line, /success/);
  assert.match(d.line, /cancelled/);
});

// ── SELF-DEFENCE ─────────────────────────────────────────────────────────────

test('the classifier has no result-discarding constructs', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, '..', 'run-outcome.mjs'), 'utf8');
  assert.doesNotMatch(src, /\|\| true/);
  assert.doesNotMatch(src, /continue-on-error/);
  assert.doesNotMatch(src, /2>\/dev\/null/);
});

test('the mutation table is non-degenerate — it covers every category', () => {
  // A table that only exercised one category would pass while proving nothing.
  const covered = new Set(TABLE.map(([raw]) => classifyOutcome(raw).category));
  assert.deepEqual(
    [...covered].sort(),
    ['failure', 'no-verdict', 'pending', 'success', 'unknown'],
    'every category must be exercised by the table',
  );
  assert.ok(TABLE.length >= 18, `table shrank to ${TABLE.length} rows`);
});
