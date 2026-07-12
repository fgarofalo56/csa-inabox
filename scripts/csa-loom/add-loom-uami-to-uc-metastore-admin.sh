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

# 3. Grant CREATE_CATALOG on the metastore.
#    ONLY metastore-level privileges may be granted on the METASTORE entity.
#    USE_CATALOG / USE_SCHEMA / BROWSE apply to CATALOGS, not the metastore, and
#    including them makes the whole PATCH fail (verified live 2026-07-12:
#    "Privilege USE CATALOG is not applicable to this entity … METASTORE").
echo ">>> Granting CREATE_CATALOG on metastore to SCIM principal"
curl -sS -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://${WORKSPACE_HOSTNAME}/api/2.1/unity-catalog/permissions/metastore/${META_ID}" \
  -d "{\"changes\":[{\"principal\":\"${UAMI_APP_ID}\",\"add\":[\"CREATE_CATALOG\"]}]}" \
  | jq .

# 4. Grant CREATE_MANAGED_STORAGE on the metastore's external location(s).
#    A metastore with `storage_root = null` (accounts with account-level Default
#    Storage) rejects a bare CREATE CATALOG; Loom then creates catalogs WITH a
#    MANAGED LOCATION under a UC external location (LOOM_DATABRICKS_UC_STORAGE_ROOT
#    on the console = that location's abfss:// base). Creating a managed catalog
#    there requires CREATE_MANAGED_STORAGE on the external location, else the sync
#    503s "User does not have CREATE MANAGED STORAGE on External Location"
#    (verified live 2026-07-12). Grant it on every external location so the
#    domain→UC sync can create catalogs regardless of which one backs the root.
echo ">>> Granting CREATE_MANAGED_STORAGE on external location(s) to SCIM principal"
EXT_LOCS="$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://${WORKSPACE_HOSTNAME}/api/2.1/unity-catalog/external-locations" \
  | jq -r '.external_locations[]?.name')"
if [[ -z "$EXT_LOCS" ]]; then
  echo "    (no UC external locations found — if the metastore has a storage_root this is fine;"
  echo "     otherwise create an external location + storage credential first, then re-run.)"
else
  for LOC in $EXT_LOCS; do
    echo "    external location: $LOC"
    curl -sS -X PATCH \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      "https://${WORKSPACE_HOSTNAME}/api/2.1/unity-catalog/permissions/external-location/${LOC}" \
      -d "{\"changes\":[{\"principal\":\"${UAMI_APP_ID}\",\"add\":[\"CREATE_MANAGED_STORAGE\"]}]}" \
      | jq -r '.privilege_assignments[]? | select(.principal=="'"${UAMI_APP_ID}"'") | "      -> " + (.privileges|join(", "))'
  done
fi

echo ""
echo "DONE. The Loom console UAMI can now CREATE CATALOG (with a managed location"
echo "under an external location) on this workspace's UC metastore — the"
echo "domain→Unity-Catalog governance sync can create catalogs + schemas."
echo "NOTE: schemas for SUBDOMAINS are created under their parent catalog; since"
echo "Loom creates the parent catalog as this UAMI, the UAMI owns it and can add"
echo "child schemas. If a catalog pre-exists under a DIFFERENT owner, the sync's"
echo "createUcSchema 403s — drop/re-own it, or grant this SP USE_CATALOG+CREATE"
echo "SCHEMA on that catalog."
echo "Verify: LOOM_DATABRICKS_HOSTNAMES on the console must include '$WORKSPACE_HOSTNAME',"
echo "and set LOOM_DATABRICKS_UC_STORAGE_ROOT to an external location's abfss:// base"
echo "when the metastore has no default storage_root."
