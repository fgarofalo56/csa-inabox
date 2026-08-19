/**
 * CSA Loom — DEPLOY STATUS: is what is running actually what was merged?
 *
 * WHY THIS EXISTS (operator, 2026-08-05). "The operator has been looking at
 * unchanged gates for two weeks while PRs merged green, because nothing
 * surfaces 'the estate is N commits behind' or 'the last infra deploy failed'."
 *
 * Both facts were measurable and neither was measured anywhere a human looks:
 *
 *   - The console has always known its own build fingerprint (public/
 *     build-marker.txt, written from the LOOM_BUILD_SHA build-arg). Nothing
 *     ever compared it to main.
 *   - The two lanes that put code into the estate — the sub-level infra deploy
 *     (`az deployment sub create -f platform/fiab/bicep/main.bicep`) and the
 *     app-image build + Container App roll — had been red for weeks
 *     (deploy-fiab-commercial: 8 consecutive failed nightlies and switched OFF;
 *     full-app-deploy-commercial: 6 consecutive failures since 2026-06-19).
 *     A merged bicep change was therefore inert, and every surface still read
 *     green, because "merged" and "applied" were never compared.
 *
 * scripts/ci/check-deploy-staleness.mjs now makes the same comparison in CI.
 * This module is its in-product half: the operator does not read CI logs, they
 * read /admin/readiness.
 *
 * PURE. Every function here takes already-measured facts and returns a verdict.
 * All I/O (the build marker, the GitHub compare + Actions APIs) lives in
 * app/api/admin/deploy-status/route.ts, so every branch below is unit-tested
 * with fixtures — no network (lib/admin/__tests__/deploy-status.test.ts).
 *
 * THE ONE INVARIANT. An UNKNOWN is never rendered as a healthy result. If the
 * console cannot reach GitHub (Gov has no egress to api.github.com; an
 * unauthenticated call can be rate-limited), the verdict is `unknown` with the
 * exact reason — a distinct state with its own colour, never 'current' and
 * never 'healthy'. This repo has shipped three separate defects where an
 * unmeasured thing rendered as a measured result; the fix is always to give the
 * unknown its own state and let it show.
 */

/** How the running build relates to the repo's default branch. */
export type DeployDriftState = 'current' | 'behind' | 'divergent' | 'unknown';

/** How a deploy lane is doing. */
export type DeployPathState = 'healthy' | 'failing' | 'disabled' | 'never-run' | 'unknown';

/** Banner severity. `ok` renders informative; `error` renders as an error bar. */
export type DeploySeverity = 'ok' | 'warning' | 'error';

/** GitHub's compare response, narrowed to what the verdict needs. */
export interface CompareResult {
  /** HEAD (= the default branch) relative to BASE (= the running build). */
  status: 'identical' | 'ahead' | 'behind' | 'diverged';
  /** Commits the default branch has that the running build does not. */
  ahead_by: number;
  /** Commits the running build has that the default branch does not. */
  behind_by: number;
  /**
   * The commits in base..head — i.e. exactly the ones this estate is MISSING,
   * oldest first. Load-bearing, not decoration: their dates are the only way to
   * ask "how LONG has this code been undeployed", which is what replaced the
   * commit-count tolerance below. Capped by GitHub at 250 per page, starting
   * from the oldest, so the oldest is always present when ahead_by > 0.
   */
  commits?: Array<{
    commit?: {
      committer?: { date?: string | null } | null;
      author?: { date?: string | null } | null;
    } | null;
  } | null> | null;
}

export interface EstateDrift {
  /** The sha the running image reports serving (build-marker.txt). */
  buildSha: string | null;
  /** The build timestamp stamped into the same marker. */
  buildStamp: string | null;
  /** Default branch the comparison was made against. */
  branch: string;
  state: DeployDriftState;
  /** Commits the branch is ahead of the running build; null when unknown. */
  commitsBehind: number | null;
  /** Date of the OLDEST commit this estate is missing; null when unmeasured. */
  behindSince: string | null;
  /** How long this estate has been missing that commit; null when unmeasured. */
  behindForMinutes: number | null;
  severity: DeploySeverity;
  headline: string;
  detail: string;
  /** A GitHub compare URL an operator can open to see exactly what is missing. */
  compareUrl: string | null;
}

export interface DeployPathHealth {
  workflow: string;
  title: string;
  why: string;
  state: DeployPathState;
  /** Consecutive completed failures at the head of the run history. */
  failureStreak: number;
  lastConclusion: string | null;
  lastSuccessAt: string | null;
  daysSinceSuccess: number | null;
  /** How many runs were examined — the window "no success" is scoped to. */
  runsExamined: number;
  /** True when the examined window is the WHOLE history (nothing older exists). */
  historyComplete: boolean;
  severity: DeploySeverity;
  detail: string;
  runsUrl: string;
}

export interface DeployStatusReport {
  generatedAt: string;
  repo: string;
  estate: EstateDrift;
  paths: DeployPathHealth[];
  /** Worst severity across the estate and every watched path. */
  severity: DeploySeverity;
  headline: string;
  /**
   * EVERY live estate, this cloud and its peers, each compared against main.
   * (#3730 — `estate` above can only ever describe the console answering the
   * request, which is how Azure Government sat 251 commits behind while every
   * Commercial signal read green.)
   *
   * Optional because the shape is additive: an older cached payload, or a unit
   * test built on the pre-#3730 report, still type-checks. Consumers MUST treat
   * absent as "not reported" and never as "no other estates exist".
   *
   * Typed as `unknown[]` here rather than importing `FleetEstate` because
   * estate-fleet.ts imports `EstateDrift` from this module; naming the concrete
   * type in both directions would be a cycle. The route and the page both
   * import the real type from estate-fleet.ts.
   */
  estates?: unknown[];
  /** The fleet's own one-line verdict, kept separate from `headline`. */
  fleetHeadline?: string;
}

/**
 * How long merged code may sit UNAPPLIED to this estate before the banner turns.
 *
 * THERE IS NO COMMIT-COUNT TOLERANCE, and the first cut of this file having one
 * is the point. It shipped `MAX_COMMITS_BEHIND = 20`, and the live estate was 13
 * behind — so the control written because "nothing surfaces 'the estate is N
 * commits behind'" classified the actual estate as `ok` and could not fire on
 * the condition it exists for. A 20-commit band lets an estate sit two thirds of
 * the way to a fortnight's divergence and read green, which is exactly the state
 * that went unnoticed for two weeks. Per the deploy-integrity rule
 * (#3004, R3), drift is a defect with an owner, not a tolerance band.
 *
 * So: BEHIND AT ALL IS THE CONDITION. `commitsBehind > 0` is reported, always.
 * The only tolerance is a small TIME window for a roll that is legitimately in
 * flight, and it is measured against the OLDEST commit the estate is missing —
 * "how long has merged code been undeployed" — not against a count.
 *
 * WHY THAT CLOCK AND NOT "AGE OF THE RUNNING BUILD". A healthy estate that
 * rolled three hours ago and takes a merge one minute ago is behind by 1 with a
 * three-hour-old build; grading it on build age would fire on every merge into a
 * perfectly healthy estate. Grading it on the age of the missing commit says
 * "one minute" and correctly waits.
 *
 * WHY 90 MINUTES. Measured, not guessed, from this repo's own merge→estate
 * cycle on 2026-08-05: build-fiab-images-acr-tasks successes ran 7–38 min and
 * loom-roll-and-validate successes 8–18 min, so the observed worst case is ~56
 * minutes end to end. 90 leaves ~1.6× headroom and nothing more. Anything longer
 * would be a tolerance for a broken roll path wearing a build's clothes.
 *
 * Matched deliberately to ESTATES[].behindGraceMinutes in
 * scripts/ci/check-deploy-staleness.mjs so CI and the console cannot disagree
 * about what "behind" means (one number, two surfaces).
 */
export const BEHIND_GRACE_MINUTES = 90;

/**
 * Consecutive completed failures that make a deploy lane "failing".
 * One red run is weather; three in a row is a broken path.
 */
export const FAILING_STREAK = 3;

/** Days without a successful run after which a lane is called out. */
export const MAX_DAYS_SINCE_SUCCESS = 21;

const DAY_MS = 86_400_000;

/** Conclusions that extend a failure streak. */
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/** A workflow run, narrowed to what the verdict needs. */
export interface RunLite {
  conclusion: string | null;
  status?: string | null;
  created_at?: string;
}

/**
 * The deploy lanes this surface reports on.
 *
 * `clouds` narrows a lane to the boundaries where it is the real path (the
 * Commercial infra deploy is not the Gov one); values are the `LoomCloud`
 * strings detectLoomCloud() returns. A lane with no `clouds` applies
 * everywhere. An UNRECOGNISED cloud shows every lane rather than none: showing
 * a lane that does not apply is a smaller error than hiding one that is broken.
 */
export interface DeployPathDef {
  workflow: string;
  title: string;
  why: string;
  clouds?: string[];
}

export const DEPLOY_PATHS: DeployPathDef[] = [
  {
    workflow: 'deploy-fiab-commercial.yml',
    title: 'Infrastructure deploy (main.bicep → this estate)',
    why: 'The only lane that applies platform/fiab/bicep/main.bicep to Commercial. Every env var, role grant and module this console depends on reaches production through it and no other — so while it is red, merged bicep is inert and capabilities stay blocked no matter how many PRs land.',
    clouds: ['Commercial'],
  },
  {
    workflow: 'deploy-fiab-gcch.yml',
    title: 'Infrastructure deploy (main.bicep → this estate)',
    why: 'The Gov ring that applies platform/fiab/bicep/main.bicep. While it is red, merged bicep is inert in Government and capabilities stay blocked no matter how many PRs land.',
    clouds: ['GCC-High', 'DoD', 'GCC'],
  },
  {
    workflow: 'full-app-deploy-commercial.yml',
    title: 'App images + Container App roll (from-scratch phase 2)',
    why: 'Builds every app image and rolls the Container Apps onto them, and is the ONLY producer of loom-wrangler-host / loom-dbt-runner / loom-transform-runner / loom-duckdb / loom-uat. While it is red a from-scratch deploy cannot complete and those five apps run whatever was last pushed.',
    clouds: ['Commercial'],
  },
  {
    workflow: 'build-fiab-images-acr-tasks.yml',
    title: 'Console image build (on every merge)',
    why: 'Builds the loom-console image this page is being served from. While it is red, nothing new can be rolled — the estate freezes at the last image that built, which is exactly how a console silently falls weeks behind main.',
  },
];

/** The lanes that apply to `cloud`; an unrecognised cloud gets them all. */
export function deployPathsForCloud(cloud: string | undefined | null): DeployPathDef[] {
  const known = new Set(DEPLOY_PATHS.flatMap((p) => p.clouds || []));
  if (!cloud || !known.has(cloud)) return DEPLOY_PATHS;
  return DEPLOY_PATHS.filter((p) => !p.clouds || p.clouds.includes(cloud));
}

/**
 * Date of the OLDEST commit in a compare result — the one this estate has been
 * missing longest. PURE. Returns null when the response carried no usable date,
 * which the caller must treat as UNMEASURED (and therefore untolerated), never
 * as zero.
 *
 * Scans every row rather than trusting `commits[0]`: GitHub documents the array
 * as oldest-first, but a verdict that turns on ordering nobody re-checks is a
 * verdict waiting to be wrong. `min` over the set is ordering-independent.
 */
export function oldestUnappliedAt(compare: CompareResult | null | undefined): string | null {
  const rows = compare?.commits;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    const d = r?.commit?.committer?.date || r?.commit?.author?.date || null;
    const t = d ? Date.parse(d) : NaN;
    if (Number.isFinite(t) && t < min) min = t;
  }
  return Number.isFinite(min) ? new Date(min).toISOString() : null;
}

/**
 * Estate-drift verdict. PURE.
 *
 * `compare` is GitHub's `compare/{buildSha}...{branch}` result, where BASE is
 * the running build and HEAD is the default branch — so `ahead_by` is how many
 * commits the branch has that the estate does not, i.e. how far behind it is.
 * (Verified against the live API: a 12-commit gap returns
 * `{status:'ahead', ahead_by:12, behind_by:0}`.)
 *
 *   no sha / no compare / error  → UNKNOWN, warning. Never 'current'.
 *   diverged, or the build ahead → DIVERGENT: the image was built from a branch
 *                                  or a force-pushed history. A commit distance
 *                                  between unrelated histories is meaningless,
 *                                  so none is reported.
 *   identical                    → CURRENT.
 *   behind, oldest missing commit
 *     within BEHIND_GRACE_MINUTES → BEHIND, ok — a roll is plausibly in flight.
 *   behind, past the grace        → BEHIND, error — the roll path has stopped.
 *   behind, grace UNMEASURABLE    → BEHIND, error. An unmeasured grace is not a
 *                                  grace; the one thing this file never does is
 *                                  let an unknown buy a green.
 *
 * NOTE THE ABSENCE OF A COUNT THRESHOLD. Any `ahead_by > 0` is reported as
 * behind. See BEHIND_GRACE_MINUTES for why the count band was removed.
 */
export function classifyEstateDrift(input: {
  buildSha?: string | null;
  buildStamp?: string | null;
  branch?: string;
  repo?: string;
  compare?: CompareResult | null;
  error?: string | null;
  /** Injected in tests; defaults to now. */
  now?: number;
  graceMinutes?: number;
}): EstateDrift {
  const branch = input.branch || 'main';
  const buildSha = input.buildSha || null;
  const buildStamp = input.buildStamp || null;
  const now = input.now ?? Date.now();
  const grace = input.graceMinutes ?? BEHIND_GRACE_MINUTES;
  const short = buildSha ? buildSha.slice(0, 8) : null;
  const compareUrl = buildSha && input.repo
    ? `https://github.com/${input.repo}/compare/${buildSha}...${branch}`
    : null;
  const base = {
    buildSha, buildStamp, branch, compareUrl,
    behindSince: null as string | null,
    behindForMinutes: null as number | null,
  };

  if (!buildSha) {
    return {
      ...base,
      state: 'unknown',
      commitsBehind: null,
      severity: 'warning',
      headline: 'Running build is unidentified',
      detail: 'This image carries no build fingerprint (public/build-marker.txt has no sha), so it cannot be compared to '
        + `${branch}. An image built outside the standard pipeline is by definition unverified against the repo.`,
    };
  }
  if (input.error || !input.compare) {
    return {
      ...base,
      state: 'unknown',
      commitsBehind: null,
      severity: 'warning',
      headline: `Cannot tell whether this estate is running ${branch}`,
      detail: `Running build ${short}, but the comparison against ${branch} could not be made — `
        + `${input.error || 'no comparison result was returned'}. `
        + 'This is UNKNOWN, not up-to-date: in a boundary with no egress to GitHub, verify the deploy lanes below through Actions instead.',
    };
  }

  const { status, ahead_by: aheadBy, behind_by: behindBy } = input.compare;
  if (status === 'diverged' || (status === 'behind' && behindBy > 0)) {
    return {
      ...base,
      state: 'divergent',
      commitsBehind: null,
      severity: 'error',
      headline: `This estate is running a build that is not on ${branch}`,
      detail: `Running build ${short} carries ${behindBy} commit(s) that ${branch} does not. `
        + 'It was built from a branch, a revert, or a force-pushed history — so "how far behind" has no meaning, '
        + `and nothing guarantees the code serving this page was ever reviewed onto ${branch}.`,
    };
  }
  if (status === 'identical' || aheadBy === 0) {
    return {
      ...base,
      state: 'current',
      commitsBehind: 0,
      severity: 'ok',
      headline: `This estate is running ${branch}`,
      detail: `Running build ${short}${buildStamp ? ` (built ${buildStamp})` : ''} — no commits behind ${branch}.`,
    };
  }

  const behindSince = oldestUnappliedAt(input.compare);
  const behindForMinutes = behindSince
    ? Math.max(0, Math.round((now - Date.parse(behindSince)) / 60_000))
    : null;
  const built = buildStamp ? ` (built ${buildStamp})` : '';
  const plural = aheadBy === 1 ? 'commit' : 'commits';

  // An UNMEASURED wait is not a short wait. The grace exists for a roll that is
  // demonstrably in flight; with no date to demonstrate it, the estate is behind
  // and that is what gets said.
  if (behindForMinutes === null) {
    return {
      ...base,
      state: 'behind',
      commitsBehind: aheadBy,
      severity: 'error',
      headline: `This estate is ${aheadBy} ${plural} behind ${branch}`,
      detail: `Running build ${short}${built}. ${aheadBy} merged ${plural} have never reached this estate, and `
        + `HOW LONG they have been waiting could not be measured (the compare carried no commit dates), so the `
        + `${grace}-minute roll-in-flight allowance cannot apply. Unmeasured is not "recent".`,
    };
  }

  const inFlight = behindForMinutes <= grace;
  return {
    ...base,
    behindSince,
    behindForMinutes,
    state: 'behind',
    commitsBehind: aheadBy,
    severity: inFlight ? 'ok' : 'error',
    headline: inFlight
      ? `This estate is ${aheadBy} ${plural} behind ${branch} (a roll is in flight)`
      : `This estate is ${aheadBy} ${plural} behind ${branch}`,
    detail: inFlight
      ? `Running build ${short}${built}. The oldest unapplied commit merged ${behindForMinutes} minute(s) ago — `
        + `inside the ${grace}-minute build-and-roll window, so a roll is plausibly still running. `
        + 'This is the ONLY tolerated form of behind.'
      : `Running build ${short}${built}. ${aheadBy} merged ${plural} have never reached this estate, the oldest `
        + `waiting ${behindForMinutes} minutes (allowance ${grace}) — that is longer than a build and roll take, so `
        + `the roll path has stopped applying ${branch}. Everything merged since ${short} is inert here, including `
        + 'any capability fix you are looking at on this page.',
  };
}

/**
 * Deploy-lane verdict. PURE.
 *
 * WHAT THIS ADDS OVER "when did it last succeed". A lane that succeeded
 * yesterday and has failed on every run since is BROKEN, and a last-success
 * timestamp cannot say so. Both lanes that were silently red for weeks had that
 * exact shape, which is why the streak is computed and reported separately from
 * the age of the last success.
 *
 * COUNTING RULES. Only a COMPLETED run with conclusion failure/timed_out/
 * startup_failure extends the streak; a success ends it; cancelled, skipped and
 * still-running rows are SKIPPED — an in-flight run is not evidence of failure
 * (the mirror of reading an in-progress check as "not found"), and a cancelled
 * run in the middle of six failures does not make the lane healthy.
 *
 * A `workflowState` of undefined is UNKNOWN, never 'active': a listing that
 * omitted the workflow (pagination, a 404, no egress) must not be read as proof
 * that it is enabled.
 *
 * "NO SUCCESS IN THE WINDOW" IS NOT "NEVER SUCCEEDED". `runs` is a PAGE of the
 * newest runs, not the whole history. deploy-fiab-commercial.yml has 30+
 * consecutive failures, so a 30-run page contains no success at all — and the
 * first cut of this function reported "it has never succeeded", which is false:
 * it succeeded on 2026-06-18. That is the exact "UNKNOWN reported as a
 * NEGATIVE" defect this file guards against everywhere else, committed here by
 * accident and caught by running it against the real API. `historyComplete`
 * (the caller got back FEWER rows than it asked for, so nothing older exists)
 * is what licenses the word "never"; without it the verdict says "no success in
 * the last N runs examined" and means exactly that.
 */
export function classifyDeployPath(input: {
  def: DeployPathDef;
  repo: string;
  runs?: RunLite[] | null;
  /** True only when `runs` is the ENTIRE run history, not a page of it. */
  historyComplete?: boolean;
  workflowState?: string | null;
  error?: string | null;
  now?: number;
  failingStreak?: number;
  maxDaysSinceSuccess?: number;
}): DeployPathHealth {
  const { def, repo } = input;
  const now = input.now ?? Date.now();
  const streakLimit = input.failingStreak ?? FAILING_STREAK;
  const maxDays = input.maxDaysSinceSuccess ?? MAX_DAYS_SINCE_SUCCESS;
  const runsUrl = `https://github.com/${repo}/actions/workflows/${def.workflow}`;
  const shell = { workflow: def.workflow, title: def.title, why: def.why, runsUrl };

  if (input.error || !input.runs) {
    return {
      ...shell,
      state: 'unknown',
      failureStreak: 0,
      lastConclusion: null,
      lastSuccessAt: null,
      daysSinceSuccess: null,
      runsExamined: 0,
      historyComplete: false,
      severity: 'warning',
      detail: `Run history unavailable — ${input.error || 'no result returned'}. `
        + 'This is UNKNOWN, not healthy: check the lane in GitHub Actions directly.',
    };
  }

  let failureStreak = 0;
  let lastConclusion: string | null = null;
  let lastSuccessAt: string | null = null;
  let streakOpen = true;
  for (const r of input.runs) {
    const c = r?.conclusion ?? null;
    if (c === 'success') {
      lastConclusion ??= c;
      lastSuccessAt ??= r.created_at ?? null;
      streakOpen = false;
      break;
    }
    if (!FAILED.has(c as string)) continue; // cancelled / skipped / in-flight
    lastConclusion ??= c;
    if (streakOpen) failureStreak += 1;
  }

  const runsExamined = input.runs.length;
  const historyComplete = input.historyComplete === true;
  const daysSinceSuccess = lastSuccessAt
    ? Math.max(0, Math.round((now - Date.parse(lastSuccessAt)) / DAY_MS))
    : null;
  const base = { failureStreak, lastConclusion, lastSuccessAt, daysSinceSuccess, runsExamined, historyComplete };
  /** Honest phrasing for "we saw no success", scoped to what we actually read. */
  const noSuccessPhrase = historyComplete
    ? 'It has never succeeded.'
    : `No successful run in the ${runsExamined} most recent examined (older runs were not read).`;
  const successPhrase = lastSuccessAt
    ? `The last success was ${lastSuccessAt.slice(0, 10)} (${daysSinceSuccess}d ago), which does NOT mean this path works today.`
    : noSuccessPhrase;

  // Disabled is checked FIRST and reported on its own: "the lane is switched
  // off" has a different fix (re-enable it) from "the lane is failing" (fix
  // it), and a disabled lane accrues drift forever while looking like lag.
  const stateInfo = input.workflowState ?? null;
  if (stateInfo === null) {
    return {
      ...shell,
      ...base,
      state: 'unknown',
      severity: 'warning',
      detail: 'Whether this lane is enabled could not be determined, so its health is UNKNOWN — not healthy.',
    };
  }
  if (stateInfo !== 'active') {
    return {
      ...shell,
      ...base,
      state: 'disabled',
      severity: 'error',
      detail: `SWITCHED OFF (state "${stateInfo}") — it cannot run on its schedule or on dispatch. `
        + `Nothing is applying this path to the estate. ${lastSuccessAt ? `Last success ${lastSuccessAt.slice(0, 10)}.` : noSuccessPhrase}`,
    };
  }
  if (failureStreak >= streakLimit) {
    return {
      ...shell,
      ...base,
      state: 'failing',
      severity: 'error',
      detail: `FAILING — ${failureStreak} consecutive failed run(s), newest conclusion "${lastConclusion}". ${successPhrase}`,
    };
  }
  if (!lastSuccessAt) {
    // Only claim "never" when the whole history was read; otherwise this is an
    // unknown last-success, which is still not healthy but is not "never".
    return {
      ...shell,
      ...base,
      state: historyComplete ? 'never-run' : 'unknown',
      severity: historyComplete ? 'error' : 'warning',
      detail: historyComplete
        ? 'Has NEVER completed successfully — this deploy path has never been applied to the estate.'
        : `${noSuccessPhrase} When it last succeeded is UNKNOWN, so this lane cannot be called healthy.`,
    };
  }
  if ((daysSinceSuccess ?? 0) > maxDays) {
    return {
      ...shell,
      ...base,
      state: 'failing',
      severity: 'warning',
      detail: `No successful run for ${daysSinceSuccess} days (limit ${maxDays}) — anything merged since ${lastSuccessAt.slice(0, 10)} has not reached the estate through this path.`,
    };
  }
  return {
    ...shell,
    ...base,
    state: 'healthy',
    severity: 'ok',
    detail: `Last success ${lastSuccessAt.slice(0, 10)} (${daysSinceSuccess}d ago)${failureStreak ? `, ${failureStreak} failure(s) since` : ''}.`,
  };
}

/** Worst of a set of severities. */
export function worstSeverity(severities: DeploySeverity[]): DeploySeverity {
  if (severities.includes('error')) return 'error';
  if (severities.includes('warning')) return 'warning';
  return 'ok';
}

/**
 * Roll the estate verdict + every lane verdict into the single line the banner
 * shows. PURE.
 *
 * The headline names the WORST fact, because a banner that averages is a banner
 * that gets ignored — and being ignored is the failure mode this whole control
 * exists to prevent.
 */
export function summarizeDeployStatus(
  estate: EstateDrift,
  paths: DeployPathHealth[],
  meta: { generatedAt: string; repo: string },
): DeployStatusReport {
  const severity = worstSeverity([estate.severity, ...paths.map((p) => p.severity)]);
  const broken = paths.filter((p) => p.severity === 'error');
  const degraded = paths.filter((p) => p.severity === 'warning');

  let headline: string;
  if (estate.severity === 'error') {
    headline = broken.length
      ? `${estate.headline} — and ${broken.length} deploy path(s) are failing or switched off`
      : estate.headline;
  } else if (broken.length) {
    const first = broken[0];
    headline = broken.length === 1
      ? `Deploy path broken: ${first.title}`
      : `${broken.length} deploy paths are failing or switched off, including ${first.title}`;
  } else if (estate.severity === 'warning') {
    headline = estate.headline;
  } else if (degraded.length) {
    headline = `${degraded.length} deploy path(s) need attention`;
  } else {
    headline = estate.headline;
  }

  return { generatedAt: meta.generatedAt, repo: meta.repo, estate, paths, severity, headline };
}
