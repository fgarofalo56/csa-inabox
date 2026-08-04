/**
 * Self-tests for check-deploy-staleness.mjs (#2775 — "merged ≠ deployed").
 *
 * WHAT IS BEING PINNED. The control watches dispatch-only DEPLOY workflows and
 * fails when a workflow's last successful run predates its last code change —
 * undeployed code is drift. The whole value of that control is the comparison,
 * and until this suite existed the comparison had a test count of ZERO: it ran
 * weekly against the live estate and had never once been shown to FAIL on a
 * fixture. A guard nobody has watched fail is the same defect class it exists to
 * catch (#2585 / the "gates that measure nothing" lesson) one rung over — a gate
 * whose teeth are unverified.
 *
 * So every branch of the drift decision is driven here with fixtures — no gh, no
 * git, no network — and each CONTROL case is chosen to DIE under an obvious
 * mutation of the code it guards:
 *
 *   - invert `driftDays > maxDays` to `<`  → the STALE-past-threshold case and
 *     the ok-within-threshold case swap, and BOTH assertions below flip. (The
 *     boundary pair at exactly maxDays / maxDays+1 pins it to the day.)
 *   - drop the `queryFailed || neverRan ||` guard → a failed gh query has a null
 *     runAt, so `code > NaN` is false and it would read `ok`. The UNKNOWN test
 *     asserts stale===true, so that mutation goes red. This is the 2026-08-02
 *     "UNKNOWN reported as fresh" trap, closed here.
 *   - remove the dry-run filter in pickLastRealSuccess → an all-dry history would
 *     return the dry run's timestamp (a false "deployed"); the all-dry test
 *     asserts { at: null }, so that mutation goes red.
 *   - make decide() always return code 0 → the any-stale test goes red.
 *
 * Run: node --test scripts/ci/__tests__/deploy-staleness.test.mjs
 * (Also picked up automatically by scripts/ci/check-node-test-suites.mjs, which
 *  the merge-blocking `guardrails` job runs — so these have teeth in CI.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDrift,
  decide,
  pickLastRealSuccess,
  DAY_MS,
  WATCHED,
} from '../check-deploy-staleness.mjs';

/** `n` days after ISO `t`, as an ISO-Z string. */
const plusDays = (t, n) => new Date(Date.parse(t) + n * DAY_MS).toISOString();
const RUN = '2026-01-01T00:00:00.000Z';
const ok = (run, code, maxDays) => classifyDrift({ codeAt: code, run: { at: run }, maxDays });

// ---------------------------------------------------------------------------
// classifyDrift — the drift decision (the whole point of the control)
// ---------------------------------------------------------------------------

test('run OLDER than code beyond maxDays is STALE (the #2775 shape)', () => {
  // gov-uc-purview-wire's real numbers: ran 2026-07-15, code 2026-07-30, limit 14.
  const c = classifyDrift({
    codeAt: '2026-07-30T00:00:00.000Z',
    run: { at: '2026-07-15T00:00:00.000Z' },
    maxDays: 14,
  });
  assert.equal(c.stale, true);
  assert.equal(c.driftDays, 15);
  assert.equal(c.neverRan, false);
  assert.equal(c.queryFailed, false);
});

test('CONTROL: run older than code but WITHIN maxDays is ok (ordinary lag)', () => {
  // csa-loom-post-deploy-bootstrap's real shape: 14 days of drift, limit 21.
  const c = ok('2026-07-19T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 21);
  assert.equal(c.stale, false);
  assert.equal(c.driftDays, 14);
});

test('CONTROL: run NEWER than code is ok, zero drift', () => {
  const c = ok(plusDays(RUN, 5), RUN, 14); // code 5 days BEFORE the run
  assert.equal(c.stale, false);
  assert.equal(c.driftDays, 0);
});

test('boundary: drift exactly == maxDays is ok; maxDays+1 is STALE', () => {
  // Pins the comparison to the day, so `>`→`>=` and `>`→`<` mutants both die.
  // ok(run, code, maxDays): code is 14 / 15 days AFTER the run.
  const atLimit = ok(RUN, plusDays(RUN, 14), 14);
  assert.equal(atLimit.driftDays, 14);
  assert.equal(atLimit.stale, false, 'drift == maxDays must be tolerated');

  const overLimit = ok(RUN, plusDays(RUN, 15), 14);
  assert.equal(overLimit.driftDays, 15);
  assert.equal(overLimit.stale, true, 'drift == maxDays+1 must fail');
});

test('never-run is STALE regardless of how generous maxDays is', () => {
  const c = classifyDrift({ codeAt: RUN, run: { at: null }, maxDays: 99_999 });
  assert.equal(c.stale, true);
  assert.equal(c.neverRan, true);
  assert.equal(c.queryFailed, false);
  assert.equal(c.driftDays, Infinity);
});

test('gh-query-failed is UNKNOWN → STALE, never a false green (2026-08-02 trap)', () => {
  const c = classifyDrift({
    codeAt: RUN,
    run: { queryFailed: true, error: 'gh: API rate limit exceeded' },
    maxDays: 99_999,
  });
  assert.equal(c.stale, true, 'an un-answerable query must NOT read as fresh');
  assert.equal(c.queryFailed, true);
  assert.equal(c.neverRan, false, 'a broken query is distinct from a never-run workflow');
  assert.equal(c.queryError, 'gh: API rate limit exceeded');
  assert.equal(c.driftDays, Infinity);
});

test('the dry-run count rides along on the classified row', () => {
  const c = classifyDrift({
    codeAt: RUN,
    run: { at: null, dryRunsSkipped: 3 },
    maxDays: 14,
  });
  assert.equal(c.neverRan, true);
  assert.equal(c.stale, true);
  assert.equal(c.dryRunsSkipped, 3); // "never ran for REAL — 3 dry runs ignored"
});

// ---------------------------------------------------------------------------
// pickLastRealSuccess — the dry-run filter (a dry run deploys nothing)
// ---------------------------------------------------------------------------

test('picks the newest REAL success, skipping a newer dry run', () => {
  const rows = [
    { createdAt: '2026-03-10T00:00:00Z', displayTitle: 'deploy-fiab-commercial — DRY RUN (whatif-only)' },
    { createdAt: '2026-03-01T00:00:00Z', displayTitle: 'deploy-fiab-commercial — apply' },
  ];
  const r = pickLastRealSuccess(rows);
  assert.equal(r.at, '2026-03-01T00:00:00Z');
  assert.equal(r.dryRunsSkipped, 1);
});

test('a history of ONLY dry runs is "never ran for real", not the dry timestamp', () => {
  const rows = [
    { createdAt: '2026-03-10T00:00:00Z', displayTitle: 'x — DRY RUN' },
    { createdAt: '2026-03-09T00:00:00Z', displayTitle: 'y — DRY RUN' },
  ];
  const r = pickLastRealSuccess(rows);
  assert.equal(r.at, null, 'a dry run deploys nothing, so it cannot count as the last deploy');
  assert.equal(r.dryRunsSkipped, 2);
});

test('CONTROL: with no dry runs the newest success wins', () => {
  const rows = [
    { createdAt: '2026-03-10T00:00:00Z', displayTitle: 'apply' },
    { createdAt: '2026-03-01T00:00:00Z', displayTitle: 'apply' },
  ];
  const r = pickLastRealSuccess(rows);
  assert.equal(r.at, '2026-03-10T00:00:00Z');
  assert.equal(r.dryRunsSkipped, 0);
});

test('an empty run history is null (feeds the never-ran branch)', () => {
  const r = pickLastRealSuccess([]);
  assert.equal(r.at, null);
  assert.equal(r.dryRunsSkipped, 0);
});

// ---------------------------------------------------------------------------
// decide — the exit code over a set of rows
// ---------------------------------------------------------------------------

test('decide: all rows ok → exit 0, no stale', () => {
  const { stale, code } = decide([{ stale: false }, { stale: false }]);
  assert.equal(code, 0);
  assert.deepEqual(stale, []);
});

test('decide: any stale row → exit 1', () => {
  const { stale, code } = decide([{ stale: false }, { stale: true }, { stale: false }]);
  assert.equal(code, 1);
  assert.equal(stale.length, 1);
});

// ---------------------------------------------------------------------------
// The WATCHED table must not be vacuous — a guard watching nothing is a green
// that measures nothing.
// ---------------------------------------------------------------------------

test('WATCHED is a non-empty, well-formed allowlist', () => {
  assert.ok(Array.isArray(WATCHED) && WATCHED.length > 0);
  for (const e of WATCHED) {
    assert.equal(typeof e.workflow, 'string', 'each entry names a workflow');
    assert.match(e.workflow, /\.yml$/);
    assert.ok(Array.isArray(e.paths) && e.paths.length > 0, `${e.workflow} declares paths`);
    assert.ok(e.paths.includes(`.github/workflows/${e.workflow}`), `${e.workflow} watches its own file`);
    assert.equal(typeof e.maxDays, 'number', `${e.workflow} sets a numeric maxDays`);
    assert.ok(e.maxDays >= 0);
    assert.ok(typeof e.why === 'string' && e.why.length > 0, `${e.workflow} states why it matters`);
  }
});

test('the three #2775-documented deploy paths are all watched', () => {
  const watched = new Set(WATCHED.map((e) => e.workflow));
  for (const wf of [
    'gov-uc-purview-wire.yml',
    'gov-workspace-identity.yml',
    'csa-loom-post-deploy-bootstrap.yml',
  ]) {
    assert.ok(watched.has(wf), `${wf} (documented in #2775) must be a WATCHED entry`);
  }
});
