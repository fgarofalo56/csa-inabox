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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflow, scalarValue } from '../_workflow-yaml.mjs';
import {
  classifyDrift,
  classifyEstate,
  classifyRunHealth,
  classifyWorkflowState,
  decide,
  pickLastRealSuccess,
  DAY_MS,
  DRY_RUN_MARKER,
  ESTATES,
  FAILING_STREAK,
  WATCHED,
} from '../check-deploy-staleness.mjs';

/** Workflow directory, resolved from the repo root the suite is run from. */
const WORKFLOWS = '.github/workflows';

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
//
// MEASUREMENT DISCIPLINE, for whoever re-walks this: measure the check's exit
// code DIRECTLY, never through a pipe.
//     node scripts/ci/check-deploy-staleness.mjs ; echo "EXIT=$?"     # correct
//     node scripts/ci/check-deploy-staleness.mjs | tee x ; echo "$?"  # reads
//                                                    tee's 0, ALWAYS
// A reviewer measuring this control through a pipe read EXIT=0 when it was
// really 1, and deploy-staleness.yml itself shipped the same `| tee` bug (fixed
// there by capturing $? from the command and re-raising it). If you must pipe,
// use ${PIPESTATUS[0]}.

const GRACE = 90;
const ESTATE_BOUNDS = { name: 'Commercial', behindGraceMinutes: GRACE, maxAgeDays: 7 };
const estate = (over) => classifyEstate({ ...ESTATE_BOUNDS, ...over });
/** Minutes → the ISO date that many minutes ago (for behindSince). */
const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

test('MUTATION PROOF — the REAL 2026-08-05 estate (13 behind, ~16h) is NOT green', () => {
  // THE CASE THIS CONTROL EXISTS FOR, and the one its first cut could not fire
  // on. Live reading on 2026-08-05: marker sha 678b53bc, 13 commits behind main
  // (14 once #3001 landed), oldest unapplied commit merged ~15.6 HOURS earlier,
  // build commit ~16h old. Under the shipped `maxCommitsBehind: 20` this
  // classified `ok` — the estate-drift half never fired on the actual drift, and
  // the exit-1 came entirely from the WATCHED workflow rows.
  //
  // A threshold that cannot fire on today's real condition is not a signal.
  const real = estate({
    liveSha: '678b53bccccc4c23ae6afa7f851a22a6910d7bb0',
    commitsBehind: 13,
    ageDays: 1,
    ancestor: true,
    behindSince: minsAgo(936), // 15.6h
    behindForMinutes: 936,
  });
  assert.equal(real.stale, true, 'a 13-commits-behind estate must produce a non-green signal');
  assert.equal(real.state, 'behind');
  assert.equal(real.commitsBehind, 13);
  assert.match(real.detail, /roll path has stopped/);

  // And it is the TIME, not the count, that fires: the same 13 commits with the
  // oldest merged one minute ago is a roll in flight and is tolerated. Delete
  // the grace and this goes red; restore a count band and the case above does.
  const inFlight = estate({
    liveSha: '678b53bc', commitsBehind: 13, ageDays: 0, ancestor: true,
    behindSince: minsAgo(1), behindForMinutes: 1,
  });
  assert.equal(inFlight.stale, false, 'a merge one minute old is a roll in flight, not drift');
  assert.equal(inFlight.state, 'behind');
});

test('ONE commit behind, past the grace, is STALE — there is no count band', () => {
  // The strongest statement of the new rule: being behind AT ALL is the
  // condition. Reintroduce any `commitsBehind > N` tolerance and this dies.
  const e = estate({ liveSha: 'abc1234567', commitsBehind: 1, ageDays: 0, ancestor: true, behindForMinutes: GRACE + 1 });
  assert.equal(e.stale, true);
  assert.equal(e.state, 'behind');
});

test('the grace bites at exactly behindGraceMinutes, in both directions', () => {
  const at = (behindForMinutes) =>
    estate({ liveSha: 'abc1234567', commitsBehind: 5, ageDays: 0, ancestor: true, behindForMinutes }).stale;
  assert.equal(at(GRACE), false, 'exactly at the allowance is tolerated');
  assert.equal(at(GRACE + 1), true, 'one minute past the allowance is stale');
  // …and flipping `>` to `<` in classifyEstate swaps both of these.
});

test('behind with an UNMEASURABLE wait is STALE — unmeasured is not "recent"', () => {
  // The recurring trap in its newest clothes: with no commit date there is
  // nothing demonstrating an in-flight roll, so the allowance must not apply.
  // Default behindForMinutes to 0 instead of null and this goes green.
  for (const missing of [undefined, null]) {
    const e = estate({ liveSha: 'abc1234567', commitsBehind: 9, ageDays: 0, ancestor: true, behindForMinutes: missing });
    assert.equal(e.stale, true, `behindForMinutes=${String(missing)} must not buy a green`);
    assert.equal(e.state, 'behind');
    assert.match(e.detail, /could not be measured/);
  }
});

test('an OLD build is stale even sitting exactly on main (a quiet week hides a dead build lane)', () => {
  const e = estate({ liveSha: 'abc1234567', commitsBehind: 0, ageDays: 30, ancestor: true });
  assert.equal(e.stale, true);
  assert.equal(e.state, 'current');
  assert.match(e.detail, /30d old/);
});

test('an estate exactly on main with a fresh build is current', () => {
  const e = estate({ liveSha: 'abc1234567', commitsBehind: 0, ageDays: 0, ancestor: true });
  assert.equal(e.state, 'current');
  assert.equal(e.stale, false);
});

test('the age bound bites at exactly maxAgeDays', () => {
  const at = (ageDays) => estate({ liveSha: 'abc1234567', commitsBehind: 0, ageDays, ancestor: true }).stale;
  assert.equal(at(7), false);
  assert.equal(at(8), true);
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

// --- CLOUD PARITY: the sovereign reconciles (cloud-parity.md) --------------
//
// On 2026-08-11 this control's own output was a cloud-parity violation. Run
// 31503308453 printed thirteen watched rows — `ok` for deploy-fiab-commercial
// and NOT ONE sovereign lane — on a day when deploy-fiab-gcch had failed six
// times (14:42, 12:17, 10:41, 07:26, 06:25, 02:59) and deploy-fiab-gcc had been
// `disabled_manually` since 2026-08-08. Commercial drift was measured; sovereign
// drift was not measurable at all, so "GCC-High is fine" and "nothing is looking
// at GCC-High" rendered identically. These two tests are what make that state
// impossible to re-enter silently.

test('CLOUD PARITY — both sovereign reconciles are WATCHED, not just Commercial', () => {
  const watched = new Set(WATCHED.map((e) => e.workflow));
  for (const wf of ['deploy-fiab-commercial.yml', 'deploy-fiab-gcch.yml', 'deploy-fiab-gcc.yml']) {
    assert.ok(watched.has(wf),
      `${wf} applies main.bicep to a supported boundary and must be watched — `
      + 'a capability measured in Commercial and not in Gov is INCOMPLETE (cloud-parity.md)');
  }
});

test('each deploy-fiab lane watches ITS OWN boundary param file, never a sibling\'s', () => {
  // The copy-paste failure this dies on: duplicating the Commercial entry for a
  // sovereign boundary and leaving params/commercial.bicepparam in `paths`. That
  // entry would read green forever on gcc-high.bicepparam changes — a watched row
  // measuring the wrong boundary, which is worse than an unwatched one because it
  // LOOKS covered. `--parameters` is not a shape check-deploy-paths-coverage.mjs
  // detects, so nothing else in CI would catch it.
  const OWN = {
    'deploy-fiab-commercial.yml': 'platform/fiab/bicep/params/commercial.bicepparam',
    'deploy-fiab-gcch.yml': 'platform/fiab/bicep/params/gcc-high.bicepparam',
    'deploy-fiab-gcc.yml': 'platform/fiab/bicep/params/gcc.bicepparam',
  };
  for (const [wf, own] of Object.entries(OWN)) {
    const entry = WATCHED.find((e) => e.workflow === wf);
    assert.ok(entry, `${wf} must be a WATCHED entry`);
    assert.ok(entry.paths.includes(own), `${wf} must watch ${own}`);
    for (const [otherWf, otherParam] of Object.entries(OWN)) {
      if (otherWf === wf) continue;
      assert.ok(!entry.paths.includes(otherParam),
        `${wf} watches ${otherParam}, which belongs to ${otherWf} — that entry is measuring the wrong boundary`);
    }
  }
});

test('a WATCHED lane whose DEFAULT dispatch applies nothing must emit the DRY RUN marker', () => {
  // KEYED TO THE MISMATCH, not to the unsafe string. The defect is the PAIR:
  // an apply step gated behind `inputs.run_mode == 'full'` while run_mode
  // DEFAULTS to something else (so the default dispatch succeeds having deployed
  // nothing) AND a `run-name` that pickLastRealSuccess cannot recognise as a dry
  // run. Either half alone is fine; together they let one default dispatch clear
  // an entry's drift without deploying anything — the "green on nothing" shape
  // this whole file exists to catch.
  //
  // Both sovereign lanes failed this the moment they were registered:
  // deploy-fiab-gcch.yml had NO run-name at all, and deploy-fiab-gcc.yml's said
  // "(whatif-only)" — human-readable, but not the literal the filter matches.
  //
  // Matched against the RAW, unevaluated run-name expression: the marker has to
  // be present in the branch that fires for a non-full dispatch, and that is what
  // is source-visible. Asserting on a rendered title would need a GitHub
  // expression evaluator this repo does not have.
  const gated = [];
  for (const entry of WATCHED) {
    const file = join(WORKFLOWS, entry.workflow);
    const doc = parseWorkflow(readFileSync(file, 'utf8'));
    const runModeDefault = scalarValue(doc?.on?.workflow_dispatch?.inputs?.run_mode?.default);
    // No run_mode input, or one that defaults to a real apply, is not this shape.
    if (runModeDefault === undefined || runModeDefault === null || runModeDefault === 'full') continue;
    gated.push(entry.workflow);
    const runName = scalarValue(doc['run-name']);
    assert.ok(typeof runName === 'string' && runName.length > 0,
      `${entry.workflow} defaults run_mode to "${runModeDefault}" (a dispatch that applies nothing) `
      + 'but declares no run-name, so every run is titled identically and a dry run would clear its drift');
    assert.ok(runName.includes(DRY_RUN_MARKER),
      `${entry.workflow} defaults run_mode to "${runModeDefault}" — a default dispatch SUCCEEDS having applied `
      + `nothing — so its run-name must carry the marker "${DRY_RUN_MARKER}" that pickLastRealSuccess filters on. `
      + `Got: ${JSON.stringify(runName)}`);
  }
  // REFUSE TO PASS ON AN EMPTY POPULATION. If the parser stops finding
  // `run_mode` (a schema change, a parser regression, an entry renamed), the
  // loop above would scan zero lanes and this test would report a green having
  // measured nothing — the exact hollow-gate class it belongs to.
  assert.ok(gated.length >= 3,
    'expected at least the three deploy-fiab reconciles to declare a whatif-only run_mode default; '
    + `found ${gated.length} (${gated.join(', ') || 'none'}). Zero or few means the matcher drifted, not that the repo is clean.`);
});

test('ESTATES carries a SMALL time allowance and NO commit-count band', () => {
  // An empty ESTATES would make the live-estate half of this control measure
  // nothing while still printing a header — the hollow-gate shape.
  assert.ok(Array.isArray(ESTATES) && ESTATES.length > 0);
  for (const e of ESTATES) {
    assert.equal(typeof e.name, 'string');
    assert.match(e.markerUrl, /^https:\/\/.+\/build-marker\.txt$/);
    assert.equal(typeof e.behindGraceMinutes, 'number');
    assert.equal(typeof e.maxAgeDays, 'number');
    // The band that made this control unable to fire on the real estate must
    // not come back under any name.
    assert.equal(e.maxCommitsBehind, undefined,
      `${e.name}: a commit-count tolerance is what let a 13-behind estate read ok`);
    // "Keep it small" with teeth. 4 hours is already far past this repo's
    // measured ~56-minute build-and-roll cycle; anything beyond it is a
    // tolerance for a broken roll path, not for a build in flight.
    assert.ok(e.behindGraceMinutes > 0 && e.behindGraceMinutes <= 240,
      `${e.name}: the roll-in-flight allowance must stay small (got ${e.behindGraceMinutes}min)`);
  }
});
