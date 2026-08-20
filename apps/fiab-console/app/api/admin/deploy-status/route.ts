/**
 * GET /api/admin/deploy-status — "is what is running actually what was merged?"
 *
 * WHY (operator, 2026-08-05): "nothing surfaces 'the estate is N commits behind'
 * or 'the last infra deploy failed'". Both were measurable; neither was
 * measured anywhere a human looks, so an operator watched unchanged gates for
 * two weeks while PRs merged green over a dead deploy path.
 *
 * Real data only (no-vaporware.md). Three real sources, no synthesis:
 *   1. THIS image's own build fingerprint — public/build-marker.txt, written by
 *      the Dockerfile from the LOOM_BUILD_SHA build-arg. Read locally; it cannot
 *      be wrong about which image is serving, because it IS the image.
 *   2. GitHub's compare API for that sha against the default branch → the exact
 *      number of merged commits that have never reached this estate.
 *   3. GitHub's Actions API for the lanes that put code INTO the estate → their
 *      enabled/disabled state and recent run conclusions.
 *
 * The verdicts themselves are PURE and unit-tested in lib/admin/deploy-status.ts;
 * this route is only the I/O.
 *
 * HONEST DEGRADE, NEVER A FALSE GREEN. The repo is public, so (2) and (3) work
 * unauthenticated — but a boundary with no egress to api.github.com (Azure
 * Government) or an exhausted unauthenticated rate limit will fail them. Every
 * such failure produces `state:'unknown'` carrying the exact reason, which the
 * banner renders as a warning. "We could not check" is never rendered as "it is
 * fine": this repo has shipped that defect three times.
 *
 * Privacy: identical to /api/version — no tenant identity is sent upstream. The
 * optional LOOM_FEEDBACK_GITHUB_TOKEN is used only to raise the rate limit.
 */
import { NextResponse } from 'next/server';
import { withCapability } from '@/lib/api/route-toolkit';
import { readBuildMarker, resolveCurrentVersion } from '@/lib/updates/current-version';
import { getOrComputeCached } from '@/lib/azure/query-result-cache';
import { detectLoomCloud } from '@/lib/azure/cloud-endpoints';
import type { LoomCloud } from '@/lib/azure/cloud-boundary';
import {
  classifyDeployPath,
  classifyEstateDrift,
  classifyRollRegression,
  deployPathsForCloud,
  rollCandidates,
  rollNeedsJobCheck,
  rollSourceForCloud,
  summarizeDeployStatus,
  worstSeverity,
  type CompareResult,
  type DeployPathDef,
  type DeployStatusReport,
  type RollRegression,
  type RollRunLite,
} from '@/lib/admin/deploy-status';
import {
  LOOM_ESTATES,
  estateIdForCloud,
  probeEstateEndpoint,
  summarizeFleet,
  type FleetEstate,
} from '@/lib/admin/estate-fleet';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const OWNER = process.env.LOOM_FEEDBACK_REPO_OWNER || 'fgarofalo56';
const NAME = process.env.LOOM_FEEDBACK_REPO_NAME || 'csa-inabox';
const REPO = `${OWNER}/${NAME}`;
const BRANCH = process.env.LOOM_UPSTREAM_BRANCH || 'main';
const API = 'https://api.github.com';

/**
 * Per-call bound. The whole point of this surface is that an operator sees the
 * answer; a page that hangs on an unreachable GitHub is a page nobody reads, so
 * a stalled fetch becomes an honest "unknown" rather than a spinner.
 */
const FETCH_TIMEOUT_MS = 6_000;

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (process.env.LOOM_FEEDBACK_GITHUB_TOKEN) {
    h.Authorization = `Bearer ${process.env.LOOM_FEEDBACK_GITHUB_TOKEN}`;
  }
  return h;
}

/** GET a GitHub JSON endpoint, or an { error } describing exactly what failed. */
async function ghJson<T>(pathname: string): Promise<{ data?: T; error?: string }> {
  try {
    const res = await fetch(`${API}${pathname}`, {
      headers: ghHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) {
      // 403 with a zero remaining budget is the unauthenticated rate limit, and
      // saying so is materially more useful than "HTTP 403" — it tells the
      // operator to set LOOM_FEEDBACK_GITHUB_TOKEN rather than chase a permission.
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (res.status === 403 && remaining === '0') {
        return { error: 'GitHub API rate limit exhausted for this egress IP (set LOOM_FEEDBACK_GITHUB_TOKEN to raise it)' };
      }
      return { error: `GitHub API returned HTTP ${res.status}` };
    }
    return { data: (await res.json()) as T };
  } catch (e: any) {
    const msg = e?.name === 'TimeoutError'
      ? `no response within ${FETCH_TIMEOUT_MS}ms`
      : String(e?.message || e).slice(0, 160);
    return { error: `could not reach api.github.com — ${msg}` };
  }
}

/**
 * Runs read per lane. A window, not the whole history — which is why
 * `historyComplete` below matters: deploy-fiab-commercial.yml currently has
 * 30+ consecutive failures, so a page of 30 contains no success at all, and
 * calling that "never succeeded" would be false (it last succeeded 2026-06-18).
 */
const RUNS_PER_PAGE = 30;

/**
 * A git object id: 7–40 hex, nothing else (CodeQL js/file-access-to-http #776).
 *
 * WHY THIS EXISTS. `build.sha` is FILE data — `readBuildMarker()` pulls it out
 * of public/build-marker.txt with `/sha=([^\s]+)/`, which accepts every
 * non-whitespace byte, and it was then interpolated straight into a request
 * path. `..` segments are collapsed by the URL parser BEFORE the request goes
 * out, so the marker chose which api.github.com endpoint this route called.
 *
 * Measured, not reasoned about — a marker of `sha=../../../../user/repos?x=`
 * produces (node, WHATWG URL):
 *
 *     pathname  /user/repos
 *     search    ?x=...main
 *
 * `GET /user/repos` is a real endpoint (401 unauthenticated, verified), so with
 * LOOM_FEEDBACK_GITHUB_TOKEN configured the request lands there authenticated.
 *
 * WHAT IT IS, STATED EXACTLY. A BLIND, credential-attached GET to an
 * attacker-chosen path on ONE host — SSRF confined to api.github.com. It is NOT
 * information disclosure: `DeployStatusReport` carries only `estate` + `paths`,
 * `EstateDrift` has no field holding the compare payload, and
 * `classifyEstateDrift` reads only `status`, `ahead_by`, `behind_by` and
 * `commits[].commit.*.date` — all `undefined` for a diverted endpoint, so
 * `behindSince` lands null. Verified against the real response shape: NO BYTE
 * of the diverted body reaches the client.
 *
 * TRUST BOUNDARY, so the severity is not overread: the only writer of
 * build-marker.txt is apps/fiab-console/Dockerfile:152, the only writers of
 * LOOM_BUILD_SHA are six CI build-args (no bicep sets it at runtime), and this
 * route sits behind `withCapability('admin.env-config','Admin')`. Anyone who
 * can set the marker already owns the image. This is defence in depth at the
 * image-build boundary, not a runtime-reachable hole.
 *
 * The marker is written from the LOOM_BUILD_SHA build-arg, and all six
 * producers pass either `github.sha` (40 hex) or `git rev-parse --short=8 HEAD`
 * (8 hex) — build-fiab-images-acr-tasks, console-bluegreen-roll,
 * full-app-deploy-commercial, gov-build-images, gov-console-roll,
 * publish-ghcr-images — so this validates what the value already is and cannot
 * reject a legitimate build. The unset case is the Dockerfile default
 * `unknown`, which readBuildMarker already drops before it reaches here.
 *
 * It is ALSO the honest-error fix, and that is the stronger half
 * (deploy-integrity R7). Without it a malformed marker produced either
 * `GitHub API returned HTTP 404` — asserting a GitHub-side cause for a purely
 * local defect — or, when the diverted endpoint answered 200, a verdict
 * computed from a body that is not a comparison at all: measured,
 * `state:'behind'` / `severity:'error'` / "This estate is **undefined** commits
 * behind main". Loud and incoherent, naming no real cause.
 */
const GIT_OBJECT_ID = /^[0-9a-f]{7,40}$/i;

/**
 * Compare one sha against the default branch. Shared by the local estate and by
 * every remote one, so a peer cloud's drift is computed exactly the way this
 * console's own is — the number on the Gov row means the same thing as the
 * number on the Commercial row.
 *
 * The sha is VALIDATED before it reaches the URL. For the local estate that is
 * defence in depth at the image-build boundary (see GIT_OBJECT_ID above); for a
 * REMOTE estate it is load-bearing, because the value is then genuinely
 * off-box input — another cloud's HTTP response deciding which api.github.com
 * path this console requests. parseBuildMarkerText already rejects a non-hex
 * value, so this is the second of two gates and neither is removable.
 *
 * `subject` names WHOSE marker is being described. Without it the peer rows
 * would report "this image's build marker is malformed" about a marker served
 * by a different console in a different cloud — an error asserting something it
 * did not establish, which is the precise thing deploy-integrity.md R7 forbids.
 */
async function compareSha(
  sha: string | null,
  subject = "this image's",
): Promise<{ data?: CompareResult; error?: string }> {
  if (!sha) return { error: `${subject} image carries no build sha` };
  if (!GIT_OBJECT_ID.test(sha)) {
    return {
      error:
        `${subject} build marker does not carry a git object id (expected 7–40 hex `
        + 'from the LOOM_BUILD_SHA build-arg), so it names no commit to compare — '
        + 'check /build-marker.txt on the running revision',
    };
  }
  return ghJson<CompareResult>(`/repos/${REPO}/compare/${sha}...${BRANCH}`);
}

/**
 * Every estate this product knows about, this one and its peers, each compared
 * against main. (#3730)
 *
 * WHY THE PEERS ARE READ OVER HTTP AND THE SELF IS NOT. This console's own
 * marker is a FILE in its own image — it cannot be wrong about which image is
 * serving, because it IS the image. A peer has to be asked, and asking can fail.
 * The two sources are labelled (`source`) rather than blended, so the surface
 * never implies it knows more about the other cloud than it does.
 *
 * A PEER THAT CANNOT BE REACHED IS THE EXPECTED CASE IN A SOVEREIGN BOUNDARY,
 * NOT AN ERROR TO HIDE. Azure Government has no general egress to the public
 * internet — it already cannot reach api.github.com, which is why the compare
 * degrades there too — so the Gov console will normally report Commercial as
 * unmeasured, and vice versa when Commercial's egress is restricted. Every such
 * case yields `reachable:false`, a named reason, and a drift state of `unknown`.
 * It is never rendered as current and never as behind (deploy-integrity.md R7).
 */
async function computeFleet(
  cloud: LoomCloud,
  selfBuild: { sha?: string; stamp?: string },
  selfDrift: ReturnType<typeof classifyEstateDrift>,
): Promise<FleetEstate[]> {
  const selfId = estateIdForCloud(cloud);

  return Promise.all(LOOM_ESTATES.map(async (endpoint): Promise<FleetEstate> => {
    const isSelf = endpoint.id === selfId;

    // ── this console: read the image, and REUSE the verdict already computed ──
    // Step 1 above has already compared this image's sha against the branch.
    // Recomputing it here would issue a second identical request to
    // api.github.com for no new information, against an UNAUTHENTICATED budget
    // of 60/hour per egress IP that this route is already close to (up to 9
    // upstream calls per miss). One estate, one compare.
    if (isSelf) {
      return {
        id: endpoint.id,
        name: endpoint.name,
        isSelf: true,
        source: 'this-image',
        markerUrl: endpoint.markerUrl,
        reachable: true,
        unreachableReason: null,
        version: resolveCurrentVersion(selfBuild),
        versionError: null,
        drift: selfDrift,
      };
    }

    // ── a peer cloud: ask it, and be honest when it does not answer ───────
    const { marker, version, versionError } = await probeEstateEndpoint(endpoint, FETCH_TIMEOUT_MS);
    // The marker error is passed straight into the classifier, which turns it
    // into state:'unknown' carrying that exact sentence. No inference is made
    // about the peer's freshness from a failure to read it.
    const compare = marker.error ? { error: marker.error } : await compareSha(marker.sha, `${endpoint.name}'s`);
    return {
      id: endpoint.id,
      name: endpoint.name,
      isSelf: false,
      source: 'remote-marker',
      markerUrl: endpoint.markerUrl,
      reachable: marker.error === null,
      unreachableReason: marker.error,
      version,
      versionError,
      drift: classifyEstateDrift({
        buildSha: marker.sha,
        buildStamp: marker.stamp,
        branch: BRANCH,
        repo: REPO,
        compare: compare.data ?? null,
        error: compare.error ?? null,
        graceMinutes: endpoint.graceMinutes,
      }),
    };
  }));
}

/**
 * How many roll runs we will pay an API call to inspect before giving up.
 *
 * Each one costs a call, and the answer is almost always the first. Three
 * covers a roll that skipped, a re-dispatch behind it that also skipped, and
 * one more — past that the honest answer is that we could not identify the last
 * effective roll, and NOT a guess drawn from the fourth-newest run.
 */
const ROLL_JOB_LOOKBACK = 3;

/**
 * Which roll actually shipped, and is this estate still running it? (#3676)
 *
 * THE HARD PART IS NOT THE COMPARISON, IT IS WHICH RUN TO COMPARE AGAINST. A
 * roll run can conclude SUCCESS having rolled NOTHING — measured 2026-08-17 on
 * run 32006479915, where the gate job succeeded, `Roll image + validate live
 * URL` was SKIPPED because the console image had not built, and the run reported
 * `success`. Taking that run's sha as "what the estate was last rolled to" would
 * convict a perfectly healthy estate of running the wrong image. So the JOB is
 * asked, never the run conclusion.
 *
 * Asking costs a call each, so it is asked only when the free evidence cannot
 * settle it — see `rollNeedsJobCheck`. On a healthy estate this function issues
 * ZERO upstream requests.
 *
 * Every failure path here degrades to `error`, which the classifier renders as
 * UNKNOWN + warning. None of them can produce a green verdict: "we could not
 * establish whether the roll was overwritten" is a different sentence from
 * "nothing overwrote it", and this repo has shipped the conflation of those two
 * three times (deploy-integrity.md R7).
 */
async function resolveRollRegression(
  def: DeployPathDef,
  fetched: { rows: RollRunLite[] | null; error: string | null } | undefined,
  build: { sha?: string; stamp?: string },
): Promise<RollRegression> {
  const common = { rollWorkflow: def.workflow, estateSha: build.sha ?? null, estateStamp: build.stamp ?? null };

  if (!fetched || fetched.error || !fetched.rows) {
    return classifyRollRegression({
      ...common,
      error: fetched?.error || `no run history was retrieved for ${def.workflow}`,
    });
  }

  const candidates = rollCandidates(def, fetched.rows);
  if (candidates.length === 0) {
    // Distinguish "the lane has never succeeded" from "it succeeded but named
    // something uncomparable" — they lead an operator to different places.
    const anySuccess = fetched.rows.some((r) => r.conclusion === 'success');
    return classifyRollRegression({
      ...common,
      error: anySuccess
        ? `${def.workflow} has succeeded recently but none of those runs names a commit sha `
          + '(a dispatch against a floating tag resolves its image only inside the run)'
        : `${def.workflow} has no successful run in the last ${RUNS_PER_PAGE}`,
    });
  }

  const settle = (c: (typeof candidates)[number], jobCompletedAt?: string | null) => classifyRollRegression({
    ...common,
    rolledSha: c.sha,
    // THE JOB'S COMPLETION, NOT THE RUN'S, WHEN WE HAVE PAID TO READ IT. The
    // run's `updated_at` is when the whole run finished, which for a roll lane
    // trails the `az containerapp update` that actually moved the estate — on
    // the 2026-08-19 incident night by 4m45s (update 07:10:44, run completed
    // 07:15:30). That stamp feeds `rolledAt`, which the classifier compares
    // against the running image's build stamp, so using the late one biases
    // toward a FALSE RED for any image built inside that window and shows the
    // operator a roll time up to five minutes after the fact.
    // scripts/ci/reconcile-policy.mjs (`selectLastConsoleRoll`) already orders
    // on the job's completion for this exact reason and records the numbers.
    rolledAt: jobCompletedAt || c.run.updated_at || c.run.created_at || null,
    rollRunUrl: c.run.html_url ?? null,
  });

  if (!rollNeedsJobCheck({ candidates, estateSha: build.sha ?? null, estateStamp: build.stamp ?? null })) {
    return settle(candidates[0]);
  }

  const looked = candidates.slice(0, ROLL_JOB_LOOKBACK);
  // COUNTED SEPARATELY, because the exit message below states a fact about
  // these runs and may only state one it established. A candidate carrying no
  // run id is never ASKED — there is no endpoint to ask — so it cannot be
  // reported as one that "did not run its roll job". That is precisely the R7
  // shape the `A failure to READ the jobs is not evidence` comment inside this
  // loop forbids, committed by the loop that hosts it.
  let checked = 0;
  let unchecked = 0;
  for (const c of looked) {
    if (!c.run.id) { unchecked += 1; continue; }
    checked += 1;
    const jobs = await ghJson<{ total_count?: number; jobs: { name?: string; conclusion?: string | null; completed_at?: string | null }[] }>(
      // per_page=100, GitHub's maximum, and the same bound the sibling
      // implementation of this identical question already uses
      // (.github/workflows/deploy-fiab-commercial.yml:1943). It was 50, which is
      // a page this route could actually run off the end of: the roll lane's
      // jobs are one gate + one roll today, but a matrix or a widened lane puts
      // the roll job on page 2, and a page-1 miss used to look exactly like
      // "this run did not roll" — settling on an older run and reporting
      // `current` from a page that was never read. `total_count` is now checked
      // as well, because a bound alone cannot prove the list was complete.
      `/repos/${REPO}/actions/runs/${c.run.id}/jobs?per_page=100`,
    );
    // A failure to READ the jobs is not evidence the roll did not happen. Fail
    // closed on the whole verdict rather than skipping to an older run, which
    // would silently name the wrong roll as the effective one.
    //
    // `Array.isArray`, not truthiness, and the difference is not academic: a 200
    // carrying an unexpected shape (the rate-limit body, an error object, the
    // array GET /user/repos returns) leaves `jobs.data` truthy and
    // `jobs.data.jobs` undefined, and `.find` on undefined THROWS. Nothing
    // upstream of here catches it — `computeDeployStatus` is called bare inside
    // the handler — so a malformed body from GitHub would 500 the route and take
    // the entire deploy panel off /admin/readiness, not merely this one verdict.
    // An unreadable job list is an UNKNOWN, which is precisely what this branch
    // already says.
    if (jobs.error || !Array.isArray(jobs.data?.jobs)) {
      return classifyRollRegression({
        ...common,
        error: `could not read the jobs of ${def.workflow} run ${c.run.id} — ${jobs.error || 'no job list returned'}`,
      });
    }
    const rollJob = jobs.data.jobs.find((j) => (j.name ?? '').trim() === def.roll!.jobName);
    if (rollJob?.conclusion === 'success') return settle(c, rollJob.completed_at ?? null);
    // NOT FOUND ON THIS PAGE IS NOT "NOT PRESENT". If GitHub says the run has
    // more jobs than it returned, the roll job's absence from what we read is
    // an unread page, not an answer — and falling through to an older candidate
    // on it would name the wrong roll as the effective one and report a green
    // verdict off a page nobody looked at. Fail closed on the whole verdict,
    // the same way an unreadable list does. A job that WAS found needs no such
    // guard: truncation cannot unfind it.
    const total = typeof jobs.data.total_count === 'number' ? jobs.data.total_count : null;
    if (!rollJob && total !== null && jobs.data.jobs.length < total) {
      return classifyRollRegression({
        ...common,
        error: `${def.workflow} run ${c.run.id} reports ${total} job(s) and only ${jobs.data.jobs.length} were `
          + `returned, so whether its "${def.roll!.jobName}" job ran was NOT established — reading a truncated `
          + 'page as "this run rolled nothing" would settle on an older roll from evidence that was never read',
      });
    }
  }

  // Say only what was ESTABLISHED. `checked` runs were asked and answered "no";
  // `unchecked` ones were never asked at all, and lumping them into the first
  // number would assert a fact about a run this code never queried.
  if (checked === 0) {
    return classifyRollRegression({
      ...common,
      error: `none of the last ${looked.length} successful ${def.workflow} run(s) could be CHECKED — the Actions `
        + 'listing carried no run id for any of them, so whether they rolled an image is unknown, not "they did not"',
    });
  }
  return classifyRollRegression({
    ...common,
    error: `none of the last ${checked} successful ${def.workflow} run(s) that could be checked actually ran `
      + `its "${def.roll!.jobName}" job`
      + (unchecked
        ? `, and a further ${unchecked} carried no run id so could not be checked at all`
        : '')
      + ', so the last roll that truly shipped an image is older than this window and was not identified',
  });
}

async function computeDeployStatus(): Promise<DeployStatusReport> {
  const build = readBuildMarker();
  const cloud = detectLoomCloud();

  // 1. How far behind the default branch is the image serving this request?
  //    The compare response's `commits[]` is load-bearing, not incidental: it
  //    carries the DATE of the oldest commit this estate is missing, which is
  //    what classifyEstateDrift tolerates a roll-in-flight against. There is no
  //    commit-count tolerance any more — being behind at all is the condition —
  //    so the only thing standing between "behind" and "error" is that date.
  //
  //    The sha is VALIDATED before it reaches the URL (see GIT_OBJECT_ID): it is
  //    file data, and a request path is not a place to interpolate file data
  //    unchecked. Each branch degrades to an honest reason, never a false green.
  const compare = await compareSha(build.sha ?? null);
  const estate = classifyEstateDrift({
    buildSha: build.sha ?? null,
    buildStamp: build.stamp ?? null,
    branch: BRANCH,
    repo: REPO,
    compare: compare.data ?? null,
    error: compare.error ?? null,
  });

  // 2. Are the lanes that put code INTO this estate actually working?
  //
  //    The raw rows are kept, not just the verdict: step 2b asks a DIFFERENT
  //    question of the same data ("what did the roll lane last ship?"), and
  //    re-fetching the identical page to ask it would spend a second call out of
  //    an unauthenticated budget of 60/hour for information already in hand.
  const defs = deployPathsForCloud(cloud);
  const rowsByWorkflow = new Map<string, { rows: RollRunLite[] | null; error: string | null }>();
  const paths = await Promise.all(defs.map(async (def) => {
    const [wf, runs] = await Promise.all([
      ghJson<{ state: string }>(`/repos/${REPO}/actions/workflows/${def.workflow}`),
      ghJson<{ workflow_runs: RollRunLite[] }>(
        `/repos/${REPO}/actions/workflows/${def.workflow}/runs?per_page=${RUNS_PER_PAGE}`,
      ),
    ]);
    const rows = runs.data?.workflow_runs ?? null;
    rowsByWorkflow.set(def.workflow, { rows, error: runs.error || wf.error || null });
    return classifyDeployPath({
      def,
      repo: REPO,
      runs: rows,
      // Fewer rows than we asked for ⇒ that IS the entire history, and only
      // then may the verdict use the word "never".
      historyComplete: rows !== null && rows.length < RUNS_PER_PAGE,
      workflowState: wf.data?.state ?? null,
      error: runs.error || wf.error || null,
    });
  }));

  // 2b. Has something OVERWRITTEN the last roll? (#3676)
  //
  //     A lane being green and the estate being current are different facts, and
  //     on 2026-08-19 they came apart: roll 32225337320 shipped 150d2937 at
  //     07:04:56Z and a scheduled reconcile put 83e7cab6 BACK at 07:10:19Z. Both
  //     shas were commits on main, so step 1 could only report the revert as
  //     ordinary lag — indistinguishable from an estate whose roll simply had not
  //     happened yet — and every lane in step 2 stayed green because the roll
  //     itself had succeeded. Nothing on this page said the word "backwards".
  const rollDef = rollSourceForCloud(cloud);
  const rollRegression = rollDef
    ? await resolveRollRegression(rollDef, rowsByWorkflow.get(rollDef.workflow), build)
    : undefined;

  // 3. And EVERY OTHER CLOUD (#3730). Steps 1 and 2 describe this console and
  //    the lanes that feed it; neither can see the sovereign estate, which is
  //    how Gov sat 251 commits behind with every Commercial signal green. The
  //    fleet is reported alongside — never folded into — the self verdict, so a
  //    healthy Commercial estate can never average away a stale Gov one.
  const estates = await computeFleet(cloud, build, estate);
  const fleet = summarizeFleet(estates);

  const base = summarizeDeployStatus(estate, paths, {
    generatedAt: new Date().toISOString(),
    repo: REPO,
  }, rollRegression);
  return {
    ...base,
    estates,
    // The banner headline names the worst fact across BOTH halves. A peer cloud
    // being 251 commits behind outranks "this estate is fine", because the
    // operator reading this page is responsible for both.
    severity: worstSeverity([base.severity, fleet.severity]),
    headline: fleet.severity === 'error' && base.severity !== 'error' ? fleet.headline : base.headline,
    fleetHeadline: fleet.headline,
  };
}

/**
 * ROUTE-TOOLKIT (R3). The session prologue is `withSession`, not a hand-rolled
 * `getSession()` — this route is net-new, so shipping it hand-rolled would have
 * ADDED to the ratchet baseline the toolkit migration exists to drain (and it
 * did: check-route-toolkit failed this file at 1 over a baseline of 0). The
 * capability gate runs INSIDE the wrapper, the same composition
 * /api/admin/gates/[id]/options uses: withSession answers "is there a session"
 * (401), enforceCapability answers "may this session do admin work" (403).
 * Byte-compatible 401 — `apiUnauthorized()` is `{ok:false,error:'unauthenticated'}`
 * at 401, exactly what `enforceCapability(null, …)` returned before.
 *
 * C22 (#3088) — now `withCapability`, which composes those two into ONE
 * non-discardable wrapper. Same 401, same 403 body (the wrapper returns
 * enforceCapability's response unchanged), same capability id and role. The
 * reason for the change is that the previous shape put the entire
 * authorization in a line the caller could delete —
 * `const capGate = await enforceCapability(…); if (capGate) return capGate;` —
 * and deleting it left every CI guard green. As an argument to the wrapper the
 * handler cannot run unless the gate allowed it.
 */
export const GET = withCapability('admin.env-config', 'Admin', async (_req, _ctx) => {
  // Upstream call budget, counted rather than guessed — unauthenticated GitHub
  // allows 60/hour per egress IP, so this number decides whether a refreshing
  // readiness page can rate-limit itself into a blank panel.
  //
  // On Commercial: 1 compare + 4 lanes x 2 (workflow state, run list) + 3 for
  // the one peer estate (its build-marker, its /api/version, its compare) = 12.
  // Four lanes because build-fiab-images-acr-tasks declares no `clouds` filter
  // and so resolves for every estate. The roll-regression step adds ZERO on a
  // healthy estate — it only reads a run's jobs when the newest roll's own sha
  // disagrees with what is live — and at most ROLL_JOB_LOOKBACK (3) more when
  // it does, for a worst case of 15.
  //
  // A 10-minute TTL keeps a busy readiness page well inside that budget while
  // still turning the banner red within one refresh of a lane breaking.
  // serve-stale means a transient GitHub blip shows a slightly-old verdict
  // rather than an "unknown" that would read as new information.
  const { value, meta } = await getOrComputeCached(
    'admin-deploy-status',
    'deploy-status-v1',
    computeDeployStatus,
    { ttlMs: 600_000, backend: 'result-cache', staleWhileRevalidate: true, serveStaleOnError: true },
  );

  return NextResponse.json({ ok: true, ...value, stale: meta.stale ?? false });
});
