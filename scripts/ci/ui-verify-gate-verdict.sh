#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ui-verify-gate-verdict.sh — the FINAL gate of loom-ui-verify (refs #2871).
# Pure: no `az`, no network, no clock. Every input arrives as an environment
# variable, so the decision is unit-testable — see
# scripts/ci/__tests__/ui-verify-gate.test.mjs. Same shape and same reasons as
# login-health-verdict.sh and service-health-verdict.sh.
#
# WHY THIS EXISTS
# ---------------
# #2837 correctly gave the login-health preflight teeth: it had printed
# "::error::LOGIN BROKEN" and exited 0, so a live sign-in outage rendered as a
# green check. The fix made it a hard early step.
#
# That created a second, opposite defect. The preflight sits AHEAD of the
# Playwright projects, so once it can fail it ABORTS THE JOB before a single
# browser test runs. While the estate carries a live AADSTS7000215 signal —
# which it does today, with the invalid_client count still climbing — there is
# no obtainable browser-E2E receipt for main AT ALL, for any change. A UI
# regression could land and nothing would see it. One true signal was masking a
# second, independent one.
#
# THE FIX IS ORDERING, NOT TOLERANCE. Explicitly NOT a skip input and NOT a
# re-added continue-on-error: the preflight still runs first, still emits its
# ::error:: annotations, but RECORDS its verdict instead of terminating the job;
# the browser suite runs and reports its own result; and this step — which runs
# with `if: always()` — turns a BROKEN verdict back into a red run. The job's
# pass/fail outcome is identical to before. The run simply now contains both
# signals instead of only the first. This is the second remedy
# check-annotation-teeth.mjs itself prescribes: "record the verdict
# (GITHUB_OUTPUT) and have a LATER step enforce it."
#
# FAIL-CLOSED, IN BOTH DIRECTIONS
#   - A recorded verdict of `broken` fails, obviously.
#   - A preflight that RAN but recorded NO usable verdict also fails. A gate
#     that reads a missing verdict as health is the #2837 defect wearing a new
#     hat; absence of evidence is not evidence of absence.
#   - A recorded verdict that CONTRADICTS the preflight's raw exit status fails.
#     Two independent signals are recorded precisely so drift between them is
#     loud rather than silently resolved in favour of the cheerful one.
#
# THE ONE THING THAT IS DELIBERATELY *NOT* A FAILURE
#   - `unknown` — the preflight could not determine the count (unreadable
#     workspace, missing Log Analytics Reader, `az` failure, unparseable
#     expiry). That tolerance is the original and legitimate reason the step
#     ever carried continue-on-error, it is preserved exactly here, and it must
#     never become a false failure. It is reported as a ::warning::, never as
#     health and never as breakage.
#   - A preflight that never ran at all (outcome empty/skipped/cancelled). That
#     only happens when an EARLIER step already failed the job or the run was
#     cancelled, so nothing is being masked and inventing a second failure would
#     only obscure the real one.
#
# `unproven` IS A FAILURE, AND IT IS NOT `unknown` (#3498)
# -------------------------------------------------------
# The two look adjacent and are not. `unknown` is "nothing was measured" — no
# hits are in hand, so there is nothing to fail on. `unproven` is "hits ARE in
# hand and this run could not order them against the newest MSAL credential",
# which blocks, because assuming they are historical is exactly how a live
# AADSTS7000215 outage renders green.
#
# It gets its own token so THIS step's message can stop asserting a cause it did
# not establish (deploy-integrity.md R7). Folded into `broken`, the job summary
# read "the preflight found evidence that sign-in is down" when what actually
# happened was that a Log Analytics query returned no timestamp — and that sent
# two investigations at a credential which had just been rotated correctly.
#
# BLOCKING SUITE OUTCOMES
# -----------------------
# The gate also re-asserts the outcome of the steps that are supposed to block.
# GitHub already fails a job when a step fails, so today this is redundant —
# which is the point: it stops being redundant the moment somebody adds
# `continue-on-error: true` to one of them, which is exactly what happened in
# #2787 to `Run extra Playwright projects` in this very file. Steps that are
# intentionally advisory (publish-version, the optional receipt) are NOT passed
# in, so their tolerance is unchanged.
#
# EVERY cause is reported before exiting, never just the first: when the
# preflight is broken AND the suite is red, a run that showed only one of them
# would send someone to fix half the problem.
#
# INPUTS (all optional; each absent value is handled explicitly above)
#   UVG_PREFLIGHT_OUTCOME  steps.<preflight>.outcome
#                          ''|skipped|cancelled = it never ran
#   UVG_VERDICT            steps.<preflight>.outputs.verdict
#                          (ok|unknown|unproven|broken)
#   UVG_RC                 steps.<preflight>.outputs.rc — the raw exit status of
#                          login-health-verdict.sh, recorded independently
#   UVG_BLOCKING           comma-separated `label=outcome` pairs for the steps
#                          that must block, e.g. "verify=success,extra=skipped"
#
# EXIT: 0 = nothing blocking, 1 = at least one blocking cause (all are printed).
# ---------------------------------------------------------------------------
set -uo pipefail

PREFLIGHT_OUTCOME="${UVG_PREFLIGHT_OUTCOME:-}"
VERDICT="${UVG_VERDICT:-}"
RC="${UVG_RC:-}"
BLOCKING="${UVG_BLOCKING:-}"

FAIL=0
CAUSES=""

# Record a blocking cause. Never exits: every cause must reach the log.
add_cause() {
  echo "::error::$1"
  CAUSES="${CAUSES}  - $1
"
  FAIL=1
}

echo "== login-health preflight =="
echo "  outcome=${PREFLIGHT_OUTCOME:-<did not run>} verdict=${VERDICT:-<none recorded>} rc=${RC:-<none recorded>}"

case "$PREFLIGHT_OUTCOME" in
  ''|skipped|cancelled)
    # An earlier step already failed the job, or the run was cancelled. There is
    # no verdict to enforce and nothing is being hidden.
    echo "::warning::the login-health preflight did not run (outcome='${PREFLIGHT_OUTCOME}') — no verdict to enforce. An earlier step failed or the run was cancelled; that is the signal to follow."
    ;;
  *)
    case "$VERDICT" in
      broken)
        add_cause "LOGIN-HEALTH BROKEN — the preflight found evidence that sign-in is down (see its ::error:: annotations earlier in this run). The browser suite was still executed so its result is available above; this run is RED for the sign-in outage regardless of how the suite scored."
        ;;
      unproven)
        # Blocks exactly as `broken` does, and says something different, because
        # it IS something different (#3498).
        add_cause "LOGIN-HEALTH UNPROVEN — invalid_client errors are present in the 7d window and the preflight could NOT establish whether any of them postdates the newest MSAL credential (see its ::error:: annotation earlier in this run, which names the read that failed). This run is RED because an unestablished recency must never be assumed historical — it is NOT a finding that sign-in is down. The fix is the READ, not a rotation; the gate cannot green itself."
        if [ "$RC" = "0" ]; then
          add_cause "login-health recorded verdict='unproven' but login-health-verdict.sh exited 0. An unprovable recency must fail closed; the two recorded signals disagree."
        fi
        ;;
      ok|unknown)
        # A verdict of ok/unknown alongside a non-zero preflight status means the
        # two recorded signals disagree. Resolve to failure, never to the
        # optimistic one.
        if [ -z "$RC" ]; then
          echo "::warning::the preflight recorded verdict='${VERDICT}' but no exit status; enforcing the recorded verdict alone."
        elif [ "$RC" != "0" ]; then
          add_cause "login-health recorded verdict='${VERDICT}' but login-health-verdict.sh exited ${RC}. The two recorded signals disagree; failing closed rather than trusting the cheerful one."
        fi
        if [ "$VERDICT" = unknown ]; then
          echo "::warning::login-health is INDETERMINATE — at least one check could not run (unreadable workspace / missing permission / unparseable expiry). This is not evidence of a broken sign-in path and does not fail the run, but it is not evidence of health either."
        else
          echo "  OK — login-health found no evidence of a broken sign-in path."
        fi
        ;;
      *)
        add_cause "the login-health preflight RAN (outcome='${PREFLIGHT_OUTCOME}') but recorded no usable verdict (got '${VERDICT}'). A gate that reads a missing verdict as health is the defect #2837 closed; failing closed."
        ;;
    esac
    ;;
esac

echo "== blocking suite steps =="
if [ -z "$BLOCKING" ]; then
  echo "  (none declared)"
else
  # Split on commas; tolerate whitespace introduced by YAML folding.
  OLDIFS="$IFS"
  IFS=','
  for pair in $BLOCKING; do
    IFS="$OLDIFS"
    pair="$(printf '%s' "$pair" | tr -d '[:space:]')"
    [ -z "$pair" ] && { IFS=','; continue; }
    label="${pair%%=*}"
    outcome="${pair#*=}"
    case "$outcome" in
      failure)
        add_cause "the '${label}' step FAILED. Its own logs and the uploaded Playwright report are the receipt."
        ;;
      ''|skipped|cancelled)
        echo "  ${label}: ${outcome:-<did not run>} (not a blocking result)"
        ;;
      *)
        echo "  ${label}: ${outcome}"
        ;;
    esac
    IFS=','
  done
  IFS="$OLDIFS"
fi

echo
if [ "$FAIL" -ne 0 ]; then
  echo "[ui-verify-gate] FAIL — blocking cause(s):"
  printf '%s' "$CAUSES"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### loom-ui-verify — FAILED"
      echo
      printf '%s' "$CAUSES"
    } >> "$GITHUB_STEP_SUMMARY" || true
  fi
  exit 1
fi

echo "[ui-verify-gate] OK — login-health verdict '${VERDICT:-n/a}' is not blocking, and no blocking suite step failed."
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "### loom-ui-verify — OK (login-health: ${VERDICT:-n/a})" >> "$GITHUB_STEP_SUMMARY" || true
fi
exit 0
