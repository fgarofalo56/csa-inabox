#!/usr/bin/env bash
# gov-vanity-domain-repair.sh: diagnose, and in MODE=repair re-attach, the console's
# vanity custom domain on the Front Door profile in $RG. Called by
# .github/workflows/gov-vanity-domain-repair.yml after `az login` + `az cloud set`.
#
# Env: MODE (diagnose|repair), VANITY_HOST, RG.
# Exit: 0 = the vanity host is Approved and served by a route (after a repair, if one
# was needed); 1 = a read failed, or the host is unbound / not Approved / missing and
# this run did not (or could not) fix it.
#
# Every ARM call goes through `arm`, which fails the run with the call's own error text
# rather than turning a failed read into an empty answer (deploy-integrity.md R7).
# The custom domain's validation token is never printed.
set -uo pipefail

: "${MODE:?}" "${VANITY_HOST:?}" "${RG:?}"
API="api-version=2021-06-01"
mkdir -p temp
ERR="temp/gov-vanity.err"

arm() { # arm <method> <url> [body-file]  -> response JSON on stdout
  local method="$1" url="$2" body="${3:-}" out
  if [ -n "$body" ]; then
    out=$(az rest --method "$method" --url "$url" --body "@$body" --headers "Content-Type=application/json" 2> "$ERR") || {
      echo "::error::ARM $method failed for ${url%%\?*}: $(head -c 400 "$ERR")" >&2; return 1; }
  else
    out=$(az rest --method "$method" --url "$url" 2> "$ERR") || {
      echo "::error::ARM $method failed for ${url%%\?*}: $(head -c 400 "$ERR")" >&2; return 1; }
  fi
  printf '%s' "$out"
}

RM=$(az cloud show --query endpoints.resourceManager -o tsv 2> "$ERR" | tr -d '[:space:]') || { echo "::error::could not read the az cloud endpoint: $(head -c 300 "$ERR")"; exit 1; }
RM=${RM%/}
SUB=$(az account show --query id -o tsv 2> "$ERR" | tr -d '[:space:]') || { echo "::error::could not read the signed-in subscription: $(head -c 300 "$ERR")"; exit 1; }
BASE="$RM/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Cdn/profiles"
WANT=$(printf '%s' "$VANITY_HOST" | tr '[:upper:]' '[:lower:]')

PROFILES_JSON=$(arm get "$BASE?$API") || exit 1
mapfile -t PROFILES < <(jq -r '.value[].name' <<< "$PROFILES_JSON")
if [ "${#PROFILES[@]}" -eq 0 ]; then
  echo "::error::No Front Door profile in $RG (the list call succeeded, so this is a measured absence). There is nothing for $VANITY_HOST to be bound to."
  exit 1
fi

FOUND=0
for P in "${PROFILES[@]}"; do
  echo "== profile $P"
  CDS=$(arm get "$BASE/$P/customDomains?$API") || exit 1
  echo "-- custom domains (validation token deliberately not shown)"
  jq -r '.value[] | "   \(.name)  host=\(.properties.hostName)  validation=\(.properties.domainValidationState)  deployment=\(.properties.deploymentStatus)  provisioning=\(.properties.provisioningState)  cert=\(.properties.tlsSettings.certificateType // "none")  validationExpires=\(.properties.validationProperties.expirationDate // "n/a")"' <<< "$CDS"

  CD_ID=$(jq -r --arg h "$WANT" '[.value[] | select((.properties.hostName | ascii_downcase) == $h)][0].id // ""' <<< "$CDS")
  [ -n "$CD_ID" ] || continue
  FOUND=1
  CD_STATE=$(jq -r --arg h "$WANT" '[.value[] | select((.properties.hostName | ascii_downcase) == $h)][0].properties.domainValidationState // "Unknown"' <<< "$CDS")
  CD_LC=$(printf '%s' "$CD_ID" | tr '[:upper:]' '[:lower:]')

  # Every route of every endpoint, and which custom domains each serves.
  EPS=$(arm get "$BASE/$P/afdEndpoints?$API") || exit 1
  BOUND_TO=""
  CONSOLE_ROUTE_URLS=()
  for EP in $(jq -r '.value[].name' <<< "$EPS"); do
    ROUTES=$(arm get "$BASE/$P/afdEndpoints/$EP/routes?$API") || exit 1
    echo "-- routes of endpoint $EP"
    jq -r '.value[] | "   \(.name)  state=\(.properties.enabledState)  patterns=\(.properties.patternsToMatch | join(","))  customDomains=\([.properties.customDomains[]?.id | split("/") | last] | join(",") | if . == "" then "(none)" else . end)"' <<< "$ROUTES"
    HIT=$(jq -r --arg id "$CD_LC" '.value[] | select([.properties.customDomains[]?.id | ascii_downcase] | index($id)) | .name' <<< "$ROUTES")
    [ -n "$HIT" ] && BOUND_TO="$BOUND_TO $EP/$HIT"
    for R in $(jq -r '.value[] | select(.name == "console-route") | .name' <<< "$ROUTES"); do
      CONSOLE_ROUTE_URLS+=("$BASE/$P/afdEndpoints/$EP/routes/$R")
    done
  done

  # WAF association is reported, not repaired here: it does not decide which
  # certificate the edge presents.
  SPS=$(arm get "$BASE/$P/securityPolicies?$API") || exit 1
  if jq -e --arg id "$CD_LC" '[.value[].properties.parameters.associations[]?.domains[]?.id | ascii_downcase] | index($id)' <<< "$SPS" > /dev/null; then
    echo "   WAF: $VANITY_HOST is covered by a security policy."
  else
    echo "::warning::$VANITY_HOST is not listed in any Front Door security policy, so the console WAF does not inspect traffic on it. A deploy-fiab-gcch apply that carries the vanity domain restores it (front-door.bicep keeps the policy's domains equal to the route's)."
  fi

  if [ "$CD_STATE" != "Approved" ]; then
    echo "::error::$VANITY_HOST is $CD_STATE, not Approved. Front Door will not issue or serve its managed certificate until the domain re-validates: the _dnsauth TXT record at the DNS provider must hold the profile's current validation token (portal: Front Door > Domains > $VANITY_HOST). This workflow cannot do that; it is a DNS-provider action."
    exit 1
  fi

  if [ -n "$BOUND_TO" ]; then
    echo "::notice::$VANITY_HOST is Approved and served by route(s):$BOUND_TO. The route binding is NOT the defect; read the deployment/provisioning state above and the certificate step below."
    exit 0
  fi

  echo "::error::VANITY DOMAIN UNBOUND: $VANITY_HOST is Approved but no route in profile $P lists it, so the edge answers it with the fallback certificate."
  if [ "$MODE" != "repair" ]; then
    echo "Re-run with mode=repair to attach it to console-route."
    exit 1
  fi
  if [ "${#CONSOLE_ROUTE_URLS[@]}" -ne 1 ]; then
    echo "::error::Expected exactly one route named console-route in profile $P, found ${#CONSOLE_ROUTE_URLS[@]}. Refusing to guess which route should serve $VANITY_HOST."
    exit 1
  fi
  URL="${CONSOLE_ROUTE_URLS[0]}"
  CUR=$(arm get "$URL?$API") || exit 1
  jq --arg id "$CD_ID" '{properties: {customDomains: ([.properties.customDomains[]? | {id}] + [{id: $id}] | unique_by(.id | ascii_downcase))}}' <<< "$CUR" > temp/gov-vanity-patch.json
  echo "PATCH ${URL##*/profiles/}: customDomains -> $(jq -c '[.properties.customDomains[].id | split("/") | last]' temp/gov-vanity-patch.json)"
  arm patch "$URL?$API" temp/gov-vanity-patch.json > /dev/null || exit 1

  # Read back until ARM reports the route Succeeded WITH the domain, bounded.
  for i in $(seq 1 20); do
    BACK=$(arm get "$URL?$API") || exit 1
    PS=$(jq -r '.properties.provisioningState' <<< "$BACK")
    HAS=$(jq -r --arg id "$CD_LC" '[.properties.customDomains[]?.id | ascii_downcase] | index($id) != null' <<< "$BACK")
    echo "   read-back $i: provisioning=$PS bound=$HAS"
    if [ "$PS" = "Succeeded" ] && [ "$HAS" = "true" ]; then
      echo "::notice::Repaired: console-route now serves $VANITY_HOST (read back from ARM). Edge propagation can take several minutes."
      exit 0
    fi
    [ "$PS" = "Failed" ] && { echo "::error::The route update reports provisioningState=Failed."; exit 1; }
    sleep 15
  done
  echo "::error::After 5 minutes the route has not read back as Succeeded with $VANITY_HOST bound. The PATCH was accepted; the outcome is NOT confirmed."
  exit 1
done

if [ "$FOUND" -eq 0 ]; then
  echo "::error::No custom domain resource for $VANITY_HOST exists in any Front Door profile in $RG (the list calls succeeded). Creating one needs DNS validation at the provider; a deploy-fiab-gcch apply with loomVanityDomain=$VANITY_HOST creates it and emits the TXT record to add."
  exit 1
fi
