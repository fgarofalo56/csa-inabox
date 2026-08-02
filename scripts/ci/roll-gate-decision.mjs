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
 * Run the tests:  node --test scripts/ci/__tests__/roll-gate-decision.test.mjs
 */

/** The check-run name the roll gates on. Must match fiab-console-ci.yml. */
export const VITEST_CHECK_NAME = 'vitest (node 20)';

/**
 * Decide whether the rolled commit is vitest-verified.
 *
 * @param {object}   input
 * @param {Array}    input.checkRuns  Check-runs for the SHA. Each
 *   `{ name, status, conclusion, started_at }`. Pass them ALL — filtering by
 *   name happens here so the caller cannot filter with different semantics.
 * @param {Array}    input.ciRuns     Runs of fiab-console-ci.yml at this SHA,
 *   each `{ status, conclusion }`. This is what distinguishes "the check has
 *   not been created YET" from "the check is never coming".
 * @param {object?}  input.mainVerification  Only consulted when the check was
 *   CANCELLED: `{ compareStatus, behindBy, mainConclusion }`.
 * @returns {{decision: 'pass'|'refuse'|'wait', reason: string}}
 */
export function classifyVitestGate({ checkRuns = [], ciRuns = [], mainVerification = null } = {}) {
  const runs = (checkRuns || [])
    .filter((r) => r && r.name === VITEST_CHECK_NAME)
    .slice()
    // Latest attempt wins: a commit can have re-runs.
    .sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
  const latest = runs[runs.length - 1];

  if (!latest) {
    // No check-run. The ONLY safe readings are "not yet" or "refuse" — never
    // "verified". Which one depends on whether CI is still working on it.
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
    return { decision: 'pass', reason: `'${VITEST_CHECK_NAME}' concluded success` };
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
    const { compareStatus, behindBy, mainConclusion } = mainVerification;
    const isAncestor = compareStatus === 'ahead' || compareStatus === 'identical';
    if (isAncestor && Number(behindBy) === 0 && mainConclusion === 'success') {
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
