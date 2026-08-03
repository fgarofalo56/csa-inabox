#!/usr/bin/env node
/**
 * Roll-gate decision logic — the two questions loom-roll-and-validate must
 * answer before it ships an image, expressed as PURE functions so they can be
 * tested without GitHub, Azure, or a live roll.
 *
 * WHY THIS EXISTS (#2819).
 *
 * Both gates in the roll had the same shape of bug: a NEGATIVE observation and
 * a FAILED observation were collapsed into the same branch, and the resulting
 * message stated the negative as fact.
 *
 *  1. THE VITEST GATE DEADLOCKED ON A RUNNING CHECK.
 *     The gate read `.conclusion` of the `vitest (node 20)` check-run once and
 *     refused when it was empty. But `.conclusion` is null while a check is
 *     QUEUED or IN_PROGRESS — so "still running" was reported as
 *         "No 'vitest (node 20)' check-run found … Re-run CI on this commit"
 *     which is both wrong and actively misleading (re-running CI cannot help;
 *     the check was already running and went on to pass).
 *
 *     This is not an edge case, it is a systematic race. The roll is triggered
 *     by `workflow_run` on build-fiab-images-acr-tasks, and the vitest job is
 *     SLOWER than the image build. Measured on the commits in #2819:
 *         5d51f961  build done 11:23:11Z | vitest 11:05:25Z → 11:33:32Z
 *                   roll read the gate at 11:23:30Z → conclusion=<none>
 *     The image build finished ~10 minutes before vitest did, so EVERY
 *     console-touching commit hit this. The gate then told the operator to fix
 *     something that was not broken.
 *
 *  2. THE IMAGE PROBE ASSERTED ABSENCE IT HAD NEVER OBSERVED.
 *     `:latest` resolution walked recent successful builds and probed ACR for
 *     each, with `az … >/dev/null 2>&1`. On failure it emitted
 *         "No recent main commit has a loom-console image in <acr>"
 *     Same collapse: not-in-registry and could-not-ask-the-registry produced
 *     one message, and that message named the registry.
 *
 *     Worse, in the observed failure the registry was never contacted at all.
 *     The candidate list comes from `gh api`, which had no GH_TOKEN in that
 *     step, so it failed; `2>/dev/null` swallowed the error, the loop iterated
 *     ZERO times, and the workflow declared the registry empty. The whole step
 *     took 164ms — there was no time for an ACR call. A single `az acr` call
 *     takes seconds.
 *
 * THE RULE BOTH FUNCTIONS ENCODE: three states, never two.
 *     verified      → proceed
 *     contradicted  → refuse, and say what failed
 *     unknown       → do NOT proceed and do NOT claim the negative; either wait
 *                     (if the answer is still coming) or refuse saying we could
 *                     not determine it.
 *
 * "Unknown" must never become a pass. A timeout waiting for a verdict is a
 * REFUSAL — this repo's dominant defect class is a control that reads green
 * while measuring nothing, and a gate that gave up and shipped would be a new
 * instance of exactly that.
 *
 * WHAT #2632 ADDED: A FOURTH STATE THE CONCLUSION CANNOT EXPRESS.
 *
 * The three states above are all read off `.conclusion`, which records what the
 * job REPORTED — never what it DID. fiab-console-ci's change detector could not
 * resolve `origin/<base>...HEAD` on a shallow fetch, swallowed the error, and
 * fell through to the branch that reports this REQUIRED check GREEN having
 * installed, built and tested nothing (#2631). The audit found 108 merged
 * console-touching PRs carrying such a `success`. This gate would have accepted
 * every one of them, and nothing in its own logs would have looked wrong.
 *
 * So the gate no longer trusts a conclusion on its own. A green is admissible
 * only if the run had a plausible wall time, OR if we POSITIVELY established
 * the commit leaves apps/fiab-console untouched (the documented path-filtered
 * green, which must keep passing or bicep-only commits become unrollable).
 * "I could not tell whether it touched the console" is not the latter.
 *
 * Run the tests:  node --test scripts/ci/__tests__/roll-gate-decision.test.mjs
 */

/** The check-run name the roll gates on. Must match fiab-console-ci.yml. */
export const VITEST_CHECK_NAME = 'vitest (node 20)';

/**
 * Wall-clock floor, in seconds, below which a `success` on a console-touching
 * commit is NOT evidence that the suite ran (#2632).
 *
 * WHY A DURATION AT ALL. Until #2631 this gate's soundness was entirely
 * inherited: it read `.conclusion` and trusted fiab-console-ci's change
 * detector to have decided honestly whether to run. When that detector could
 * not resolve `origin/<base>...HEAD` it fell through to a branch that reports
 * this REQUIRED check GREEN without installing, building, or testing anything —
 * so the gate would have accepted a commit nobody examined, and its own logs
 * would have shown nothing wrong. A conclusion cannot distinguish "passed" from
 * "never ran". Wall time can.
 *
 * WHY 120. Measured over every `vitest (node 20)` check-run on the 1311
 * console-touching main commits and 1297 merged console PRs between 2026-06-04
 * and 2026-08-02 (the #2632 audit; raw data in that issue):
 *     runs that ACTUALLY executed   294s … 1036s   (min across 950 runs)
 *     runs the detector SKIPPED       8s …   14s   (max across 251 runs)
 * The two populations are separated by a factor of 21 with nothing in between.
 * 120s sits ~8.6x above the slowest observed skip and ~2.4x below the fastest
 * observed real run, so it cannot be reached by either normal variation or a
 * faster runner.
 *
 * A LOWER floor would let a skip through; a HIGHER one starts risking a real
 * run on a future, smaller suite. If the suite ever legitimately drops under
 * two minutes, change this WITH the measurement that justifies it — do not
 * widen it to make a red gate green.
 */
export const VITEST_MIN_PLAUSIBLE_SECONDS = 120;

/**
 * Paths whose change obliges the vitest job to actually run. MUST stay in sync
 * with the change detector's grep in .github/workflows/fiab-console-ci.yml.
 */
export const CONSOLE_PATH_RE = /^apps\/fiab-console\/|^\.github\/workflows\/fiab-console-ci\.yml/;

/** GitHub caps `GET /repos/{o}/{r}/commits/{sha}` at 300 files, silently. */
export const COMMIT_FILES_CAP = 300;

/**
 * Project a raw check-run into the shape the classifier consumes.
 *
 * This exists so the field list lives in ONE place. The I/O shell used to map
 * `{name, status, conclusion, started_at}` by hand; adding a duration rule
 * without adding `completed_at` there would have made every duration
 * unmeasurable — i.e. would have silently disabled the very guard it was
 * carrying. A test pins this list.
 */
export function projectCheckRun(raw) {
  return {
    name: raw?.name,
    status: raw?.status,
    conclusion: raw?.conclusion,
    started_at: raw?.started_at,
    completed_at: raw?.completed_at,
  };
}

/**
 * Wall time of a completed check-run, in whole seconds, or null when it cannot
 * be measured (missing / unparsable / negative timestamps).
 */
export function checkRunSeconds(run) {
  const a = Date.parse(run?.started_at ?? '');
  const b = Date.parse(run?.completed_at ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const seconds = Math.round((b - a) / 1000);
  return seconds < 0 ? null : seconds;
}

/**
 * Did this commit touch the console? Derived from the commit's file list.
 *
 * Returns `null` — UNKNOWN, never `false` — when the list is absent or was
 * truncated at the API's 300-file cap, because "I did not see a console file in
 * a partial list" is not "there is no console file". A positive sighting is
 * conclusive regardless of truncation, so it is checked first.
 *
 * @param {{files?: Array<{filename?: string}>}|null} commit
 * @returns {boolean|null}
 */
export function consoleTouchedFromCommit(commit) {
  const files = Array.isArray(commit?.files) ? commit.files : null;
  if (!files) return null;
  if (files.some((f) => CONSOLE_PATH_RE.test(String(f?.filename ?? '')))) return true;
  if (files.length >= COMMIT_FILES_CAP) return null;
  return false;
}

/**
 * Is a GREEN verdict admissible as proof the suite ran? Returns null when it
 * is, or a refusal when it is not.
 *
 * The only way a fast green is admissible is when we have POSITIVELY
 * established that the console was untouched — that is fiab-console-ci's
 * documented path-filtered behaviour (it reports the check green rather than
 * skipping it, so bicep-only commits stay rollable). Not knowing is not the
 * same as knowing it was untouched, so unknown refuses.
 */
function inadmissibleGreen({ seconds, consoleTouched, where }) {
  if (seconds !== null && seconds >= VITEST_MIN_PLAUSIBLE_SECONDS) return null;
  if (consoleTouched === false) return null;
  const observed = seconds === null ? 'an unmeasurable wall time' : `${seconds}s`;
  const why =
    consoleTouched === true
      ? 'this commit DOES change apps/fiab-console, so the suite had to run'
      : 'it could not be established that this commit leaves apps/fiab-console untouched';
  return {
    decision: 'refuse',
    reason: `'${VITEST_CHECK_NAME}' ${where} concluded success in ${observed} — under the ${VITEST_MIN_PLAUSIBLE_SECONDS}s floor for a run that actually executed (real runs measured 294–1036s; a change-detector skip is 8–14s), and ${why}. A green check that never ran is not verification (#2631/#2632). Re-run fiab-console-ci for this commit and roll again.`,
  };
}

/**
 * Decide whether the rolled commit is vitest-verified.
 *
 * @param {object}   input
 * @param {Array}    input.checkRuns  Check-runs for the SHA. Each
 *   `{ name, status, conclusion, started_at, completed_at }` — use
 *   {@link projectCheckRun}. Pass them ALL; filtering by name happens here so
 *   the caller cannot filter with different semantics.
 * @param {Array}    input.ciRuns     Runs of fiab-console-ci.yml at this SHA,
 *   each `{ status, conclusion }`. This is what distinguishes "the check has
 *   not been created YET" from "the check is never coming".
 * @param {object?}  input.mainVerification  Only consulted when the check was
 *   CANCELLED: `{ compareStatus, behindBy, mainConclusion, mainSeconds }`.
 * @param {boolean} [input.checkRunsComplete=true]  False when the check-run
 *   list could not be read in full (paging incomplete / API error). An absent
 *   check in a TRUNCATED list is not evidence of absence.
 * @param {boolean?} [input.consoleTouched=null]  Whether the SHA changes
 *   apps/fiab-console. `null` means UNKNOWN — see {@link consoleTouchedFromCommit}.
 * @returns {{decision: 'pass'|'refuse'|'wait', reason: string}}
 */
export function classifyVitestGate({
  checkRuns = [],
  ciRuns = [],
  mainVerification = null,
  checkRunsComplete = true,
  consoleTouched = null,
} = {}) {
  const runs = (checkRuns || [])
    .filter((r) => r && r.name === VITEST_CHECK_NAME)
    .slice()
    // Latest attempt wins: a commit can have re-runs.
    .sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
  const latest = runs[runs.length - 1];

  if (!latest) {
    // No check-run in what we READ. Before reading anything into that, check
    // whether we actually read all of it.
    //
    // The check-runs endpoint pages at 100. A CSA Loom main commit was carrying
    // 39 check-runs a few commits ago and 67 by f322c14a — climbing. Once it
    // crosses 100, `?per_page=100` silently drops the tail and `vitest (node
    // 20)` can simply not be in the page we looked at. "I only saw part of the
    // list" is an UNKNOWN, and rendering it as "the check does not exist" would
    // be this bug all over again, in a form that only appears once the repo
    // gets busy enough — i.e. exactly when a wrong refusal costs the most.
    if (!checkRunsComplete) {
      return {
        decision: 'wait',
        reason: `could not read the complete check-run list for this SHA — '${VITEST_CHECK_NAME}' may be present but unread (paging). Treating as unknown, not absent.`,
      };
    }
    // The ONLY safe readings are "not yet" or "refuse" — never "verified".
    // Which one depends on whether CI is still working on it.
    const pending = (ciRuns || []).filter((r) => r && r.status !== 'completed');
    if (pending.length > 0) {
      return {
        decision: 'wait',
        reason: `console CI is ${pending[0].status} for this SHA but the '${VITEST_CHECK_NAME}' check-run has not appeared yet`,
      };
    }
    if ((ciRuns || []).length === 0) {
      // Could be "the push event has not created the run yet" or "it never
      // will". Both are unknown, so both WAIT and then time out into a refusal
      // — we never guess which one it was.
      return {
        decision: 'wait',
        reason: 'no console-CI workflow run observed for this SHA yet',
      };
    }
    return {
      decision: 'refuse',
      reason: `console CI completed for this SHA without producing a '${VITEST_CHECK_NAME}' check-run — the commit is not test-verified`,
    };
  }

  if (latest.status !== 'completed') {
    // THE #2819 DEADLOCK. conclusion is null here; that is "not finished",
    // which is emphatically not "not found".
    return {
      decision: 'wait',
      reason: `'${VITEST_CHECK_NAME}' is ${latest.status} for this SHA`,
    };
  }

  const concl = latest.conclusion;

  if (concl === 'success') {
    // A conclusion says the job REPORTED green. It does not say the job RAN.
    // #2632: 108 merged console PRs carried a `success` produced in 8–14s by a
    // change detector that skipped every heavy step.
    const seconds = checkRunSeconds(latest);
    const bad = inadmissibleGreen({ seconds, consoleTouched, where: 'for this SHA' });
    if (bad) return bad;
    return {
      decision: 'pass',
      reason: `'${VITEST_CHECK_NAME}' concluded success${
        seconds === null ? '' : ` in ${seconds}s`
      }${consoleTouched === false ? ' (console untouched — path-filtered green)' : ''}`,
    };
  }

  if (concl === 'cancelled') {
    // A push-run can be auto-cancelled when a newer push supersedes it, even
    // though the content was fully tested. Accept ONLY if the commit is an
    // ancestor of a main whose own vitest passed.
    if (!mainVerification) {
      return {
        decision: 'refuse',
        reason: `'${VITEST_CHECK_NAME}' was cancelled and no main-branch verification was available`,
      };
    }
    const { compareStatus, behindBy, mainConclusion, mainSeconds = null } = mainVerification;
    const isAncestor = compareStatus === 'ahead' || compareStatus === 'identical';
    if (isAncestor && Number(behindBy) === 0 && mainConclusion === 'success') {
      // Same admissibility test on the substitute evidence. Borrowing main's
      // verdict is only sound if main's run actually executed: if main's own
      // tip commit was path-filtered, its 10s green verified nothing, least of
      // all a console-touching ancestor.
      const bad = inadmissibleGreen({
        seconds: mainSeconds,
        consoleTouched,
        where: "on main (borrowed as this commit's verification)",
      });
      if (bad) return bad;
      return {
        decision: 'pass',
        reason: `'${VITEST_CHECK_NAME}' was superseded (cancelled), but the commit is an ancestor of main whose vitest passed`,
      };
    }
    return {
      decision: 'refuse',
      reason: `'${VITEST_CHECK_NAME}' was cancelled and could not be verified via main (status=${compareStatus} behind=${behindBy} main_vitest=${mainConclusion})`,
    };
  }

  if (concl === 'skipped') {
    // fiab-console-ci does NOT skip this job — its change detector reports the
    // check GREEN when the console is untouched, precisely so path-filtered
    // commits stay rollable. So a genuine 'skipped' means someone changed that
    // contract, and treating it as a pass would silently turn this gate into a
    // no-op for every commit thereafter. Refuse loudly instead.
    return {
      decision: 'refuse',
      reason: `'${VITEST_CHECK_NAME}' concluded 'skipped' — the job did not run, so this commit is unverified. fiab-console-ci.yml is expected to report this check green (not skip it) when the console is untouched; if that changed, this gate must be revisited.`,
    };
  }

  return {
    decision: 'refuse',
    reason: `'${VITEST_CHECK_NAME}' concluded '${concl ?? 'null'}' (not success)`,
  };
}

/**
 * Classify a failed `az acr repository show` by its stderr.
 *
 * The distinction that matters: did the registry ANSWER "no such tag", or did
 * we never get an answer? Only the first justifies saying the image is absent.
 *
 * Defaults to 'unreachable' on anything unrecognised — an unclassified error is
 * by definition not a confirmed absence.
 *
 * @param {string} stderr
 * @returns {'absent'|'unreachable'}
 */
export function classifyAcrProbeError(stderr) {
  const s = String(stderr || '').toLowerCase();

  // The registry answered, and the answer was "not here".
  //
  // These strings are COPIED FROM REAL `az acr repository show` output, not
  // guessed. The first draft of this list had 'the tag does not exist', and az
  // actually emits "the specified tag does not exist" — so a genuine
  // not-found would have been misclassified as unreachable. (Fail-closed, so
  // nothing would have shipped wrongly, but the honest "registry says there is
  // no image" message would have been unreachable in practice.) Observed
  // 2026-08-02 against acrloomk6mvh5sm6z7do:
  //   missing tag  → "ERROR: … Error: the specified tag does not exist. Correlation ID: …"
  //   missing repo → same message
  const ABSENT = [
    'resourcenotfound',
    'manifest unknown',
    'tag does not exist',
    'not found in the registry',
    'repositorynotfound',
    'tagnotfound',
  ];
  // We never got a usable answer: network, firewall, auth, throttling.
  // Observed: a registry that does not resolve gives
  //   "ERROR: Could not connect to the registry login server '…'."
  const UNREACHABLE = [
    'denied',
    'unauthorized',
    'forbidden',
    'authentication',
    'credential',
    'timed out',
    'timeout',
    'connection',
    'could not connect',
    'temporary failure in name resolution',
    'not allowed access',
    'publicnetworkaccess',
    'too many requests',
    'throttl',
  ];

  // Unreachable wins ties: an auth failure that also happens to contain the
  // word "not found" is still an unanswered question.
  if (UNREACHABLE.some((p) => s.includes(p))) return 'unreachable';
  if (ABSENT.some((p) => s.includes(p))) return 'absent';
  return 'unreachable';
}

/**
 * Pick the newest candidate commit that actually has an image, given the
 * observations made about each.
 *
 * @param {object} input
 * @param {Array}  input.candidates  NEWEST FIRST. Each:
 *   `{ sha, acr: 'found'|'absent'|'unreachable', buildJob?: 'success'|'failure'|'absent'|'unknown' }`
 *   - `acr`      what the registry said (or that we could not ask it)
 *   - `buildJob` whether the app's own build job in that run concluded success.
 *                Weaker evidence — used ONLY when the registry is unreachable.
 * @param {boolean} [input.listComplete=true]  False when the candidate list
 *   itself could not be retrieved (e.g. the GitHub API call failed). An empty
 *   list is then UNKNOWN, not "nothing is built".
 * @returns {{decision: 'resolved'|'refuse', sha?: string, evidence?: 'acr'|'build-job', reason: string}}
 */
export function resolveImageTag({ candidates = [], listComplete = true } = {}) {
  if (!listComplete) {
    // The exact #2819 failure: the candidate list came back empty because the
    // API call failed, and the workflow reported that as an empty REGISTRY.
    return {
      decision: 'refuse',
      reason:
        'could not retrieve the list of successful image builds — this says nothing about what is in the registry. Pass an explicit SHA as image_tag.',
    };
  }

  if (candidates.length === 0) {
    return {
      decision: 'refuse',
      reason: 'no successful image-build runs found on main to consider',
    };
  }

  // Pass 1 — the registry itself confirmed the image. Authoritative.
  const confirmed = candidates.find((c) => c.acr === 'found');
  if (confirmed) {
    return {
      decision: 'resolved',
      sha: confirmed.sha,
      evidence: 'acr',
      reason: 'image confirmed present in the registry',
    };
  }

  const unreachable = candidates.filter((c) => c.acr === 'unreachable');

  // Pass 2 — the registry could not be asked. Fall back to the build's own job
  // list, which is what a human uses to answer this question. Weaker, and
  // labelled as such; the downstream cosign/digest step re-checks with a
  // firewall lease and fails the roll if the tag really is missing.
  if (unreachable.length > 0) {
    const built = candidates.find((c) => c.acr === 'unreachable' && c.buildJob === 'success');
    if (built) {
      return {
        decision: 'resolved',
        sha: built.sha,
        evidence: 'build-job',
        reason: `registry unreachable (${unreachable.length}/${candidates.length} probes); resolved from the build run's own job list, which reported the image built`,
      };
    }
    return {
      decision: 'refuse',
      reason: `registry unreachable (${unreachable.length}/${candidates.length} probes) and no build run reported building the image — cannot determine whether an image exists. This is UNKNOWN, not absent. Pass an explicit SHA as image_tag, or check the ACR firewall lease (scripts/csa-loom/acr-firewall-lease.sh).`,
    };
  }

  // Every probe got a real answer, and every answer was "not here".
  return {
    decision: 'refuse',
    reason: `the registry was reachable and reported no image for any of the ${candidates.length} most recent successful builds`,
  };
}
