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
# POSITIVE CONTROL: the script first proves it can SEE a function definition at
# all (the apps index 3 definitions between them). A host that has gone away, or
# an `az` that cannot reach it, must not read as "disabled" — absence is
# reported as UNKNOWN and exits non-zero (deploy-integrity.md R7).
#
# Usage:
#   scripts/csa-loom/check-retired-function-timers.sh            # verify only
#   scripts/csa-loom/check-retired-function-timers.sh --apply    # re-disable
#
# --apply writes app settings only. It never deletes anything. Teardown of the
# hosts themselves is a separate operator action — see
# docs/fiab/deployment/functions-to-aca-jobs.md §7.
set -euo pipefail

SUB="${LOOM_ADMIN_SUBSCRIPTION:-e093f4fd-5047-4ee4-968d-a56942c665f3}"
RG="${LOOM_ADMIN_RG:-rg-csa-loom-admin-centralus}"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

# Boundary guard (mirrors scripts/measure/estate-resume.mjs): this is the
# Commercial admin plane by construction. Per csa_loom_gov_verify_via_actions a
# sovereign boundary is never touched from a workstation `az`, so refuse rather
# than act on whatever cloud the ambient session happens to be on.
CLOUD="$(az account show --query environmentName -o tsv)"
if [[ "$CLOUD" != "AzureCloud" ]]; then
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

rc=0
seen=0
for t in "${TARGETS[@]}"; do
  APP="${t%%|*}"; FN="${t##*|}"
  SETTING="AzureWebJobs.${FN}.Disabled"

  if [[ $APPLY -eq 1 ]]; then
    az functionapp config appsettings set -g "$RG" -n "$APP" --subscription "$SUB" \
      --settings "${SETTING}=true" -o none
  fi

  # Read 1 — the app setting an operator writes.
  VAL="$(az functionapp config appsettings list -g "$RG" -n "$APP" --subscription "$SUB" \
          --query "[?name=='${SETTING}'].value | [0]" -o tsv)"
  # Read 2 — what the Functions host computed from it. A host that cannot be
  # reached fails here rather than yielding a convenient empty string.
  if ! SHOWN="$(az functionapp function show -g "$RG" -n "$APP" --subscription "$SUB" \
                  --function-name "$FN" --query isDisabled -o tsv)"; then
    echo "  UNKNOWN  ${APP}/${FN}: the definition could not be read — NOT the same as disabled." >&2
    rc=1
    continue
  fi
  seen=$((seen + 1))

  if [[ "$VAL" == "true" && "$SHOWN" == "true" ]]; then
    echo "  OK       ${APP}/${FN}: ${SETTING}=${VAL}, isDisabled=${SHOWN}"
  else
    echo "  ENABLED  ${APP}/${FN}: ${SETTING}=${VAL:-<unset>}, isDisabled=${SHOWN:-<unset>} — DOUBLE-EXECUTION HAZARD against its ACA job twin. Re-run with --apply." >&2
    rc=1
  fi
done

# Positive control: if we resolved NO definition at all, the loop above proved
# nothing and a rc=0 would be a green over an empty set.
if [[ "$seen" -eq 0 ]]; then
  echo "REFUSING a verdict: zero function definitions were readable, so this run measured nothing." >&2
  exit 2
fi
echo "definitions read: ${seen}/${#TARGETS[@]}"
exit "$rc"
