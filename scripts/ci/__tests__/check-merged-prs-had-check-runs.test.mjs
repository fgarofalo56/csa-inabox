/**
 * #4046 — the guard for "a PR merged into main with ZERO check runs".
 *
 * WHAT THIS SUITE HAS TO PROVE, given the class ALREADY LOOKS CLOSED. The last
 * blind merge (#3678, head 6b27f125) is weeks old, so a guard written for it
 * would pass on today's tree whether it worked or not. A test that only asserts
 * "the repo is clean right now" would be measuring the repo, not the guard.
 *
 * So the subject here is the PREDICATE, exercised over both ends of the class
 * with the counts recorded from the real API on 2026-09-02:
 *
 *   #3678 head 6b27f125 -> total_count = 0  -> must be FLAGGED
 *   #4082 head 904ae9ae -> total_count = 72 -> must be CLEAN
 *   #4288 head e30cd576 -> total_count = 28 -> must be CLEAN
 *
 * and over the two shapes that let a detector read green while detecting
 * nothing: an API call that FAILED (must not become "zero, therefore fine", and
 * must not become "fine" either), and a comparison mutated so it can no longer
 * fire.
 *
 * THE MUTATION ARM IS THE POINT. `runControls()` replays those recorded
 * observations through whatever predicate it is handed, so this suite can hand
 * it a WEAKENED predicate and watch the controls disagree. That is what makes
 * the embedded controls a ratchet rather than decoration: change `total === 0`
 * to `total < 0` in the real script and the script itself refuses to run, which
 * this proves by construction rather than by transcript.
 *
 * Run: node --test scripts/ci/__tests__/check-merged-prs-had-check-runs.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  judge,
  runControls,
  resolvePr,
  countCheckRuns,
  CONTROLS,
  GRADED,
  BLIND,
  UNREADABLE,
  NO_PR,
} from '../check-merged-prs-had-check-runs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'ci', 'check-merged-prs-had-check-runs.mjs');
const GUARDRAILS = join(REPO_ROOT, '.github', 'workflows', 'loom-guardrails.yml');

const pr = (number, head) => ({ number, head });

// ── THE TWO ENDS OF THE CLASS ──────────────────────────────────────────────

test('#3678 (head 6b27f125, ZERO check runs) is FLAGGED', () => {
  const v = judge({ pr: pr(3678, '6b27f125'), checkRuns: { ok: true, total: 0 } });
  assert.equal(v.verdict, BLIND);
  assert.match(v.why, /#3678/);
  assert.match(v.why, /6b27f125/, 'the message must name the head that was not graded');
});

test('#4082 (head 904ae9ae, 72 check runs) is CLEAN', () => {
  assert.equal(judge({ pr: pr(4082, '904ae9ae'), checkRuns: { ok: true, total: 72 } }).verdict, GRADED);
});

test('#4288 (head e30cd576, 28 check runs) is CLEAN', () => {
  assert.equal(judge({ pr: pr(4288, 'e30cd576'), checkRuns: { ok: true, total: 28 } }).verdict, GRADED);
});

test('one check run is the boundary — graded, not flagged', () => {
  assert.equal(judge({ pr: pr(1, 'aaaaaaa'), checkRuns: { ok: true, total: 1 } }).verdict, GRADED);
});

// ── AN UNREADABLE API IS NOT A PASS, AND IS NOT A ZERO ─────────────────────

test('a failed API call is UNREADABLE, and the message does not claim zero', () => {
  const v = judge({ pr: pr(9, 'bbbbbbb'), checkRuns: { ok: false, why: 'HTTP 403: Resource not accessible' } });
  assert.equal(v.verdict, UNREADABLE);
  assert.match(v.why, /HTTP 403/, 'the real cause has to survive into the message');
  assert.ok(
    !/ZERO check runs/.test(v.why),
    `an unreadable count must not be reported as zero (R7): ${v.why}`,
  );
});

test('a non-numeric total_count is refused rather than rounded to zero', () => {
  for (const total of [null, undefined, 'many', 1.5, -1]) {
    const v = judge({ pr: pr(9, 'bbbbbbb'), checkRuns: { ok: true, total } });
    assert.equal(v.verdict, UNREADABLE, `total=${JSON.stringify(total)} must be refused`);
  }
});

test('a commit with no PR is reported as unobserved, never as clean', () => {
  const v = judge({ pr: null, checkRuns: { ok: true, total: 0 } });
  assert.equal(v.verdict, NO_PR);
  assert.match(v.why, /outside what this detector can see/);
});

// ── THE MUTATION ARM: THE CONTROLS ACTUALLY BITE ───────────────────────────

test('the control table covers both ends of the class', () => {
  assert.ok(CONTROLS.length >= 5, `an emptied control table passes vacuously (${CONTROLS.length})`);
  assert.ok(CONTROLS.some((c) => c.expect === BLIND), 'no control exercises the flagged case');
  assert.ok(CONTROLS.some((c) => c.expect === GRADED), 'no control exercises the clean case');
  assert.ok(CONTROLS.some((c) => c.expect === UNREADABLE), 'no control exercises an unreadable read');
});

test('the real predicate agrees with every recorded observation', () => {
  assert.deepEqual(runControls(), []);
});

test('a comparison mutated to `< 0` is caught by the controls', () => {
  // The exact mutation named in the brief. `total < 0` can never be true for a
  // count, so the guard would pass on every input — including #3678.
  const weakened = (o) => {
    if (!o.pr) return { verdict: NO_PR, why: '' };
    if (o.checkRuns.ok !== true) return { verdict: UNREADABLE, why: '' };
    return { verdict: o.checkRuns.total < 0 ? BLIND : GRADED, why: '' };
  };
  const failures = runControls(weakened);
  assert.ok(failures.length > 0, 'a predicate that can never fire must be caught');
  assert.ok(
    failures.some((f) => f.name.includes('#3678')),
    `the #3678 control is the one that must disagree, got: ${failures.map((f) => f.name).join(' | ')}`,
  );
});

test('a predicate that treats an unreadable API as clean is caught', () => {
  const optimistic = (o) => {
    if (!o.pr) return { verdict: NO_PR, why: '' };
    if (o.checkRuns.ok !== true) return { verdict: GRADED, why: '' };
    return { verdict: o.checkRuns.total === 0 ? BLIND : GRADED, why: '' };
  };
  assert.ok(runControls(optimistic).length > 0);
});

// ── THE IO HALF FAILS CLOSED ───────────────────────────────────────────────

test('a gh failure becomes an explicit refusal carrying its stderr', () => {
  const run = () => {
    const e = new Error('Command failed');
    e.stderr = 'gh: Resource not accessible by integration (HTTP 403)';
    throw e;
  };
  const res = resolvePr('o/r', 'deadbeef', run);
  assert.equal(res.ok, false);
  assert.match(res.why, /403/, 'the stderr must reach the caller, not be discarded');
});

test('the PR for a merge commit is resolved by merge_commit_sha, not by position', () => {
  const run = () =>
    JSON.stringify([
      { number: 11, merge_commit_sha: 'other', head: { sha: 'h11' } },
      { number: 22, merge_commit_sha: 'sha1', head: { sha: 'h22' } },
    ]);
  assert.deepEqual(resolvePr('o/r', 'sha1', run), { ok: true, pr: { number: 22, head: 'h22' } });
});

test('an ambiguous commit resolves to no PR rather than guessing one', () => {
  const run = () =>
    JSON.stringify([
      { number: 11, merge_commit_sha: 'x', head: { sha: 'h11' } },
      { number: 22, merge_commit_sha: 'y', head: { sha: 'h22' } },
    ]);
  assert.deepEqual(resolvePr('o/r', 'sha1', run), { ok: true, pr: null });
});

test('a response with no numeric total_count is unreadable, not zero', () => {
  const run = () => JSON.stringify({ check_runs: [] });
  const res = countCheckRuns('o/r', 'head', run);
  assert.equal(res.ok, false);
  assert.match(res.why, /total_count/);
});

test('a real numeric total_count is read straight through', () => {
  const run = () => JSON.stringify({ total_count: 72, check_runs: [] });
  assert.deepEqual(countCheckRuns('o/r', '904ae9ae', run), { ok: true, total: 72 });
});

// ── AND IT IS ACTUALLY WIRED IN ────────────────────────────────────────────

test('the guard is invoked from a workflow, on push to main', () => {
  // A guard nobody runs is the defect one rung below the one being closed
  // (#2860). check-ci-guard-reachability.mjs enforces the general rule; this
  // pins the SPECIFIC vantage point, which is the whole design: on a
  // `pull_request` event the job would be a check run on the very head it is
  // counting, so it could never observe a zero.
  const yaml = readFileSync(GUARDRAILS, 'utf8');
  assert.match(yaml, /node scripts\/ci\/check-merged-prs-had-check-runs\.mjs/);
  assert.match(
    yaml,
    /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/,
    'the audit job must be scoped to a push on main — see the header for why a PR event cannot work',
  );
});

test('the script discards no result', () => {
  // CODE only. The header discusses `2>/dev/null` at length — a check a COMMENT
  // could fail is as wrong as one a comment could satisfy
  // (check-ci-guard-reachability.mjs makes the same distinction, in the other
  // direction).
  const src = readFileSync(SCRIPT, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  assert.ok(src.includes('execFileSync'), 'comment-stripping must not have emptied the corpus');
  for (const forbidden of ['|| true', '2>/dev/null', 'continue-on-error']) {
    assert.ok(!src.includes(forbidden), `a detector that swallows its own result is not a detector: ${forbidden}`);
  }
});
