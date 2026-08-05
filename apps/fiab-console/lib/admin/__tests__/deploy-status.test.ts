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
 *   - flip `aheadBy > max` to `<` → the behind/ok pair swaps; both go red.
 *   - reorder classifyDeployPath so `failing` is tested before `disabled` → the
 *     disabled test's asserted state changes; it goes red.
 *   - count cancelled/in-flight runs as failures → the skip test goes red.
 *   - make summarizeDeployStatus return a fixed severity → the roll-up tests go
 *     red in both directions.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyDeployPath,
  classifyEstateDrift,
  deployPathsForCloud,
  summarizeDeployStatus,
  worstSeverity,
  DEPLOY_PATHS,
  FAILING_STREAK,
  MAX_COMMITS_BEHIND,
  MAX_DAYS_SINCE_SUCCESS,
  type DeployPathHealth,
  type RunLite,
} from '@/lib/admin/deploy-status';

const REPO = 'fgarofalo56/csa-inabox';
const SHA = '678b53bccccc4c23ae6afa7f851a22a6910d7bb0';
const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const runs = (...conclusions: (string | null)[]): RunLite[] =>
  conclusions.map((c, i) => ({ conclusion: c, created_at: daysAgo(i) }));

const DEF = DEPLOY_PATHS[0];
const path = (over: Partial<Parameters<typeof classifyDeployPath>[0]>): DeployPathHealth =>
  classifyDeployPath({ def: DEF, repo: REPO, workflowState: 'active', now: NOW, ...over });

describe('classifyEstateDrift — how far behind main is the image serving this page', () => {
  it('reports the exact commit count when the estate is behind but within bound', () => {
    // The live 2026-08-05 reading. GitHub's compare/{buildSha}...main returns
    // status 'ahead' with ahead_by = the commits main has that we do not
    // (verified against the live API).
    const e = classifyEstateDrift({
      buildSha: SHA, buildStamp: '20260805T054836Z', repo: REPO,
      compare: { status: 'ahead', ahead_by: 12, behind_by: 0 },
    });
    expect(e.state).toBe('behind');
    expect(e.commitsBehind).toBe(12);
    expect(e.severity).toBe('ok'); // 12 <= MAX_COMMITS_BEHIND: ordinary merge lag
    expect(e.compareUrl).toBe(`https://github.com/${REPO}/compare/${SHA}...main`);
  });

  it('turns ERROR past the bound and says the roll path has stopped', () => {
    const e = classifyEstateDrift({
      buildSha: SHA, repo: REPO,
      compare: { status: 'ahead', ahead_by: 120, behind_by: 0 },
    });
    expect(e.state).toBe('behind');
    expect(e.severity).toBe('error');
    expect(e.headline).toContain('120 commits behind');
    expect(e.detail).toMatch(/roll path has stopped/);
  });

  it('the bound bites at exactly MAX_COMMITS_BEHIND, in both directions', () => {
    const at = (n: number) => classifyEstateDrift({
      buildSha: SHA, repo: REPO, compare: { status: 'ahead', ahead_by: n, behind_by: 0 },
    }).severity;
    expect(at(MAX_COMMITS_BEHIND)).toBe('ok');
    expect(at(MAX_COMMITS_BEHIND + 1)).toBe('error');
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
      buildSha: SHA, repo: REPO, compare: { status: 'ahead', ahead_by: 400, behind_by: 0 },
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
