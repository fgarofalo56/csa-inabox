#!/usr/bin/env node
/**
 * ensure-aas-server-settled.mjs — bring the estate's Azure Analysis Services
 * server out of `Paused` BEFORE the ARM apply, and report enough for the caller
 * to put it back afterwards.
 *
 * ── THE DEFECT THIS REMOVES (#3948) ─────────────────────────────────────────
 *
 * `deploy-fiab-commercial` run 32874774243 failed at "Provision (idempotent)"
 * with three ARM leaves, the AAS one verbatim:
 *
 *   BadRequest on 'aasloomk6mvh5sm6z7do':
 *   The server 'aasloomk6mvh5sm6z7do' is currently being updated. Please try again later.
 *
 * #4034 taught the taxonomy to classify that as `transient.resource-mid-update`,
 * so the deploy correctly retried it — four times, with ~50s of backoff each.
 * Every attempt failed the same way, because an AAS control-plane operation on a
 * suspended S1 does not finish inside fifty seconds. The retries were not
 * useless, they were simply aimed at the wrong thing: the server was not
 * momentarily busy, it was PAUSED, and each apply nudged it into a transitional
 * state that the next apply then collided with.
 *
 * #4034's own remediation text says exactly this, and names this file's shape:
 *
 *   "For Microsoft.AnalysisServices/servers specifically, a server left
 *    Paused/Suspending by the estate PAUSE tier is the first thing to check …
 *    the durable fix is a preflight that settles the server before the apply, in
 *    the shape of scripts/ci/ensure-adx-cluster-running.mjs, rather than a
 *    longer retry budget here."
 *
 * ── WHY RESUME RATHER THAN SKIP THE ADMIN WRITE ─────────────────────────────
 *
 * `admin-plane` declares the Console UAMI as an AAS administrator. Skipping that
 * write when the server is paused would turn a loud failure into a silent one:
 * the deploy would go green with `properties.asAdministrators` still null, and
 * every semantic-model surface would later fail with a permission error nobody
 * could trace back to this deploy. `auto-bind-by-default.md` §5 and
 * `deploy-integrity.md` R6 both say the opposite — where the platform CAN
 * perform the remediation, it must. This is the same argument
 * `ensure-adx-cluster-running.mjs` makes for starting a stopped Kusto cluster,
 * and the same first-party action the deploy identity already holds
 * (`Microsoft.AnalysisServices/servers/resume/action`).
 *
 * MEASURED, and the reason this is not hypothetical: `asAdministrators` on
 * aasloomk6mvh5sm6z7do is `null` right now. The delta that adds it landed on
 * main 2026-08-23T16:52Z, after the last successful scheduled deploy, and every
 * attempt since has died on this leaf. The write has never once completed.
 *
 * ── WHY IT DOES NOT LEAVE THE SERVER RUNNING ────────────────────────────────
 *
 * ADX can afford to be left started because `enableAutoStop: true` makes Azure
 * stop it again when it goes idle. **Analysis Services has no auto-pause.** A
 * resume that is never undone bills an S1 indefinitely and silently defeats the
 * estate PAUSE tier, so this script emits `aas_resumed` and the workflow
 * re-suspends afterwards in an `if: always()` step gated on that output. The
 * cost is bounded to the deploy window rather than being open-ended, and the
 * pause tier's intent survives.
 *
 * WHAT THIS DOES *NOT* CLAIM. It does not assert WHY the server was paused. The
 * estate pause-actuator suspends exactly this resource type, which is a
 * candidate explanation and not an established one — this script observes only
 * the STATE, never a suspend event (deploy-integrity.md R7). It also does not
 * claim the admin write will now succeed: it establishes only that the server is
 * no longer paused or transitional. If the write still fails, that is a
 * different defect and the deploy will say so.
 *
 * ── ROUND 2 (#4074 review): FOUR DEFECTS THE FIRST DRAFT SHIPPED ────────────
 *
 * R1. `Pausing` WAS NOT IN THE TABLE. The Analysis Services `State` enum has
 *     exactly twelve values — Deleting, Succeeded, Failed, Paused, Suspended,
 *     Provisioning, Updating, Suspending, Pausing, Resuming, Preparing, Scaling
 *     (learn.microsoft.com/javascript/api/@azure/arm-analysisservices/knownstate).
 *     The first draft covered eleven. `Pausing` — a server mid-suspend, which is
 *     PRECISELY what the estate PAUSE tier produces and therefore the single
 *     most likely state for this preflight to arrive on — fell through to
 *     `default: refuse` and would have failed the deploy on a completely
 *     ordinary, self-resolving condition. It is a transitional state, so it is
 *     `wait`, and the loop below then resumes the `Paused` it settles into.
 *
 * R2. THE `wait` ARM WAS A DEAD END. The old poll only ever terminated on
 *     `Succeeded`, a refuse-class state, or budget exhaustion. So a server found
 *     `Suspending`/`Pausing` was classified `wait`, polled while it settled to
 *     `Paused` — a state whose classification is `resume` and therefore neither
 *     success nor refusal — and then spun for the entire 1800s budget before
 *     failing with a timeout. It never issued the one verb that would have
 *     fixed it, and the deploy died reporting a budget where the truth was "I
 *     watched it become fixable and did nothing" (R7). The poll is now a SETTLE
 *     loop: every reading is re-classified, and a reading that becomes resumable
 *     IS resumed. `planSettleStep` is that decision, extracted pure.
 *
 *     The resume count is BOUNDED (`MAX_RESUME_ATTEMPTS`), and — after a review
 *     round found a bare count is not a safe bound here — TIME-bounded first
 *     (`RESUME_GRACE_SECONDS`). A server that returns to `Paused` after we
 *     resumed it may be being suspended by something else, OR may simply not
 *     have finished resuming; the script cannot tell those apart, so it waits
 *     before re-issuing and its refusal names both. deploy-integrity.md R6: "a
 *     retry that cannot fail is forbidden."
 *
 * R3. NO RETRY ON THE `az` CALLS. Every call was single-shot, in a script whose
 *     entire job is settling a resource — so a GatewayTimeout on the state read
 *     failed the whole deploy. That is the #3786 defect verbatim, already paid
 *     for once on the ADX sibling. Reads and resumes now go through
 *     `azWithRetry`, which retries ONLY what `_az-failure-class.mjs` classifies
 *     as transient, with bounded backoff, and FAILS CLOSED on exhaustion. Every
 *     remediation is derived from the classified cause, never assumed.
 *
 * R4. `shouldResuspend` WAS DEAD CODE — exported, unit-tested, and called by
 *     nothing, while `main()` computed the same answer inline as
 *     `String(resumedByUs)`. An exported, tested function that nothing calls is
 *     a control that measures nothing: its tests could stay green through any
 *     change to the behaviour they claim to guard. It is now the ONLY producer
 *     of the `aas_resumed` output the workflow's re-suspend step gates on, so a
 *     mutation to it moves a real verdict.
 *
 * Also fixed here: `--timeout-seconds` was unvalidated, and `elapsed >= NaN` is
 * ALWAYS false — a non-numeric budget made the poll unbounded, terminated only
 * by the job's `timeout-minutes`. A budget that cannot be exceeded is not a
 * budget. Same defect the ADX sibling closed; this file had inherited the shape
 * without the fix.
 *
 * ── FAILURE MODES ───────────────────────────────────────────────────────────
 *
 *   none    already Succeeded → no mutation at all.
 *   resume  Paused/Suspended → POST .../resume, then poll until settled.
 *   wait    Provisioning/Updating/Scaling/Resuming/Suspending/Pausing/Preparing
 *           → someone else is mid-flight; poll rather than issuing a second
 *           verb, and resume it once it settles somewhere resumable.
 *   refuse  Failed/Deleting/Deleted, an unknown state string, an unreadable
 *           control plane, a resume Azure rejected, more than
 *           MAX_RESUME_ATTEMPTS resumes, or a settle that did not finish inside
 *           the budget. Never "assume it came up".
 *
 * Usage:
 *   node scripts/ci/ensure-aas-server-settled.mjs \
 *     --subscription <sub-id> --rg rg-csa-loom-admin-<loc> [--timeout-seconds 1800]
 *
 * Outputs (to $GITHUB_OUTPUT when set, and always to stdout as NAME=VALUE):
 *   aas_server        the server name it acted on, or empty when none exists
 *   aas_prior_state   the state observed BEFORE any mutation
 *   aas_resumed       'true' only when THIS run issued a resume Azure ACCEPTED
 *
 * Tests: node --test scripts/ci/__tests__/aas-preflight.test.mjs
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { classifyAzFailure, isRetryable } from './_az-failure-class.mjs';

/** The api-version every AAS caller in this repo already uses. */
export const AAS_API_VERSION = '2017-08-01';
export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const POLL_INTERVAL_SECONDS = 30;

/**
 * How many times this run will resume the SAME server before giving up.
 *
 * More than one because the honest sequence `Pausing → Paused → resume` can be
 * preceded by a resume we issued against a server that was already on its way
 * down, and one retry absorbs that race. Bounded because a server that keeps
 * returning to `Paused` is being suspended by something ELSE, and duelling with
 * it for the whole budget produces a timeout instead of the real story.
 *
 * READ THIS WITH `RESUME_GRACE_SECONDS`. A count alone is NOT a safe bound
 * here — see the note on that constant for why a bare count made the effective
 * ceiling 60 seconds.
 */
export const MAX_RESUME_ATTEMPTS = 2;

/**
 * How long an ACCEPTED resume gets to take effect before a second one is even
 * considered.
 *
 * THE DEFECT THIS CLOSES (#4074 review, round 2). `az resource invoke-action
 * --action resume` returns on the RP's 202: it starts a long-running operation
 * and does not wait for it. Nothing in this script waits for the LRO either —
 * it observes `properties.state`. So for some period after an accepted resume,
 * a reading of `Paused` is EXPECTED, not a second problem.
 *
 * With a bare count bound and a 30s poll, `MAX_RESUME_ATTEMPTS = 2` meant the
 * `Paused` branch tolerated exactly two readings before hard-failing the
 * deploy. Measured: it gave up at t=60s against a stated 1800s budget — on the
 * single likeliest path this preflight takes, and directly contradicting this
 * file's own premise that "an AAS control-plane operation on a suspended S1
 * does not finish inside fifty seconds". The 1800s budget was unreachable on
 * that branch.
 *
 * Worse, it said so DISHONESTLY: the message asserted "something OTHER than
 * this step is suspending it", when at t=60s the likelier explanation is the
 * one it did not offer — the accepted resume has not landed yet. That is R7,
 * and it is the `csa_loom_a_bare_substring_signal_misclassifies_and_blocks`
 * shape: an operator sent to inspect the pause actuator when the answer was
 * "wait longer".
 *
 * So the bound is now TIME-based first and count-based second, and the
 * exhaustion message names both possibilities without choosing between them.
 * 300s is ten polls — comfortably longer than a normal AAS resume, and two
 * grace windows plus the refusal still land at ~600s inside the 1800s budget.
 */
export const RESUME_GRACE_SECONDS = 300;

/**
 * Backoff schedule for a TRANSIENT az failure. Length defines the retry count:
 * 1 initial attempt + one retry per entry, so 4 attempts over ~50s of waiting.
 * A schedule expressed as a finite array cannot become unbounded by arithmetic
 * the way a `while (Date.now() < deadline)` loop can. Matches the ADX sibling.
 */
export const TRANSIENT_BACKOFF_SECONDS = [5, 15, 30];

/**
 * PURE. What to do about a `properties.state` reading.
 *
 * The state table is the full Analysis Services `State` enum, and it is
 * COMPLETE on purpose — every one of the twelve documented values is named, so
 * the `default` arm can only ever be reached by a value Azure did not document
 * when this was written. That is what makes refusing there defensible rather
 * than merely strict.
 *
 * The `refuse` branch is the point of the function: an unrecognised state is
 * UNKNOWN, and an unknown state is not "probably fine". Adding a state to this
 * table is a deliberate act, not a convenience.
 *
 * @param {string} state `properties.state` from the Analysis Services RP.
 * @returns {{action: 'none'|'resume'|'wait'|'refuse', reason: string}}
 */
export function classifyServerState(state) {
  switch (String(state ?? '')) {
    case 'Succeeded':
      return { action: 'none', reason: 'the server is Succeeded and not transitional; the deploy can write its administrators.' };
    case 'Paused':
    case 'Suspended':
      return {
        action: 'resume',
        reason:
          `the server is ${state}, and an asAdministrators write cannot be applied to a suspended server — ` +
          'ARM refuses it as "currently being updated" and every retry collides with the same window.',
      };
    case 'Provisioning':
    case 'Updating':
    case 'Scaling':
    case 'Resuming':
    case 'Suspending':
    // `Pausing` is the state the estate PAUSE tier puts this server INTO, so it
    // is the likeliest one for this preflight to arrive on. Omitting it (the
    // first draft did) sent the single most ordinary condition to `refuse`.
    case 'Pausing':
    case 'Preparing':
      return { action: 'wait', reason: `the server is ${state} — a control-plane operation is already in flight.` };
    case 'Failed':
    case 'Deleting':
    case 'Deleted':
      return {
        action: 'refuse',
        reason:
          `the server reports state '${state}', which no resume can resolve. The deploy would fail its ` +
          'administrator write regardless, so it stops here with the real reason instead.',
      };
    default:
      return {
        action: 'refuse',
        reason:
          `the server reports the unrecognised state '${state || '<empty>'}'. Whether a resume would help is ` +
          'UNKNOWN, and an unknown state is not an assumption this step is willing to make.',
      };
  }
}

/**
 * PURE. Real elapsed seconds between two timestamps.
 *
 * Clamped at 0 so the number this hands to `planSettleStep` — and therefore the
 * number QUOTED IN THE ERROR — is never negative. That is all the clamp buys,
 * and the earlier comment here overclaimed: clamping to 0 does NOT make the
 * budget reachable under a backwards clock, because `-5 >= 600` and `0 >= 600`
 * are equally false. A clock that decreases on every call would defeat the
 * budget either way. The bound that survives that is the iteration cap in the
 * settle loop (`maxPolls`), not this function.
 *
 * @param {number} startedAtMs Date.now() when the settle loop began
 * @param {number} nowMs       Date.now() at the moment of the check
 * @returns {number} whole seconds, never negative
 */
export function elapsedSecondsSince(startedAtMs, nowMs) {
  const deltaMs = Number(nowMs) - Number(startedAtMs);
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return 0;
  return Math.floor(deltaMs / 1000);
}

/**
 * PURE. What should the settle loop DO about this reading?
 *
 * This replaces the first draft's `evaluatePoll`, which could only answer
 * "keep going / stop". That vocabulary is what made the `wait` arm a dead end:
 * a server observed settling from `Suspending` into `Paused` had become
 * FIXABLE, and a function that can only say "not done yet" cannot say so. The
 * verb set is therefore settled / resume / wait / fail.
 *
 * ORDER IS LOAD-BEARING:
 *   1. settled  — the only successful exit.
 *   2. fail on a refuse-class state — reported NOW with the real reason, never
 *      deferred to the budget. A `Failed` server reported as a timeout is a
 *      false cause (R7), and the budget would hide it for 30 minutes first.
 *   3. resume   — but only after the GRACE window has let the previous accepted
 *      resume take effect, and only while attempts remain. Exhaustion is its
 *      own, more specific failure than "the budget ran out", so it is checked
 *      BEFORE the budget; the fixture at `elapsedSeconds === budgetSeconds`
 *      pins that ordering.
 *   4. wait     — subject to the budget, which therefore always binds.
 *
 * @param {{state: string|null, elapsedSeconds: number, budgetSeconds: number,
 *          resumesIssued?: number, maxResumes?: number,
 *          secondsSinceLastResume?: number, resumeGraceSeconds?: number}} p
 * @returns {{action: 'settled'|'resume'|'wait'|'fail', reason: string}}
 */
export function planSettleStep({
  state,
  elapsedSeconds,
  budgetSeconds,
  resumesIssued = 0,
  maxResumes = MAX_RESUME_ATTEMPTS,
  secondsSinceLastResume = Number.POSITIVE_INFINITY,
  resumeGraceSeconds = RESUME_GRACE_SECONDS,
}) {
  const verdict = classifyServerState(state);

  if (verdict.action === 'none') {
    return { action: 'settled', reason: `settled to '${state}' after ${elapsedSeconds}s.` };
  }

  if (verdict.action === 'refuse') {
    return { action: 'fail', reason: verdict.reason };
  }

  const outOfBudget = {
    action: 'fail',
    reason:
      `still '${state}' after ${elapsedSeconds}s (budget ${budgetSeconds}s). The outcome is UNCONFIRMED, so ` +
      'this reports failure rather than letting the deploy attempt an administrator write on a server that ' +
      'may still be suspended.',
  };

  // Set when the state IS resumable but a second resume would be premature —
  // the loop then waits instead, and the budget below still binds.
  let graceHold = null;

  if (verdict.action === 'resume') {
    if (resumesIssued > 0 && secondsSinceLastResume < resumeGraceSeconds) {
      graceHold =
        `state='${state}', ${elapsedSeconds}s elapsed — ${secondsSinceLastResume}s since the last ACCEPTED ` +
        `resume, inside the ${resumeGraceSeconds}s grace. An accepted resume is a 202 on a long-running ` +
        'operation, so a state that has not moved yet is expected, not a second problem.';
    } else if (resumesIssued >= maxResumes) {
      return {
        action: 'fail',
        reason:
          `the state has not left '${state}' in ${elapsedSeconds}s, after ${resumesIssued} ACCEPTED resume(s), ` +
          `the last of them ${secondsSinceLastResume}s ago. EITHER the resume has not taken effect OR ` +
          'something else is re-suspending it — this step observed only the state and never a suspend event, ' +
          'so it does NOT choose between those. Check the server (Analysis Services -> the server -> ' +
          'Overview) and the estate pause actuator.',
      };
    } else if (elapsedSeconds >= budgetSeconds) {
      return outOfBudget;
    } else {
      return { action: 'resume', reason: verdict.reason };
    }
  }

  if (elapsedSeconds >= budgetSeconds) return outOfBudget;
  return { action: 'wait', reason: graceHold ?? `state='${state}', ${elapsedSeconds}s elapsed.` };
}

/**
 * PURE. Should the caller re-suspend afterwards?
 *
 * Only when THIS run resumed it. A server that was already running when we
 * arrived belongs to whoever started it, and suspending it would be this script
 * reaching outside what it changed.
 *
 * WIRED, not decorative (#4074 review R4): the boolean this returns IS the
 * `aas_resumed` output, and `deploy-fiab-commercial.yml` gates its `always()`
 * re-suspend step on `steps.aas_preflight.outputs.aas_resumed == 'true'`. There
 * is no second inline copy of this decision to drift away from it.
 *
 * @param {{priorState: string, resumedByUs: boolean}} p
 * @returns {{resuspend: boolean, reason: string}}
 */
export function shouldResuspend({ priorState, resumedByUs }) {
  if (!resumedByUs) {
    return {
      resuspend: false,
      reason: `this run did not resume the server (prior state '${priorState}'), so it does not own putting it back.`,
    };
  }
  return {
    resuspend: true,
    reason:
      `this run resumed the server from '${priorState}'. Analysis Services has no auto-pause, so leaving it ` +
      'running would bill an S1 indefinitely and silently defeat the estate PAUSE tier.',
  };
}

/**
 * PURE. How long to wait before attempt N+1, or null when the budget is spent.
 *
 * Exported so the exhaustion boundary is unit-testable without burning 50s of
 * real sleep, and so a future edit that makes the schedule infinite fails a test
 * rather than hanging a deploy.
 *
 * @param {number} attemptIndex 0-based index of the attempt that just FAILED
 * @returns {number|null} seconds to sleep, or null to stop retrying
 */
export function nextRetryDelaySeconds(attemptIndex) {
  if (!Number.isInteger(attemptIndex) || attemptIndex < 0) return null;
  return attemptIndex < TRANSIENT_BACKOFF_SECONDS.length ? TRANSIENT_BACKOFF_SECONDS[attemptIndex] : null;
}

/**
 * PURE. The remediation for a classified az failure, in Analysis Services terms.
 *
 * NOT `_az-failure-class.mjs`'s `remediationFor`, deliberately. That one names
 * ADX-SPECIFIC levers — a Kusto data-plane role, the ADX cluster's SKU
 * parameter and the ADX preflight's own what-if/apply ordering — in three of its
 * five branches, because it was written for the ADX preflight. Reusing it here
 * would print a Kusto role for an Analysis Services scope — a remediation that
 * cannot possibly be right, which is deploy-integrity.md R7 in the exact form
 * that file exists to end. The CLASSIFIER is shared (that part is provider
 * agnostic); only the operator-facing text is local.
 *
 * #4123 — THIS PARAGRAPH USED TO QUOTE THAT FUNCTION'S PROSE VERBATIM
 * ("adx-cluster.bicep `adxSku`"), and the quote went stale the moment #4115
 * rewrote the capacity branch: `adxSku` is not a parameter anywhere
 * (`adx-cluster.bicep` declares `param skuName`), so the branch now explains the
 * `adxConfig` / BCP259 reachability gap instead. The reasoning above was, and
 * remains, correct — only the citation was wrong. It is therefore stated in
 * terms of what the other function is FOR rather than what it currently SAYS, so
 * it cannot go stale again the next time that branch is reworded. If you find
 * yourself pasting another module's sentences in here, don't.
 *
 * Permission strings verified against
 * learn.microsoft.com/azure/role-based-access-control/permissions/analytics.
 *
 * @param {'capacity'|'transient'|'denied'|'notfound'|'unknown'} kind
 * @param {string} scopeId the ARM id the failing call targeted
 * @param {number} [attempts] how many times a transient failure was retried
 * @returns {string}
 */
export function aasRemediationFor(kind, scopeId, attempts = 0) {
  switch (kind) {
    case 'transient':
      return (
        `az did not complete the call in ${attempts} attempt(s), and the last failure carried a transient ` +
        'signal (the raw error below is what it said). Re-run this workflow. THE LIMIT OF WHAT THIS ' +
        "ESTABLISHES: the call did not complete. This step did not test the deploy identity's permissions, " +
        "the SKU's capacity, or the server's existence, so none of those is ruled out — if a re-run fails " +
        'the same way, read the raw error rather than assuming the cause is Azure-side.'
      );
    case 'denied':
      return (
        `the deploy service principal was REFUSED on ${scopeId}. This one IS a permission problem, and az ` +
        'named it: it needs Microsoft.AnalysisServices/servers/read to read the state and ' +
        'Microsoft.AnalysisServices/servers/resume/action to resume it — Contributor at that scope carries ' +
        'both, or grant a custom role holding exactly those two.'
      );
    case 'capacity':
      return (
        "Azure has NO CAPACITY for this server's SKU in this region, so no retry and no role grant will " +
        'resolve it. This is not a defect in the deploy. Either pick a SKU that has capacity in the region ' +
        '(the aas-server bicep module\'s `sku`), deploy the server to a region that does, or wait for ' +
        'capacity to free up and re-run. The raw az error below names the SKU.'
      );
    case 'notfound':
      return (
        `ARM reports the target does not exist at ${scopeId}. If this is a greenfield subscription the ` +
        'template creates the server, and a freshly created server is Succeeded — so this step should not ' +
        'have reached a per-server read at all. Treat a not-found HERE as a real inconsistency.'
      );
    default:
      return (
        'az failed with an error this step does NOT recognise, so NO cause is asserted — not permissions, ' +
        'not capacity, not a transient blip. The raw az stderr below is the only thing that was ' +
        'established; read it before acting on any hypothesis.'
      );
  }
}

/**
 * Run an `az` call, retrying ONLY what `_az-failure-class.mjs` calls transient.
 *
 * Returns the LAST attempt's result plus what was learned about it, so a caller
 * can build a message from the established cause instead of a hypothesis. A
 * `denied`, `capacity`, `notfound` or `unknown` failure returns immediately —
 * retrying a refusal just delays the truth by 50 seconds.
 *
 * DUPLICATION, DISCLOSED. `ensure-adx-cluster-running.mjs` carries a function of
 * the same name and shape. Unifying them means refactoring a preflight that is
 * currently working on a lane that is currently broken, and
 * `_az-failure-class.mjs`'s own header records the precedent for not doing that
 * here: "Unifying them is a behaviour change that needs its own measurement, not
 * a drive-by in a P0." The CLASSIFIER — the part where drift would silently
 * change how a real failure is read — is already shared. Tracked for extraction
 * into a `_az-retry.mjs` once this lane is green.
 *
 * @param {string[]} args
 * @param {{runner?: Function, sleep?: Function, log?: Function, label?: string}} [io] seams for tests
 * @returns {{ok: boolean, stdout: string, stderr: string, kind: string|null, attempts: number}}
 */
export function azWithRetry(args, io = {}) {
  const runner = io.runner ?? az;
  const sleep = io.sleep ?? sleepSeconds;
  const log = io.log ?? console.log;
  const label = io.label ?? 'az';
  let attempts = 0;
  for (;;) {
    const res = runner(args);
    attempts += 1;
    if (res.ok) return { ...res, kind: null, attempts };

    const kind = classifyAzFailure(res.stderr);
    if (!isRetryable(kind)) return { ...res, kind, attempts };

    const delay = nextRetryDelaySeconds(attempts - 1);
    if (delay == null) {
      // FAIL CLOSED. The budget is spent and the call never succeeded, so the
      // outcome is UNCONFIRMED and this hands that back rather than proceeding.
      return { ...res, kind, attempts };
    }
    log(`[aas-preflight] ${label}: transient az failure (attempt ${attempts}) — retrying in ${delay}s.`);
    sleep(delay);
  }
}

// ── I/O shell ───────────────────────────────────────────────────────────────

/**
 * PURE. `--flag value` pairs.
 *
 * A flag present with NO value yields the empty string, not `undefined`. The
 * distinction is load-bearing: `args['timeout-seconds'] ?? DEFAULT` would turn
 * a trailing `--timeout-seconds` into a silent 1800s default, so a typo'd
 * invocation would run on a budget the caller never asked for. `''` is not
 * nullish, so it reaches the validation and is refused.
 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    out[key.slice(2)] = next === undefined || next.startsWith('--') ? '' : next;
  }
  return out;
}

/**
 * Run az and return {ok, stdout, stderr}. stderr is CAPTURED, never discarded —
 * per deploy-integrity R7 a swallowed stderr turns "I could not read this" into
 * "it is not there", which is how a permission denial gets reported as an
 * absent resource.
 */
function az(args) {
  try {
    const stdout = execFileSync('az', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout: String(stdout).trim(), stderr: '' };
  } catch (e) {
    return { ok: false, stdout: String(e?.stdout ?? '').trim(), stderr: String(e?.stderr ?? e?.message ?? e).trim() };
  }
}

function sleepSeconds(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

/**
 * The whole preflight, with every I/O edge injected.
 *
 * Returns an exit code rather than calling `process.exit`, so the settle loop —
 * the thing the #4074 review found broken in two separate ways — can be driven
 * end-to-end by a test with a scripted `az`. A state machine whose only proof is
 * a unit test of its pure parts is a state machine whose WIRING is unproven,
 * which is how `shouldResuspend` shipped exported, tested and uncalled.
 *
 * @param {{argv: string[], io: object}} p
 * @returns {number} process exit code
 */
export function runPreflight({ argv = [], io = {} } = {}) {
  const runAz = io.az ?? ((args) => az(args));
  const sleep = io.sleep ?? sleepSeconds;
  const now = io.now ?? (() => Date.now());
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const emit =
    io.emit ??
    ((name, value) => {
      // NEWLINE GUARD. `$GITHUB_OUTPUT` is parsed line-by-line, so a value
      // carrying a newline injects an arbitrary extra step output. These values
      // come from an ARM response, and `.trim()` only strips the ENDS — an
      // embedded newline would survive it. Nothing observed has ever contained
      // one; this is closing the shape, not reacting to an incident.
      const safe = String(value).replace(/[\r\n]+/g, ' ');
      const line = `${name}=${safe}`;
      console.log(line);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
    });

  const args = parseArgs(argv);
  const subscription = args.subscription;
  const rg = args.rg;

  if (!subscription || !rg) {
    error('[aas-preflight] ERROR: --subscription and --rg are both required.');
    return 2;
  }

  const budgetSeconds = Number(args['timeout-seconds'] ?? DEFAULT_TIMEOUT_SECONDS);
  // `elapsed >= NaN` is ALWAYS false, so a non-numeric budget makes the settle
  // loop unbounded — terminated only by the job's `timeout-minutes`, at which
  // point nothing gets to classify anything. A budget that cannot be exceeded
  // is a budget that is not enforced.
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) {
    error(
      `[aas-preflight] ERROR: --timeout-seconds must be a positive number; got ` +
        `'${args['timeout-seconds']}'. Refusing to poll on a budget that can never be exceeded.`,
    );
    return 2;
  }

  // `aas_resumed` is emitted EXACTLY ONCE, on every exit path, and always via
  // shouldResuspend(). Once-only because the workflow gate reads a single value
  // and a second emission would make the outcome depend on GITHUB_OUTPUT's
  // last-key-wins parsing rather than on this decision.
  let resumedEmitted = false;
  const emitResumeVerdict = (priorState, resumedByUs) => {
    if (resumedEmitted) return;
    resumedEmitted = true;
    const v = shouldResuspend({ priorState, resumedByUs });
    log(`[aas-preflight] re-suspend gate: aas_resumed=${v.resuspend} — ${v.reason}`);
    emit('aas_resumed', String(v.resuspend));
  };

  const failWith = (message, stderr) => {
    error(`::error::[aas-preflight] ${message}`);
    if (stderr) {
      error('--- raw az stderr (first 20 lines) ---');
      error(String(stderr).split('\n').slice(0, 20).join('\n'));
    }
    return 1;
  };

  const list = azWithRetry(
    [
      'resource', 'list',
      '--subscription', subscription,
      '--resource-group', rg,
      '--resource-type', 'Microsoft.AnalysisServices/servers',
      '--query', '[].name', '-o', 'tsv',
    ],
    { runner: runAz, sleep, log, label: `enumerate Microsoft.AnalysisServices/servers in ${rg}` },
  );
  if (!list.ok) {
    emitResumeVerdict('', false);
    return failWith(
      `Could NOT enumerate Analysis Services servers in ${rg} after ${list.attempts} attempt(s). This is NOT ` +
        'the same as "there is no server" — the lookup did not happen at all, so whether this estate has a ' +
        `suspended server is UNKNOWN. az classified this as: ${list.kind}. ` +
        `REMEDIATION: ${aasRemediationFor(list.kind, rg, list.attempts)}`,
      list.stderr,
    );
  }

  // `az -o tsv` carries a trailing CR on some agents; strip it before using it.
  const name = list.stdout.replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
  if (!name) {
    log(`[aas-preflight] No Microsoft.AnalysisServices/servers in ${rg}. Nothing to settle.`);
    emit('aas_server', '');
    emit('aas_prior_state', '');
    emitResumeVerdict('', false);
    return 0;
  }

  const id = `/subscriptions/${subscription}/resourceGroups/${rg}/providers/Microsoft.AnalysisServices/servers/${name}`;
  const readState = () => {
    const r = azWithRetry(
      ['resource', 'show', '--ids', id, '--api-version', AAS_API_VERSION, '--query', 'properties.state', '-o', 'tsv'],
      { runner: runAz, sleep, log, label: `read state of ${name}` },
    );
    if (!r.ok) return { ok: false, state: null, stderr: r.stderr, kind: r.kind, attempts: r.attempts };
    return { ok: true, state: r.stdout.replace(/\r/g, '').trim(), stderr: '', kind: null, attempts: r.attempts };
  };

  const first = readState();
  if (!first.ok) {
    emitResumeVerdict('', false);
    return failWith(
      `Could NOT read the state of Analysis Services server '${name}' after ${first.attempts} attempt(s), so ` +
        "whether the deploy's administrator write can land is UNKNOWN. It is not something to proceed past on " +
        `an unread value. az classified this as: ${first.kind}. ` +
        `REMEDIATION: ${aasRemediationFor(first.kind, id, first.attempts)}`,
      first.stderr,
    );
  }

  const priorState = first.state;
  emit('aas_server', name);
  emit('aas_prior_state', priorState);
  const firstVerdict = classifyServerState(priorState);
  log(`[aas-preflight] ${name}: state='${priorState}' -> ${firstVerdict.action} — ${firstVerdict.reason}`);

  // ── THE SETTLE LOOP ──────────────────────────────────────────────────────
  // One loop for every path, because the first draft's split (decide once, then
  // poll) is what made `wait` a dead end: the poll had no vocabulary for "it has
  // become resumable". Each iteration RE-CLASSIFIES and acts.
  let resumesIssued = 0;
  let lastResumeAtMs = null;
  let state = priorState;
  const startedAtMs = now();

  // A SECOND bound, independent of the clock. The budget is the primary one,
  // but it is only reachable if `now()` advances — and `elapsedSecondsSince`
  // clamps a backwards clock to 0, which reads as "no time has passed" forever.
  // This cap cannot be defeated by any clock at all, so the loop terminates
  // even when the wall clock lies. Derived from the budget, +2 for the initial
  // reading and the boundary poll, so it can never fire BEFORE the budget on a
  // healthy clock — the budget stays the control that reports.
  const maxPolls = Math.ceil(budgetSeconds / POLL_INTERVAL_SECONDS) + 2;
  let polls = 0;

  for (;;) {
    polls += 1;
    if (polls > maxPolls) {
      emitResumeVerdict(priorState, resumesIssued > 0);
      return failWith(
        `${name}: made ${polls - 1} readings against a cap of ${maxPolls} derived from the ${budgetSeconds}s ` +
          `budget at ${POLL_INTERVAL_SECONDS}s per poll, without the budget ever being reached. That means the ` +
          'wall clock did not advance as expected, so every elapsed figure in this log is UNTRUSTWORTHY and ' +
          'the outcome is UNCONFIRMED. Stopping on the iteration count instead of polling forever.',
      );
    }

    const step = planSettleStep({
      state,
      elapsedSeconds: elapsedSecondsSince(startedAtMs, now()),
      budgetSeconds,
      resumesIssued,
      secondsSinceLastResume:
        lastResumeAtMs === null ? Number.POSITIVE_INFINITY : elapsedSecondsSince(lastResumeAtMs, now()),
    });

    if (step.action === 'settled') {
      log(`[aas-preflight] ${name}: ${step.reason}`);
      emitResumeVerdict(priorState, resumesIssued > 0);
      return 0;
    }

    if (step.action === 'fail') {
      emitResumeVerdict(priorState, resumesIssued > 0);
      return failWith(`${name}: ${step.reason}`);
    }

    if (step.action === 'resume') {
      log(`[aas-preflight] ${name}: ${step.reason}`);
      const r = azWithRetry(
        ['resource', 'invoke-action', '--ids', id, '--api-version', AAS_API_VERSION, '--action', 'resume'],
        { runner: runAz, sleep, log, label: `resume ${name}` },
      );
      if (!r.ok) {
        // The resume was REJECTED, so this run did not resume anything and must
        // not claim it did — the workflow would then try to suspend a server it
        // never started.
        emitResumeVerdict(priorState, resumesIssued > 0);
        return failWith(
          `The resume of Analysis Services server '${name}' was REJECTED after ${r.attempts} attempt(s), so ` +
            "the deploy's administrator write would still fail on a suspended server. " +
            `az classified this as: ${r.kind}. REMEDIATION: ${aasRemediationFor(r.kind, id, r.attempts)}`,
          r.stderr,
        );
      }
      resumesIssued += 1;
      lastResumeAtMs = now();
      // Emitted the moment Azure ACCEPTS the resume, not at the end: if this
      // process is killed mid-poll (a job timeout), the marker is already
      // written and the workflow's always() step still puts the server back.
      emitResumeVerdict(priorState, true);
      log(
        `[aas-preflight] ${name}: resume ACCEPTED (${resumesIssued}/${MAX_RESUME_ATTEMPTS}) — that is a 202 on a ` +
          `long-running operation, not a settled server. Polling, and holding off a further resume for ` +
          `${RESUME_GRACE_SECONDS}s.`,
      );
    } else {
      log(`[aas-preflight] ${name}: ${step.reason} — waiting ${POLL_INTERVAL_SECONDS}s.`);
    }

    sleep(POLL_INTERVAL_SECONDS);

    const poll = readState();
    if (!poll.ok) {
      emitResumeVerdict(priorState, resumesIssued > 0);
      return failWith(
        `Lost the ability to read Analysis Services server '${name}' while waiting for it to settle ` +
          `(${poll.attempts} attempt(s)), so its state is UNKNOWN and this step will NOT report that it came ` +
          `up. az classified this as: ${poll.kind}. REMEDIATION: ${aasRemediationFor(poll.kind, id, poll.attempts)}`,
        poll.stderr,
      );
    }
    state = poll.state;
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) process.exit(runPreflight({ argv: process.argv.slice(2) }));
