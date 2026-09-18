#!/usr/bin/env bash
# CSA Loom — verify (and, on request, re-apply) the OP-19 (a) mitigation.
#
# WHAT THIS IS FOR
# ----------------
# `func-secexp-*` and `func-cpeval-*` are retired Function hosts whose indexed
# timer definitions fire on schedules IDENTICAL to their live Container App Job
# replacements:
#
#     func-secexp  secretExpiryMonitor    NCRONTAB `0 0 6 * * *`  == 06:00 UTC
#     job          loom-secret-expiry-monitor   cron `0 6 * * *`  == 06:00 UTC
#     func-cpeval  copilotEvaluatorTimer  NCRONTAB `0 0 7 * * *`  == 07:00 UTC
#     job          loom-copilot-evaluator       cron `0 7 * * *`  == 07:00 UTC
#
# (NCRONTAB is 6-field with a leading SECONDS field; the ACA cron is standard
# 5-field. Drop the seconds field and the two are the same instant.)
#
# If either host ever resumes executing, credential-expiry monitoring and the
# Copilot evaluator each run TWICE, concurrently, on the same schedule.
#
# MEASURED 2026-09-17 (#4495, OP-19): both hosts are ALREADY disabled —
# `AzureWebJobs.secretExpiryMonitor.Disabled=true`,
# `AzureWebJobs.copilotEvaluatorTimer.Disabled=true`,
# `AzureWebJobs.copilotEvaluatorHttp.Disabled=true`, and
# `az functionapp function show` reports `isDisabled: true` for all three. That
# was done OUT OF BAND: nothing in this repo sets those settings and no issue or
# PR records it, so nothing would notice a re-enable. This script is that
# notice.
#
# WHAT WOULD MAKE THIS SCRIPT FAIL (assertion-design.md): any of the three
# settings absent or not "true", or `isDisabled` not true on the corresponding
# definition. Both reads are kept because they are INDEPENDENT: the app setting
# is what an operator writes, `isDisabled` is what the Functions host computed
# from it. Agreement between them is the evidence; either alone could be stale.
#
# ABSENCE IS NOT UNREADABILITY. An earlier revision collapsed the two and so
# broke itself on its own remediation: both hosts are on the OP-19 delete list,
# and once they are deleted every definition read fails, every target takes the
# UNKNOWN arm, and the script exits 2 forever — "the hazard is permanently
# retired because the host is gone" reported as "I could not measure". That is
# the R7 distinction this header preaches, applied one level up. So each target
# is first resolved against a host LISTING:
#
#   list succeeds, host absent   -> GONE     the hazard is retired by teardown (rc 0)
#   list succeeds, host present  -> read the definition; OK / ENABLED / UNKNOWN
#   list FAILS                   -> UNKNOWN  we could not measure (never GONE)
#
# The listing is the discriminator precisely because it answers with an empty
# set when the host is gone and with a non-zero exit when we cannot reach ARM.
#
# EXIT CODES (a caller reading only the status can tell these apart):
#   0  every target is OK or GONE — no live hazard
#   1  at least one ENABLED target — a live double-execution hazard
#   2  nothing ENABLED, but the requested outcome could not be certified:
#      at least one UNKNOWN target, or a --apply write that failed, or the
#      boundary itself was unreadable — refusing a verdict
# ENABLED outranks UNKNOWN deliberately: a confirmed live hazard is strictly
# more actionable than an unmeasured one, and hiding it behind "could not
# measure" would send the operator to debug `az` instead of re-disabling a timer.
# The tally line is printed on every path that REACHES the loop. The one class
# that precedes the loop — an unreadable boundary — cannot print a tally because
# no target has been considered yet, so it exits 2 with an explicit refusal
# instead of dying bare; see the guard below.
#
# EVERY `az` INVOCATION IN THIS FILE IS GUARDED, and that is a counted property,
# not an impression. Under `set -euo pipefail` a bare `VAR="$(az …)"` or a bare
# `az …` aborts the run at rc=1 — which is the ENABLED code, so an expired token
# or a missing role would be indistinguishable from a confirmed live hazard, with
# no verdict line, no tally and no refusal.
#
# Audited 2026-09-17 across the WHOLE file rather than at the two reported sites,
# by construct rather than by line number (a line number in this header goes
# stale the moment this header is edited — it did, mid-fix):
#
#   5 command substitutions in executable code
#       CLOUD=   `if !` guarded   <- WAS BARE; this is the fix
#       LISTED=  `if !` guarded
#       VAL=     `if !` guarded
#       SHOWN=   `if !` guarded
#       the `$([[ $APPLY -eq 1 ]] && echo apply || echo verify)` inside the
#         boundary echo — the `||` makes it total, so it cannot carry a
#         non-zero status; measured, not assumed
#   1 `az` command outside a substitution
#       `appsettings set`, guarded by `&& ! az` in an `if` condition
#                                     <- WAS BARE; this is the other half
#   0 bare `az` at line start (`grep -cE '^[[:space:]]*az '` == 0)
#   8 arithmetic expansions `$((…))`, measured NOT to carry a command status —
#       including the zero-valued `resolved=$((0))` — against a negative control
#       (`V="$(false)"`) that did abort, so the zero is a result and not a
#       blind probe
#   1 `[[ … ]] && APPLY=1`, measured safe: a short-circuited AND-list mid-script
#       does not trip errexit
#
# The two that were unguarded — the boundary read and the --apply write — are
# exactly the two an earlier revision's receipt table never varied. A table is
# SILENT where it does not vary its input, not clean; the rows below vary both.
#
# Usage:
#   scripts/csa-loom/check-retired-function-timers.sh            # verify only
#   scripts/csa-loom/check-retired-function-timers.sh --apply    # re-disable
#
# --apply writes app settings only. It never deletes anything, and it skips a
# host that is GONE. Teardown of the hosts themselves is a separate operator
# action — see docs/fiab/deployment/functions-to-aca-jobs.md §7.
set -euo pipefail

SUB="${LOOM_ADMIN_SUBSCRIPTION:-e093f4fd-5047-4ee4-968d-a56942c665f3}"
RG="${LOOM_ADMIN_RG:-rg-csa-loom-admin-centralus}"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

# Boundary guard (mirrors scripts/measure/estate-resume.mjs): this is the
# Commercial admin plane by construction. Per csa_loom_gov_verify_via_actions a
# sovereign boundary is never touched from a workstation `az`, so refuse rather
# than act on whatever cloud the ambient session happens to be on.
#
# GUARDED, and for the same reason as the three reads in the loop: a bare
# `CLOUD="$(az …)"` here aborts at rc=1 — the ENABLED code — before the boundary
# line, the tally or any refusal is printed, so an expired `az login` presents to
# a status-only caller as a confirmed double-execution hazard. This is the one
# failure that cannot produce a tally (no target has been read yet), so it says
# so in words.
if ! CLOUD="$(az account show --query environmentName -o tsv)"; then
  echo "REFUSING: the active cloud could not be read — \`az account show\` failed (expired login, no subscription selected, or no \`az\` on PATH). This run established NOTHING: not the boundary, and not one timer. Sign in against the Commercial admin subscription and re-run." >&2
  exit 2
fi
CLOUD="${CLOUD//$'\r'/}"   # same CRLF strip as LISTED below; a Windows `-o tsv`
                           # trailing \r would otherwise fail the == comparison
                           # and REFUSE on a correct boundary.
if [[ "$CLOUD" != "AzureCloud" ]]; then
  # `${CLOUD:-<unreadable>}` is reachable by exactly ONE value now that the read
  # is guarded: an `az` that exits 0 printing nothing. That is arm C of the
  # receipt table, which had to be synthesised — disclosed here per
  # assertion-design.md item 5 rather than left looking like a live remediation.
  echo "REFUSING: active cloud is '${CLOUD:-<unreadable>}', not AzureCloud. This script is Commercial-only by construction." >&2
  exit 2
fi
echo "boundary=$CLOUD subscription=$SUB rg=$RG mode=$([[ $APPLY -eq 1 ]] && echo apply || echo verify)"

# app|function|expected-setting-name
TARGETS=(
  "func-secexp-k6mvh5sm6z7do|secretExpiryMonitor"
  "func-cpeval-k6mvh5sm6z7do|copilotEvaluatorTimer"
  "func-cpeval-k6mvh5sm6z7do|copilotEvaluatorHttp"
)

ok=0
gone=0
enabled=0
unknown=0
applyfail=0
for t in "${TARGETS[@]}"; do
  APP="${t%%|*}"; FN="${t##*|}"
  SETTING="AzureWebJobs.${FN}.Disabled"
  # Reset per target. R6 wants a remediation that is actually available: after a
  # DENIED write, "re-run with --apply" is the one thing already known not to
  # work, so the ENABLED line points at the role instead.
  FIXHINT="Re-run with --apply."

  # Step 1 — does the host still exist? A LIST that fails is not an absence.
  if ! LISTED="$(az functionapp list -g "$RG" --subscription "$SUB" \
                   --query "[?name=='${APP}'].name | [0]" -o tsv)"; then
    echo "  UNKNOWN  ${APP}/${FN}: the host listing failed, so absence could not be distinguished from unreachability — NOT the same as disabled, and NOT the same as deleted." >&2
    unknown=$((unknown + 1))
    continue
  fi
  LISTED="${LISTED//$'\r'/}"
  if [[ -z "$LISTED" ]]; then
    echo "  GONE     ${APP}/${FN}: host is absent from a successful listing of ${RG} — the double-execution hazard is retired by teardown."
    gone=$((gone + 1))
    continue
  fi

  # The --apply WRITE. GUARDED for the same reason as the three reads: a bare
  # `az … set` aborts the run mid-loop at rc=1 with no tally and no remediation,
  # so a 403 on the write is indistinguishable from a confirmed ENABLED timer.
  # deploy-integrity.md R6 additionally requires a permission failure to name the
  # exact role and scope, which a bare `az` error does not.
  #
  # A failed write deliberately does NOT `continue`. The reads below still
  # establish the target's ACTUAL state, so a genuinely enabled timer is still
  # reported ENABLED (rc 1) rather than downgraded to UNKNOWN — this file's own
  # precedence (see EXIT CODES) says a confirmed hazard outranks an unmeasured
  # one, and a failed write is a reason to distrust the FIX, not the MEASUREMENT.
  if [[ $APPLY -eq 1 ]] && ! az functionapp config appsettings set -g "$RG" -n "$APP" \
       --subscription "$SUB" --settings "${SETTING}=true" -o none; then
    echo "  APPLYFAIL ${APP}/${FN}: could not write ${SETTING} — the definition was NOT changed. Needs Microsoft.Web/sites/config/write (built-in role: Website Contributor) on /subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Web/sites/${APP}." >&2
    applyfail=$((applyfail + 1))
    FIXHINT="--apply was already tried on this run and was DENIED — grant the role named in the APPLYFAIL line above, then re-run with --apply."
  fi

  # Read 1 — the app setting an operator writes. GUARDED: under `set -e` a bare
  # `VAL="$(az …)"` aborts the whole script on a failed read, which is how the
  # PRE-FIX revision actually behaved once the hosts were deleted — it died here
  # with a bare az error and rc=1 (the ENABLED code), never reaching its own
  # UNKNOWN arm or its refusal. Classify instead of aborting.
  if ! VAL="$(az functionapp config appsettings list -g "$RG" -n "$APP" --subscription "$SUB" \
                --query "[?name=='${SETTING}'].value | [0]" -o tsv)"; then
    echo "  UNKNOWN  ${APP}/${FN}: the host EXISTS but its app settings could not be read — NOT the same as disabled." >&2
    unknown=$((unknown + 1))
    continue
  fi
  # Read 2 — what the Functions host computed from it. A host that exists but
  # cannot be read fails here rather than yielding a convenient empty string.
  if ! SHOWN="$(az functionapp function show -g "$RG" -n "$APP" --subscription "$SUB" \
                  --function-name "$FN" --query isDisabled -o tsv)"; then
    echo "  UNKNOWN  ${APP}/${FN}: the host EXISTS but its definition could not be read — NOT the same as disabled." >&2
    unknown=$((unknown + 1))
    continue
  fi

  if [[ "$VAL" == "true" && "$SHOWN" == "true" ]]; then
    echo "  OK       ${APP}/${FN}: ${SETTING}=${VAL}, isDisabled=${SHOWN}"
    ok=$((ok + 1))
  else
    echo "  ENABLED  ${APP}/${FN}: ${SETTING}=${VAL:-<unset>}, isDisabled=${SHOWN:-<unset>} — DOUBLE-EXECUTION HAZARD against its ACA job twin. ${FIXHINT}" >&2
    enabled=$((enabled + 1))
  fi
done

# Positive control: if NOTHING resolved to a definite state, the loop proved
# nothing and an rc=0 would be a green over an empty set. A host confirmed GONE
# IS a definite state — that is the terminal good state of the OP-19 teardown,
# not a failure to measure.
resolved=$((ok + gone + enabled))
echo "targets=${#TARGETS[@]} ok=${ok} gone=${gone} enabled=${enabled} unknown=${unknown} applyfail=${applyfail}"
if [[ "$resolved" -eq 0 ]]; then
  echo "REFUSING a verdict: no target resolved to a definite state, so this run measured nothing." >&2
  exit 2
fi
if [[ "$enabled" -gt 0 ]]; then
  exit 1
fi
if [[ "$unknown" -gt 0 ]]; then
  echo "REFUSING a verdict: ${unknown} target(s) were unreadable, so 'no hazard' is not established for them." >&2
  exit 2
fi
# A --apply run whose write failed measured a state it did not produce. The
# targets may well already be disabled (and then every read says OK), but the
# operator asked for a WRITE and did not get one, so a status-only caller must
# not read 0. This is the second member of rc 2's "could not certify the
# requested outcome" class, alongside UNKNOWN.
if [[ "$applyfail" -gt 0 ]]; then
  echo "REFUSING a verdict: --apply could not write ${applyfail} target(s); the current state above was MEASURED, not APPLIED by this run." >&2
  exit 2
fi
if [[ "$gone" -eq "${#TARGETS[@]}" ]]; then
  echo "RETIRED: every target host is gone. The OP-19 (a) hazard cannot recur without a redeploy."
fi
exit 0
