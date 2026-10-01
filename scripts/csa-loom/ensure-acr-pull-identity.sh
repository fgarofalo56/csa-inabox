#!/usr/bin/env bash
# =============================================================================
# ensure-acr-pull-identity.sh — make sure loom-unity's dedicated identity can
# pull from the registry, or stop with the exact grant to run
# =============================================================================
#
# WHY THIS EXISTS
#
# gov-uc-purview-wire.yml deployed loom-unity with the dedicated
# `uami-loom-unity-<region>` as its registry pull identity without checking
# that it could pull. On 2026-09-30 (run 36774518931) the new revision never
# started and ARM reported only "Operation expired"; the next day the
# gov-bff-verify diagnostics (run 36804850561) read `acrpull=no` for that
# identity, the probable cause. admin-plane/main.bicep grants it AcrPull
# (loomUnityAcrPull), but only on a deploy that reached that resource with
# `loomUnityActive && !skipRoleGrants`.
#
# The catalog runs ONLY as the dedicated identity: `unityUamiId` is the app's
# own identity and AZURE_CLIENT_ID as well as its pull identity
# (loom-unity-app.bicep), and main.bicep's loomUnityUami is "never the Console
# UAMI". So there is NO fallback to another identity: if the dedicated one
# cannot pull, this script stops and prints the grant to run.
#
# WHAT IT DOES
#
#   1. Reads the dedicated identity (by name) and the registry id. If the
#      identity does not exist, it stops (exit 1) with how to create it.
#   2. If the identity holds a pull-capable role on the registry (AcrPull,
#      AcrPush, Contributor or Owner, at the registry scope or inherited from
#      above it), it is used. No grant.
#   3. Otherwise it tries to grant AcrPull (role definition
#      7f951dda-4ed3-4680-a7ca-43fe172d538d, the id main.bicep uses) on the
#      registry scope, then polls the role assignment list (bounded) and
#      settles. If the grant is refused, fails, or never becomes visible, it
#      stops (exit 1) with the grant command for an operator who holds
#      Microsoft.Authorization/roleAssignments/write.
#
# This script's role query (`az role assignment list --scope <registry>
# --include-inherited`) does not list assignments that reach the identity
# through a GROUP, so "none visible" is not proof of absence; messages that
# rely on it say so.
#
# It never prints a principal id or a client id. Azure error text it quotes is
# reduced to one line with GUIDs masked and `::` / `##[` broken, so it cannot
# act as a workflow command.
#
# USAGE
#   ensure-acr-pull-identity.sh --acr NAME --rg RG --identity NAME --out FILE
#
# Writes to FILE (KEY=VALUE per line): UAMI_ID, UAMI_CLIENT_ID, UAMI_NAME,
# PULL_ROLE, GRANTED (yes = granted by this run | already = the assignment
# already existed | no = not needed).
#
# EXIT CODES
#   0   the identity can pull; FILE written
#   1   it cannot, and this run could not make it (stop; grant printed)
#   2   a read the decision depends on failed, so the answer is unknown
#   64  usage error
#
# ENVIRONMENT (tests shorten these)
#   LOOM_PULL_GRANT_POLL_ATTEMPTS   default 12
#   LOOM_PULL_GRANT_POLL_SECONDS    default 10
#   LOOM_PULL_GRANT_SETTLE_SECONDS  default 30
# =============================================================================
set -uo pipefail

ACRPULL_ROLE_ID=7f951dda-4ed3-4680-a7ca-43fe172d538d
PULL_ROLES="AcrPull AcrPush Contributor Owner"
POLL_ATTEMPTS="${LOOM_PULL_GRANT_POLL_ATTEMPTS:-12}"
POLL_SECONDS="${LOOM_PULL_GRANT_POLL_SECONDS:-10}"
SETTLE_SECONDS="${LOOM_PULL_GRANT_SETTLE_SECONDS:-30}"

ACR="" RG="" IDN="" OUT=""
PR_STATE="" PR_ROLE="" PR_WHY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --acr) ACR="${2:-}"; shift 2 ;;
    --rg) RG="${2:-}"; shift 2 ;;
    --identity) IDN="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    *) echo "::error::ensure-acr-pull-identity: unknown argument '$1'"; exit 64 ;;
  esac
done
if [ -z "$ACR" ] || [ -z "$RG" ] || [ -z "$IDN" ] || [ -z "$OUT" ]; then
  echo "::error::ensure-acr-pull-identity: --acr, --rg, --identity and --out are all required"
  exit 64
fi

# One line, GUIDs masked, `::` and `##[` broken: safe inside an annotation.
mask() {
  tr '\r\n' '  ' | sed -E \
    -e 's/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/<guid>/g' \
    -e 's/##\[/## [/g' -e 's/::/: :/g' | cut -c1-400
}

# azq ARGS...: runs az; sets AZ_OUT (stdout, CR stripped), AZ_RC, AZ_ERR (raw).
azq() {
  local f
  f=$(mktemp)
  AZ_RC=0
  AZ_OUT=$(az "$@" 2>"$f" </dev/null) || AZ_RC=$?
  AZ_OUT=$(printf '%s' "$AZ_OUT" | tr -d '\r')
  AZ_ERR=$(head -c 2000 "$f")
  rm -f "$f"
}

# classify the last az error: notfound | authz | exists | other
err_class() {
  case "$AZ_ERR" in
    *RoleAssignmentExists*|*"role assignment already exists"*) echo exists ;;
    *AuthorizationFailed*|*"does not have authorization"*|*"roleAssignments/write"*) echo authz ;;
    *ResourceNotFound*|*"was not found"*|*"could not be found"*|*NotFound*) echo notfound ;;
    *) echo other ;;
  esac
}

# pull_role PRINCIPAL: sets PR_STATE (yes|no|unknown), PR_ROLE, PR_WHY
pull_role() {
  local r
  PR_ROLE=""
  azq role assignment list --scope "$ACR_ID" --include-inherited --fill-principal-name false \
    --query "[?principalId=='$1'].roleDefinitionName" -o tsv
  if [ "$AZ_RC" -ne 0 ]; then
    PR_STATE=unknown
    PR_WHY="the role assignment read exited $AZ_RC: $(printf '%s' "$AZ_ERR" | mask)"
    return 0
  fi
  for r in $PULL_ROLES; do
    if grep -qxF "$r" <<< "$AZ_OUT"; then PR_ROLE="$r"; break; fi
  done
  if [ -n "$PR_ROLE" ]; then PR_STATE=yes; else PR_STATE=no; fi
}

grant_cmd() {
  printf '%s' "az role assignment create --assignee-object-id \"\$(az identity show -n $IDN -g $RG --query principalId -o tsv)\" --assignee-principal-type ServicePrincipal --role $ACRPULL_ROLE_ID --scope \"\$(az acr show -n $ACR --query id -o tsv)\""
}

# stop WHY: fail closed with the exact grant for an operator to run.
stop() {
  echo "::error::loom-unity's pull identity $IDN cannot pull from registry $ACR: $1. The catalog runs only as this identity, so the deployment stops here. Remediation: as a principal that holds Microsoft.Authorization/roleAssignments/write on the registry (Owner or User Access Administrator), grant AcrPull (role definition $ACRPULL_ROLE_ID) on the registry scope to the user-assigned managed identity $IDN in resource group $RG (principal type ServicePrincipal; its principal id is read by the inner command): $(grant_cmd) -- then re-dispatch this workflow."
  exit 1
}

write_out() {  # ID CLIENT_ID ROLE GRANTED
  {
    printf 'UAMI_ID=%s\n' "$1"
    printf 'UAMI_CLIENT_ID=%s\n' "$2"
    printf 'UAMI_NAME=%s\n' "$IDN"
    printf 'PULL_ROLE=%s\n' "$3"
    printf 'GRANTED=%s\n' "$4"
  } > "$OUT"
}

# ---- registry -----------------------------------------------------------------
azq acr show -n "$ACR" --query id -o tsv
ACR_ID="$AZ_OUT"
if [ "$AZ_RC" -ne 0 ] || [ -z "$ACR_ID" ]; then
  echo "::error::Could not read registry $ACR (az exit $AZ_RC: $(printf '%s' "$AZ_ERR" | mask)). Whether $IDN can pull from it is therefore UNKNOWN; refusing to deploy on an unverified pull identity."
  exit 2
fi

# ---- the dedicated identity ---------------------------------------------------
# A list multiselect with `-o tsv` prints ONE VALUE PER LINE (see
# scripts/ci/__tests__/roll-health-verdict.test.mjs), so read line by line.
azq identity show -n "$IDN" -g "$RG" --query "[id, principalId, clientId]" -o tsv
if [ "$AZ_RC" -ne 0 ]; then
  if [ "$(err_class)" = notfound ]; then
    echo "::error::The dedicated identity $IDN does not exist in resource group $RG (az answered not-found). loom-unity runs only as this identity, so the deployment stops here. Remediation: deploy the admin plane (admin-plane/main.bicep creates it as loomUnityUami and grants it AcrPull when loomUnityActive), or create it with: az identity create -n $IDN -g $RG -- and grant it AcrPull on registry $ACR: $(grant_cmd) -- then re-dispatch this workflow."
    exit 1
  fi
  echo "::error::The dedicated identity $IDN could not be read (az exit $AZ_RC: $(printf '%s' "$AZ_ERR" | mask)). Whether it exists or can pull is UNKNOWN; refusing to deploy."
  exit 2
fi
{ read -r P_ID; read -r P_PID; read -r P_CID; } <<< "$AZ_OUT"
if [ -z "${P_ID:-}" ] || [ -z "${P_PID:-}" ] || [ -z "${P_CID:-}" ]; then
  echo "::error::Reading the dedicated identity $IDN succeeded but did not yield its id, principalId and clientId (expected three lines, one value each). Refusing to deploy on an identity this run could not resolve."
  exit 2
fi

pull_role "$P_PID"
case "$PR_STATE" in
  yes)
    write_out "$P_ID" "$P_CID" "$PR_ROLE" no
    echo "::notice::loom-unity pulls with its dedicated identity $IDN (role $PR_ROLE on registry $ACR). No grant needed."
    exit 0 ;;
  unknown)
    echo "::error::The role assignments of $IDN on registry $ACR could not be read ($PR_WHY), so whether it can pull is UNKNOWN. Refusing to deploy."
    exit 2 ;;
esac

# ---- grant AcrPull -------------------------------------------------------------
echo "The dedicated identity $IDN holds no AcrPull, AcrPush, Contributor or Owner assignment visible at or above registry $ACR (this query does not list group-inherited assignments). Trying to grant AcrPull ($ACRPULL_ROLE_ID) on the registry scope."
GRANTED=yes
azq role assignment create --assignee-object-id "$P_PID" --assignee-principal-type ServicePrincipal \
  --role "$ACRPULL_ROLE_ID" --scope "$ACR_ID" -o none
if [ "$AZ_RC" -ne 0 ]; then
  case "$(err_class)" in
    exists)
      GRANTED=already
      echo "az reported RoleAssignmentExists: AcrPull was already granted, though the read above did not show it. Waiting for it to become visible." ;;
    authz) stop "the deploy principal could not grant AcrPull: it lacks Microsoft.Authorization/roleAssignments/write on the registry (az exit $AZ_RC)" ;;
    *) stop "granting AcrPull failed (az exit $AZ_RC: $(printf '%s' "$AZ_ERR" | mask))" ;;
  esac
fi

i=0
while [ "$i" -lt "$POLL_ATTEMPTS" ]; do
  i=$((i + 1))
  pull_role "$P_PID"
  if [ "$PR_STATE" = yes ]; then
    echo "AcrPull for $IDN is visible after $i read(s); settling ${SETTLE_SECONDS}s for the registry to observe it."
    sleep "$SETTLE_SECONDS"
    write_out "$P_ID" "$P_CID" "$PR_ROLE" "$GRANTED"
    if [ "$GRANTED" = already ]; then
      echo "::notice::AcrPull on registry $ACR was already granted to $IDN (RoleAssignmentExists); loom-unity pulls with it."
    else
      echo "::notice::Granted AcrPull on registry $ACR to the dedicated identity $IDN; loom-unity pulls with it."
    fi
    exit 0
  fi
  [ "$i" -lt "$POLL_ATTEMPTS" ] && sleep "$POLL_SECONDS"
done
stop "AcrPull was assigned but did not become visible after $POLL_ATTEMPTS reads (last read: ${PR_WHY:-$PR_STATE}); if it appears later, re-dispatch"
