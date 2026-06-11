#!/usr/bin/env bash
# CSA Loom — grant the Console UAMI a Microsoft Purview CLASSIC Data Map
# data-plane role on the account's ROOT collection, via the metadata-policy API.
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
#   ./scripts/csa-loom/grant-purview-datamap-role.sh                 # Data Curator (default)
#   ROLE=data-reader ./scripts/csa-loom/grant-purview-datamap-role.sh # MIP label-on-download (F5) read role
#   PURVIEW_ACCOUNT=purview-csa-loom-eastus2 UAMI_PRINCIPAL=<oid> ./...sh
#
# REQUIRES: az CLI logged in as a Collection Admin on the Purview account
#           (the limitlessdata_deploy SP, after a one-time human grant), + jq.
set -uo pipefail

PURVIEW_ACCOUNT="${PURVIEW_ACCOUNT:-${LOOM_PURVIEW_ACCOUNT:-purview-csa-loom-eastus2}}"
# Normalize a pasted URL / -api host (Commercial .com OR US Gov .us) down to the
# short account name.
PURVIEW_ACCOUNT="$(echo "$PURVIEW_ACCOUNT" | sed -E 's#^https?://##; s#-api\.purview\.azure\.(com|us).*$##; s#\.purview\.azure\.(com|us).*$##; s#/+$##')"

# Console UAMI principal (object) id — the identity the BFF runs as.
UAMI_PRINCIPAL="${CONSOLE_UAMI_PRINCIPAL:-${UAMI_PRINCIPAL:-e61f3eb3-c646-4183-8198-4c4a34cd9a01}}"
ROLE="${ROLE:-data-curator}"   # data-curator | data-reader | data-source-administrator | collection-administrator
API_VERSION="2021-07-01"
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
ROLE_SUFFIX="purviewmetadatarole_builtin_${ROLE}"

echo "== CSA Loom — Purview classic Data Map role grant =="
echo "   account=$PURVIEW_ACCOUNT  uami=$UAMI_PRINCIPAL  role=$ROLE"
echo "   base=$BASE"
echo

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required"; exit 1; }

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

# 2) Add the UAMI object id to the fromRule attribute of the role's attributeRule.
#    The attributeRule id ends with the role suffix; we add the principal to the
#    nested attributeValueIncludedIn entitlement that names principal.microsoft.id.
echo "-> adding $UAMI_PRINCIPAL to the '$ROLE' attributeRule (idempotent)"
UPDATED="$(echo "$POLICY" | jq \
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

if [[ "$UPDATED" == "$POLICY" ]]; then
  echo "   (no change — principal already present, or role suffix '$ROLE_SUFFIX' not found in this policy)"
fi

# 3) PUT the policy back.
echo "-> PUT metadataPolicies/$POLICY_ID"
HTTP_CODE="$(curl -sS -o /tmp/purview-policy-put.json -w '%{http_code}' \
  -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$UPDATED" \
  "${BASE}/policystore/metadataPolicies/${POLICY_ID}?api-version=${API_VERSION}")"

if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "201" ]]; then
  echo "   ✓ policy updated (HTTP $HTTP_CODE) — UAMI now holds '$ROLE' on the root collection."
  echo
  echo "Verify with the Console probe:"
  echo "  GET ${BASE}/datamap/api/atlas/v2/types/typedefs/headers?api-version=2023-09-01  → expect 200"
else
  echo "   ✗ PUT failed (HTTP $HTTP_CODE). Response:"
  head -c 800 /tmp/purview-policy-put.json; echo
  exit 1
fi
