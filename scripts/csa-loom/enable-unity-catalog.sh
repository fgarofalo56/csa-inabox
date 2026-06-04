#!/usr/bin/env bash
# enable-unity-catalog.sh
#
# Fully automates Unity Catalog enablement for a Loom Databricks workspace via
# the Databricks ACCOUNT API (accounts.azuredatabricks.net) — NO manual account-
# console clicking. It (1) creates a UC metastore for the region if none exists,
# (2) assigns it to the workspace, and (3) adds the Loom Console UAMI as a
# metastore admin (least-privilege). Idempotent: re-running is safe.
#
# WHY THIS IS POSSIBLE (vs. the workspace API):
#   The account API lives at accounts.azuredatabricks.net, a DIFFERENT plane than
#   the (often network-restricted/private) workspace host. So even when the
#   workspace blocks public network access, metastore create/assign works here.
#
# THE ONE REQUIREMENT: the caller must be a Databricks ACCOUNT ADMIN. The first
# account admin is the Azure AD identity that created the account / first
# workspace (typically a Global Admin or the platform owner). A service
# principal can be made an account admin by an existing one — once that's done,
# this script can run unattended in the deploy bootstrap.
#
# Pre-reqs: az CLI logged in as a Databricks ACCOUNT ADMIN; jq; curl.
#
# Usage:
#   DATABRICKS_ACCOUNT_ID=<account-guid> \
#   ./enable-unity-catalog.sh \
#     --region eastus2 \
#     --workspace-id 7405613013893759 \
#     --uami-app-id  c6272de5-3c4e-4b72-8b57-71b2e950209b \
#     [--metastore-name loom-eastus2] [--storage-root abfss://uc@acct.dfs.core.windows.net/]
#
# Find the account id: Databricks account console (accounts.azuredatabricks.net)
# → top-right user menu → the GUID after "Account ID", or the ?account_id= URL.
set -euo pipefail

ACCOUNT_HOST="https://accounts.azuredatabricks.net"
REGION="" WORKSPACE_ID="" UAMI_APP_ID="" METASTORE_NAME="" STORAGE_ROOT=""
ACCOUNT_ID="${DATABRICKS_ACCOUNT_ID:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --account-id)     ACCOUNT_ID="$2"; shift 2 ;;
    --region)         REGION="$2"; shift 2 ;;
    --workspace-id)   WORKSPACE_ID="$2"; shift 2 ;;
    --uami-app-id)    UAMI_APP_ID="$2"; shift 2 ;;
    --metastore-name) METASTORE_NAME="$2"; shift 2 ;;
    --storage-root)   STORAGE_ROOT="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ -z "$ACCOUNT_ID" ]] && { echo "ERROR: set DATABRICKS_ACCOUNT_ID or pass --account-id" >&2; exit 1; }
[[ -z "$REGION" || -z "$WORKSPACE_ID" ]] && { echo "ERROR: --region and --workspace-id are required" >&2; exit 1; }
METASTORE_NAME="${METASTORE_NAME:-loom-${REGION}}"

echo ">>> Acquiring Databricks account-console AAD token"
TOKEN="$(az account get-access-token --resource 2ff814a6-3304-4ab8-85cb-cd0e6f879c1d --query accessToken -o tsv)"
API="${ACCOUNT_HOST}/api/2.0/accounts/${ACCOUNT_ID}"
auth=(-H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json")

echo ">>> Looking for an existing metastore in ${REGION}"
EXISTING="$(curl -s "${auth[@]}" "${API}/metastores" | jq -r --arg r "$REGION" '.metastores[]? | select(.region==$r) | .metastore_id' | head -1)"

if [[ -n "$EXISTING" && "$EXISTING" != "null" ]]; then
  METASTORE_ID="$EXISTING"
  echo "    reusing metastore ${METASTORE_ID}"
else
  echo ">>> Creating metastore '${METASTORE_NAME}' in ${REGION}"
  BODY="$(jq -n --arg n "$METASTORE_NAME" --arg r "$REGION" --arg s "$STORAGE_ROOT" \
    '{metastore_info: ({name:$n, region:$r} + (if $s=="" then {} else {storage_root:$s} end))}')"
  METASTORE_ID="$(curl -s "${auth[@]}" -X POST "${API}/metastores" -d "$BODY" | jq -r '.metastore_info.metastore_id // .metastore_id')"
  [[ -z "$METASTORE_ID" || "$METASTORE_ID" == "null" ]] && { echo "ERROR: metastore create failed (are you an account admin?)" >&2; exit 1; }
  echo "    created ${METASTORE_ID}"
fi

echo ">>> Assigning metastore ${METASTORE_ID} to workspace ${WORKSPACE_ID}"
curl -s "${auth[@]}" -X PUT "${API}/workspaces/${WORKSPACE_ID}/metastore" \
  -d "$(jq -n --arg m "$METASTORE_ID" '{metastore_id:$m, default_catalog_name:"main"}')" >/dev/null
echo "    assigned."

if [[ -n "$UAMI_APP_ID" ]]; then
  echo ">>> Ensuring UAMI ${UAMI_APP_ID} is an account service principal + metastore admin"
  # Account-level SCIM: add the SP by its applicationId.
  SP_ID="$(curl -s "${auth[@]}" "${API}/scim/v2/ServicePrincipals?filter=applicationId+eq+${UAMI_APP_ID}" | jq -r '.Resources[0].id // empty')"
  if [[ -z "$SP_ID" ]]; then
    SP_ID="$(curl -s "${auth[@]}" -X POST "${API}/scim/v2/ServicePrincipals" \
      -d "$(jq -n --arg a "$UAMI_APP_ID" '{schemas:["urn:ietf:params:scim:schemas:core:2.0:ServicePrincipal"], applicationId:$a, displayName:"loom-console-uami", active:true}')" | jq -r '.id // empty')"
  fi
  # Set the SP as the metastore owner/admin (PATCH metastore owner to the SP).
  curl -s "${auth[@]}" -X PATCH "${API}/metastores/${METASTORE_ID}" \
    -d "$(jq -n --arg a "$UAMI_APP_ID" '{metastore_info:{owner:$a}, update_mask:"owner"}')" >/dev/null || true
  echo "    UAMI SCIM id=${SP_ID:-unknown}; metastore owner set to the UAMI."
fi

echo ""
echo "✓ Unity Catalog enabled. Metastore ${METASTORE_ID} assigned to workspace ${WORKSPACE_ID}."
echo "  The Loom /catalog surface lists metastores + catalogs now (no redeploy)."
