#!/usr/bin/env bash
# =============================================================================
# ensure-acr-pull-identity.sh — choose a registry pull identity that can pull
# =============================================================================
#
# WHY THIS EXISTS
#
# gov-uc-purview-wire.yml deployed loom-unity with the dedicated
# `uami-loom-unity-<region>` as its registry pull identity whenever that
# identity existed, without checking that it could pull. On 2026-09-30 (run
# 36774518931) it existed but held no pull role on the Gov ACR, the new
# revision never started, and ARM reported only "Operation expired". The
# gov-bff-verify diagnostics (run 36804850561) then read `acrpull=no` for it.
# admin-plane/main.bicep grants this identity AcrPull (loomUnityAcrPull), but
# only on a deploy where `loomUnityActive && !skipRoleGrants` reached that
# resource.
#
# WHAT IT DOES
#
#   1. Reads the preferred identity (by name) and the registry id.
#   2. If the preferred identity holds a pull-capable role on the registry
#      (AcrPull, AcrPush, Contributor or Owner, at or above the registry
#      scope), it is chosen. No grant.
#   3. If it holds none, grants AcrPull (role definition
#      7f951dda-4ed3-4680-a7ca-43fe172d538d, the same id main.bicep uses) on
#      the registry scope to that identity's principal, then polls the role
#      assignment list (bounded) and settles before choosing it.
#   4. If the grant cannot be made, or does not become visible, or the preferred
#      identity does not exist, the fallback identity (the Console UAMI) is
#      chosen when IT holds a pull-capable role, with a ::notice:: saying why.
#   5. If neither can pull, it fails closed with an ::error:: naming the role,
#      the scope and the principal kind, and the command that fixes it.
#
# Role assignments inherited through a GROUP are not listed by
# `az role assignment list`, so "none visible" is not proof of absence; every
# message that relies on it says so.
#
# It never prints a principal id or a client id. Azure error text it quotes is
# reduced to one line, GUIDs are masked, and `##[` is broken, so a quoted error
# cannot act as a workflow command.
#
# USAGE
#   ensure-acr-pull-identity.sh --acr NAME --rg RG --preferred-uami NAME \
#       --fallback-uami-id RESOURCE_ID --out FILE
#
# Writes to FILE (one KEY=VALUE per line): UAMI_ID, UAMI_CLIENT_ID, UAMI_NAME,
# PULL_ROLE, GRANTED (yes|no).
#
# EXIT CODES
#   0   an identity that can pull was chosen and written to FILE
#   1   neither identity can pull (fail closed)
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

ACR="" RG="" PREF="" FB_ID="" OUT=""
PR_STATE="" PR_ROLE="" PR_WHY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --acr) ACR="${2:-}"; shift 2 ;;
    --rg) RG="${2:-}"; shift 2 ;;
    --preferred-uami) PREF="${2:-}"; shift 2 ;;
    --fallback-uami-id) FB_ID="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    *) echo "::error::ensure-acr-pull-identity: unknown argument '$1'"; exit 64 ;;
  esac
done
if [ -z "$ACR" ] || [ -z "$RG" ] || [ -z "$PREF" ] || [ -z "$FB_ID" ] || [ -z "$OUT" ]; then
  echo "::error::ensure-acr-pull-identity: --acr, --rg, --preferred-uami, --fallback-uami-id and --out are all required"
  exit 64
fi

# One line, GUIDs masked, `##[` broken: safe to put inside an annotation.
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

write_out() {  # ID CLIENT_ID NAME ROLE GRANTED
  {
    printf 'UAMI_ID=%s\n' "$1"
    printf 'UAMI_CLIENT_ID=%s\n' "$2"
    printf 'UAMI_NAME=%s\n' "$3"
    printf 'PULL_ROLE=%s\n' "$4"
    printf 'GRANTED=%s\n' "$5"
  } > "$OUT"
}

remediation() {  # IDENTITY_NAME IDENTITY_RG
  printf '%s' "Grant AcrPull (role definition $ACRPULL_ROLE_ID) on registry $ACR to the user-assigned managed identity $1 (principal type ServicePrincipal), as a principal that holds Microsoft.Authorization/roleAssignments/write on the registry: az role assignment create --assignee-object-id \"\$(az identity show -n $1 -g $2 --query principalId -o tsv)\" --assignee-principal-type ServicePrincipal --role $ACRPULL_ROLE_ID --scope \"\$(az acr show -n $ACR --query id -o tsv)\". Then re-dispatch this workflow."
}

# ---- registry -----------------------------------------------------------------
azq acr show -n "$ACR" --query id -o tsv
ACR_ID="$AZ_OUT"
if [ "$AZ_RC" -ne 0 ] || [ -z "$ACR_ID" ]; then
  echo "::error::Could not read registry $ACR (az exit $AZ_RC: $(printf '%s' "$AZ_ERR" | mask)). Which identity can pull from it is therefore UNKNOWN; refusing to deploy on an unverified pull identity."
  exit 2
fi

# ---- fallback identity (the Console UAMI) ------------------------------------
FB_NAME="${FB_ID##*/}"
FB_RG=$(printf '%s' "$FB_ID" | sed -nE 's#.*/resource[Gg]roups/([^/]+)/.*#\1#p')
use_fallback() {  # WHY_THE_PREFERRED_IDENTITY_WAS_NOT_USED  REMEDIATION_TARGET_NAME REMEDIATION_TARGET_RG
  local why="$1" fb_pid fb_cid
  azq identity show --ids "$FB_ID" --query "[principalId, clientId]" -o tsv
  if [ "$AZ_RC" -ne 0 ]; then
    echo "::error::$why. The fallback identity $FB_NAME could not be read either (az exit $AZ_RC: $(printf '%s' "$AZ_ERR" | mask)), so no pull identity can be verified. Refusing to deploy."
    exit 2
  fi
  IFS=$'\t' read -r fb_pid fb_cid <<< "$AZ_OUT"
  if [ -z "${fb_pid:-}" ] || [ -z "${fb_cid:-}" ]; then
    echo "::error::$why. The fallback identity $FB_NAME returned no principalId or clientId, so it cannot be verified as a pull identity. Refusing to deploy."
    exit 2
  fi
  pull_role "$fb_pid"
  case "$PR_STATE" in
    yes)
      write_out "$FB_ID" "$fb_cid" "$FB_NAME" "$PR_ROLE" no
      echo "::notice::loom-unity will pull with the Console UAMI $FB_NAME (role $PR_ROLE on registry $ACR) because $why."
      exit 0 ;;
    no)
      echo "::error::No pull identity can pull from registry $ACR: $why, and the Console UAMI $FB_NAME holds no AcrPull, AcrPush, Contributor or Owner assignment visible at or above the registry (group-inherited assignments are not listed). Refusing to deploy a revision that cannot pull its image. $(remediation "$2" "$3")"
      exit 1 ;;
    *)
      echo "::error::$why, and the role assignments of the Console UAMI $FB_NAME could not be read ($PR_WHY), so whether it can pull is UNKNOWN. Refusing to deploy."
      exit 2 ;;
  esac
}

# ---- preferred identity --------------------------------------------------------
azq identity show -n "$PREF" -g "$RG" --query "[id, principalId, clientId]" -o tsv
if [ "$AZ_RC" -ne 0 ]; then
  if [ "$(err_class)" = notfound ]; then
    use_fallback "the dedicated identity $PREF does not exist in $RG" "$FB_NAME" "${FB_RG:-$RG}"
  fi
  use_fallback "the dedicated identity $PREF could not be read (az exit $AZ_RC: $(printf '%s' "$AZ_ERR" | mask))" "$PREF" "$RG"
fi
IFS=$'\t' read -r P_ID P_PID P_CID <<< "$AZ_OUT"
if [ -z "${P_ID:-}" ] || [ -z "${P_PID:-}" ] || [ -z "${P_CID:-}" ]; then
  use_fallback "the dedicated identity $PREF returned no id, principalId or clientId" "$PREF" "$RG"
fi

pull_role "$P_PID"
if [ "$PR_STATE" = yes ]; then
  write_out "$P_ID" "$P_CID" "$PREF" "$PR_ROLE" no
  echo "::notice::loom-unity will pull with the dedicated identity $PREF (role $PR_ROLE on registry $ACR). No grant needed."
  exit 0
fi
if [ "$PR_STATE" = unknown ]; then
  use_fallback "the role assignments of the dedicated identity $PREF could not be read ($PR_WHY)" "$PREF" "$RG"
fi

# ---- grant AcrPull to the preferred identity ---------------------------------
echo "The dedicated identity $PREF holds no pull-capable role visible on registry $ACR. Granting AcrPull ($ACRPULL_ROLE_ID) on the registry scope."
azq role assignment create --assignee-object-id "$P_PID" --assignee-principal-type ServicePrincipal \
  --role "$ACRPULL_ROLE_ID" --scope "$ACR_ID" -o none
if [ "$AZ_RC" -ne 0 ]; then
  case "$(err_class)" in
    exists) echo "The assignment already exists (az reported RoleAssignmentExists); waiting for it to become visible." ;;
    authz) use_fallback "the deploy principal could not grant AcrPull to $PREF: it lacks Microsoft.Authorization/roleAssignments/write on registry $ACR (az exit $AZ_RC)" "$PREF" "$RG" ;;
    *) use_fallback "granting AcrPull to $PREF failed (az exit $AZ_RC: $(printf '%s' "$AZ_ERR" | mask))" "$PREF" "$RG" ;;
  esac
fi

i=0
while [ "$i" -lt "$POLL_ATTEMPTS" ]; do
  i=$((i + 1))
  pull_role "$P_PID"
  if [ "$PR_STATE" = yes ]; then
    echo "AcrPull for $PREF is visible after $i read(s); settling ${SETTLE_SECONDS}s for the registry to observe it."
    sleep "$SETTLE_SECONDS"
    write_out "$P_ID" "$P_CID" "$PREF" "$PR_ROLE" yes
    echo "::notice::Granted AcrPull on registry $ACR to the dedicated identity $PREF; loom-unity will pull with it."
    exit 0
  fi
  [ "$i" -lt "$POLL_ATTEMPTS" ] && sleep "$POLL_SECONDS"
done
use_fallback "AcrPull was assigned to $PREF but did not become visible after $POLL_ATTEMPTS reads (last read: ${PR_WHY:-$PR_STATE})" "$PREF" "$RG"
