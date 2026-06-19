#!/usr/bin/env bash
# CSA Loom — grant the Console UAMI one or more Microsoft Purview CLASSIC Data
# Map data-plane roles on the account's ROOT collection, via the metadata-policy
# API.
#
# WHY THIS SCRIPT (and not `az role assignment create`):
#   Classic Purview Data Map permissions are NOT ARM RBAC. Since Aug 2021 they
#   live in the account's collection METADATA POLICY (data plane). To let the
#   Console UAMI read/write the Atlas catalog, glossary, lineage, collections,
#   and scan plane, its object id must be added to the metadata-policy
#   attributeRule that backs the chosen Data Map role (default: Data Curator).
#
# Endpoints (data plane; resource = https://purview.azure.net):
#   GET {account}.purview.azure.com/policystore/metadataPolicies?api-version=2021-07-01
#   PUT {account}.purview.azure.com/policystore/metadataPolicies/{policyId}?api-version=2021-07-01
#   ref: https://learn.microsoft.com/purview/legacy/tutorial-metadata-policy-collections-apis
#
# Roles → attributeRule id suffix in the root-collection metadata policy:
#   Data Curator             → purviewmetadatarole_builtin_data-curator
#   Data Reader              → purviewmetadatarole_builtin_data-reader
#   Data Source Administrator→ purviewmetadatarole_builtin_data-source-administrator
#   Collection Admin         → purviewmetadatarole_builtin_collection-administrator
#
# USAGE:
#   ./scripts/csa-loom/grant-purview-datamap-role.sh
#       # grants ALL four Data Map roles (default: ROLES env unset → all four)
#   ROLES="data-curator data-reader" ./scripts/csa-loom/grant-purview-datamap-role.sh
#       # space-separated list of roles; ROLE (singular) also accepted
#   PURVIEW_ACCOUNT=purview-csa-loom-eastus2 CONSOLE_UAMI_PRINCIPAL=<oid> ./...sh
#
# PE-PROTECTED ACCOUNTS:
#   When the Purview account was deployed with publicNetworkAccess=Disabled, the
#   data-plane metadata-policy endpoint is unreachable from a public CI runner.
#   Set PURVIEW_TOGGLE_PUBLIC=1 (the bootstrap workflow sets this automatically)
#   and the script will:
#     1. Read the current publicNetworkAccess value.
#     2. Temporarily set it to Enabled.
#     3. Poll the metadataPolicies endpoint until reachable (up to 8 min).
#     4. Run all role grants.
#     5. RESTORE the original value (even on failure, via trap).
#   Requires the caller to have Owner/Contributor on the Purview ARM resource.
#
# PRINCIPAL RESOLUTION:
#   If CONSOLE_UAMI_PRINCIPAL is not set, the script resolves it from the Azure
#   deployment: it looks for a UAMI named *console* in ADMIN_RG (default:
#   discovered from the first resource group that contains loom-console Container
#   App). If resolution fails, the script exits non-zero with a clear error rather
#   than silently granting the wrong (e61f3eb3 placeholder) principal.
#
# REQUIRES: az CLI logged in as a Collection Admin on the Purview account
#           (the limitlessdata_deploy SP, after a one-time human grant), + jq.
set -uo pipefail

PURVIEW_ACCOUNT="${PURVIEW_ACCOUNT:-${LOOM_PURVIEW_ACCOUNT:-}}"
# Normalize a pasted URL / -api host (Commercial .com OR US Gov .us) down to the
# short account name.
if [ -n "${PURVIEW_ACCOUNT:-}" ]; then
  PURVIEW_ACCOUNT="$(echo "$PURVIEW_ACCOUNT" | sed -E 's#^https?://##; s#-api\.purview\.azure\.(com|us).*$##; s#\.purview\.azure\.(com|us).*$##; s#/+$##')"
fi

# ---------------------------------------------------------------------------
# PRINCIPAL RESOLUTION — resolve from deployment when not explicitly passed.
# The placeholder e61f3eb3 is INTENTIONALLY not used as a fallback; if we
# can't resolve the real principal we exit with a clear error.
# ---------------------------------------------------------------------------
UAMI_PRINCIPAL="${CONSOLE_UAMI_PRINCIPAL:-${UAMI_PRINCIPAL:-}}"
if [ -z "${UAMI_PRINCIPAL:-}" ]; then
  echo "-> CONSOLE_UAMI_PRINCIPAL not set — resolving from deployment..."
  # Try ADMIN_RG first (passed as env or derived from the bootstrap workflow).
  _ADMIN_RG="${ADMIN_RG:-}"
  if [ -z "$_ADMIN_RG" ]; then
    # Fallback: discover by looking for loom-console Container App.
    _ADMIN_RG=$(az containerapp list --query "[?name=='loom-console'].resourceGroup | [0]" -o tsv 2>/dev/null || true)
  fi
  if [ -n "$_ADMIN_RG" ]; then
    UAMI_PRINCIPAL=$(az identity list -g "$_ADMIN_RG" \
      --query "[?contains(name,'console')].principalId | [0]" -o tsv 2>/dev/null || true)
  fi
  if [ -z "${UAMI_PRINCIPAL:-}" ]; then
    echo "ERROR: Could not resolve the Console UAMI principal id."
    echo "  Set CONSOLE_UAMI_PRINCIPAL=<object-id> explicitly, or ensure ADMIN_RG is set"
    echo "  and the Console UAMI (uami-loom-console-*) exists there."
    exit 1
  fi
  echo "   Resolved Console UAMI principal: $UAMI_PRINCIPAL"
fi

# Roles to grant. Accepts ROLES (space-separated list), ROLE (single), or
# defaults to all four roles needed for full Data Map access.
if [ -n "${ROLES:-}" ]; then
  # ROLES env is the canonical multi-role input.
  ROLE_LIST="$ROLES"
elif [ -n "${ROLE:-}" ]; then
  # Legacy single-role env (ROLE=data-curator) still accepted.
  ROLE_LIST="$ROLE"
else
  # Default: grant all four roles so the bootstrap only needs one call.
  ROLE_LIST="data-reader data-curator data-source-administrator collection-administrator"
fi

API_VERSION="2021-07-01"
PURVIEW_ARM_API_VERSION="2024-04-01-preview"
RESOURCE="https://purview.azure.net"
# Per-cloud Data Map host TLD: `.us` in the US Government clouds (GCC-High / IL5 /
# DoD — all AzureUSGovernment), `.com` everywhere else. Mirrors purviewBase()'s
# isGovCloud() switch in apps/fiab-console/lib/azure/purview-client.ts so the
# grant targets the SAME host the Console probes. Drive off PURVIEW_CLOUD, else
# the standard LOOM_CLOUD / AZURE_CLOUD signals. The token audience (RESOURCE)
# stays https://purview.azure.net in ALL clouds — only the endpoint host changes.
PURVIEW_CLOUD="${PURVIEW_CLOUD:-${LOOM_CLOUD:-${AZURE_CLOUD:-AzureCloud}}}"
case "$(echo "$PURVIEW_CLOUD" | tr '[:upper:]' '[:lower:]')" in
  *usgov*|*government*|*gcc-high*|*gcchigh*|*il5*|*dod*) PURVIEW_TLD="us" ;;
  *) PURVIEW_TLD="com" ;;
esac
BASE="https://${PURVIEW_ACCOUNT}.purview.azure.${PURVIEW_TLD}"

echo "== CSA Loom — Purview classic Data Map role grant =="
echo "   account=$PURVIEW_ACCOUNT  uami=$UAMI_PRINCIPAL  roles=${ROLE_LIST}"
echo "   base=$BASE"
echo

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required"; exit 1; }

# ---------------------------------------------------------------------------
# PE-PROTECTED ACCOUNT HANDLING
# When PURVIEW_TOGGLE_PUBLIC=1 is set, temporarily enable public network access
# so the data-plane endpoint is reachable from a public CI runner, then restore.
# ---------------------------------------------------------------------------
_PURVIEW_ORIG_PNA=""
_PURVIEW_ID=""

_restore_pna() {
  if [ -n "$_PURVIEW_ID" ] && [ "${_PURVIEW_ORIG_PNA:-Enabled}" != "Enabled" ]; then
    echo "-> [trap] restoring Purview publicNetworkAccess=Disabled"
    az resource update --ids "$_PURVIEW_ID" --api-version "$PURVIEW_ARM_API_VERSION" \
      --set properties.publicNetworkAccess=Disabled \
      --query "properties.publicNetworkAccess" -o tsv 2>/dev/null || \
      echo "::warning::Could not restore Purview publicNetworkAccess — please set it back to Disabled manually."
  fi
}
trap _restore_pna EXIT

if [ "${PURVIEW_TOGGLE_PUBLIC:-0}" = "1" ]; then
  echo "-> PURVIEW_TOGGLE_PUBLIC=1 — resolving ARM resource id for publicNetworkAccess toggle..."
  _PURVIEW_ID="$(az resource list --resource-type Microsoft.Purview/accounts \
    --query "[?name=='$PURVIEW_ACCOUNT'].id | [0]" -o tsv 2>/dev/null || true)"
  if [ -z "$_PURVIEW_ID" ]; then
    _PURVIEW_ID="$(az purview account show -n "$PURVIEW_ACCOUNT" \
      --query id -o tsv 2>/dev/null || true)"
  fi
  if [ -n "$_PURVIEW_ID" ]; then
    _PURVIEW_ORIG_PNA="$(az resource show --ids "$_PURVIEW_ID" \
      --api-version "$PURVIEW_ARM_API_VERSION" \
      --query "properties.publicNetworkAccess" -o tsv 2>/dev/null || echo "Enabled")"
    echo "   current publicNetworkAccess=$_PURVIEW_ORIG_PNA"
    if [ "$_PURVIEW_ORIG_PNA" != "Enabled" ]; then
      echo "-> enabling public access for grant window..."
      az resource update --ids "$_PURVIEW_ID" --api-version "$PURVIEW_ARM_API_VERSION" \
        --set properties.publicNetworkAccess=Enabled \
        --query "properties.publicNetworkAccess" -o tsv || \
        echo "::warning::Could not enable Purview public access — grant may fail."
      # Poll until the metadataPolicies endpoint is reachable (up to 8 min).
      echo "-> polling metadataPolicies endpoint (up to 480 s)..."
      _POLL_WAIT=0
      _POLL_MAX=480
      _TOKEN_PROBE="$(az account get-access-token --resource "$RESOURCE" --query accessToken -o tsv 2>/dev/null || true)"
      while [ "$_POLL_WAIT" -lt "$_POLL_MAX" ]; do
        _HTTP=$(curl -sS -o /dev/null -w '%{http_code}' \
          -H "Authorization: Bearer $_TOKEN_PROBE" \
          "${BASE}/policystore/metadataPolicies?collectionName=${PURVIEW_ACCOUNT}&api-version=${API_VERSION}" 2>/dev/null || echo "000")
        if [ "$_HTTP" = "200" ] || [ "$_HTTP" = "401" ] || [ "$_HTTP" = "403" ]; then
          # 401/403 means reachable but auth; 200 = ready.
          echo "   endpoint reachable (HTTP $_HTTP) after ${_POLL_WAIT}s"
          break
        fi
        echo "   HTTP $_HTTP after ${_POLL_WAIT}s — waiting 30s..."
        sleep 30
        _POLL_WAIT=$((_POLL_WAIT + 30))
      done
    fi
  else
    echo "::warning::PURVIEW_TOGGLE_PUBLIC=1 but could not resolve ARM id for '$PURVIEW_ACCOUNT' — proceeding without toggle."
  fi
fi

TOKEN="$(az account get-access-token --resource "$RESOURCE" --query accessToken -o tsv 2>/dev/null)"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: could not acquire a Purview data-plane token. Run 'az login' first."
  exit 1
fi

# 1) GET the metadata policy for the ROOT collection (collectionName == account name).
echo "-> GET metadataPolicies (root collection: $PURVIEW_ACCOUNT)"
POLICIES_JSON="$(curl -sS -H "Authorization: Bearer $TOKEN" \
  "${BASE}/policystore/metadataPolicies?collectionName=${PURVIEW_ACCOUNT}&api-version=${API_VERSION}")"

POLICY="$(echo "$POLICIES_JSON" | jq -c '.values[0] // empty')"
if [[ -z "$POLICY" ]]; then
  echo "ERROR: no metadata policy returned for the root collection. Raw response:"
  echo "$POLICIES_JSON" | head -c 800; echo
  echo "Likely cause: the signed-in principal is NOT a Collection Admin on this Purview account."
  echo "One-time fix: in the Purview portal → Data Map → Collections → root → Role assignments,"
  echo "add the signed-in principal as Collection Admin, then re-run."
  exit 1
fi

POLICY_ID="$(echo "$POLICY" | jq -r '.id')"
echo "   policyId=$POLICY_ID"

# 2) Add the UAMI object id to each requested role's attributeRule in one pass.
#    The attributeRule id ends with the role suffix; we add the principal to the
#    nested attributeValueIncludedIn entitlement that names principal.microsoft.id.
UPDATED="$POLICY"
for ROLE in $ROLE_LIST; do
  ROLE_SUFFIX="purviewmetadatarole_builtin_${ROLE}"
  echo "-> adding $UAMI_PRINCIPAL to '$ROLE' attributeRule (idempotent)"
  UPDATED="$(echo "$UPDATED" | jq \
    --arg suffix "$ROLE_SUFFIX" \
    --arg oid "$UAMI_PRINCIPAL" '
    .properties.attributeRules |= map(
      if (.id | endswith($suffix)) then
        .dnfCondition |= ( . // [] | map(
          map(
            if (.attributeName == "principal.microsoft.id")
            then .attributeValueIncludedIn = ((.attributeValueIncludedIn // []) + [$oid] | unique)
            else .
            end
          )
        ))
      else .
      end
    )
  ')"
done

if [[ "$UPDATED" == "$POLICY" ]]; then
  echo "   (no change — principal already present in all requested roles)"
fi

# 3) PUT the updated policy back in a single call.
echo "-> PUT metadataPolicies/$POLICY_ID"
HTTP_CODE="$(curl -sS -o /tmp/purview-policy-put.json -w '%{http_code}' \
  -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$UPDATED" \
  "${BASE}/policystore/metadataPolicies/${POLICY_ID}?api-version=${API_VERSION}")"

if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "201" ]]; then
  echo "   policy updated (HTTP $HTTP_CODE) — UAMI now holds [${ROLE_LIST}] on the root collection."
  echo
  echo "Verify with the Console probe:"
  echo "  GET ${BASE}/datamap/api/atlas/v2/types/typedefs/headers?api-version=2023-09-01  -> expect 200"
else
  echo "   PUT failed (HTTP $HTTP_CODE). Response:"
  head -c 800 /tmp/purview-policy-put.json; echo
  exit 1
fi
# trap EXIT fires here → restores publicNetworkAccess if it was toggled.
