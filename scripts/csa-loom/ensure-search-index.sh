#!/usr/bin/env bash
# CSA Loom — ensure the AI Search governance catalog index exists (day-one).
#
# Creates the `loom-governance-items` index on the Loom AI Search service so the
# Governance → Catalog page loads on first sign-in instead of 404-ing
# ("index not found" → "Could not load catalog"). Idempotent: skips when the
# index already exists; PUT is overwrite-safe for an identical schema.
#
# WHY a bootstrap step (not pure bicep): the search service is deployed with
#   publicNetworkAccess='disabled' AND disableLocalAuth=true (ai-search.bicep).
# So (a) the data plane is unreachable from a public runner, and (b) admin keys
# are off — only AAD works. This script mirrors the Purview/Synapse/KV pattern:
# temporarily flip publicNetworkAccess=enabled for the PUT window, use an AAD
# token (the deploy SP, which holds Owner / Search Service Contributor), then
# RESTORE publicNetworkAccess=disabled via a trap (even on failure).
#
# The Console BFF ALSO self-heals this index from inside the VNet on first
# catalog load (ensureGovernanceCatalogIndex) + the admin Rebuild-index action,
# so this step is belt-and-braces for day-one — it just makes the very first
# page load succeed without waiting for the BFF self-heal.
#
# The index schema below is the SINGLE SOURCE in
#   apps/fiab-console/lib/azure/governance-catalog-shapes.ts
#   (GOVERNANCE_CATALOG_INDEX_FIELDS) — keep the two in sync.
#
# Usage:
#   SEARCH_SERVICE=<name> SEARCH_RG=<rg> SUBSCRIPTION=<sub> ./ensure-search-index.sh
# Env:
#   SEARCH_SERVICE   AI Search service name (e.g. search-loom-xxxx). Required.
#   SEARCH_RG        Resource group of the search service. Required.
#   SUBSCRIPTION     Subscription id holding the search service. Optional.
#   SEARCH_SUFFIX    Data-plane host suffix. Default search.windows.net
#                    (set search.usgovcloudapi.net for Azure US Government).
#   SEARCH_API       Data-plane API version. Default 2024-07-01.
#   INDEX_NAME       Override index name. Default loom-governance-items.

set -uo pipefail
export MSYS_NO_PATHCONV=1

SEARCH_SERVICE="${SEARCH_SERVICE:-}"
SEARCH_RG="${SEARCH_RG:-}"
SUBSCRIPTION="${SUBSCRIPTION:-}"
SEARCH_SUFFIX="${SEARCH_SUFFIX:-search.windows.net}"
SEARCH_API="${SEARCH_API:-2024-07-01}"
INDEX_NAME="${INDEX_NAME:-loom-governance-items}"

if [ -z "$SEARCH_SERVICE" ] || [ -z "$SEARCH_RG" ]; then
  echo "::notice::SEARCH_SERVICE / SEARCH_RG not set — skipping governance index ensure."
  exit 0
fi
[ -n "$SUBSCRIPTION" ] && az account set --subscription "$SUBSCRIPTION" >/dev/null 2>&1 || true

SEARCH_ID=$(az search service show -n "$SEARCH_SERVICE" -g "$SEARCH_RG" --query id -o tsv 2>/dev/null || true)
if [ -z "$SEARCH_ID" ]; then
  echo "::warning::AI Search service '$SEARCH_SERVICE' not found in $SEARCH_RG — skipping index ensure."
  exit 0
fi

# Temporarily open the PE-locked data plane for the PUT window; restore on EXIT.
ORIG_PNA=""
restore_pna() {
  if [ "${ORIG_PNA:-enabled}" != "enabled" ] && [ "${ORIG_PNA:-Enabled}" != "Enabled" ]; then
    echo "-> restoring AI Search publicNetworkAccess=disabled"
    az search service update -n "$SEARCH_SERVICE" -g "$SEARCH_RG" \
      --public-network-access disabled -o none 2>/dev/null \
      || az resource update --ids "$SEARCH_ID" --api-version 2025-02-01-preview \
           --set properties.publicNetworkAccess=disabled -o none 2>/dev/null || true
  fi
}
trap restore_pna EXIT
ORIG_PNA=$(az search service show -n "$SEARCH_SERVICE" -g "$SEARCH_RG" \
  --query "publicNetworkAccess" -o tsv 2>/dev/null || echo enabled)
echo "AI Search $SEARCH_SERVICE publicNetworkAccess=$ORIG_PNA"
if [ "${ORIG_PNA,,}" != "enabled" ]; then
  echo "-> temporarily enabling AI Search public access for the index PUT window"
  az search service update -n "$SEARCH_SERVICE" -g "$SEARCH_RG" \
    --public-network-access enabled -o none 2>/dev/null \
    || az resource update --ids "$SEARCH_ID" --api-version 2025-02-01-preview \
         --set properties.publicNetworkAccess=enabled -o none 2>/dev/null \
    || echo "::warning::Could not enable AI Search public access — the index PUT may be unreachable from the runner."
  sleep 25
fi

# AAD token for the data plane (disableLocalAuth=true → keys are off).
TOKEN=$(az account get-access-token --resource https://search.azure.com --query accessToken -o tsv 2>/dev/null || true)
if [ -z "$TOKEN" ]; then
  echo "::warning::Could not acquire an AAD token for https://search.azure.com — skipping index ensure."
  exit 0
fi
BASE="https://${SEARCH_SERVICE}.${SEARCH_SUFFIX}"

# Already present? (200 → done; idempotent.)
GET_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "${BASE}/indexes/${INDEX_NAME}?api-version=${SEARCH_API}" \
  -H "Authorization: Bearer $TOKEN" 2>/dev/null || echo 000)
if [ "$GET_STATUS" = "200" ]; then
  echo "  Index '$INDEX_NAME' already exists — nothing to do."
  exit 0
fi

# Index schema — MUST mirror GOVERNANCE_CATALOG_INDEX_FIELDS in
# apps/fiab-console/lib/azure/governance-catalog-shapes.ts.
read -r -d '' BODY <<JSON
{
  "name": "${INDEX_NAME}",
  "fields": [
    { "name": "id", "type": "Edm.String", "key": true, "filterable": true, "retrievable": true },
    { "name": "tenantId", "type": "Edm.String", "filterable": true, "retrievable": true },
    { "name": "workspaceId", "type": "Edm.String", "filterable": true, "retrievable": true },
    { "name": "workspaceName", "type": "Edm.String", "retrievable": true },
    { "name": "itemType", "type": "Edm.String", "filterable": true, "facetable": true, "retrievable": true },
    { "name": "domainId", "type": "Edm.String", "filterable": true, "facetable": true, "retrievable": true },
    { "name": "displayName", "type": "Edm.String", "searchable": true, "sortable": true, "retrievable": true, "analyzer": "standard.lucene" },
    { "name": "description", "type": "Edm.String", "searchable": true, "retrievable": true, "analyzer": "standard.lucene" },
    { "name": "owner", "type": "Edm.String", "retrievable": true },
    { "name": "ownerUpn", "type": "Edm.String", "searchable": true, "retrievable": true },
    { "name": "classifications", "type": "Collection(Edm.String)", "filterable": true, "facetable": true, "retrievable": true },
    { "name": "endorsement", "type": "Edm.String", "filterable": true, "facetable": true, "retrievable": true },
    { "name": "sensitivity", "type": "Edm.String", "filterable": true, "facetable": true, "retrievable": true },
    { "name": "isDiscoverable", "type": "Edm.Boolean", "filterable": true, "retrievable": true },
    { "name": "updatedAt", "type": "Edm.DateTimeOffset", "sortable": true, "filterable": true, "retrievable": true },
    { "name": "rowCount", "type": "Edm.Int64", "sortable": true, "retrievable": true },
    { "name": "sizeBytes", "type": "Edm.Int64", "sortable": true, "retrievable": true }
  ]
}
JSON

echo "Creating index '$INDEX_NAME' on $SEARCH_SERVICE ..."
PUT_STATUS=$(curl -sS -o /tmp/idx.json -w "%{http_code}" -X PUT \
  "${BASE}/indexes/${INDEX_NAME}?api-version=${SEARCH_API}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY" 2>/dev/null || echo 000)
if [ "$PUT_STATUS" = "200" ] || [ "$PUT_STATUS" = "201" ]; then
  echo "  Index '$INDEX_NAME' created (HTTP $PUT_STATUS)."
else
  echo "::warning::Index PUT returned $PUT_STATUS: $(head -c 300 /tmp/idx.json 2>/dev/null). The Console BFF self-heals this on first catalog load — non-fatal."
fi
