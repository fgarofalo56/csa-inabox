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

/** How the estate relates to the last roll that actually shipped an image. */
export type RollRegressionState = 'current' | 'regressed' | 'ahead' | 'unknown';

/**
 * Did something OVERWRITE a successful roll with an older image? (#3676)
 *
 * Distinct from `EstateDrift` on purpose. Drift asks "is the estate behind
 * main", and its answer for a reverted estate is "behind by N" — true, but
 * indistinguishable from the ordinary, harmless case of a roll that simply has
 * not happened yet. A REGRESSION is a different fact: a roll ran, succeeded,
 * and shipped a tag, and the estate is no longer running it. Something took the
 * estate BACKWARDS after a validated fix had landed on it.
 */
export interface RollRegression {
  /** The sha the estate's console is serving (build-marker.txt). */
  estateSha: string | null;
  /** The sha the last EFFECTIVE roll shipped — see classifyRollRegression. */
  rolledSha: string | null;
  /** When that roll finished. */
  rolledAt: string | null;
  /** The workflow whose roll is being compared against. */
  rollWorkflow: string | null;
  state: RollRegressionState;
  severity: DeploySeverity;
  headline: string;
  detail: string;
  /** The roll run an operator can open to see what shipped. */
  rollRunUrl: string | null;
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
  /**
   * Whether a successful roll was OVERWRITTEN by an older image (#3676).
   *
   * Optional on the same reasoning as `estates`: the shape is additive, and a
   * caller that could not measure it omits it rather than supplying a green
   * verdict it did not establish. Consumers MUST read absent as "not reported",
   * never as "no regression" — those are different claims and only one of them
   * was made.
   */
  rollRegression?: RollRegression;
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

/**
 * A git object id — the shape an image tag must have before it can be compared
 * to a commit sha at all.
 *
 * The lower bound is 7 because that is git's own abbreviation floor, and the
 * upper is 40 because a full sha is the longest legal form. Anything outside
 * that is a floating tag ('latest', 'v0.1', a branch name), which is precisely
 * the input that must NOT be compared — see `rollShaFromRun`.
 */
const GIT_OBJECT_ID = /^[0-9a-f]{7,40}$/i;

/** Conclusions that extend a failure streak. */
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/** A workflow run, narrowed to what the verdict needs. */
export interface RunLite {
  conclusion: string | null;
  status?: string | null;
  created_at?: string;
}

/**
 * A run of a ROLL lane, narrowed to what "what did this actually ship" needs.
 *
 * `updated_at` rather than `created_at` orders these, because the question is
 * when the roll FINISHED writing to the estate, not when it was queued.
 */
export interface RollRunLite extends RunLite {
  id?: number;
  name?: string | null;
  display_title?: string | null;
  head_sha?: string | null;
  updated_at?: string | null;
  html_url?: string | null;
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
  /**
   * Set ONLY on a lane that actually writes a console image onto the estate.
   *
   * Its presence is what makes a lane a roll source, so "which workflow rolls
   * this cloud" is stated exactly once — here — rather than in a second table
   * that can drift out of step with this one. (This repo has already shipped
   * one pair of keys whose name and target disagreed.)
   *
   * `jobName` is matched against the run's JOB names, never the run conclusion,
   * because A ROLL RUN CAN CONCLUDE SUCCESS HAVING ROLLED NOTHING — measured
   * 2026-08-17 on run 32006479915, where `Should this roll proceed?` succeeded,
   * `Roll image + validate live URL` was SKIPPED because the console image had
   * not built, and the run reported `success`. Reading the run conclusion would
   * name that run's sha as "what the estate was last rolled to" when nothing of
   * the sort was deployed — and then report a healthy estate as regressed.
   *
   * `shaFrom` says where the shipped sha lives:
   *   'title'    loom-roll-and-validate's `run-name`. Its `head_sha` is the
   *              default-branch HEAD at trigger time, NOT the sha it rolls
   *              (#2963), so the title is the only honest source.
   *   'headSha'  gov-console-roll builds from its own checkout, so the run's
   *              head_sha IS the image it pushes and rolls.
   *
   * `titlePattern` must capture the sha in group 1. A title that does not match
   * yields null, which the caller treats as UNKNOWN — a dispatch may legitimately
   * name a floating tag ('latest', a prefix), and the sha it resolved to lives
   * only inside that run. Comparing a floating name to a commit sha would be a
   * fabricated verdict.
   */
  roll?: {
    jobName: string;
    shaFrom: 'title' | 'headSha';
    titlePattern?: RegExp;
  };
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
  {
    workflow: 'loom-roll-and-validate.yml',
    title: 'Console roll (build → this estate)',
    why: 'The lane that actually moves the running console onto a freshly built image on every merge. It was absent from this list until #3676, which is how the 2026-08-19 revert went unseen: the roller nobody watched was the writer that lost the race with the scheduled reconcile, and the estate went BACKWARDS onto an older image while every other lane here stayed green.',
    clouds: ['Commercial'],
    roll: {
      jobName: 'Roll image + validate live URL',
      shaFrom: 'title',
      // .github/workflows/loom-roll-and-validate.yml run-name:
      //   roll ${{ …head_sha || inputs.image_tag }} (build-triggered | manual dispatch)
      titlePattern: /^roll\s+(\S+)\s+\((?:build-triggered|manual dispatch)\)$/,
    },
  },
  {
    workflow: 'gov-console-roll.yml',
    title: 'Console roll (build → this estate)',
    why: 'The Gov ring that rolls the console onto a built image. It is DISPATCH-ONLY — Gov has no continuous deploy at all — so a long gap since its last success is the normal state and not a bug in itself. It is listed because the alternative is that the one lane that can move Government forward is the one lane nobody can see.',
    clouds: ['GCC-High', 'DoD', 'GCC'],
    roll: {
      jobName: 'Build + roll Gov console',
      shaFrom: 'headSha',
      // .github/workflows/gov-console-roll.yml run-name:
      //   gov-console-roll ${{ github.sha }} (merge-triggered | manual dispatch)
      titlePattern: /^gov-console-roll\s+(\S+)\s+\((?:merge-triggered|manual dispatch)\)$/,
    },
  },
];

/**
 * The roll lane for `cloud`, or null when none of its lanes writes an image.
 *
 * Deliberately derived from DEPLOY_PATHS rather than from a second list: the
 * lane a cloud rolls from and the lane this page watches are the SAME fact, and
 * two places holding one fact is how they end up disagreeing.
 *
 * Answers ONLY when the answer is unambiguous — exactly one roll lane applies.
 * Zero or several yields null, i.e. UNKNOWN, and that is deliberate in both
 * directions:
 *
 *   - An UNRECOGNISED cloud gets every lane back from deployPathsForCloud(),
 *     which is the right call for a LIST ("showing a lane that does not apply is
 *     a smaller error than hiding one that is broken") and the wrong one here.
 *     Naming a roll lane is a claim about which workflow writes THIS estate; if
 *     we do not know what estate this is, picking the first would compare a
 *     local or unknown build marker against Commercial's roll history and
 *     manufacture a regression out of nothing.
 *   - If a cloud ever gains a SECOND writer, that ambiguity is a real problem to
 *     resolve here, not something to paper over by silently picking one.
 */
export function rollSourceForCloud(cloud: string | undefined | null): DeployPathDef | null {
  const rolls = deployPathsForCloud(cloud).filter((p) => p.roll);
  return rolls.length === 1 ? rolls[0] : null;
}

/**
 * The sha a roll run actually shipped, or null when it cannot be established.
 *
 * NULL IS A REAL ANSWER, not a failure to try. A manual dispatch may name a
 * floating tag ('latest', a prefix, a branch name); the commit it resolved to
 * exists only inside that run's logs. Returning the floating string here would
 * hand the comparator a value that can never match a 40-char estate sha, and it
 * would report every dispatch-rolled estate as reverted. Null routes to UNKNOWN,
 * which is the honest verdict for "a roll happened and I cannot say to what".
 */
export function rollShaFromRun(
  def: DeployPathDef,
  run: RollRunLite,
): string | null {
  if (!def.roll) return null;
  if (def.roll.shaFrom === 'headSha') {
    const head = String(run.head_sha ?? '').trim();
    return GIT_OBJECT_ID.test(head) ? head : null;
  }
  const title = String(run.name ?? run.display_title ?? '').trim();
  const m = def.roll.titlePattern?.exec(title);
  const tag = m?.[1];
  // A tag that is not a git object id is a floating name — see the doc above.
  return tag && GIT_OBJECT_ID.test(tag) ? tag : null;
}

/** A roll run that concluded successfully AND names a sha we can compare. */
export interface RollCandidate {
  run: RollRunLite;
  sha: string;
  /** When the run finished. Null when the API did not carry a stamp. */
  finishedMs: number | null;
}

/**
 * Roll runs worth asking about, newest finish first.
 *
 * A run only becomes a candidate if it CONCLUDED SUCCESS and names a sha. Both
 * filters drop runs that cannot answer the question rather than guessing at
 * them: an in-flight run has not written anything yet, a failed one did not
 * write what it intended, and a floating-tag dispatch names something that is
 * not a commit.
 *
 * Note what this deliberately does NOT establish: that a candidate's roll STEP
 * ran. A run concluding success proves only that no job failed — on run
 * 32006479915 (2026-08-17) the gate job succeeded, the roll job was SKIPPED
 * because the image had not built, and the run reported success having deployed
 * nothing. That question costs an extra API call per run and is answered
 * separately, only when the cheap evidence is inconclusive.
 */
export function rollCandidates(def: DeployPathDef, runs: RollRunLite[] | null): RollCandidate[] {
  if (!def.roll || !runs) return [];
  return runs
    .filter((r) => r.conclusion === 'success')
    .map((run) => {
      const sha = rollShaFromRun(def, run);
      const ms = Date.parse(String(run.updated_at ?? run.created_at ?? ''));
      return sha ? { run, sha, finishedMs: Number.isNaN(ms) ? null : ms } : null;
    })
    .filter((c): c is RollCandidate => c !== null)
    .sort((a, b) => (b.finishedMs ?? 0) - (a.finishedMs ?? 0));
}

/**
 * Must we spend API calls asking WHICH candidate actually shipped?
 *
 * WHY THIS EXISTS AND IS NOT JUST "ALWAYS ASK". Confirming a run's roll job ran
 * costs one more upstream call per run, and this route already issues up to a
 * dozen against an unauthenticated budget of 60/hour per egress IP. Paying that
 * on every refresh of a healthy estate — the overwhelmingly common case — would
 * exhaust the budget and turn the whole page UNKNOWN, which is a strictly worse
 * outcome than the question it was meant to answer.
 *
 * FALSE is returned only when the cheap evidence is already conclusive:
 *
 *   1. the newest candidate names exactly what the estate is running, AND
 *   2. no OLDER candidate names a different sha and finished AFTER this image
 *      was built.
 *
 * (2) is the part that is easy to leave out and wrong to. Without it, a newest
 * run that named the reverted sha and then skipped would let a genuine
 * regression short-circuit to "current" — the estate would be running what SOME
 * roll named while sitting behind a later roll that actually shipped. With it,
 * any older roll that could have overtaken this image forces the real check.
 *
 * An unmeasurable ordering (no build stamp, no run stamp) returns TRUE: when we
 * cannot show the cheap evidence is conclusive, we do not assume it is.
 */
export function rollNeedsJobCheck(input: {
  candidates: RollCandidate[];
  estateSha?: string | null;
  estateStamp?: string | null;
}): boolean {
  const { candidates } = input;
  if (candidates.length === 0) return false; // nothing to ask about
  const estateSha = input.estateSha || null;
  if (!estateSha) return true;
  if (!shaMatches(estateSha, candidates[0].sha)) return true;

  const builtMs = input.estateStamp ? Date.parse(input.estateStamp) : NaN;
  if (Number.isNaN(builtMs)) return true;

  return candidates.slice(1).some(
    (c) => !shaMatches(estateSha, c.sha) && (c.finishedMs === null || c.finishedMs > builtMs),
  );
}

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
 * Do two shas refer to the same commit when one of them may be abbreviated?
 *
 * The estate publishes a full 40-char sha in build-marker.txt; the roll ships an
 * image whose TAG is the 8-char short sha (`loom-console:150d2937`). Comparing
 * them with `===` reports every healthy estate as regressed, so the comparison
 * is on the shorter length — with a 7-char floor, below which a "match" is not
 * evidence of anything and the answer is no.
 */
function shaMatches(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  if (n < 7) return false;
  return a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

/**
 * Did something take this estate BACKWARDS off a successful roll? (#3676) PURE.
 *
 * WHY THIS EXISTS WHEN classifyEstateDrift ALREADY REPORTS "BEHIND". Because on
 * 2026-08-19 drift reported the incident correctly and it still went unnoticed.
 * The estate's revision history:
 *
 *   0000781  05:46:46Z  loom-console:83e7cab6
 *   0000782  07:04:56Z  loom-console:150d2937   <- roll 32225337320 shipped this
 *   0000783  07:10:19Z  loom-console:83e7cab6   <- the reconcile put it BACK
 *
 * Both shas are commits on main, so drift-vs-main saw revision 783 and said
 * "behind by N" — indistinguishable from the ordinary, harmless case of an
 * estate whose roll simply has not happened yet. The fact that matters is not
 * expressible in that vocabulary: a roll RAN, SUCCEEDED, shipped 150d2937, and
 * five minutes later the estate was not running it. A validated fix was undone.
 * "Behind" is a lane that has not caught up; a REGRESSION is a lane that went
 * the wrong way, and only one of those is an incident.
 *
 * CONTRACT ON `rolledSha`: it must be what the last EFFECTIVE roll shipped — a
 * roll run can conclude SUCCESS having rolled NOTHING (every job skipped), and
 * such a run's tag would be a phantom to compare against. Filtering those out is
 * the caller's job, exactly as reconcile-policy.mjs does it: ask the JOBS, not
 * the run.
 *
 * THE VERDICTS:
 *   no roll to compare against  → UNKNOWN, warning. Nothing is asserted.
 *   estate sha unidentified     → UNKNOWN, warning.
 *   estate IS the rolled sha    → CURRENT, ok.
 *   differs, estate image built
 *     AFTER the roll finished   → AHEAD, ok. A newer writer moved it forward;
 *                                 that is the roll lane working, not a revert.
 *                                 This branch is the whole reason the ordering
 *                                 is checked at all — without it every merge
 *                                 that lands between a roll and this read would
 *                                 flash red.
 *   differs, estate image built
 *     BEFORE the roll finished  → REGRESSED, error. The estate is running an
 *                                 image OLDER than one a successful roll had
 *                                 already put on it.
 *   differs, ordering UNMEASURABLE → UNKNOWN, warning. Two shas that differ with
 *                                 no usable timestamps is a real disagreement
 *                                 whose DIRECTION is unknown; calling it green
 *                                 would hide a revert and calling it red would
 *                                 cry wolf on a normal roll, so it says what it
 *                                 actually knows. It is never 'ok'.
 */
export function classifyRollRegression(input: {
  /** The sha the estate's console is serving (build-marker.txt). */
  estateSha?: string | null;
  /** When THAT image was built (build-marker.txt stamp). */
  estateStamp?: string | null;
  /** What the last effective roll shipped — see the contract above. */
  rolledSha?: string | null;
  /** When that roll completed. */
  rolledAt?: string | null;
  rollWorkflow?: string | null;
  rollRunUrl?: string | null;
  error?: string | null;
}): RollRegression {
  const estateSha = input.estateSha || null;
  const rolledSha = input.rolledSha || null;
  const rolledAt = input.rolledAt || null;
  const base = {
    estateSha,
    rolledSha,
    rolledAt,
    rollWorkflow: input.rollWorkflow || null,
    rollRunUrl: input.rollRunUrl || null,
  };
  const shortEstate = estateSha ? estateSha.slice(0, 8) : null;
  const shortRolled = rolledSha ? rolledSha.slice(0, 8) : null;
  const lane = base.rollWorkflow ? `${base.rollWorkflow} ` : '';

  if (input.error || !rolledSha) {
    return {
      ...base,
      state: 'unknown',
      severity: 'warning',
      headline: 'Cannot tell whether a roll has been overwritten',
      detail: `The last effective ${lane}roll could not be identified — `
        + `${input.error || 'no successful roll that actually shipped an image was found'}. `
        + 'This is UNKNOWN, not "nothing was overwritten": with no roll to compare against, an estate that '
        + 'was reverted onto an older image looks exactly like one that was never rolled.',
    };
  }
  if (!estateSha) {
    return {
      ...base,
      state: 'unknown',
      severity: 'warning',
      headline: 'Cannot tell whether a roll has been overwritten',
      detail: `The last roll shipped ${shortRolled}, but this image carries no build fingerprint `
        + '(public/build-marker.txt has no sha), so what is actually running cannot be compared to it.',
    };
  }
  if (shaMatches(estateSha, rolledSha)) {
    return {
      ...base,
      state: 'current',
      severity: 'ok',
      headline: 'This estate is running what the last roll shipped',
      detail: `The last effective ${lane}roll shipped ${shortRolled}${rolledAt ? ` at ${rolledAt}` : ''}, `
        + 'and that is the image serving this page. Nothing has overwritten it.',
    };
  }

  const builtMs = input.estateStamp ? Date.parse(input.estateStamp) : NaN;
  const rolledMs = rolledAt ? Date.parse(rolledAt) : NaN;
  if (Number.isNaN(builtMs) || Number.isNaN(rolledMs)) {
    return {
      ...base,
      state: 'unknown',
      severity: 'warning',
      headline: `This estate is not running the sha the last roll shipped (${shortRolled})`,
      detail: `The last effective ${lane}roll shipped ${shortRolled}; this estate is serving ${shortEstate}. `
        + 'WHICH IS NEWER could not be established — '
        + `${Number.isNaN(builtMs) ? 'the running image carries no build timestamp' : 'the roll carried no completion timestamp'}. `
        + 'So this is either a newer image that landed after that roll (harmless) or an OLDER one that overwrote it '
        + '(#3676), and it is reported as unknown rather than guessed in either direction.',
    };
  }
  if (builtMs > rolledMs) {
    return {
      ...base,
      state: 'ahead',
      severity: 'ok',
      headline: 'This estate is running an image newer than the last roll',
      detail: `The last effective ${lane}roll shipped ${shortRolled} at ${rolledAt}; this estate is serving `
        + `${shortEstate}, built afterwards. A later writer moved it FORWARD — that is the deploy path working.`,
    };
  }
  return {
    ...base,
    state: 'regressed',
    severity: 'error',
    headline: `This estate was rolled BACKWARDS off ${shortRolled}`,
    detail: `A successful ${lane}roll put ${shortRolled} on this estate at ${rolledAt}, and it is now serving `
      + `${shortEstate} — an image built BEFORE that roll. Something overwrote a validated deploy with an older `
      + 'one, so every fix between those two images is inert here despite having merged, passed CI, and been '
      + 'rolled once already. This is the #3676 race, and it is not something waiting for a roll: the roll '
      + 'already happened and was undone.',
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
 *
 * A ROLL REGRESSION OUTRANKS EVERYTHING, including a broken lane and a behind
 * estate. Those two say work has not ARRIVED; a regression says work arrived,
 * was validated, and was then REMOVED — and unlike the others it will not fix
 * itself on the next successful run, because the last successful run is what
 * undid it. `rollRegression` is optional so a caller that cannot measure it
 * omits it entirely rather than passing a fabricated healthy verdict.
 */
export function summarizeDeployStatus(
  estate: EstateDrift,
  paths: DeployPathHealth[],
  meta: { generatedAt: string; repo: string },
  rollRegression?: RollRegression | null,
): DeployStatusReport {
  const severity = worstSeverity([
    estate.severity,
    ...paths.map((p) => p.severity),
    ...(rollRegression ? [rollRegression.severity] : []),
  ]);
  const broken = paths.filter((p) => p.severity === 'error');
  const degraded = paths.filter((p) => p.severity === 'warning');

  let headline: string;
  if (rollRegression?.severity === 'error') {
    headline = rollRegression.headline;
  } else if (estate.severity === 'error') {
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
  } else if (rollRegression?.severity === 'warning') {
    headline = rollRegression.headline;
  } else {
    headline = estate.headline;
  }

  const report: DeployStatusReport = {
    generatedAt: meta.generatedAt, repo: meta.repo, estate, paths, severity, headline,
  };
  if (rollRegression) report.rollRegression = rollRegression;
  return report;
}
