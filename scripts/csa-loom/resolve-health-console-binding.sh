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
#   LOOM_HEALTH_CP_AUDIENCE       api://<appId>; appId from $HEALTH_CP_APP_CLIENT_ID (OPTIONAL repo variable
#                                 LOOM_HEALTH_CP_APP_CLIENT_ID), else the ONE Entra app named loom-health-cp
#                                 (the default path: no variable needs to exist)
#
# This script NEVER fails the deploy it runs ahead of: a health-only value must not take the whole
# daily admin-plane apply down (deploy-integrity R1). It reports through $GITHUB_OUTPUT instead:
#   health_binding=resolved   all three exported from the estate
#   health_binding=absent     no loom-health-cp app (LHDS not deployed is legitimate); nothing exported
#   health_binding=preserved  a lookup was UNKNOWN/ambiguous, so the values the live loom-console already
#                             carries were exported unchanged (a transient error cannot blank them); ::warning::
#   health_binding=unknown    a lookup was UNKNOWN/ambiguous AND the live values could not be read either;
#                             nothing exported (values render empty, as before); ::error:: and a follow-on
#                             step after the apply turns the run red (R6/R7: never green over an unmeasured state)
#   health_binding_reason     one line saying why (unknown / preserved)
# Exit status: 0 always, except 2 for bad arguments.
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
OUT="${GITHUB_ENV:-/dev/stdout}"
GHOUT="${GITHUB_OUTPUT:-/dev/null}"

emit() { # $1 = state, $2 = reason (single line)
  {
    echo "health_binding=$1"
    echo "health_binding_reason=$(printf '%s' "$2" | tr '\r\n' '  ' | head -c 400)"
  } >> "$GHOUT"
}

# Export the non-empty values the LIVE loom-console already carries. Returns 0 when at least one was exported.
preserve() {
  if ! az containerapp list "${SUBARG[@]}" --query "[?name=='loom-console'].{env:properties.template.containers[0].env}" -o json > "$TMP/console.json" 2> "$TMP/console.err"; then
    return 1
  fi
  [ "$(jq 'length' "$TMP/console.json" 2> /dev/null)" = "1" ] || return 1
  local n v got=1
  for n in LOOM_HEALTH_CP_URL LOOM_HEALTH_CP_AUDIENCE LOOM_HEALTH_DEFAULT_STAMP_ID; do
    v=$(jq -r --arg n "$n" '[.[0].env[]? | select(.name==$n) | .value] | first // ""' "$TMP/console.json" 2> /dev/null)
    if [ -n "$v" ] && [ "$v" != "null" ]; then echo "$n=$v" >> "$OUT"; got=0; fi
  done
  return "$got"
}

# $1 = what is unknown. Never exits non-zero: preserve what is live, else report UNKNOWN.
unknown() {
  if preserve; then
    echo "::warning::$1 The console health values already on the live loom-console were carried through unchanged, so this deploy does not blank them."
    emit preserved "$1"
  else
    echo "::error::$1 The live loom-console values could not be read either, so the console health binding is UNKNOWN and may render empty after this deploy. The deploy itself was not stopped; the run is failed at the end so this is not green over an unmeasured state."
    emit unknown "$1"
  fi
  exit 0
}

az containerapp list "${SUBARG[@]}" --query "[?name=='loom-health-cp'].{rg:resourceGroup,fqdn:properties.configuration.ingress.fqdn}" -o json > "$TMP/cp.json" 2> "$TMP/cp.err"
RC=$?
[ "$RC" = "0" ] || unknown "Could not list Container Apps to find loom-health-cp (az exit $RC: $(head -c 300 "$TMP/cp.err")). Whether the health control plane exists is UNKNOWN."
N=$(jq 'length' "$TMP/cp.json" 2> /dev/null)
printf '%s' "$N" | grep -Eq '^[0-9]+$' || unknown "The loom-health-cp lookup returned output that could not be parsed as a JSON list (got '$(head -c 120 "$TMP/cp.json")'), so whether the health control plane exists is UNKNOWN (not a claim that it is missing)."
if [ "$N" = "0" ]; then
  echo "::notice::No loom-health-cp Container App in this subscription (LHDS not deployed); the console health binding is left empty."
  emit absent "no loom-health-cp Container App in this subscription"
  exit 0
fi
[ "$N" = "1" ] || unknown "Found $N Container Apps named loom-health-cp; exactly 1 is required and this lane will not guess which one the console should use."

FQDN=$(jq -r '.[0].fqdn // ""' "$TMP/cp.json")
CPRG=$(jq -r '.[0].rg // ""' "$TMP/cp.json")
[ -n "$FQDN" ] || unknown "loom-health-cp exists in '$CPRG' but reports no ingress FQDN, so its URL is UNKNOWN."
STAMP=$(printf '%s' "$CPRG" | sed -nE 's/^rg-csa-loom-health-(.+)-[a-z0-9]+$/\1/p')
[ -n "$STAMP" ] || unknown "loom-health-cp is in resource group '$CPRG', which does not match rg-csa-loom-health-<stamp>-<region>, so the stamp id is UNKNOWN."

APP="${HEALTH_CP_APP_CLIENT_ID:-}"
SRC="repository variable LOOM_HEALTH_CP_APP_CLIENT_ID"
if [ -z "$APP" ]; then
  SRC="Entra lookup by display name loom-health-cp"
  az ad app list --filter "displayName eq 'loom-health-cp'" --query "[].appId" -o json > "$TMP/app.json" 2> "$TMP/app.err"
  RC=$?
  [ "$RC" = "0" ] || unknown "Could not read Entra to find the app loom-health-cp (az exit $RC: $(head -c 300 "$TMP/app.err")). Whether it exists is UNKNOWN. Optionally set the repository variable LOOM_HEALTH_CP_APP_CLIENT_ID."
  AN=$(jq 'length' "$TMP/app.json" 2> /dev/null)
  printf '%s' "$AN" | grep -Eq '^[0-9]+$' || unknown "The Entra lookup for loom-health-cp returned output that could not be parsed as a JSON list (got '$(head -c 120 "$TMP/app.json")'), so whether the app exists is UNKNOWN."
  [ "$AN" != "0" ] || unknown "loom-health-cp is deployed ($FQDN) but no Entra app named loom-health-cp was found, so the console audience cannot be resolved. Create the app registration or set the repository variable LOOM_HEALTH_CP_APP_CLIENT_ID."
  [ "$AN" = "1" ] || unknown "Found $AN Entra apps named loom-health-cp; exactly 1 is required and this lane will not guess. Set the repository variable LOOM_HEALTH_CP_APP_CLIENT_ID to choose."
  APP=$(jq -r '.[0]' "$TMP/app.json")
fi
printf '%s' "$APP" | grep -Eq "$GUID" || unknown "The control plane app client id from the $SRC is not a GUID."

{
  echo "LOOM_HEALTH_CP_URL=https://$FQDN"
  echo "LOOM_HEALTH_CP_AUDIENCE=api://$APP"
  echo "LOOM_HEALTH_DEFAULT_STAMP_ID=$STAMP"
} >> "$OUT"
echo "::notice::console health binding resolved from the estate: control plane in $CPRG, stamp $STAMP, audience from the $SRC (ids and URLs, not secrets)."
emit resolved "control plane $CPRG, stamp $STAMP"
exit 0
