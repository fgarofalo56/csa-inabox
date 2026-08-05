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
  classifyEstate,
  classifyRunHealth,
  classifyWorkflowState,
  decide,
  pickLastRealSuccess,
  DAY_MS,
  ESTATES,
  FAILING_STREAK,
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

// ===========================================================================
// THE ESTATE SIGNAL (2026-08-05) — "make deploy failure impossible to miss".
//
// The operator watched unchanged gates for two weeks while PRs merged green,
// because nothing anywhere surfaced "the estate is N commits behind" or "the
// last infra deploy failed". classifyDrift could not have surfaced either: it
// asks ONLY "when did this workflow last SUCCEED?", so
//
//   - a lane that succeeded recently and has failed on every run since reads
//     `ok` (full-app-deploy-commercial: 6 failures since 2026-06-19;
//      deploy-fiab-commercial: 8 consecutive failed nightlies),
//   - a lane that has been SWITCHED OFF reads as ordinary lag
//     (deploy-fiab-commercial is `disabled_manually` — its cron cannot fire),
//   - and the LIVE estate was never looked at at all.
//
// Each classifier below closes one of those, and each CONTROL case is chosen
// to die under an obvious mutation of the code it guards.
// ===========================================================================

/** Run rows as `gh run list` returns them: newest first. */
const runs = (...conclusions) => conclusions.map((c) => ({ conclusion: c }));

// --- classifyRunHealth ------------------------------------------------------

test('a failure STREAK is failing even though a success exists behind it', () => {
  // full-app-deploy-commercial's real shape: one success, then nothing but red.
  const h = classifyRunHealth(runs('failure', 'failure', 'failure', 'failure', 'success'));
  assert.equal(h.failureStreak, 4);
  assert.equal(h.failing, true);
  assert.equal(h.lastConclusion, 'failure');
});

test('CONTROL: below the streak threshold is NOT failing (one red run is weather)', () => {
  // Pins the boundary in the other direction: flip `>=` to `>` in
  // classifyRunHealth and the exactly-3 case below goes green, killing that.
  const h = classifyRunHealth(runs('failure', 'failure', 'success'));
  assert.equal(h.failureStreak, 2);
  assert.equal(h.failing, false);
});

test('the streak threshold bites at exactly FAILING_STREAK', () => {
  assert.equal(classifyRunHealth(runs('failure', 'failure', 'failure', 'success')).failing, true);
  assert.equal(FAILING_STREAK, 3);
});

test('a newest SUCCESS ends the streak — a repaired path is not reported failing', () => {
  const h = classifyRunHealth(runs('success', 'failure', 'failure', 'failure', 'failure'));
  assert.equal(h.failureStreak, 0);
  assert.equal(h.failing, false);
  assert.equal(h.lastConclusion, 'success');
});

test('in-flight and cancelled runs are SKIPPED, not counted as failures', () => {
  // The mirror of the 2026-08-02 "UNKNOWN reported as NEGATIVE" trap: a run
  // that has not concluded is not evidence of failure. Drop the skip and this
  // two-failure history reads as a four-failure streak.
  const h = classifyRunHealth([
    { conclusion: null }, { conclusion: 'cancelled' },
    { conclusion: 'failure' }, { conclusion: 'failure' }, { conclusion: 'success' },
  ]);
  assert.equal(h.failureStreak, 2);
  assert.equal(h.failing, false);
});

test('a cancelled run in the MIDDLE does not rescue a failing path', () => {
  const h = classifyRunHealth(runs('failure', 'cancelled', 'failure', 'failure', 'success'));
  assert.equal(h.failureStreak, 3);
  assert.equal(h.failing, true);
});

test('startup_failure and timed_out count as failures', () => {
  assert.equal(classifyRunHealth(runs('timed_out', 'startup_failure', 'failure')).failing, true);
});

test('an empty history shows no streak (never-run is classifyDrift job)', () => {
  assert.deepEqual(classifyRunHealth([]), { failureStreak: 0, lastConclusion: null, failing: false });
});

// --- classifyWorkflowState --------------------------------------------------

test('a disabled_manually workflow is reported DISABLED, not merely stale', () => {
  // deploy-fiab-commercial's live state: the only lane that applies main.bicep
  // to Commercial cannot run at all, on schedule or on dispatch.
  const s = classifyWorkflowState('disabled_manually');
  assert.equal(s.disabled, true);
  assert.equal(s.unknown, false);
  assert.equal(s.state, 'disabled_manually');
});

test('CONTROL: an active workflow is neither disabled nor unknown', () => {
  assert.deepEqual(classifyWorkflowState('active'), { state: 'active', disabled: false, unknown: false });
});

test('a workflow MISSING from the listing is UNKNOWN, never "active"', () => {
  // `gh workflow list` defaults to 50 rows; this repo has 117, and the default
  // page silently omitted full-app-deploy-commercial.yml. Reporting that
  // omission as active would be a false green produced by pagination.
  for (const missing of [undefined, null, '']) {
    const s = classifyWorkflowState(missing);
    assert.equal(s.unknown, true, `${String(missing)} must be unknown`);
    assert.equal(s.state, 'unknown');
    assert.equal(s.disabled, false, 'unknown is its own state, not "disabled"');
  }
});

test('disabled_inactivity (the 60-day auto-disable) also counts as disabled', () => {
  assert.equal(classifyWorkflowState('disabled_inactivity').disabled, true);
});

// --- classifyEstate ---------------------------------------------------------

const ESTATE_BOUNDS = { name: 'Commercial', maxCommitsBehind: 20, maxAgeDays: 7 };
const estate = (over) => classifyEstate({ ...ESTATE_BOUNDS, ...over });

test('an estate too many commits behind main is STALE', () => {
  const e = estate({ liveSha: 'abc1234567', commitsBehind: 40, ageDays: 2, ancestor: true });
  assert.equal(e.stale, true);
  assert.equal(e.state, 'behind');
  assert.match(e.detail, /40 commits behind main/);
});

test('CONTROL: an estate within BOTH bounds is ok (ordinary merge lag)', () => {
  // The live 2026-08-05 reading: 12 behind, built the same day. Invert either
  // comparison in classifyEstate and this case flips to stale.
  const e = estate({ liveSha: '678b53bc', commitsBehind: 12, ageDays: 0, ancestor: true });
  assert.equal(e.stale, false);
  assert.equal(e.state, 'behind');
  assert.equal(e.commitsBehind, 12);
});

test('an OLD build is stale even when few commits behind (a quiet week hides a dead roll)', () => {
  const e = estate({ liveSha: 'abc1234567', commitsBehind: 1, ageDays: 30, ancestor: true });
  assert.equal(e.stale, true);
  assert.match(e.detail, /30d old/);
});

test('the estate bounds bite at exactly the limit, in both directions', () => {
  const at = (commitsBehind, ageDays) =>
    estate({ liveSha: 'abc1234567', commitsBehind, ageDays, ancestor: true }).stale;
  assert.equal(at(20, 7), false, 'exactly at both limits is tolerated');
  assert.equal(at(21, 7), true, 'one commit past the commit bound is stale');
  assert.equal(at(20, 8), true, 'one day past the age bound is stale');
});

test('an estate exactly on main is current', () => {
  const e = estate({ liveSha: 'abc1234567', commitsBehind: 0, ageDays: 0, ancestor: true });
  assert.equal(e.state, 'current');
  assert.equal(e.stale, false);
});

test('an UNMEASURABLE estate is STALE, never "current" (the recurring trap)', () => {
  // Three separate incidents in this repo were an unknown rendering as a
  // result. Drop the `error ||` guard and an unreachable console reads green.
  const unreachable = estate({ error: 'marker unreachable — ETIMEDOUT' });
  assert.equal(unreachable.stale, true);
  assert.equal(unreachable.state, 'unknown');

  const noSha = estate({ liveSha: null });
  assert.equal(noSha.stale, true);
  assert.equal(noSha.state, 'unknown');

  const notInCheckout = estate({ liveSha: 'abc1234567', commitsBehind: null, ageDays: null });
  assert.equal(notInCheckout.stale, true);
  assert.equal(notInCheckout.state, 'unknown');
});

test('a build that is NOT an ancestor of main is DIVERGENT, not "0 behind"', () => {
  const e = estate({ liveSha: 'deadbeef99', commitsBehind: null, ageDays: 1, ancestor: false });
  assert.equal(e.state, 'divergent');
  assert.equal(e.stale, true);
  assert.equal(e.commitsBehind, null);
});

// --- the tables themselves --------------------------------------------------

test('the two silently-broken deploy paths are BOTH watched', () => {
  const watched = new Set(WATCHED.map((e) => e.workflow));
  // deploy-fiab-commercial = the sub-level infra deploy (az deployment sub
  // create -f main.bicep); full-app-deploy = the app-image build + roll path.
  // Both were red for weeks; only the first was watched, and even that entry
  // could not say "failing" or "disabled".
  assert.ok(watched.has('deploy-fiab-commercial.yml'), 'the sub-level infra deploy is watched');
  assert.ok(watched.has('full-app-deploy-commercial.yml'), 'the app-image deploy path is watched');
});

test('full-app-deploy watches the image contexts NO other lane builds', () => {
  const entry = WATCHED.find((e) => e.workflow === 'full-app-deploy-commercial.yml');
  // build-fiab-images-acr-tasks.yml's `all` matrix carries eleven apps and not
  // these; full-app-deploy is their only producer, which is why loom-duckdb:v0.1
  // is absent from the Commercial ACR today.
  for (const ctx of [
    'apps/loom-duckdb/**',
    'apps/loom-transform-runner/**',
    'apps/fiab-dbt-runner/**',
    'apps/fiab-wrangler-host/**',
  ]) {
    assert.ok(entry.paths.includes(ctx), `${ctx} is watched by the only lane that builds it`);
  }
});

test('ESTATES is non-empty and every entry carries BOTH bounds', () => {
  // An empty ESTATES would make the live-estate half of this control measure
  // nothing while still printing a header — the hollow-gate shape.
  assert.ok(Array.isArray(ESTATES) && ESTATES.length > 0);
  for (const e of ESTATES) {
    assert.equal(typeof e.name, 'string');
    assert.match(e.markerUrl, /^https:\/\/.+\/build-marker\.txt$/);
    assert.equal(typeof e.maxCommitsBehind, 'number');
    assert.equal(typeof e.maxAgeDays, 'number');
  }
});
