/**
 * Unit tests for lib/admin/deploy-status.ts — the in-product "is what is
 * running actually what was merged?" verdict.
 *
 * WHAT IS BEING PINNED, and why these cases and not others.
 *
 * The operator watched /admin/readiness report 98/100 for two weeks while the
 * two lanes that put code into the estate were red and merged bicep was inert.
 * Every case below is a shape that was live on 2026-08-05 and invisible:
 *
 *   - the estate 12 commits behind main, with no surface saying so;
 *   - deploy-fiab-commercial.yml `disabled_manually` with 8 consecutive failed
 *     nightlies — the ONLY lane that applies main.bicep to Commercial;
 *   - full-app-deploy-commercial.yml with 6 consecutive failures behind a
 *     last-success that a "when did it last succeed?" check reads as data.
 *
 * Each CONTROL case is chosen to DIE under an obvious mutation:
 *   - drop the `error ||` guard in classifyEstateDrift → the unreachable-GitHub
 *     case reports current; the unknown test goes red.
 *   - flip `behindForMinutes > grace` to `<` → the in-flight and past-grace pair
 *     swaps; both go red (and the boundary pair pins it to the minute).
 *   - reintroduce ANY commit-count tolerance → the "13 behind for 16h" case and
 *     the "1 commit past the grace" case both go green, and both assert error.
 *   - default a missing `behindForMinutes` to 0 instead of null → the
 *     unmeasurable-wait case reads ok; it asserts error.
 *   - reorder classifyDeployPath so `failing` is tested before `disabled` → the
 *     disabled test's asserted state changes; it goes red.
 *   - count cancelled/in-flight runs as failures → the skip test goes red.
 *   - make summarizeDeployStatus return a fixed severity → the roll-up tests go
 *     red in both directions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyDeployPath,
  classifyEstateDrift,
  classifyRollRegression,
  deployBannerBody,
  deployPathsForCloud,
  oldestUnappliedAt,
  rollCandidates,
  rollNeedsJobCheck,
  rollShaFromRun,
  rollSourceForCloud,
  summarizeDeployStatus,
  worstSeverity,
  DEPLOY_PATHS,
  BEHIND_GRACE_MINUTES,
  FAILING_STREAK,
  MAX_DAYS_SINCE_SUCCESS,
  type DeployPathHealth,
  type RollCandidate,
  type RollRunLite,
  type RunLite,
} from '@/lib/admin/deploy-status';

const REPO = 'fgarofalo56/csa-inabox';
const SHA = '678b53bccccc4c23ae6afa7f851a22a6910d7bb0';
const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const minsAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

/** A compare result whose missing commits are all `mins` old. */
const behindBy = (n: number, mins: number | null) => ({
  status: 'ahead' as const,
  ahead_by: n,
  behind_by: 0,
  commits: mins === null ? [] : [{ commit: { committer: { date: minsAgo(mins) } } }],
});

const runs = (...conclusions: (string | null)[]): RunLite[] =>
  conclusions.map((c, i) => ({ conclusion: c, created_at: daysAgo(i) }));

const DEF = DEPLOY_PATHS[0];
const path = (over: Partial<Parameters<typeof classifyDeployPath>[0]>): DeployPathHealth =>
  classifyDeployPath({ def: DEF, repo: REPO, workflowState: 'active', now: NOW, ...over });

describe('classifyEstateDrift — how far behind main is the image serving this page', () => {
  it('MUTATION PROOF: the REAL 2026-08-05 estate (13 behind, ~16h) is NOT ok', () => {
    // THE CASE THIS SURFACE EXISTS FOR, and the one its first cut could not fire
    // on. Live reading on 2026-08-05: marker sha 678b53bc, 13 commits behind
    // main, oldest unapplied commit merged ~15.6 HOURS earlier. Under the
    // shipped `MAX_COMMITS_BEHIND = 20` this rendered severity 'ok' — the
    // estate-drift half never fired on the actual drift.
    //
    // A threshold that cannot fire on today's real condition is not a signal.
    const e = classifyEstateDrift({
      buildSha: SHA, buildStamp: '20260805T054836Z', repo: REPO, now: NOW,
      compare: behindBy(13, 936), // 15.6h
    });
    expect(e.state).toBe('behind');
    expect(e.commitsBehind).toBe(13);
    expect(e.severity).toBe('error');
    expect(e.behindForMinutes).toBe(936);
    expect(e.detail).toMatch(/roll path has stopped/);
    expect(e.compareUrl).toBe(`https://github.com/${REPO}/compare/${SHA}...main`);
  });

  it('the SAME 13 commits, one minute old, is a roll in flight and reads ok', () => {
    // It is the TIME that fires, not the count. Delete the grace and this goes
    // red; reintroduce a count band and the case above does.
    const e = classifyEstateDrift({
      buildSha: SHA, repo: REPO, now: NOW, compare: behindBy(13, 1),
    });
    expect(e.state).toBe('behind');
    expect(e.severity).toBe('ok');
    expect(e.headline).toMatch(/roll is in flight/);
  });

  it('ONE commit behind past the grace is an ERROR — there is no count band', () => {
    const e = classifyEstateDrift({
      buildSha: SHA, repo: REPO, now: NOW, compare: behindBy(1, BEHIND_GRACE_MINUTES + 1),
    });
    expect(e.state).toBe('behind');
    expect(e.severity).toBe('error');
    expect(e.headline).toContain('1 commit behind');
  });

  it('the grace bites at exactly BEHIND_GRACE_MINUTES, in both directions', () => {
    const at = (mins: number) => classifyEstateDrift({
      buildSha: SHA, repo: REPO, now: NOW, compare: behindBy(5, mins),
    }).severity;
    expect(at(BEHIND_GRACE_MINUTES)).toBe('ok');
    expect(at(BEHIND_GRACE_MINUTES + 1)).toBe('error');
  });

  it('behind with NO measurable wait is an ERROR — unmeasured is not "recent"', () => {
    // No commit dates in the compare ⇒ nothing demonstrates an in-flight roll,
    // so the allowance must not apply. Default behindForMinutes to 0 and this
    // goes green — the recurring "unknown rendered as a result" trap.
    const e = classifyEstateDrift({
      buildSha: SHA, repo: REPO, now: NOW, compare: behindBy(9, null),
    });
    expect(e.state).toBe('behind');
    expect(e.severity).toBe('error');
    expect(e.behindForMinutes).toBeNull();
    expect(e.detail).toMatch(/could not be measured/);
  });

  it('oldestUnappliedAt takes the MINIMUM date, not commits[0]', () => {
    // Ordering-independent on purpose: GitHub documents oldest-first, but a
    // verdict turning on ordering nobody re-checks is a verdict waiting to be
    // wrong. Reverse the array and the answer must not change.
    const rows = [
      { commit: { committer: { date: minsAgo(10) } } },
      { commit: { committer: { date: minsAgo(500) } } },
      { commit: { committer: { date: minsAgo(50) } } },
    ];
    expect(oldestUnappliedAt({ status: 'ahead', ahead_by: 3, behind_by: 0, commits: rows }))
      .toBe(minsAgo(500));
    expect(oldestUnappliedAt({ status: 'ahead', ahead_by: 3, behind_by: 0, commits: [...rows].reverse() }))
      .toBe(minsAgo(500));
    // author.date is the documented fallback when committer is absent.
    expect(oldestUnappliedAt({
      status: 'ahead', ahead_by: 1, behind_by: 0,
      commits: [{ commit: { author: { date: minsAgo(7) } } }],
    })).toBe(minsAgo(7));
    // Nothing usable ⇒ null, which the caller must treat as untolerated.
    expect(oldestUnappliedAt({ status: 'ahead', ahead_by: 1, behind_by: 0, commits: [] })).toBeNull();
    expect(oldestUnappliedAt(null)).toBeNull();
  });

  it('an identical build is CURRENT', () => {
    const e = classifyEstateDrift({
      buildSha: SHA, repo: REPO, compare: { status: 'identical', ahead_by: 0, behind_by: 0 },
    });
    expect(e.state).toBe('current');
    expect(e.commitsBehind).toBe(0);
    expect(e.severity).toBe('ok');
  });

  it('UNREACHABLE GitHub is UNKNOWN, never "current" (the recurring trap)', () => {
    // Azure Government has no egress to api.github.com. Reporting that as
    // up-to-date would be the third repeat of "unknown rendered as a result".
    const e = classifyEstateDrift({
      buildSha: SHA, repo: REPO, compare: null,
      error: 'could not reach api.github.com — no response within 6000ms',
    });
    expect(e.state).toBe('unknown');
    expect(e.severity).toBe('warning');
    expect(e.commitsBehind).toBeNull();
    expect(e.detail).toMatch(/UNKNOWN, not up-to-date/);
  });

  it('an image with no build fingerprint is UNKNOWN, not current', () => {
    const e = classifyEstateDrift({ buildSha: null, repo: REPO, compare: null });
    expect(e.state).toBe('unknown');
    expect(e.severity).toBe('warning');
    expect(e.compareUrl).toBeNull();
  });

  it('a diverged or ahead-of-main build is DIVERGENT, not "0 behind"', () => {
    const diverged = classifyEstateDrift({
      buildSha: SHA, repo: REPO, compare: { status: 'diverged', ahead_by: 3, behind_by: 4 },
    });
    expect(diverged.state).toBe('divergent');
    expect(diverged.severity).toBe('error');
    expect(diverged.commitsBehind).toBeNull();

    const offBranch = classifyEstateDrift({
      buildSha: SHA, repo: REPO, compare: { status: 'behind', ahead_by: 0, behind_by: 5 },
    });
    expect(offBranch.state).toBe('divergent');
    expect(offBranch.detail).toMatch(/5 commit\(s\) that main does not/);
  });
});

describe('classifyDeployPath — has this lane been failing, or switched off?', () => {
  it('a failure STREAK is FAILING even with a last success behind it', () => {
    // full-app-deploy-commercial's real shape. A "when did it last succeed?"
    // check reads the success and calls this healthy.
    const p = path({ runs: runs('failure', 'failure', 'failure', 'failure', 'success') });
    expect(p.state).toBe('failing');
    expect(p.failureStreak).toBe(4);
    expect(p.severity).toBe('error');
    expect(p.detail).toMatch(/does NOT mean this path works today/);
  });

  it('CONTROL: below the streak threshold with a recent success is HEALTHY', () => {
    // Pins the boundary the other way: flip `>=` to `>` and the exactly-3 case
    // below goes healthy, killing that assertion.
    const p = path({ runs: runs('failure', 'failure', 'success') });
    expect(p.state).toBe('healthy');
    expect(p.failureStreak).toBe(2);
    expect(p.severity).toBe('ok');
  });

  it('the streak threshold bites at exactly FAILING_STREAK', () => {
    expect(path({ runs: runs('failure', 'failure', 'failure', 'success') }).state).toBe('failing');
    expect(FAILING_STREAK).toBe(3);
  });

  it('a DISABLED lane is called out as switched off, not merely stale', () => {
    // deploy-fiab-commercial's live state: the only lane that applies main.bicep
    // to Commercial cannot run at all. Its fix (re-enable) differs from a
    // failing lane's (repair), so it gets its own state.
    const p = path({ workflowState: 'disabled_manually', runs: runs('failure', 'failure', 'success') });
    expect(p.state).toBe('disabled');
    expect(p.severity).toBe('error');
    expect(p.detail).toMatch(/SWITCHED OFF/);
  });

  it('disabled is reported even when the lane is ALSO failing', () => {
    // Ordering matters: a disabled lane with 8 red runs must say "switched off",
    // because re-enabling is the prerequisite for the failures to mean anything.
    const p = path({ workflowState: 'disabled_manually', runs: runs('failure', 'failure', 'failure', 'failure') });
    expect(p.state).toBe('disabled');
    expect(p.failureStreak).toBe(4);
  });

  it('in-flight and cancelled runs are SKIPPED, not counted as failures', () => {
    const p = path({ runs: [
      { conclusion: null }, { conclusion: 'cancelled' },
      { conclusion: 'failure', created_at: daysAgo(1) },
      { conclusion: 'failure', created_at: daysAgo(2) },
      { conclusion: 'success', created_at: daysAgo(3) },
    ] });
    expect(p.failureStreak).toBe(2);
    expect(p.state).toBe('healthy');
  });

  it('a lane that has never succeeded is NEVER-RUN, at error severity', () => {
    // "never" requires having read the WHOLE history — historyComplete.
    const p = path({ runs: runs('failure', 'failure'), historyComplete: true });
    expect(p.state).toBe('never-run');
    expect(p.severity).toBe('error');
  });

  it('"no success in the PAGE" is NOT reported as "never succeeded"', () => {
    // Caught by running the real thing against the real API: the console reads
    // a 30-run page, deploy-fiab-commercial.yml has 30+ consecutive failures,
    // so the page holds no success — and the first cut said "it has never
    // succeeded", which is false (it last succeeded 2026-06-18). That is
    // UNKNOWN reported as a NEGATIVE, the class this whole file guards.
    const page = Array.from({ length: 30 }, () => ({ conclusion: 'failure' }));
    const p = path({ runs: page, historyComplete: false });
    expect(p.state).toBe('failing');
    expect(p.detail).not.toMatch(/never/i);
    expect(p.detail).toMatch(/30 most recent examined/);
    expect(p.runsExamined).toBe(30);
    expect(p.historyComplete).toBe(false);
  });

  it('a DISABLED lane with a truncated page does not claim "never" either', () => {
    // deploy-fiab-commercial's exact live shape: switched off AND no success
    // inside the page we read.
    const page = Array.from({ length: 30 }, () => ({ conclusion: 'failure' }));
    const p = path({ runs: page, historyComplete: false, workflowState: 'disabled_manually' });
    expect(p.state).toBe('disabled');
    expect(p.detail).toMatch(/SWITCHED OFF/);
    expect(p.detail).not.toMatch(/never/i);
  });

  it('no success and no streak in a truncated page is UNKNOWN, not healthy', () => {
    const page = Array.from({ length: 30 }, () => ({ conclusion: 'cancelled' }));
    const p = path({ runs: page, historyComplete: false });
    expect(p.state).toBe('unknown');
    expect(p.severity).toBe('warning');
    expect(p.detail).toMatch(/UNKNOWN/);
  });

  it('a long-stale but not-failing lane is a WARNING with the day count', () => {
    const p = path({ runs: [{ conclusion: 'success', created_at: daysAgo(MAX_DAYS_SINCE_SUCCESS + 5) }] });
    expect(p.severity).toBe('warning');
    expect(p.daysSinceSuccess).toBe(MAX_DAYS_SINCE_SUCCESS + 5);
  });

  it('UNKNOWN run history is UNKNOWN, never healthy', () => {
    const p = path({ runs: null, error: 'could not reach api.github.com' });
    expect(p.state).toBe('unknown');
    expect(p.severity).toBe('warning');
    expect(p.detail).toMatch(/UNKNOWN, not healthy/);
  });

  it('an undetermined workflow state is UNKNOWN, never assumed active', () => {
    const p = path({ runs: runs('success'), workflowState: null });
    expect(p.state).toBe('unknown');
    expect(p.severity).toBe('warning');
  });
});

describe('summarizeDeployStatus — the one line the banner shows', () => {
  const okEstate = classifyEstateDrift({
    buildSha: SHA, repo: REPO, compare: { status: 'identical', ahead_by: 0, behind_by: 0 },
  });

  it('names the broken deploy path when the estate itself looks fine', () => {
    // The 2026-08-05 shape: the image was fresh, the lanes were not.
    const broken = path({ workflowState: 'disabled_manually', runs: runs('failure', 'failure', 'failure') });
    const r = summarizeDeployStatus(okEstate, [broken], { generatedAt: 'x', repo: REPO });
    expect(r.severity).toBe('error');
    expect(r.headline).toContain('Deploy path broken');
    expect(r.headline).toContain(DEF.title);
  });

  it('leads with the estate when the estate is the worse fact, and names both', () => {
    const behind = classifyEstateDrift({
      buildSha: SHA, repo: REPO, now: NOW, compare: behindBy(400, 5_000),
    });
    const broken = path({ runs: runs('failure', 'failure', 'failure') });
    const r = summarizeDeployStatus(behind, [broken], { generatedAt: 'x', repo: REPO });
    expect(r.headline).toContain('400 commits behind');
    expect(r.headline).toMatch(/1 deploy path\(s\) are failing or switched off/);
  });

  it('CONTROL: all-healthy rolls up to ok and the estate headline', () => {
    const healthy = path({ runs: runs('success') });
    const r = summarizeDeployStatus(okEstate, [healthy], { generatedAt: 'x', repo: REPO });
    expect(r.severity).toBe('ok');
    expect(r.headline).toBe(okEstate.headline);
  });

  it('a warning anywhere prevents an ok roll-up', () => {
    const unknown = path({ runs: null, error: 'no egress' });
    const r = summarizeDeployStatus(okEstate, [unknown], { generatedAt: 'x', repo: REPO });
    expect(r.severity).toBe('warning');
  });

  it('worstSeverity ranks error > warning > ok', () => {
    expect(worstSeverity(['ok', 'warning', 'error'])).toBe('error');
    expect(worstSeverity(['ok', 'warning'])).toBe('warning');
    expect(worstSeverity(['ok', 'ok'])).toBe('ok');
    expect(worstSeverity([])).toBe('ok');
  });
});

describe('the watched-lane table itself', () => {
  it('covers BOTH lanes that were silently broken', () => {
    const wf = new Set(DEPLOY_PATHS.map((p) => p.workflow));
    expect(wf.has('deploy-fiab-commercial.yml')).toBe(true);   // sub-level infra deploy
    expect(wf.has('full-app-deploy-commercial.yml')).toBe(true); // app images + roll
  });

  it('covers the ROLL lanes — the writer that lost the race was unwatched (#3676)', () => {
    // Until #3676 this table held four lanes and neither roller was among them,
    // which is how the 2026-08-19 revert happened with every listed lane green:
    // the lane that actually moves the running console was not being looked at.
    const wf = new Set(DEPLOY_PATHS.map((p) => p.workflow));
    expect(wf.has('loom-roll-and-validate.yml')).toBe(true);
    expect(wf.has('gov-console-roll.yml')).toBe(true);
  });

  it('the roll lane exists in BOTH boundaries — Commercial-only would be the cloud-parity defect', () => {
    // cloud-parity.md: a control that watches Commercial and not Gov leaves the
    // boundary with NO continuous deploy as the one nobody can see.
    expect(deployPathsForCloud('Commercial').map((p) => p.workflow)).toContain('loom-roll-and-validate.yml');
    for (const c of ['GCC-High', 'DoD', 'GCC']) {
      expect(deployPathsForCloud(c).map((p) => p.workflow)).toContain('gov-console-roll.yml');
    }
    // ...and neither boundary is shown the other's roller.
    expect(deployPathsForCloud('Commercial').map((p) => p.workflow)).not.toContain('gov-console-roll.yml');
    expect(deployPathsForCloud('GCC-High').map((p) => p.workflow)).not.toContain('loom-roll-and-validate.yml');
  });

  it('every lane carries a title and a consequence, so the banner can explain itself', () => {
    expect(DEPLOY_PATHS.length).toBeGreaterThan(0);
    for (const p of DEPLOY_PATHS) {
      expect(p.workflow).toMatch(/\.yml$/);
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.why.length).toBeGreaterThan(20);
    }
  });

  it('cloud filtering picks the right infra lane, and never hides everything', () => {
    const commercial = deployPathsForCloud('Commercial').map((p) => p.workflow);
    expect(commercial).toContain('deploy-fiab-commercial.yml');
    expect(commercial).not.toContain('deploy-fiab-gcch.yml');

    const gov = deployPathsForCloud('GCC-High').map((p) => p.workflow);
    expect(gov).toContain('deploy-fiab-gcch.yml');
    expect(gov).not.toContain('deploy-fiab-commercial.yml');

    // An unrecognised cloud shows everything rather than nothing: showing a
    // lane that does not apply is a smaller error than hiding a broken one.
    expect(deployPathsForCloud('Neptune')).toHaveLength(DEPLOY_PATHS.length);
    expect(deployPathsForCloud(undefined)).toHaveLength(DEPLOY_PATHS.length);

    // Every cloud sees the console-image lane — it builds the image serving
    // this page in every boundary.
    for (const c of ['Commercial', 'GCC-High', 'DoD', 'GCC']) {
      expect(deployPathsForCloud(c).map((p) => p.workflow)).toContain('build-fiab-images-acr-tasks.yml');
    }
  });
});

/**
 * classifyRollRegression — "did something take the estate BACKWARDS?" (#3676)
 *
 * THE FIXTURES ARE THE INCIDENT, not invented shapes. The shas and revision
 * timestamps below were read off the live Commercial estate's revision history
 * and are recorded verbatim in deploy-fiab-commercial.yml (the I-BEHIND block):
 *
 *   0000781  2026-08-19T05:46:46Z  loom-console:83e7cab6
 *   0000782  2026-08-19T07:04:56Z  loom-console:150d2937   <- roll 32225337320
 *   0000783  2026-08-19T07:10:19Z  loom-console:83e7cab6   <- reconcile put it BACK
 *   0000784  2026-08-19T08:23:31Z  loom-console:82ee5050
 *
 * The one DERIVED value is each image's build stamp: the estate publishes it in
 * build-marker.txt, and what is known from the revision history is only that
 * 83e7cab6's image existed by 05:46:46. BUILD_83E7 is therefore any instant
 * before that, chosen — the ORDERING is the measured fact, not the minute.
 *
 * Each CONTROL case dies under an obvious mutation:
 *   - drop the timestamp ordering and always call a mismatch regressed → the
 *     AHEAD case goes red (and every ordinary merge would flash the estate red).
 *   - compare shas with === instead of a prefix → the abbreviated-tag case goes
 *     red, i.e. every healthy estate reads as reverted.
 *   - let an unmeasurable ordering fall through to 'ok' → the unknown case goes
 *     red; it asserts warning, because an unknown is never a green.
 *   - drop the regression from summarizeDeployStatus's severity fold → the
 *     roll-up test goes red while every individual verdict still passes.
 */
describe('classifyRollRegression — a roll that was overwritten (#3676)', () => {
  const SHA_83E7 = '83e7cab6f0a14d2b9c7e5518aa30c41d7b6e2f90'; // full, as build-marker publishes it
  const ROLLED = '150d2937';        // as the image TAG carries it
  const ROLL_AT = '2026-08-19T07:04:56Z';
  const BUILD_83E7 = '2026-08-19T05:32:11Z'; // before revision 781 ran it
  const BUILD_82EE = '2026-08-19T08:15:02Z'; // after the roll — revision 784
  const LANE = 'loom-roll-and-validate.yml';

  const regression = (over: Record<string, unknown> = {}) => classifyRollRegression({
    estateSha: SHA_83E7,
    estateStamp: BUILD_83E7,
    rolledSha: ROLLED,
    rolledAt: ROLL_AT,
    rollWorkflow: LANE,
    ...over,
  });

  it('THE INCIDENT: a successful roll shipped 150d2937 and the estate is serving an OLDER image', () => {
    const r = regression();
    expect(r.state).toBe('regressed');
    expect(r.severity).toBe('error');
    // The headline must name the sha that was LOST — that is the actionable fact.
    expect(r.headline).toContain('150d2937');
    expect(r.headline).toMatch(/BACKWARDS/);
    // And the detail must say this is not something a future roll fixes.
    expect(r.detail).toContain('83e7cab6');
    expect(r.detail).toMatch(/#3676/);
  });

  it('CONTROL: one revision earlier — running exactly what the roll shipped — is CURRENT', () => {
    // Revision 0000782. Same comparison, same code path, opposite verdict. Without
    // this the incident test would pass against a function that always says
    // "regressed".
    const r = regression({ estateSha: '150d2937abc0000000000000000000000000beef', estateStamp: '2026-08-19T06:58:00Z' });
    expect(r.state).toBe('current');
    expect(r.severity).toBe('ok');
  });

  it('an image built AFTER the roll is AHEAD, not a revert — no false red on an ordinary merge', () => {
    // Revision 0000784. Between a roll and this read, a later merge legitimately
    // moves the estate forward. Calling that a regression would fire on every
    // healthy merge, and a guard that cries wolf is a guard that gets switched off.
    const r = regression({ estateSha: '82ee5050d1c24b83af90116e2c7d55a03e18b4c7', estateStamp: BUILD_82EE });
    expect(r.state).toBe('ahead');
    expect(r.severity).toBe('ok');
  });

  it('a full 40-char estate sha MATCHES the 8-char image tag it was built from', () => {
    // build-marker.txt publishes 40 chars; the image tag carries 8. Comparing
    // them with === reports every healthy estate as reverted.
    const r = classifyRollRegression({
      estateSha: '150d2937abc0000000000000000000000000beef',
      estateStamp: '2026-08-19T06:58:00Z',
      rolledSha: '150d2937',
      rolledAt: ROLL_AT,
    });
    expect(r.state).toBe('current');
  });

  it('a sha too short to be evidence is NOT a match', () => {
    const r = classifyRollRegression({
      estateSha: '150d', estateStamp: BUILD_83E7, rolledSha: '150d', rolledAt: ROLL_AT,
    });
    expect(r.state).not.toBe('current');
    expect(r.severity).not.toBe('ok');
  });

  it('no roll to compare against is UNKNOWN, never "nothing was overwritten"', () => {
    const r = regression({ rolledSha: null, rolledAt: null });
    expect(r.state).toBe('unknown');
    expect(r.severity).toBe('warning');
    expect(r.detail).toMatch(/UNKNOWN/);
  });

  it('a failed roll lookup FAILS CLOSED — an error is not an all-clear', () => {
    const r = regression({ error: 'Actions API 403' });
    expect(r.state).toBe('unknown');
    expect(r.severity).toBe('warning');
    expect(r.detail).toContain('403');
  });

  it('an unidentified running image is UNKNOWN, not current', () => {
    const r = regression({ estateSha: null });
    expect(r.state).toBe('unknown');
    expect(r.severity).toBe('warning');
  });

  it('shas that DIFFER with no usable ordering is UNKNOWN — not ok, and not a hard red', () => {
    // The honest middle. It is a real disagreement whose DIRECTION was not
    // established, so it is neither hidden nor asserted as a revert.
    const r = regression({ estateStamp: null });
    expect(r.state).toBe('unknown');
    expect(r.severity).toBe('warning');
    expect(r.detail).toMatch(/WHICH IS NEWER could not be established/);
  });

  it('carries the roll run link so the verdict is checkable, not just assertable', () => {
    const url = 'https://github.com/fgarofalo56/csa-inabox/actions/runs/32225337320';
    expect(regression({ rollRunUrl: url }).rollRunUrl).toBe(url);
  });

  it('BOUNDARY: a build stamped at the EXACT instant the roll completed is REGRESSED, not ahead', () => {
    // The tie was unpinned: `builtMs > rolledMs` mutated to `>=` survived the
    // whole suite green, and the two verdicts on either side of that boundary
    // are "the deploy path is working" and "a validated deploy was undone".
    //
    // Equality is not evidence the image came AFTER the roll — the two stamps
    // come from different writers at second granularity — so it falls to the
    // loud side. Between a false green and a false red on a coin-flip, the red
    // is the one an operator actually looks at.
    const r = regression({ estateStamp: ROLL_AT });
    expect(r.state).toBe('regressed');
    expect(r.severity).toBe('error');
    // …and one millisecond the other way is the control, so this test cannot be
    // passing because the function always says regressed.
    const after = regression({ estateStamp: new Date(Date.parse(ROLL_AT) + 1).toISOString() });
    expect(after.state).toBe('ahead');
    expect(after.severity).toBe('ok');
  });
});

describe('summarizeDeployStatus folds the roll regression in', () => {
  const okEstate = classifyEstateDrift({
    buildSha: SHA, repo: REPO, compare: { status: 'identical', ahead_by: 0, behind_by: 0 },
  });
  const reverted = classifyRollRegression({
    estateSha: '83e7cab6f0a14d2b9c7e5518aa30c41d7b6e2f90',
    estateStamp: '2026-08-19T05:32:11Z',
    rolledSha: '150d2937',
    rolledAt: '2026-08-19T07:04:56Z',
    rollWorkflow: 'loom-roll-and-validate.yml',
  });

  it('a regression turns an otherwise-green report red', () => {
    const healthy = path({ runs: runs('success') });
    const r = summarizeDeployStatus(okEstate, [healthy], { generatedAt: 'x', repo: REPO }, reverted);
    expect(r.severity).toBe('error');
    expect(r.headline).toMatch(/BACKWARDS/);
  });

  it('a regression OUTRANKS a behind estate and a broken lane in the headline', () => {
    // Behind and broken both mean work has not ARRIVED. A regression means work
    // arrived, was validated, and was removed — and the next successful run will
    // not fix it, because the last successful run is what did it.
    const behind = classifyEstateDrift({ buildSha: SHA, repo: REPO, now: NOW, compare: behindBy(400, 5_000) });
    const broken = path({ runs: runs('failure', 'failure', 'failure') });
    const r = summarizeDeployStatus(behind, [broken], { generatedAt: 'x', repo: REPO }, reverted);
    expect(r.headline).toBe(reverted.headline);
    expect(r.headline).not.toContain('400 commits behind');
  });

  it('CONTROL: a CURRENT roll leaves the headline exactly where it was', () => {
    // Proves the branch above is the regression firing, not the argument merely
    // being present.
    const current = classifyRollRegression({
      estateSha: '150d2937abc0000000000000000000000000beef',
      estateStamp: '2026-08-19T06:58:00Z',
      rolledSha: '150d2937', rolledAt: '2026-08-19T07:04:56Z',
    });
    const healthy = path({ runs: runs('success') });
    const r = summarizeDeployStatus(okEstate, [healthy], { generatedAt: 'x', repo: REPO }, current);
    expect(r.severity).toBe('ok');
    expect(r.headline).toBe(okEstate.headline);
  });

  it('an OMITTED regression is absent from the report — not reported as "no regression"', () => {
    // Absent must read as "not measured". A caller that could not establish it
    // must not be able to launder that into a green field.
    const healthy = path({ runs: runs('success') });
    const r = summarizeDeployStatus(okEstate, [healthy], { generatedAt: 'x', repo: REPO });
    expect(r.rollRegression).toBeUndefined();
    expect(r.severity).toBe('ok');
  });

  it('an UNKNOWN regression prevents an ok roll-up', () => {
    const unknown = classifyRollRegression({ estateSha: SHA, rolledSha: null });
    const healthy = path({ runs: runs('success') });
    const r = summarizeDeployStatus(okEstate, [healthy], { generatedAt: 'x', repo: REPO }, unknown);
    expect(r.severity).toBe('warning');
    expect(r.headline).toBe(unknown.headline);
  });
});

/**
 * deployBannerBody — the sentence UNDER the headline must be the same verdict's.
 *
 * THE OBSERVED DEFECT, from one real /api/admin/deploy-status response: the
 * banner printed MessageBarTitle "This estate was rolled BACKWARDS off 150d2937"
 * and, directly beneath it, "Running build 83e7cab6 (built …) — no commits
 * behind main." The regression's detail, rolledSha, rolledAt and rollRunUrl were
 * computed, serialized, and never rendered. So the loudest headline this surface
 * can print was explained away underneath by a DIFFERENT question's answer, and
 * the incident read as reassurance.
 *
 * Mutations these die under:
 *   - go back to `status.estate.detail` unconditionally → the regression case
 *     returns the drift sentence and its assertions go red;
 *   - always return the regression detail when one is present → the CONTROL
 *     (a current roll under a behind-estate headline) goes red.
 */
describe('deployBannerBody — whoever owns the headline owns the body', () => {
  const behind = classifyEstateDrift({ buildSha: SHA, repo: REPO, now: NOW, compare: behindBy(5, 5_000) });
  const reverted = classifyRollRegression({
    estateSha: '83e7cab6f0a14d2b9c7e5518aa30c41d7b6e2f90',
    estateStamp: '2026-08-19T05:32:11Z',
    rolledSha: '150d2937',
    rolledAt: '2026-08-19T07:04:56Z',
    rollWorkflow: 'loom-roll-and-validate.yml',
    rollRunUrl: 'https://github.com/fgarofalo56/csa-inabox/actions/runs/32225337320',
  });

  it('THE DEFECT: under a REGRESSION headline the body is the regression, not the drift line', () => {
    const report = summarizeDeployStatus(behind, [], { generatedAt: 'x', repo: REPO }, reverted);
    const body = deployBannerBody(report);
    expect(report.headline).toMatch(/BACKWARDS/); // precondition, not the assertion
    expect(body.detail).toBe(reverted.detail);
    expect(body.detail).toMatch(/#3676/);
    // The exact sentence that used to sit under that headline.
    expect(body.detail).not.toBe(behind.detail);
    expect(body.ownedByRollRegression).toBe(true);
    // …and the run link finally reaches the surface, so the claim is checkable.
    expect(body.rollRunUrl).toBe(reverted.rollRunUrl);
  });

  it('CONTROL: when the ESTATE owns the headline the body is the estate detail', () => {
    // Without this the fix could be "always show the regression", which would
    // hide the drift sentence on every ordinary behind-estate load.
    const current = classifyRollRegression({
      estateSha: '150d2937abc0000000000000000000000000beef',
      estateStamp: '2026-08-19T06:58:00Z',
      rolledSha: '150d2937', rolledAt: '2026-08-19T07:04:56Z',
      rollRunUrl: 'https://github.com/x/y/actions/runs/1',
    });
    const report = summarizeDeployStatus(behind, [], { generatedAt: 'x', repo: REPO }, current);
    const body = deployBannerBody(report);
    expect(report.headline).toBe(behind.headline);
    expect(body.detail).toBe(behind.detail);
    expect(body.ownedByRollRegression).toBe(false);
    // No roll link under someone else's verdict — it would read as the subject
    // of the sentence above it.
    expect(body.rollRunUrl).toBeNull();
  });

  it('an OMITTED regression leaves the body exactly where it was', () => {
    const report = summarizeDeployStatus(behind, [], { generatedAt: 'x', repo: REPO });
    const body = deployBannerBody(report);
    expect(body.detail).toBe(behind.detail);
    expect(body.ownedByRollRegression).toBe(false);
  });

  it('an UNKNOWN regression that took the headline also takes the body', () => {
    // The unknown verdict owns the headline when nothing worse exists, and the
    // same rule has to hold there: "cannot tell whether a roll was overwritten"
    // over "no commits behind main" is the same mismatch, one severity down.
    const ok = classifyEstateDrift({
      buildSha: SHA, repo: REPO, compare: { status: 'identical', ahead_by: 0, behind_by: 0 },
    });
    const unknown = classifyRollRegression({ estateSha: SHA, rolledSha: null });
    const report = summarizeDeployStatus(ok, [], { generatedAt: 'x', repo: REPO }, unknown);
    const body = deployBannerBody(report);
    expect(report.headline).toBe(unknown.headline);
    expect(body.detail).toBe(unknown.detail);
    expect(body.ownedByRollRegression).toBe(true);
  });
});

/**
 * The roll-source resolver (#3676) — "which lane writes this estate, and what
 * did it actually ship?"
 *
 * These four functions are the pure half of the route's regression check. The
 * route's job is to fetch; theirs is to decide what the fetched rows mean, and
 * every wrong answer here becomes a wrong verdict on /admin/readiness with no
 * second surface to catch it.
 *
 * Each CONTROL case names the mutation it dies under:
 *   - `.find((p) => p.roll)` back in place of the `length === 1` rule → an
 *     unrecognised cloud gets Commercial's roller; that test asserts null.
 *   - `shaFrom: 'headSha'` on the Commercial lane → the #2963 test goes red
 *     (head_sha is the branch HEAD at trigger time, not the rolled sha).
 *   - drop the GIT_OBJECT_ID guard → 'roll latest (manual dispatch)' returns
 *     the string 'latest' and every dispatch-rolled estate reads as reverted.
 *   - drop the `conclusion === 'success'` filter → a FAILED roll becomes the
 *     candidate that defines "what the estate was last rolled to".
 *   - sort on `created_at` instead of `updated_at` → the out-of-order pair
 *     swaps and the wrong run is named as newest.
 *   - delete the `.slice(1).some(...)` clause in rollNeedsJobCheck → the
 *     overtaken-by-an-older-roll case returns false and a real regression
 *     short-circuits to "current".
 */
describe('rollSourceForCloud', () => {
  it('names the Commercial roller for Commercial', () => {
    expect(rollSourceForCloud('Commercial')?.workflow).toBe('loom-roll-and-validate.yml');
  });

  it('names the Gov roller for each Gov ring', () => {
    for (const cloud of ['GCC-High', 'DoD', 'GCC']) {
      expect(rollSourceForCloud(cloud)?.workflow, cloud).toBe('gov-console-roll.yml');
    }
  });

  it('CONTROL: an UNRECOGNISED cloud gets NO roll source', () => {
    // deployPathsForCloud deliberately returns every lane here, which is right
    // for a list and fabricated for a verdict: picking the first would compare
    // an unknown estate's build marker against Commercial's roll history.
    expect(rollSourceForCloud('Mars')).toBeNull();
    expect(rollSourceForCloud(undefined)).toBeNull();
    expect(rollSourceForCloud(null)).toBeNull();
    expect(rollSourceForCloud('')).toBeNull();
  });

  it('CONTROL: no cloud has TWO roll lanes — the ambiguity this rule guards', () => {
    // If this ever fails, the fix is to decide which lane is authoritative for
    // that cloud, not to relax the rule above.
    for (const cloud of [...new Set(DEPLOY_PATHS.flatMap((p) => p.clouds || []))]) {
      expect(deployPathsForCloud(cloud).filter((p) => p.roll).length, cloud).toBe(1);
    }
  });

  it('every roll lane carries a title pattern that captures group 1', () => {
    // shaFrom:'title' is useless without one, and a pattern with no capture
    // group silently yields undefined → null → permanent UNKNOWN.
    for (const p of DEPLOY_PATHS.filter((d) => d.roll)) {
      expect(p.roll!.titlePattern, p.workflow).toBeInstanceOf(RegExp);
      expect(p.roll!.jobName.length, p.workflow).toBeGreaterThan(0);
    }
  });
});

describe('rollShaFromRun', () => {
  const commercial = rollSourceForCloud('Commercial')!;
  const gov = rollSourceForCloud('GCC-High')!;

  it('reads the sha out of the Commercial run title', () => {
    expect(rollShaFromRun(commercial, { name: 'roll 150d2937 (build-triggered)' })).toBe('150d2937');
    expect(rollShaFromRun(commercial, { name: `roll ${SHA} (manual dispatch)` })).toBe(SHA);
  });

  it('falls back to display_title when the API omits name', () => {
    expect(rollShaFromRun(commercial, { display_title: 'roll 83e7cab6 (build-triggered)' })).toBe('83e7cab6');
  });

  it('CONTROL: the Commercial lane IGNORES head_sha (#2963)', () => {
    // loom-roll-and-validate's head_sha is the default-branch HEAD at trigger
    // time, NOT the image it rolls. Reading it would name whatever landed on
    // main while the roll was queued as "what is deployed".
    const run = { name: 'roll 150d2937 (build-triggered)', head_sha: SHA };
    expect(rollShaFromRun(commercial, run)).toBe('150d2937');
    expect(rollShaFromRun(commercial, run)).not.toBe(SHA);
  });

  it('CONTROL: a FLOATING tag yields null, never the string', () => {
    // 'latest' can never equal a 40-char estate sha, so returning it would
    // report every dispatch-rolled estate as reverted.
    expect(rollShaFromRun(commercial, { name: 'roll latest (manual dispatch)' })).toBeNull();
    expect(rollShaFromRun(commercial, { name: 'roll v0.1 (manual dispatch)' })).toBeNull();
    expect(rollShaFromRun(commercial, { name: 'roll main (manual dispatch)' })).toBeNull();
    // Below git's own abbreviation floor: a "match" on 6 chars is not evidence.
    expect(rollShaFromRun(commercial, { name: 'roll 150d29 (build-triggered)' })).toBeNull();
  });

  it('a title that does not match the workflow run-name yields null', () => {
    expect(rollShaFromRun(commercial, { name: 'roll 150d2937' })).toBeNull();
    expect(rollShaFromRun(commercial, { name: 'Roll image + validate live URL' })).toBeNull();
    expect(rollShaFromRun(commercial, {})).toBeNull();
  });

  it('the Gov lane reads head_sha, because it builds from its own checkout', () => {
    expect(rollShaFromRun(gov, { head_sha: SHA, name: 'roll 150d2937 (build-triggered)' })).toBe(SHA);
    expect(rollShaFromRun(gov, { head_sha: '', name: `gov-console-roll ${SHA} (merge-triggered)` })).toBeNull();
  });

  it('a lane with no roll block yields null', () => {
    const notARoller = DEPLOY_PATHS.find((p) => !p.roll)!;
    expect(rollShaFromRun(notARoller, { name: 'roll 150d2937 (build-triggered)', head_sha: SHA })).toBeNull();
  });
});

describe('rollCandidates', () => {
  const def = rollSourceForCloud('Commercial')!;
  const roll = (sha: string, over: Partial<RollRunLite> = {}): RollRunLite => ({
    conclusion: 'success',
    name: `roll ${sha} (build-triggered)`,
    updated_at: minsAgo(10),
    ...over,
  });

  it('CONTROL: a FAILED roll is not a candidate', () => {
    // A run that failed did not write what it intended; treating it as the last
    // roll would name a sha that never reached the estate.
    const c = rollCandidates(def, [
      roll('aaaaaaaa', { conclusion: 'failure' }),
      roll('bbbbbbbb', { conclusion: 'cancelled' }),
      roll('cccccccc', { conclusion: null }),
      roll('dddddddd'),
    ]);
    expect(c.map((x) => x.sha)).toEqual(['dddddddd']);
  });

  it('a run whose sha cannot be established is dropped, not guessed at', () => {
    const c = rollCandidates(def, [roll('x', { name: 'roll latest (manual dispatch)' }), roll('eeeeeeee')]);
    expect(c.map((x) => x.sha)).toEqual(['eeeeeeee']);
  });

  it('CONTROL: orders by updated_at — when the roll FINISHED writing', () => {
    // Array order and created_at both disagree with updated_at here on purpose.
    const c = rollCandidates(def, [
      roll('aaaaaaaa', { created_at: minsAgo(5), updated_at: minsAgo(90) }),
      roll('bbbbbbbb', { created_at: minsAgo(80), updated_at: minsAgo(3) }),
    ]);
    expect(c.map((x) => x.sha)).toEqual(['bbbbbbbb', 'aaaaaaaa']);
  });

  it('falls back to created_at, and records an unmeasurable finish as null', () => {
    const c = rollCandidates(def, [roll('aaaaaaaa', { updated_at: null, created_at: minsAgo(7) })]);
    expect(c[0].finishedMs).toBe(Date.parse(minsAgo(7)));
    const none = rollCandidates(def, [roll('bbbbbbbb', { updated_at: null, created_at: undefined })]);
    expect(none[0].finishedMs).toBeNull();
  });

  it('CONTROL: an UNMEASURABLE finish sorts LAST, never first', () => {
    // `?? 0` in the comparator is doing this, and mutating it to `?? Infinity`
    // survived the whole suite green — because every ordering case above uses
    // two DATED runs, where the fallback is never reached. A stamp-less run
    // sorting first would make it `candidates[0]`, i.e. the run whose sha
    // defines "what the estate was last rolled to", chosen on the strength of
    // having no evidence at all. It also flips rollNeedsJobCheck's cheap path,
    // which reads candidates[0].
    const c = rollCandidates(def, [
      roll('aaaaaaaa', { updated_at: null, created_at: undefined }),
      roll('bbbbbbbb', { updated_at: minsAgo(90) }),
    ]);
    expect(c.map((x) => x.sha)).toEqual(['bbbbbbbb', 'aaaaaaaa']);
    expect(c[0].finishedMs).not.toBeNull();
    // Even against a run that finished long ago — an unstamped row must not
    // outrank a dated one merely by being unstamped.
    const older = rollCandidates(def, [
      roll('cccccccc', { updated_at: null, created_at: undefined }),
      roll('dddddddd', { updated_at: new Date(NOW - 400 * 86_400_000).toISOString() }),
    ]);
    expect(older.map((x) => x.sha)).toEqual(['dddddddd', 'cccccccc']);
  });

  it('no rows, or a lane that does not roll, yields nothing to ask about', () => {
    expect(rollCandidates(def, null)).toEqual([]);
    expect(rollCandidates(def, [])).toEqual([]);
    expect(rollCandidates(DEPLOY_PATHS.find((p) => !p.roll)!, [roll('aaaaaaaa')])).toEqual([]);
  });
});

describe('rollNeedsJobCheck', () => {
  /** A candidate that finished `mins` ago. */
  const cand = (sha: string, mins: number | null): RollCandidate => ({
    run: {},
    sha,
    finishedMs: mins === null ? null : NOW - mins * 60_000,
  });
  const ESTATE = '150d2937abc0000000000000000000000000beef';
  const BUILT = new Date(NOW - 30 * 60_000).toISOString();

  it('nothing to ask about when there are no candidates', () => {
    expect(rollNeedsJobCheck({ candidates: [], estateSha: ESTATE, estateStamp: BUILT })).toBe(false);
  });

  it('the CHEAP path: newest candidate is what the estate runs, nothing overtook it', () => {
    // The overwhelmingly common case, and the reason this function exists —
    // it must cost ZERO extra API calls or the rate budget is gone.
    const c = [cand('150d2937', 20), cand('83e7cab6', 200)];
    expect(rollNeedsJobCheck({ candidates: c, estateSha: ESTATE, estateStamp: BUILT })).toBe(false);
  });

  it('asks when the newest roll named something else', () => {
    const c = [cand('83e7cab6', 20), cand('150d2937', 200)];
    expect(rollNeedsJobCheck({ candidates: c, estateSha: ESTATE, estateStamp: BUILT })).toBe(true);
  });

  it('asks when the estate sha is unknown', () => {
    const c = [cand('150d2937', 20)];
    expect(rollNeedsJobCheck({ candidates: c, estateSha: null, estateStamp: BUILT })).toBe(true);
    expect(rollNeedsJobCheck({ candidates: c, estateSha: '', estateStamp: BUILT })).toBe(true);
  });

  it('asks when the estate build stamp cannot be read', () => {
    // Without it the ordering in (2) is unmeasurable, and unmeasurable is not ok.
    const c = [cand('150d2937', 20), cand('83e7cab6', 5)];
    expect(rollNeedsJobCheck({ candidates: c, estateSha: ESTATE, estateStamp: null })).toBe(true);
    expect(rollNeedsJobCheck({ candidates: c, estateSha: ESTATE, estateStamp: 'not a date' })).toBe(true);
  });

  it('CONDITION (2): an OLDER roll that finished after this image was built forces the check', () => {
    // The hole this closes. The newest run names exactly what the estate is
    // running — so the cheap evidence says "current" — but a second run named a
    // DIFFERENT sha and finished after this image was built. If that newest run
    // skipped its roll job, the estate is behind a roll that really shipped and
    // the whole verdict would have short-circuited to healthy.
    const c = [cand('150d2937', 20), cand('83e7cab6', 25)];
    expect(rollNeedsJobCheck({ candidates: c, estateSha: ESTATE, estateStamp: BUILT })).toBe(true);
  });

  it('CONTROL for (2): the same shape, but the older roll predates the build', () => {
    // Identical to the case above except the older roll finished BEFORE this
    // image was built, so it cannot have overtaken it. Delete the `.slice(1)`
    // clause and the pair collapses: this one stays false and the one above
    // flips to false with it.
    const c = [cand('150d2937', 20), cand('83e7cab6', 45)];
    expect(rollNeedsJobCheck({ candidates: c, estateSha: ESTATE, estateStamp: BUILT })).toBe(false);
  });

  it('CONDITION (2): an older roll with an unmeasurable finish also forces the check', () => {
    const c = [cand('150d2937', 20), cand('83e7cab6', null)];
    expect(rollNeedsJobCheck({ candidates: c, estateSha: ESTATE, estateStamp: BUILT })).toBe(true);
  });

  it('an older roll naming the SAME sha does not force the check', () => {
    // A re-roll of the same image is not an overtake — there is nothing newer
    // for the estate to be behind.
    const c = [cand('150d2937', 20), cand('150d2937', 5)];
    expect(rollNeedsJobCheck({ candidates: c, estateSha: ESTATE, estateStamp: BUILT })).toBe(false);
  });

  it('BOUNDARY: an older roll finishing at the EXACT build instant does NOT force the check', () => {
    // The tie was unpinned — `c.finishedMs > builtMs` mutated to `>=` survived
    // the whole suite green — and this is the LESS conservative of the two
    // directions, so it is the one worth nailing down: equal means the job
    // check is NOT paid for, and if someone later wants the other behaviour
    // they have to change this assertion deliberately rather than discover it.
    const tie = [cand('150d2937', 20), cand('83e7cab6', 30)]; // BUILT is exactly 30m ago
    expect(rollNeedsJobCheck({ candidates: tie, estateSha: ESTATE, estateStamp: BUILT })).toBe(false);
    // One minute the other side of the boundary DOES force it — without this
    // control the assertion above would also pass against a function that
    // never asks.
    const after = [cand('150d2937', 20), cand('83e7cab6', 29)];
    expect(rollNeedsJobCheck({ candidates: after, estateSha: ESTATE, estateStamp: BUILT })).toBe(true);
  });

  it('matches an abbreviated roll tag against the full estate sha', () => {
    // The estate publishes 40 chars; the image tag is the 8-char short sha.
    expect(rollNeedsJobCheck({
      candidates: [cand(ESTATE, 20)], estateSha: '150d2937', estateStamp: BUILT,
    })).toBe(false);
  });
});

/**
 * CONTRACT: the console's roll parser vs the workflows it parses.
 *
 * `titlePattern` and `jobName` are strings in THIS repo that describe strings in
 * ANOTHER file — `.github/workflows/*.yml`. Nothing in TypeScript connects them,
 * so a rename on the workflow side breaks the parser silently and in the worst
 * possible direction: `rollShaFromRun` starts returning null forever, every
 * verdict becomes UNKNOWN, and no test goes red because the console's own units
 * still agree with themselves. This is the same failure shape as a guard keyed
 * to a pattern the code no longer emits.
 *
 * So these read the workflow files and assert the two sides still agree. They
 * THROW rather than skip when a file is missing: a contract test that quietly
 * finds nothing to check is a guard with zero population.
 */
describe('roll parser matches the workflows it parses', () => {
  /** Repo root, found by walking up from THIS file — independent of cwd. */
  const repoRoot = (() => {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(dir, '.github', 'workflows'))) return dir;
      dir = dirname(dir);
    }
    throw new Error(`could not locate the repository root from ${import.meta.url}`);
  })();

  /** The `run-name: >-` folded block, joined exactly as YAML folds it. */
  const runNameOf = (yaml: string): string => {
    const lines = yaml.split(/\r?\n/);
    const i = lines.findIndex((l) => /^run-name:\s*>-\s*$/.test(l));
    if (i < 0) throw new Error('no folded `run-name: >-` block — the run title is what this parser reads');
    const block: string[] = [];
    for (const l of lines.slice(i + 1)) {
      if (!/^\s+\S/.test(l)) break;
      block.push(l.trim());
    }
    if (block.length === 0) throw new Error('the `run-name: >-` block is empty');
    return block.join(' ');
  };

  /**
   * The event names in a workflow's top-level `on:` block.
   *
   * Read from the file rather than assumed, because the whole point of these
   * tests is that a string in THIS repo describes a file in ANOTHER, and the
   * only way that stays true is to go and look. Comments and blank lines inside
   * the block are indented or empty, so they do not terminate it; the first
   * column-0 line does.
   */
  const triggersOf = (yaml: string): string[] => {
    const lines = yaml.split(/\r?\n/);
    const i = lines.findIndex((l) => /^on:\s*$/.test(l));
    if (i < 0) throw new Error('no top-level `on:` block — a workflow with no triggers cannot deploy anything');
    const events: string[] = [];
    for (const l of lines.slice(i + 1)) {
      if (/^\S/.test(l)) break;
      const m = /^ {2}([a-z_]+):/.exec(l);
      if (m) events.push(m[1]);
    }
    if (events.length === 0) throw new Error('the `on:` block declares no events');
    return events;
  };

  /** Events that fire WITHOUT a human — i.e. the lane deploys continuously. */
  const AUTOMATIC = new Set(['push', 'workflow_run', 'schedule', 'pull_request', 'release']);

  for (const def of DEPLOY_PATHS.filter((p) => p.roll)) {
    describe(def.workflow, () => {
      const file = join(repoRoot, '.github', 'workflows', def.workflow);
      const yaml = existsSync(file)
        ? readFileSync(file, 'utf8')
        : (() => { throw new Error(`${def.workflow} is named in DEPLOY_PATHS but does not exist at ${file}`); })();
      const runName = runNameOf(yaml);
      const exprs = [...runName.matchAll(/\$\{\{(.*?)\}\}/g)].map((m) => m[1]);

      it('the run title still has the shape the parser assumes: <sha expr> … <trigger expr>', () => {
        expect(exprs.length, runName).toBe(2);
      });

      it('the lane\'s `why` does not contradict the workflow\'s OWN triggers', () => {
        // THE DEFECT THIS EXISTS FOR. gov-console-roll.yml gained
        // `push: branches: [main]` in #3745 (049349a9), and the Gov lane's
        // `why` — the sentence rendered to the operator on /admin/readiness —
        // went on saying the lane is "DISPATCH-ONLY … so a long gap since its
        // last success is the normal state and not a bug in itself". Measured
        // at the same SHA: 13 of the last 20 Gov roll runs were `push`, with
        // six consecutive merge-triggered successes on 2026-08-19. So the
        // banner was telling the operator to ignore precisely the failure this
        // surface exists to catch, on the boundary that already spent 251
        // commits behind main because nobody could see this lane.
        //
        // Two independent teeth, because a guard keyed to one phrase is a guard
        // that survives a reword.
        const events = triggersOf(yaml);
        const automatic = events.filter((e) => AUTOMATIC.has(e));
        expect(events.length, `${def.workflow} on: ${events.join(', ')}`).toBeGreaterThan(0);

        const claimsNoAutoDeploy = /dispatch[- ]only|no continuous deploy|normal state|not a bug in itself/i
          .test(def.why);
        const namesItsAutomation = /push|merge|automatic/i.test(def.why);

        if (automatic.length > 0) {
          expect(claimsNoAutoDeploy, `${def.workflow} fires automatically on ${automatic.join(', ')}, so its `
            + `\`why\` may not tell the operator a gap is normal: ${def.why}`).toBe(false);
          expect(namesItsAutomation, `${def.workflow} fires automatically on ${automatic.join(', ')}, so its `
            + `\`why\` must say what moves it: ${def.why}`).toBe(true);
        } else {
          // The mirror case, so this is a contract and not a one-way ratchet: a
          // lane that genuinely only a human can start must SAY so, or the
          // operator reads an ordinary quiet lane as a broken one.
          expect(claimsNoAutoDeploy, `${def.workflow} has only ${events.join(', ')}, so its \`why\` must say `
            + `a human has to start it: ${def.why}`).toBe(true);
        }
      });

      it("the parser's trigger words are the workflow's OWN trigger words", () => {
        // `… && 'A' || 'B'` — rename either side in the workflow and the
        // console's alternation stops matching every run it produces.
        const ternary = /&&\s*'([^']+)'\s*\|\|\s*'([^']+)'/.exec(exprs[exprs.length - 1]);
        expect(ternary, `no \`&& 'a' || 'b'\` trigger ternary in: ${exprs[exprs.length - 1]}`).not.toBeNull();
        for (const word of [ternary![1], ternary![2]]) {
          expect(def.roll!.titlePattern!.source, word).toContain(word);
        }
      });

      it('the pattern matches a real rendered title on BOTH trigger branches, capturing the sha', () => {
        const ternary = /&&\s*'([^']+)'\s*\|\|\s*'([^']+)'/.exec(exprs[exprs.length - 1])!;
        for (const word of [ternary[1], ternary[2]]) {
          let seen = 0;
          const title = runName.replace(/\$\{\{.*?\}\}/g, () => (seen++ === 0 ? '150d2937' : word));
          expect(def.roll!.titlePattern!.exec(title)?.[1], title).toBe('150d2937');
          // And the whole way through rollShaFromRun, not just the regex.
          expect(rollShaFromRun(def, { name: title }), title).toBe(
            def.roll!.shaFrom === 'title' ? '150d2937' : null,
          );
        }
      });

      it(`the workflow still declares a job named "${def.roll!.jobName}"`, () => {
        // The job whose conclusion decides whether this run rolled anything.
        // Renaming it turns every job check into "job not found" → no candidate
        // is ever confirmed → the whole verdict degrades to UNKNOWN.
        const declared = [...yaml.matchAll(/^\s{4}name:\s*(.+?)\s*$/gm)].map((m) => m[1].replace(/^['"]|['"]$/g, ''));
        expect(declared, `job names declared in ${def.workflow}`).toContain(def.roll!.jobName);
      });
    });
  }
});
