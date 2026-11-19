#!/usr/bin/env bash
# resolve-health-console-binding.sh (#5346) - resolve the three values loom-console needs to reach the
# LHDS health control plane, from the DEPLOYED ESTATE, so a bicep re-render of loom-console carries them
# instead of blanking them.
#
# Why: admin-plane/main.bicep renders LOOM_HEALTH_CP_URL / LOOM_HEALTH_CP_AUDIENCE /
# LOOM_HEALTH_DEFAULT_STAMP_ID from observabilityConfig.healthCp*, default empty. deploy-health.yml binds
# them with `az containerapp update`; the SCHEDULED deploy-fiab-* lane then re-rendered loom-console and
# blanked them (revision --0001214, 2026-11-18). The *.bicepparam files read these three env vars with
# readEnvironmentVariable(); this script exports them before the what-if/apply.
#
# Source of truth (never a guess):
#   LOOM_HEALTH_CP_URL            https:// + ingress FQDN of the ONE Container App named loom-health-cp
#   LOOM_HEALTH_DEFAULT_STAMP_ID  <stamp> from that app's resource group rg-csa-loom-health-<stamp>-<region>
#                                 (health.bicep names the stamp RG that way, so this AGREES with the
#                                 healthStamp.stampName deploy-health.yml binds)
#   LOOM_HEALTH_CP_AUDIENCE       api://<appId>; appId from $HEALTH_CP_APP_CLIENT_ID (repo variable
#                                 LOOM_HEALTH_CP_APP_CLIENT_ID), else the ONE Entra app named loom-health-cp
#
# Outcomes:
#   no loom-health-cp app            -> exports NOTHING, ::notice:: (LHDS not deployed is legitimate), exit 0
#   exactly one                      -> exports all three, exit 0
#   more than one / az error / unparseable output -> exit 1; says the state is UNKNOWN where it is
#                                      (deploy-integrity R7: "could not look" is never "not there")
# Output: KEY=VALUE lines appended to $GITHUB_ENV, or to stdout when GITHUB_ENV is unset.
# Usage: resolve-health-console-binding.sh [--subscription <id>]
set -uo pipefail
# The runner shell is `bash -e`; without this a failing `az ... 2> file` ends the script before the RC check.
set +e

SUB=""
while [ $# -gt 0 ]; do
  case "$1" in
    --subscription) SUB="${2:-}"; shift 2 ;;
    *) echo "::error::unknown argument '$1'"; exit 2 ;;
  esac
done
SUBARG=()
[ -n "$SUB" ] && SUBARG=(--subscription "$SUB")

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
GUID='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
fail() { echo "::error::$1"; exit 1; }

az containerapp list "${SUBARG[@]}" --query "[?name=='loom-health-cp'].{rg:resourceGroup,fqdn:properties.configuration.ingress.fqdn}" -o json > "$TMP/cp.json" 2> "$TMP/cp.err"
RC=$?
[ "$RC" = "0" ] || fail "could not list Container Apps to find loom-health-cp (az exit $RC: $(head -c 300 "$TMP/cp.err")). Whether the health control plane exists is UNKNOWN, so the console binding was NOT resolved."
N=$(jq 'length' "$TMP/cp.json" 2> /dev/null)
printf '%s' "$N" | grep -Eq '^[0-9]+$' || fail "the loom-health-cp lookup returned output that could not be parsed as a JSON list (got '$(head -c 120 "$TMP/cp.json")'), so whether the health control plane exists is UNKNOWN (not a claim that it is missing)."
if [ "$N" = "0" ]; then
  echo "::notice::No loom-health-cp Container App in this subscription (LHDS not deployed); the console health binding is left empty."
  exit 0
fi
[ "$N" = "1" ] || fail "found $N Container Apps named loom-health-cp; exactly 1 is required and this lane will not guess which one the console should use."

FQDN=$(jq -r '.[0].fqdn // ""' "$TMP/cp.json")
CPRG=$(jq -r '.[0].rg // ""' "$TMP/cp.json")
[ -n "$FQDN" ] || fail "loom-health-cp exists in '$CPRG' but reports no ingress FQDN, so its URL is UNKNOWN."
STAMP=$(printf '%s' "$CPRG" | sed -nE 's/^rg-csa-loom-health-(.+)-[a-z0-9]+$/\1/p')
[ -n "$STAMP" ] || fail "loom-health-cp is in resource group '$CPRG', which does not match rg-csa-loom-health-<stamp>-<region>, so the stamp id is UNKNOWN."

APP="${HEALTH_CP_APP_CLIENT_ID:-}"
SRC="repository variable LOOM_HEALTH_CP_APP_CLIENT_ID"
if [ -z "$APP" ]; then
  SRC="Entra lookup by display name loom-health-cp"
  az ad app list --filter "displayName eq 'loom-health-cp'" --query "[].appId" -o json > "$TMP/app.json" 2> "$TMP/app.err"
  RC=$?
  [ "$RC" = "0" ] || fail "could not read Entra to find the app loom-health-cp (az exit $RC: $(head -c 300 "$TMP/app.err")). Whether it exists is UNKNOWN. Set the repository variable LOOM_HEALTH_CP_APP_CLIENT_ID or grant the deploy identity Graph Application.Read.All."
  AN=$(jq 'length' "$TMP/app.json" 2> /dev/null)
  printf '%s' "$AN" | grep -Eq '^[0-9]+$' || fail "the Entra lookup for loom-health-cp returned output that could not be parsed as a JSON list (got '$(head -c 120 "$TMP/app.json")'), so whether the app exists is UNKNOWN."
  if [ "$AN" = "0" ]; then
    echo "::warning::loom-health-cp is deployed ($FQDN) but no Entra app named loom-health-cp was found, so the console audience cannot be resolved; the console health binding is left empty. Set the repository variable LOOM_HEALTH_CP_APP_CLIENT_ID."
    exit 0
  fi
  [ "$AN" = "1" ] || fail "found $AN Entra apps named loom-health-cp; exactly 1 is required and this lane will not guess."
  APP=$(jq -r '.[0]' "$TMP/app.json")
fi
printf '%s' "$APP" | grep -Eq "$GUID" || fail "the control plane app client id from the $SRC is not a GUID."

OUT="${GITHUB_ENV:-/dev/stdout}"
{
  echo "LOOM_HEALTH_CP_URL=https://$FQDN"
  echo "LOOM_HEALTH_CP_AUDIENCE=api://$APP"
  echo "LOOM_HEALTH_DEFAULT_STAMP_ID=$STAMP"
} >> "$OUT"
echo "::notice::console health binding resolved from the estate: control plane in $CPRG, stamp $STAMP, audience from the $SRC (ids and URLs, not secrets)."
exit 0
