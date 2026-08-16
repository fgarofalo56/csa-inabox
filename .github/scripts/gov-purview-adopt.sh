#!/usr/bin/env bash
# gov-purview-adopt.sh — the deploy-gov.yml adapter for the Purview adopt plan.
#
# Turns the workflow's three inputs into an invocation of
# scripts/csa-loom/discover-purview-adopt-plan.sh and leaves the resulting ARM
# parameters envelope at $RUNNER_TEMP/adopt.json, which both the What-If and
# Deploy steps pass to `az deployment sub`.
#
# WHY IT IS A FILE AND NOT AN INLINE `run:` BLOCK
#   The inputs are attacker-controllable strings on a workflow_dispatch. Reading
#   them from the environment here — rather than interpolating `${{ }}` into a
#   shell body — means no input value is ever parsed as shell.
#
# WHY THE REGION IS READ FROM THE PARAMS FILE
#   The quota this reasons about is per-tenant PER-REGION, so asking about the
#   wrong region would produce a confident answer about the wrong thing. The
#   params file is the same artifact the deployment itself is given, so the two
#   cannot disagree.
#
# Expects: PARAMS_FILE, PURVIEW_ACCOUNT, PURVIEW_ACCOUNT_RG, RUNNER_TEMP.
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP must be set (this script is meant to run on a GitHub runner)}"
PARAMS_FILE="${PARAMS_FILE:?PARAMS_FILE must be set}"
PURVIEW_ACCOUNT="${PURVIEW_ACCOUNT:-}"
PURVIEW_ACCOUNT_RG="${PURVIEW_ACCOUNT_RG:-}"

PARAMS_PATH="deploy/bicep/gov/${PARAMS_FILE}"
if [ ! -f "$PARAMS_PATH" ]; then
  echo "::error::gov-purview-adopt: parameters file '$PARAMS_PATH' does not exist, so the target region cannot be determined." >&2
  exit 1
fi

LOCATION="$(jq -r '.parameters.location.value // empty' "$PARAMS_PATH")"
if [ -z "$LOCATION" ]; then
  echo "::error::gov-purview-adopt: '$PARAMS_PATH' declares no .parameters.location.value. Refusing to guess a region — the Purview cap is per-region, so a guess would be a confident answer about the wrong place." >&2
  exit 1
fi
echo "gov-purview-adopt: target region '$LOCATION' (read from $PARAMS_PATH)"

ARGS=(--location "$LOCATION" --out "$RUNNER_TEMP/adopt.json")

case "$PURVIEW_ACCOUNT" in
  '')
    echo "gov-purview-adopt: no account supplied — discovering what the tenant already owns."
    ;;
  NEW | new | New)
    # The explicit "deploy a new one" answer. It is honoured, and the script
    # still refuses it up front if it can SEE the region is already full.
    echo "gov-purview-adopt: purview_account='NEW' — a brand-new account will be requested."
    ARGS+=(--create-new)
    ;;
  *)
    echo "gov-purview-adopt: binding the supplied account '$PURVIEW_ACCOUNT'."
    ARGS+=(--account "$PURVIEW_ACCOUNT")
    ;;
esac

if [ -n "$PURVIEW_ACCOUNT_RG" ]; then
  ARGS+=(--account-rg "$PURVIEW_ACCOUNT_RG")
fi

bash scripts/csa-loom/discover-purview-adopt-plan.sh "${ARGS[@]}"

# Echo the plan into the log. An adoption that is not visible in the run record
# is a binding nobody can audit afterwards.
echo "gov-purview-adopt: adopt plan submitted to ARM:"
jq -c '.parameters.adopt.value' "$RUNNER_TEMP/adopt.json"
