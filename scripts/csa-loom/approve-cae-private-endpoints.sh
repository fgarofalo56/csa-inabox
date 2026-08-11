#!/usr/bin/env bash
# =============================================================================
# approve-cae-private-endpoints.sh — approve the Front Door -> Container Apps
#                                    env Private Link connection, in any cloud.
# =============================================================================
#
# WHY THIS IS NOT A deploymentScript ANY MORE (#3203).
#
# This ran as an ARM `Microsoft.Resources/deploymentScripts` inside
# front-door.bicep. ARM auto-provisions an ephemeral staging storage account for
# such a script, and that account uses SHARED KEY auth. Any subscription with a
# policy denying `allowSharedKeyAccess` blocks it:
#
#     DeploymentScriptOperationFailed  script-loom-fd-aca-pe-approve
#     ErrorCode: KeyBasedAuthenticationNotPermitted
#     "Key based authentication is not permitted on this storage account."
#
# Measured on deploy-fiab-commercial run 31435481880 — one of four ARM leaves
# that failed the whole apply. front-door.bicep had PREDICTED it in a comment and
# the mitigation was to pass an EMPTY scriptIdentityId on GCC-High/IL5 so the
# script never runs, leaving this instruction in its place:
#
#     "the operator approves the one PE connection manually (ACA env ->
#      Networking -> Private endpoint connections -> Approve)"
#
# That is two rule violations at once. `auto-bind-by-default.md` forbids a
# remediation the platform could have performed itself, and forbids requiring an
# operator to hand-run a portal step for a first-class capability. And
# `cloud-parity.md` forbids the sovereign boundaries getting the lesser path —
# the boundary where Loom's differentiators matter most was the one told to click
# through the portal. Meanwhile MCAPS policy has since reached Commercial too, so
# the "Commercial is fine" half of that split stopped being true.
#
# Running it from the deploy identity instead needs no staging storage, works
# unchanged in every boundary, and is idempotent — so it is also the SELF-HEALING
# form the rule asks for: if the connection is deleted or FD raises a new one,
# the next deploy re-approves it rather than erroring.
#
# HONESTY (deploy-integrity.md R6/R7). The original inline script read the
# connection list with `2>/dev/null || true`, which turns a permission denial or
# an unreachable ARM into an empty list — i.e. into "nothing pending, all done".
# That is the exact conversion R7 exists to forbid, and it is how #2819 shipped.
# Here every az call's exit status is captured and classified, and a read that
# fails is an UNKNOWN that exits non-zero, never a silent success.
#
# USAGE
#   bash scripts/csa-loom/approve-cae-private-endpoints.sh \
#        --cae-id <resourceId of the Container Apps managed environment> \
#        [--timeout-seconds 600] [--require-one]
#
#   --require-one  fail if no connection was ever seen (use when Front Door is
#                  known to be enabled, so "zero connections" means the origin
#                  never raised its request — a real defect, not a no-op).
#
# Exit codes:
#   0  no pending connections remain (approved some, or none were pending)
#   1  could not READ or APPROVE — an UNKNOWN, stated as one
#   2  --require-one was set and no connection ever appeared
#   3  usage
# -----------------------------------------------------------------------------
set -uo pipefail

CAE_ID=""
BUDGET=600
REQUIRE_ONE=0
INTERVAL=15

while [ $# -gt 0 ]; do
  case "$1" in
    --cae-id) CAE_ID="${2:-}"; shift 2 ;;
    --timeout-seconds) BUDGET="${2:-600}"; shift 2 ;;
    --interval-seconds) INTERVAL="${2:-15}"; shift 2 ;;
    --require-one) REQUIRE_ONE=1; shift ;;
    -h|--help) sed -n '1,60p' "$0"; exit 0 ;;
    *) echo "approve-cae-private-endpoints: unknown argument '$1'" >&2; exit 3 ;;
  esac
done

if [ -z "$CAE_ID" ]; then
  echo "::error::approve-cae-private-endpoints: --cae-id <managedEnvironment resource id> is required." >&2
  exit 3
fi

# Never print a full ARM id (it carries the subscription). Name only.
CAE_NAME="${CAE_ID##*/}"

# WHICH API VERSION? DISCOVER IT; DO NOT HARDCODE ONE.
#
# `az network private-endpoint-connection list --id <caeId>` DOES NOT WORK for
# Microsoft.App/managedEnvironments -- it answers "Resource ID is invalid.
# Please check it." That is exactly what the old inline deploymentScript called,
# under `2>/dev/null || true`, so the failure became an empty list and the empty
# list became "nothing pending, all done". Measured 2026-08-11 against the live
# Commercial environment: the az form errors, while the ARM child path returns
# the one real (Approved) connection.
#
# The child path is served by only SOME api-versions -- `2025-01-01` answers
# "Unsupported API version" while `2024-10-02-preview` works -- and the provider
# does not advertise `managedEnvironments/privateEndpointConnections` as a
# resource type at all, so its apiVersions list cannot be used. Probe a
# candidate list newest-first and use the first that returns a JSON body with a
# `value` array. Hardcoding one preview version is what rots; probing does not.
API_CANDIDATES="2024-10-02-preview 2024-08-02-preview 2024-02-02-preview 2023-11-02-preview"
API_VERSION=""
LAST_API_ERR=""

read_connections() {
  # Emits the raw JSON on stdout; returns 0 only when a version actually answered.
  local v out
  for v in ${API_VERSION:-$API_CANDIDATES}; do
    out="$(az rest --method get \
      --url "https://management.azure.com${CAE_ID}/privateEndpointConnections?api-version=${v}" \
      -o json 2>&1 | grep -v '^WARNING')"
    if printf '%s' "$out" | grep -q '"value"'; then
      API_VERSION="$v"
      printf '%s' "$out"
      return 0
    fi
    LAST_API_ERR="$out"
  done
  printf '%s' "${LAST_API_ERR:-no api-version answered}"
  return 1
}

DEADLINE=$(( $(date +%s) + BUDGET ))
APPROVED=0
SEEN_ANY=0
ATTEMPT=0

echo "[cae-pe] approving pending private-endpoint connections on managed environment '${CAE_NAME}' (budget ${BUDGET}s)"

while :; do
  ATTEMPT=$(( ATTEMPT + 1 ))

  # READ. The exit status is the verdict — an unreadable list is NOT an empty one.
  set +e
  LIST_OUT="$(read_connections)"
  LIST_RC=$?
  if [ $LIST_RC -ne 0 ]; then
    echo "::error::approve-cae-private-endpoints: could not READ the private-endpoint connections on '${CAE_NAME}' (az exit ${LIST_RC}): $(printf '%s' "$LIST_OUT" | tr -d '\r' | tr '\n' ' ' | cut -c1-300). This is an UNKNOWN — it does NOT establish that there are no pending connections. Tried api-versions: ${API_CANDIDATES}. Either none of them serve this child path any more (add the current one), or the deploy identity lacks 'Microsoft.App/managedEnvironments/privateEndpointConnections/read' -- grant it Network Contributor (or Contributor) on the admin-plane resource group." >&2
    exit 1
  fi

  TOTAL="$(printf '%s' "$LIST_OUT" | jq '.value | length' 2>/dev/null || echo "")"
  if [ -z "$TOTAL" ]; then
    echo "::error::approve-cae-private-endpoints: az returned output with no readable 'value' array for '${CAE_NAME}'. Refusing to infer a count from it: $(printf '%s' "$LIST_OUT" | tr -d '\r' | tr '\n' ' ' | cut -c1-200)" >&2
    exit 1
  fi
  [ "$TOTAL" -gt 0 ] && SEEN_ANY=1

  PENDING="$(printf '%s' "$LIST_OUT" \
    | jq -r '.value[] | select(.properties.privateLinkServiceConnectionState.status=="Pending") | .id' 2>/dev/null)"

  if [ -n "${PENDING:-}" ]; then
    while IFS= read -r conn; do
      [ -z "$conn" ] && continue
      echo "[cae-pe] approving pending connection '${conn##*/}'"
      set +e
      APV_OUT="$(az rest --method put \
        --url "https://management.azure.com${conn}?api-version=${API_VERSION}" \
        --headers "Content-Type=application/json" \
        --body '{"properties":{"privateLinkServiceConnectionState":{"status":"Approved","description":"Auto-approved by CSA Loom deploy (Front Door -> Container Apps env)"}}}' \
        -o none 2>&1)"
      APV_RC=$?
      if [ $APV_RC -ne 0 ]; then
        echo "::error::approve-cae-private-endpoints: APPROVE failed for connection '${conn##*/}' on '${CAE_NAME}' (az exit ${APV_RC}): $(printf '%s' "$APV_OUT" | tr -d '\r' | tr '\n' ' ' | cut -c1-300). Front Door will keep answering 504 until this connection is Approved, so this is not skippable." >&2
        exit 1
      fi
      APPROVED=$(( APPROVED + 1 ))
    done <<< "$PENDING"
  fi

  STILL="$(printf '%s' "$LIST_OUT" \
    | jq '[.value[] | select(.properties.privateLinkServiceConnectionState.status=="Pending")] | length' 2>/dev/null || echo 0)"

  # Done when we have seen at least one connection and none of them are pending.
  if [ "$SEEN_ANY" = "1" ] && [ "$APPROVED" -gt 0 ] && [ "${STILL:-0}" -eq 0 ]; then
    echo "::notice::approve-cae-private-endpoints: approved ${APPROVED} connection(s) on '${CAE_NAME}'; none pending."
    exit 0
  fi
  if [ "$SEEN_ANY" = "1" ] && [ "$APPROVED" -eq 0 ] && [ "${STILL:-0}" -eq 0 ]; then
    echo "::notice::approve-cae-private-endpoints: ${TOTAL} connection(s) on '${CAE_NAME}', none pending — nothing to do."
    exit 0
  fi

  NOW=$(date +%s)
  if [ "$NOW" -ge "$DEADLINE" ]; then break; fi
  echo "[cae-pe] attempt ${ATTEMPT}: ${TOTAL} connection(s), ${STILL:-0} pending — Front Door may not have raised its request yet; waiting ${INTERVAL}s"
  SLEEP=$INTERVAL
  REMAIN=$(( DEADLINE - NOW ))
  [ "$REMAIN" -lt "$SLEEP" ] && SLEEP=$REMAIN
  sleep "$SLEEP"
done

if [ "$SEEN_ANY" = "0" ]; then
  if [ "$REQUIRE_ONE" = "1" ]; then
    echo "::error::approve-cae-private-endpoints: NO private-endpoint connection ever appeared on '${CAE_NAME}' within ${BUDGET}s, and --require-one was set (Front Door is enabled for this deploy). The FD origin should have raised a shared-private-link request; if it did not, the origin's privateLink.id does not point at this environment. Front Door will answer 504 until a connection exists and is Approved." >&2
    exit 2
  fi
  echo "::notice::approve-cae-private-endpoints: no private-endpoint connections on '${CAE_NAME}' within ${BUDGET}s — nothing to approve (Front Door not enabled for this deploy)."
  exit 0
fi

echo "::error::approve-cae-private-endpoints: '${CAE_NAME}' still has ${STILL:-?} pending connection(s) after ${BUDGET}s and ${ATTEMPT} attempt(s); ${APPROVED} were approved. Front Door answers 504 while a connection is Pending." >&2
exit 1
