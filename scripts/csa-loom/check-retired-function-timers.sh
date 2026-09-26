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
# PR records it, so nothing would notice a re-enable.
#
# WHAT ACTUALLY NOTICES. Not this file on its own — a script a human has to
# remember to run notices nothing, which is deploy-integrity.md R3 ("surfaced
# where the operator looks") and no-vaporware.md's control-that-does-nothing.
# An earlier revision of this header called itself "the standing check" while
# NOTHING invoked it; that claim was false and is corrected here rather than
# quietly dropped (PR #4564 round 6 review, S1). The notice is the
# `op19-retired-timers` job in .github/workflows/loom-drift-check.yml, weekly
# on the same schedule as live bicep-drift detection, read-only, failing closed
# on both "a timer is ENABLED" (rc 1) and "I could not measure" (rc 2). This
# file is the instrument that job runs, and the on-demand verifier an operator
# runs by hand.
#
# THAT JOB HAS NOT YET PRODUCED A RUN as of the commit that added it —
# "supported-in-code, never exercised" in cloud-parity.md's sense. Its first
# scheduled run is what establishes whether the Commercial deploy SP can read
# the DMLZ admin RG this script targets. Do not quote the lane as evidence
# before reading that run.
#
# Once the OP-19 §8.3 deletes land, every target resolves GONE and the job
# stays green on the terminal good state rather than going quiet.
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
#   list succeeds, host absent   -> CORROBORATE with a direct `show`, because a
#                                   succeeding list returns a FILTERED view when
#                                   the identity cannot read the RG. 404 -> GONE
#                                   (rc 0); host found -> present, the list was
#                                   incomplete; any other failure -> UNKNOWN.
#                                   An uncorroborated absence was a fail-OPEN:
#                                   measured gone=2, rc 0, for two live hosts.
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
# stale the moment this header is edited — it did, mid-fix).
#
# RE-MEASURED 2026-09-18 after the corroborating `show` landed, and AGAIN after
# review found this audit had gone false in the same commit that wrote it. The
# earlier revisions' counts were correct WHEN WRITTEN and then the file grew.
# Worse, the revision that updated them also lifted a substitution OUT of
# argument position into a bare assignment and went on describing it as
# argument-position — a false row in the very audit offered as this change's
# receipt. A bare count in a header is a claim with no owner, so the population
# is enumerated below BY GUARD SHAPE and the count derived from it. Check the
# ROW SET, not the number, and re-run the scoped measurement rather than a raw
# grep: a raw grep counts this prose as well as the code, so it answers a
# different question and its answer is not comparable to the rows below.
#
# NO RAW FIGURE IS QUOTED IN THAT SENTENCE ANY MORE, and the deletion is the fix
# rather than an omission. It used to carry a pair of raw counts, to show how far
# wrong a raw grep goes. They were ALREADY stale at the commit that wrote them
# and had drifted further by the time review measured them — a stale number
# inside the sentence warning about stale numbers. A figure that goes false on
# every edit of the prose around it is not repaired by re-measuring it once, so
# it is deleted and the enumerated rows below are the receipt.
#
# THE ROWS BELOW WERE ALL RE-MEASURED AT afc5d291834e, by name rather than only
# the one review reported: command substitutions in executable code and each of
# their three guard shapes, bare `VAR="$(cmd)"` assignments, `az` outside a
# substitution, bare `az` at line start, arithmetic expansions, and
# `[[ … ]] && APPLY=1`. Each held. The commit that writes this paragraph adds
# comment lines and rewords one message string, and changes no executable
# expansion, so the populations counted below are the same at this commit as at
# afc5d291834e — re-derive against each row's SET rather than against this
# sentence, and if you add a row, this sentence is wrong until you re-measure.
#
#   8 command substitutions in executable code, in three shapes:
#
#     SIX guarded by `if !` — the failure arm is reachable and tested:
#       CLOUD=     `if !`   <- WAS BARE; this is the original fix
#       LISTED=    `if !`
#       SHOW_TAIL= `if !`   <- WAS BARE after the 2026-09-18 refactor; guarded
#                              once review caught it. Coreutils-only, so no live
#                              hazard — guarded because the audit must be true.
#       VAL=       `if !`
#       SHOWN=     `if !`, twice (the read and the post-write re-read)
#
#     ONE in an OR-LIST that CAPTURES the status rather than discarding it:
#       SHOW_ERR="$(az … 2>&1)" || SHOW_RC=$?
#       The `||` makes it a list, so errexit does not fire at the assignment,
#       and `$?` is preserved for the exit-code-3 discrimination below. This is
#       NOT the bare shape: a bare `VAR="$(cmd)"` dies AT THE ASSIGNMENT.
#
#     ONE in ARGUMENT position, inside `echo`:
#       the boundary echo's `$([[ $APPLY -eq 1 ]] && echo apply || echo verify)`.
#       Safe because a command substitution in argument position never carries
#       its status to errexit. The reason is NOT that the `||` makes the list
#       total: an earlier revision of this header said that and it is false by
#       measurement — `{ [[ 1 -eq 1 ]] && echo apply || echo verify; } >&-`
#       returns 1, because with the descriptor closed BOTH arms fail. Against
#       a positive control on the same harness,
#       `echo "arg-position: $(false)END"` under `set -euo pipefail` exits 0
#       and the script continues, while `V="$(false)"` exits 1 and it dies.
#       Same conclusion, load-bearing for a different reason.
#
#   ZERO bare `VAR="$(cmd)"` assignments. That is the claim this audit exists
#   to make, and it is the one that went false without anyone noticing.
#
#   1 `az` command outside a substitution
#       `appsettings set`, guarded by standing AS THE CONDITION of an
#       `if az … ; then WROTE=1; else …; fi` split
#                                     <- WAS BARE; this is the other half.
#       NAMED BY THE SHAPE IT ACTUALLY HAS. Every revision of this row up to
#       #4564 round 14 called it `&& ! az` in an `if` condition, which is the
#       shape it CARRIED and the shape the comment at the write site explicitly
#       records replacing — so the audit contradicted the comment at its own
#       write site. Raised as N2 in round 13, carried unanswered through
#       round 14, and corrected here rather than quietly dropped. Either form
#       is guarded and either is one invocation, so the COUNT was right
#       throughout; it is the row's DESCRIPTION that was false, which is the
#       same defect class as a false count and is why it is fixed at the site.
#   0 bare `az` at line start (`grep -cE '^[[:space:]]*az '` == 0)
#   ARITHMETIC EXPANSIONS `$((…))` — ENUMERATED BY TARGET, never counted.
#       This was the ONE row in this audit that was a bare number with no row
#       set behind it, so the count WAS the claim and nothing could be checked
#       against it. It duly went false a THIRD time: the round-13 commit took
#       it from 12 to 14 — adding SLEPT, REREADS and the sixth `unknown=`,
#       minus the `$((RETRY_UNIT * 6))` that left the LAGNOTE string — in the
#       same commit that fixed a different false claim, which is precisely the
#       failure mode the paragraph above describes. Enumerated now, so the next
#       edit that adds one has a row to land in rather than a number to
#       invalidate silently.
#
#       None of them carries a command status. Measured against a negative
#       control (`V="$(false)"`) that DID abort the script, so a clean result
#       here is a result and not a blind probe — including the zero-valued
#       `resolved=$((0))` case.
#
#       TALLY INCREMENTS — exactly one per verdict arm (10):
#         unknown=  x6  the listing failed · absent + direct read DENIED ·
#                       absent + direct read did not establish absence ·
#                       host exists, app settings unreadable · host exists,
#                       definition unreadable · post-write re-read could not
#                       be performed  <- the sixth, added round 13
#         gone=     x1  absence corroborated by a 404
#         applyfail=x1  the --apply write was denied
#         ok=       x1  both reads agree on disabled
#         enabled=  x1  a readable definition that is not disabled
#       RETRY-LOOP BOOKKEEPING (3), all added or kept at round 13:
#         sleep $((attempt * RETRY_UNIT))   the backoff itself
#         SLEPT=                            accumulated AS slept, so the
#                                           elapsed figure cannot be a stale
#                                           constant
#         REREADS=                          re-reads that actually RETURNED
#       DERIVED TOTAL (1):
#         resolved=$((ok + gone + enabled))
#
#       Fourteen rows, and the ROW SET is the claim — check it, not the
#       number. Re-derive by stripping comment lines first and counting `$((`
#       in what remains; a raw grep returns more because it counts this prose,
#       which is how two earlier revisions measured this wrong.
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

# Backoff unit for the post-write restart-lag re-read below: waits are
# 1x, 2x, 3x this (default 5s, 10s, 15s). Overridable ONLY so the tracked
# harness scripts/ci/__tests__/retired-function-timers-apply-lag.test.mjs can
# exercise that arm in seconds rather than minutes. It is NOT a bypass:
# shortening it makes the script give up SOONER and therefore report ENABLED
# more readily — the fail-closed direction. No value of it can turn a
# confirmed hazard into an OK.
RETRY_UNIT="${LOOM_OP19_RETRY_UNIT_SECONDS:-5}"

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
#
# PINNED BY FULL HOST NAME, SUFFIX INCLUDED, and that is a scope limit worth
# stating rather than a defect to fix. The corroboration design above
# distinguishes "deleted" from "invisible to me"; it does NOT distinguish
# "deleted" from "present under a different name". A host of the same role
# carrying a different suffix in this RG is not a target at all — it is absent
# from the listing, the corroborating `show` 404s on the name asked for, and the
# run scores GONE and prints RETIRED at rc 0 while that host runs its timer.
# Unreachable in practice because SUB and RG are pinned to the one estate these
# three names belong to, so this file measures a KNOWN estate and is not a
# discovery tool: point it at another estate and it answers about names that
# were never there. Raised as N2 in PR #4564 round 14 as a note, not a finding.
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
  WROTE=0        # did the --apply write SUCCEED on this run, for this target?
  LAGNOTE=""     # set only when a post-write re-read still disagrees

  # Step 1 — does the host still exist? A LIST that fails is not an absence.
  if ! LISTED="$(az functionapp list -g "$RG" --subscription "$SUB" \
                   --query "[?name=='${APP}'].name | [0]" -o tsv)"; then
    echo "  UNKNOWN  ${APP}/${FN}: the host listing failed, so absence could not be distinguished from unreachability — NOT the same as disabled, and NOT the same as deleted." >&2
    unknown=$((unknown + 1))
    continue
  fi
  LISTED="${LISTED//$'\r'/}"
  if [[ -z "$LISTED" ]]; then
    # AN EMPTY RESULT FROM A SUCCEEDING LIST IS NOT AN ABSENCE. `az functionapp
    # list` exits 0 and returns a FILTERED view when the identity cannot read
    # the resource group — so "not in the list" conflates "deleted" with "not
    # visible to me", and the deleted reading is the fail-OPEN one: it reports
    # rc 0 and "the hazard is retired by teardown" for hosts that still exist.
    # Measured on review: an RBAC-filtered list produced gone=2, rc 0, for two
    # live hosts. That lands on exactly the identity whose read scope THIS FILE
    # says at :41-45 is unestablished until the lane's first run.
    #
    # So corroborate absence with a DIRECT read, where ARM distinguishes the two
    # for us (csa_loom_count_is_an_oracle_when_caller_picks_scope — 404, not
    # 403). A `show` that SUCCEEDS proves the list was filtered and the host is
    # present, which is the third outcome and must not be silently dropped.
    #
    # KEYED ON THE EXIT CODE FIRST, prose second. `az` exits 3 for
    # resource-not-found, which is a contract; the message text is a third
    # party's prose that can be reworded or localised. An earlier revision
    # matched prose ONLY, which fails closed — but it fails closed into the
    # PERMANENTLY RED state, because once the OP-19 deletes land every target
    # depends on that match to reach GONE. The exit code keeps the terminal good
    # state reachable; the prose match stays as a fallback for an az that
    # reports absence some other way.
    SHOW_ERR=""; SHOW_RC=0
    SHOW_ERR="$(az functionapp show -n "$APP" -g "$RG" --subscription "$SUB" -o none 2>&1)" \
      || SHOW_RC=$?
    # GUARDED, like every other substitution in this file. An earlier revision
    # lifted this out of the UNKNOWN `echo` into a BARE assignment — creating a
    # new instance of the exact defect class this script exists to close, in the
    # same commit whose header certified it safe as "argument position". It was
    # argument-position before the refactor; it was not after. Measured: bare
    # assignment on a failing pipeline dies at rc=127 before the tally, while
    # the same expression in argument position continues at rc=0.
    #
    # The pipeline is coreutils-only so there is no live hazard, and the honest
    # reason to guard it anyway is that the audit below is offered as this PR's
    # receipt — a false row in it is worse than the risk it describes.
    SHOW_TAIL=""
    if ! SHOW_TAIL="$(printf '%s' "$SHOW_ERR" | tr '\n' ' ' | cut -c1-240)"; then
      SHOW_TAIL="<could not be summarised>"
    fi
    if [ "$SHOW_RC" -eq 0 ]; then
      echo "  WARN     ${APP}/${FN}: the host listing did not contain it, but a direct read FOUND it — the listing was incomplete (RBAC-filtered or paged). Treating the host as PRESENT and continuing to read its definition." >&2
    elif [ "$SHOW_RC" -eq 3 ] \
         || printf '%s' "$SHOW_ERR" | grep -qiE 'ResourceNotFound|was not found|could not be found'; then
      echo "  GONE     ${APP}/${FN}: absent from the listing AND a direct read reports the resource does not exist (az rc=${SHOW_RC}) — the double-execution hazard is retired by teardown."
      gone=$((gone + 1))
      continue
    elif printf '%s' "$SHOW_ERR" | grep -qiE 'AuthorizationFailed|does not have authorization|Forbidden|\(403\)'; then
      # R6: name the role AND the scope — but only where a PERMISSION failure was
      # actually established. An earlier revision printed this remediation on
      # EVERY non-404, which asserts a cause the code had not determined (R7).
      echo "  UNKNOWN  ${APP}/${FN}: absent from the listing, and the direct read was DENIED — this is blindness, not deletion. Grant the running identity Reader on ${RG} (subscription ${SUB}) and re-run. ARM said: ${SHOW_TAIL}" >&2
      unknown=$((unknown + 1))
      continue
    else
      echo "  UNKNOWN  ${APP}/${FN}: absent from the listing, and a direct read did NOT establish absence — it failed with az rc=${SHOW_RC} for a reason this script has not classified, so it is neither a deletion nor a confirmed permission problem. Read the message before assuming either. ARM said: ${SHOW_TAIL}" >&2
      unknown=$((unknown + 1))
      continue
    fi
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
  #
  # Split into if/else rather than the old `[[ … ]] && ! az …` so the SUCCESS of
  # the write is recordable. WROTE is what the restart-lag arm after the reads
  # keys on, and "APPLY was off" must not look like "the write succeeded".
  if [[ $APPLY -eq 1 ]]; then
    if az functionapp config appsettings set -g "$RG" -n "$APP" \
         --subscription "$SUB" --settings "${SETTING}=true" -o none; then
      WROTE=1
    else
      echo "  APPLYFAIL ${APP}/${FN}: could not write ${SETTING} — the definition was NOT changed. Needs Microsoft.Web/sites/config/write (built-in role: Website Contributor) on /subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Web/sites/${APP}." >&2
      applyfail=$((applyfail + 1))
      FIXHINT="--apply was already tried on this run and was DENIED — grant the role named in the APPLYFAIL line above, then re-run with --apply."
    fi
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
  # Same CRLF strip as CLOUD and LISTED above. Without it, a Windows `-o tsv`
  # emits "true\r", the `== "true"` test at the verdict below is FALSE, the S3
  # lag arm is skipped on its `"$VAL" == "true"` guard, and a correctly
  # DISABLED timer is reported as an ENABLED double-execution hazard at rc=1,
  # permanently. Fail-closed in direction, wrong in fact.
  #
  # WHICH WORKSTATION SHELL, narrowed — the round-7 revision of this comment
  # said "this script is offered as the on-demand verifier an operator runs
  # from a workstation, which is exactly where that CR comes from", and that
  # is not true of every workstation shell. Measured 2026-09-18:
  #   Git Bash / MSYS : `V="$(printf 'a\r\n')"` yields `a`   — $() strips the
  #                     trailing CR as well as the LF, so VAL never carries one
  #                     and these strips are INERT there.
  #   Linux / WSL     : the same yields `a\r`                — $() strips LF
  #                     only, so the CR survives and these strips are the only
  #                     thing standing between a disabled timer and a false
  #                     hazard.
  # The reachable case is therefore WSL (or any Linux shell) driving a Windows
  # `az.exe`, plus the ubuntu-latest runner that op19 executes on — not Git
  # Bash. The strips are correct and load-bearing; the sentence justifying them
  # named the wrong shell, and is corrected rather than quietly dropped.
  # Witnessed by scripts/ci/__tests__/retired-function-timers-apply-lag.test.mjs
  # (`AZ_CR=1`), which is a REAL witness only on Linux for the same reason —
  # both strip deletions survive on Git Bash and are killed on WSL Ubuntu.
  VAL="${VAL//$'\r'/}"
  # Read 2 — what the Functions host computed from it. A host that exists but
  # cannot be read fails here rather than yielding a convenient empty string.
  if ! SHOWN="$(az functionapp function show -g "$RG" -n "$APP" --subscription "$SUB" \
                  --function-name "$FN" --query isDisabled -o tsv)"; then
    echo "  UNKNOWN  ${APP}/${FN}: the host EXISTS but its definition could not be read — NOT the same as disabled." >&2
    unknown=$((unknown + 1))
    continue
  fi
  SHOWN="${SHOWN//$'\r'/}"   # as at the retry read below; same reason as VAL.

  # RESTART LAG, and only in that exact shape. `appsettings set` RESTARTS the
  # Functions host, and read 2 is what the host has RECOMPUTED — so on the run
  # that writes the setting, read 2 can still answer with the pre-write value
  # and a correct --apply reports its own fix as a DOUBLE-EXECUTION HAZARD
  # (rc 1) seconds after disabling the timer. The two-independent-reads design
  # is kept; what is added is that a disagreement is re-measured ONCE THE WRITE
  # IS KNOWN TO HAVE LANDED, rather than scored immediately.
  #
  # FAILS CLOSED, deliberately. This arm cannot turn a real hazard into an OK:
  # a host that is genuinely still running the timer keeps answering `false`,
  # the loop exhausts, and the verdict is ENABLED exactly as before — carrying
  # LAGNOTE, which says the lag explanation was tested and rejected. A read
  # that FAILS mid-retry empties SHOWN rather than leaving the stale value, so
  # "unreadable" never presents as "disabled".
  #
  # A FAILED RE-READ IS NOT A DISAGREEMENT, and this arm used to conflate them.
  # An earlier revision broke out of the loop on a failed `show`, emptied SHOWN,
  # fell into the SAME `!= "true"` branch as a genuine disagreement, and emitted
  # LAGNOTE — which then asserted three things the run had not established:
  #   1. `~$((RETRY_UNIT * 6))s` elapsed, a constant that is only true when all
  #      three attempts ran, printed after a single sleep. 6x overstated.
  #   2. "without agreeing", when the host had not answered at all.
  #   3. "so this is NOT a host-restart lag", when a host mid-restart is exactly
  #      the state that makes `function show` fail — so the sentence ruled out
  #      the hypothesis it was least able to rule out.
  # That is deploy-integrity.md R7 inside the file whose own header preaches
  # ABSENCE IS NOT UNREADABILITY, and the consequence was the ROUTING: FIXHINT
  # stayed "Re-run with --apply", so an operator whose re-read hit a 429 or an
  # expiring token was told the lag explanation had been tested and rejected and
  # sent to re-apply. Both independent reviews of #4564 on 2026-09-21 found it.
  #
  # AND THE FIX FOR THAT R7 VIOLATION COMMITTED A SMALLER ONE, corrected here.
  # The replacement UNKNOWN line reported the retained observation as a value
  # "which predates the restart" — and this script holds no restart timestamp
  # and no host-uptime read. It knows only that the write returned 0 and that a
  # later read answered. WHETHER that read landed before the host finished
  # restarting is exactly what this arm exists to refuse to decide, and the next
  # sentence of the same message says so, so the two contradicted each other:
  # had the value provably predated the restart, the run WOULD have established
  # the lag. What the script can establish is the ORDERING against the write,
  # which is all the line now claims.
  #
  # So the break path is SEPARATED and scored the way this file scores every
  # other unreadable definition: UNKNOWN, rc 2, refusing a verdict. It is the
  # same failure as the pre-loop `function show` above and gets the same
  # classification; the only difference is that a write happened first, which
  # the message says. ENABLED-outranks-UNKNOWN is NOT weakened by this — that
  # precedence is about a CONFIRMED hazard, and nothing here was confirmed. The
  # lane stays red either way: loom-drift-check.yml emits an `::error::` and
  # exits non-zero on rc 2 as well as on rc 1.
  #
  # ELAPSED AND COUNT ARE ACCUMULATED, not derived from the loop bounds, so a
  # change to those bounds cannot silently falsify the sentence the way
  # `RETRY_UNIT * 6` did.
  #
  # WHAT VALUE MAKES THIS ARM RUN: SHOWN="false" on the first read after a
  # successful write. WHAT VALUE STILL FAILS THE RUN AS ENABLED: SHOWN="false"
  # on all three. WHAT VALUE ROUTES IT TO UNKNOWN INSTEAD: a `function show`
  # that FAILS mid-retry. WHAT VALUE SKIPS IT ENTIRELY: WROTE=0 — a verify-only
  # run is scored exactly as it was, so the default read-only path is unchanged.
  if [[ $WROTE -eq 1 && "$VAL" == "true" && "$SHOWN" != "true" ]]; then
    REREAD_FAILED=0   # did the loop exit because a read FAILED, not disagreed?
    REREADS=0         # re-reads that actually RETURNED a value
    SLEPT=0           # seconds actually slept, summed as they are slept
    LAST_SEEN="$SHOWN"  # the last value the host ACTUALLY returned. Kept
                        # because SHOWN is emptied on a failed read, and an
                        # UNKNOWN that throws away the observation it DID make
                        # is R6-poor even when it is R7-honest: "1 re-read
                        # returned a value" never says WHICH value.
    # THE PRE-LOOP SEED ABOVE IS WITNESSED; THE IN-LOOP UPDATE FURTHER DOWN WAS
    # NOT, and both are read by the same message, so the obvious arm cannot tell
    # them apart. In the AZ_SHOW_TRUE_FROM=4 / AZ_SHOW_FAIL_AT=3 fixture the
    # seeded value and the one value a re-read returned are BOTH `false`, so
    # replacing the in-loop assignment with a no-op left the suite 13/13 green
    # at afc5d291834e — an unwitnessed line counted as covered.
    # `assertion-design.md` item 5 disclosure would be the wrong remedy here:
    # the line is not an equivalent mutant, only an uncovered one, so it gets a
    # fixture instead. WHAT VALUE KILLS THE IN-LOOP UPDATE: a re-read that
    # SUCCEEDS carrying a value different from the seed — an `az` exiting 0 and
    # printing nothing, so the host's own last answer is empty where the
    # pre-loop read said `false`. With the update the line reports
    # `isDisabled=<unset>`, which is what the host last actually returned;
    # without it, `isDisabled=false`, a superseded value published as the last
    # one returned. Witnessed by the AZ_SHOW_EMPTY_AT arm in
    # scripts/ci/__tests__/retired-function-timers-apply-lag.test.mjs.
    for attempt in 1 2 3; do
      sleep $((attempt * RETRY_UNIT))
      SLEPT=$((SLEPT + attempt * RETRY_UNIT))
      if ! SHOWN="$(az functionapp function show -g "$RG" -n "$APP" --subscription "$SUB" \
                      --function-name "$FN" --query isDisabled -o tsv)"; then
        SHOWN=""
        REREAD_FAILED=1
        break
      fi
      REREADS=$((REREADS + 1))
      SHOWN="${SHOWN//$'\r'/}"
      LAST_SEEN="$SHOWN"
      if [[ "$SHOWN" == "true" ]]; then
        break
      fi
    done
    if [[ $REREAD_FAILED -eq 1 ]]; then
      echo "  UNKNOWN  ${APP}/${FN}: the --apply write SUCCEEDED and ${SETTING} reads true, but the post-write re-read of isDisabled COULD NOT BE PERFORMED — ${REREADS} re-read(s) returned a value and ~${SLEPT}s were waited before a read failed. The last value the host actually returned was isDisabled=${LAST_SEEN:-<unset>}; it was read AFTER the write, but this run did not establish whether the host had finished restarting by then, so it may be stale. This run did NOT establish whether the write took effect, and it does NOT rule out a host-restart lag. NEXT: the write already landed, so re-run this script WITHOUT --apply in a minute or two — a plain verify settles it and changes nothing. If the re-read keeps failing, the fault is in the READ, not the write: a 429/5xx is transient and a re-run clears it, while a persistent failure means the identity lacks Microsoft.Web/sites/functions/read on /subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Web/sites/${APP}." >&2
      unknown=$((unknown + 1))
      continue
    fi
    if [[ "$SHOWN" != "true" ]]; then
      LAGNOTE=" The --apply write on this run SUCCEEDED and ${SETTING} reads true, and isDisabled was re-read ${REREADS} more time(s) over ~${SLEPT}s without agreeing — so this is NOT a host-restart lag."
    fi
  fi

  if [[ "$VAL" == "true" && "$SHOWN" == "true" ]]; then
    echo "  OK       ${APP}/${FN}: ${SETTING}=${VAL}, isDisabled=${SHOWN}"
    ok=$((ok + 1))
  else
    echo "  ENABLED  ${APP}/${FN}: ${SETTING}=${VAL:-<unset>}, isDisabled=${SHOWN:-<unset>} — DOUBLE-EXECUTION HAZARD against its ACA job twin.${LAGNOTE} ${FIXHINT}" >&2
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
