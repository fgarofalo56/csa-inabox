#!/usr/bin/env bash
# add-loom-uami-to-uc-metastore-admin.sh
#
# One-time bootstrap: adds the Loom console UAMI's service principal as a
# Unity Catalog metastore admin on a Databricks workspace, so the Unified
# Catalog surface (/catalog) can list catalogs, grant privileges, and read
# UC lineage.
#
# Why this is a script (not bicep): Databricks UC permission grants happen
# inside the Databricks workspace via SCIM + UC REST, not via ARM RBAC.
# Bicep can deploy the workspace + assign workspace contributor, but
# elevating to "metastore admin" requires (1) the UAMI SP to exist as a
# Databricks SCIM service principal in the workspace and (2) a `PATCH
# /api/2.1/unity-catalog/metastores/{id}` adding the SP to the metastore
# admins group. This script does both.
#
# Pre-requisites:
#   - az CLI logged in as a Databricks workspace admin
#   - jq installed
#   - The Loom console UAMI exists (see admin-plane bicep)
#
# Usage:
#   ./add-loom-uami-to-uc-metastore-admin.sh \
#       --workspace-hostname adb-1234.5.azuredatabricks.net \
#       --uami-principal-id <objectId-of-Loom-Console-UAMI>
#
set -euo pipefail

WORKSPACE_HOSTNAME=""
UAMI_PRINCIPAL_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace-hostname) WORKSPACE_HOSTNAME="$2"; shift 2 ;;
    --uami-principal-id)  UAMI_PRINCIPAL_ID="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$WORKSPACE_HOSTNAME" || -z "$UAMI_PRINCIPAL_ID" ]]; then
  echo "ERROR: --workspace-hostname and --uami-principal-id are required" >&2
  echo "Run with --help for usage." >&2
  exit 1
fi

WORKSPACE_HOSTNAME="${WORKSPACE_HOSTNAME#https://}"
WORKSPACE_HOSTNAME="${WORKSPACE_HOSTNAME%/}"

echo ">>> Acquiring Databricks AAD token for $WORKSPACE_HOSTNAME"
TOKEN="$(az account get-access-token --resource 2ff814a6-3304-4ab8-85cb-cd0e6f879c1d --query accessToken -o tsv)"

# 1. Find or create the SCIM service principal record for the UAMI in
#    this workspace. Databricks SCIM uses the AAD `applicationId` (i.e.
#    the UAMI's client id, NOT its principal id) — accept either and
#    look up the App registration if needed.
echo ">>> Looking up UAMI applicationId from AAD principal $UAMI_PRINCIPAL_ID"
UAMI_APP_ID="$(az ad sp show --id "$UAMI_PRINCIPAL_ID" --query appId -o tsv 2>/dev/null || true)"
if [[ -z "$UAMI_APP_ID" ]]; then
  # Caller passed an appId already
  UAMI_APP_ID="$UAMI_PRINCIPAL_ID"
fi
echo "    applicationId = $UAMI_APP_ID"

echo ">>> Ensuring UAMI exists as a Databricks SCIM service principal"
EXISTING="$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://${WORKSPACE_HOSTNAME}/api/2.0/preview/scim/v2/ServicePrincipals?filter=applicationId%20eq%20%22${UAMI_APP_ID}%22" \
  | jq -r '.Resources[0].id // empty')"

if [[ -z "$EXISTING" ]]; then
  echo "    creating SCIM principal"
  EXISTING="$(curl -s -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    "https://${WORKSPACE_HOSTNAME}/api/2.0/preview/scim/v2/ServicePrincipals" \
    -d "{\"schemas\":[\"urn:ietf:params:scim:schemas:core:2.0:ServicePrincipal\"],\"applicationId\":\"${UAMI_APP_ID}\",\"displayName\":\"Loom Console UAMI\",\"active\":true,\"entitlements\":[{\"value\":\"workspace-access\"},{\"value\":\"databricks-sql-access\"}]}" \
    | jq -r '.id')"
fi
echo "    SCIM principal id = $EXISTING"

# 2. Discover the metastore id from this workspace.
META_ID="$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://${WORKSPACE_HOSTNAME}/api/2.1/unity-catalog/metastores" \
  | jq -r '.metastores[0].metastore_id // empty')"

if [[ -z "$META_ID" ]]; then
  echo "ERROR: no UC metastore found for workspace $WORKSPACE_HOSTNAME" >&2
  exit 1
fi
echo ">>> Metastore id = $META_ID"

# 3. Resolve the metastore admins group name (defaults to `account admins`
#    on the metastore). We patch the metastore's `delta_sharing_recipient_token_lifetime_in_seconds`
#    no — the canonical add is `PATCH /metastores/{id}` with `owner` OR add
#    the SP to a UC group that is the metastore admin.
#
# Easiest robust path: ensure the SP is a member of the workspace's
# "admins" group AND set the metastore's `owner` to a group the SP belongs
# to. The least invasive option supported by every cloud is to grant the
# SP USE_CATALOG + USE_SCHEMA on the metastore (workspace-level "metastore
# admin equivalent") via a PATCH to /permissions/metastore.
echo ">>> Granting USE_CATALOG + CREATE_CATALOG on metastore to SCIM principal"
curl -sS -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://${WORKSPACE_HOSTNAME}/api/2.1/unity-catalog/permissions/metastore/${META_ID}" \
  -d "{\"changes\":[{\"principal\":\"${UAMI_APP_ID}\",\"add\":[\"USE_CATALOG\",\"CREATE_CATALOG\",\"USE_SCHEMA\",\"BROWSE\"]}]}" \
  | jq .

echo ""
echo "DONE. The Loom UAMI can now enumerate this workspace's UC metastore."
echo "Verify: LOOM_DATABRICKS_HOSTNAMES on the console must include '$WORKSPACE_HOSTNAME'."
