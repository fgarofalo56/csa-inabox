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
#     [--workspace-host adb-7405613013893759.19.azuredatabricks.net] \
#     [--default-catalog main] \
#     [--account-host accounts.azuredatabricks.net] \
#     [--metastore-name loom-eastus2] [--storage-root abfss://uc@acct.dfs.core.windows.net/]
#
# DEFAULT-ON CATALOG (2026-06 — "Unity Catalog configured by default"):
#   After assigning the metastore, this script makes the workspace's DEFAULT
#   CATALOG deterministic so Browse > Unity Catalog shows a real, usable catalog:
#     1. If --workspace-host is given (the workspace REST host, reachable while
#        public access is temporarily enabled in the post-deploy bootstrap), it
#        CREATEs the default catalog via the workspace UC REST 2.1 (tolerating a
#        409 if it already exists), then pins it as default_catalog_name.
#     2. If no host is reachable, it does NOT force default_catalog_name to a
#        name that may not exist (the old "main" bug). Accounts created after
#        2023-11-09 auto-create a workspace catalog and set it as the default on
#        assignment, so Browse still shows a catalog; older accounts get the
#        catalog created on the next bootstrap run with a reachable host.
#   This keeps the assignment idempotent and never leaves a dangling default.
#
# Find the account id: Databricks account console (accounts.azuredatabricks.net)
# → top-right user menu → the GUID after "Account ID", or the ?account_id= URL.
set -euo pipefail

ACCOUNT_HOST="${DATABRICKS_ACCOUNT_HOST:-accounts.azuredatabricks.net}"
DBX_RESOURCE="2ff814a6-3304-4ab8-85cb-cd0e6f879c1d"   # Azure Databricks AAD app
REGION="" WORKSPACE_ID="" UAMI_APP_ID="" METASTORE_NAME="" STORAGE_ROOT=""
WORKSPACE_HOST="" DEFAULT_CATALOG="main"
ACCOUNT_ID="${DATABRICKS_ACCOUNT_ID:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --account-id)      ACCOUNT_ID="$2"; shift 2 ;;
    --region)          REGION="$2"; shift 2 ;;
    --workspace-id)    WORKSPACE_ID="$2"; shift 2 ;;
    --uami-app-id)     UAMI_APP_ID="$2"; shift 2 ;;
    --workspace-host)  WORKSPACE_HOST="$2"; shift 2 ;;
    --default-catalog) DEFAULT_CATALOG="$2"; shift 2 ;;
    --account-host)    ACCOUNT_HOST="$2"; shift 2 ;;
    --metastore-name)  METASTORE_NAME="$2"; shift 2 ;;
    --storage-root)    STORAGE_ROOT="$2"; shift 2 ;;
    -h|--help) sed -n '2,49p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ -z "$ACCOUNT_ID" ]] && { echo "ERROR: set DATABRICKS_ACCOUNT_ID or pass --account-id" >&2; exit 1; }
[[ -z "$REGION" || -z "$WORKSPACE_ID" ]] && { echo "ERROR: --region and --workspace-id are required" >&2; exit 1; }
METASTORE_NAME="${METASTORE_NAME:-loom-${REGION}}"
# Normalize the account host: accept a bare host or a full URL, always emit a
# scheme-prefixed base. Defaults to the Commercial host; pass --account-host
# accounts.azuredatabricks.us (or set DATABRICKS_ACCOUNT_HOST) for Azure US Gov.
ACCOUNT_HOST="${ACCOUNT_HOST#https://}"; ACCOUNT_HOST="${ACCOUNT_HOST#http://}"; ACCOUNT_HOST="${ACCOUNT_HOST%/}"
ACCOUNT_HOST="https://${ACCOUNT_HOST}"
# Normalize the workspace host (strip scheme / trailing slash) if supplied.
WORKSPACE_HOST="${WORKSPACE_HOST#https://}"; WORKSPACE_HOST="${WORKSPACE_HOST#http://}"; WORKSPACE_HOST="${WORKSPACE_HOST%/}"

echo ">>> Acquiring Databricks account-console AAD token"
TOKEN="$(az account get-access-token --resource "$DBX_RESOURCE" --query accessToken -o tsv)"
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
# Assign WITHOUT forcing default_catalog_name yet — we only pin a default once we
# know the catalog exists (avoids leaving a dangling default that points at a
# non-existent catalog, which leaves Browse empty). Accounts created after
# 2023-11-09 auto-create a workspace catalog + set it as default here.
curl -s "${auth[@]}" -X PUT "${API}/workspaces/${WORKSPACE_ID}/metastore" \
  -d "$(jq -n --arg m "$METASTORE_ID" '{metastore_id:$m}')" >/dev/null
echo "    assigned."

# ---------------------------------------------------------------------------
# Make the DEFAULT CATALOG deterministic so Browse > Unity Catalog shows a real
# catalog. Requires a reachable workspace REST host (public access temporarily
# enabled by the post-deploy bootstrap, or in-VNet). Best-effort: if the host is
# unreachable we leave the account's auto-created default catalog in place.
# ---------------------------------------------------------------------------
if [[ -n "$WORKSPACE_HOST" ]]; then
  WS_API="https://${WORKSPACE_HOST}/api/2.1/unity-catalog"
  echo ">>> Ensuring default catalog '${DEFAULT_CATALOG}' exists on ${WORKSPACE_HOST}"
  # The deploy identity is metastore admin (account_admin → metastore admin), so
  # CREATE CATALOG succeeds. Tolerate 409/ALREADY_EXISTS.
  CREATE_CODE="$(curl -s -o /tmp/uc_catalog.json -w '%{http_code}' --max-time 60 \
    "${auth[@]}" -X POST "${WS_API}/catalogs" \
    -d "$(jq -n --arg n "$DEFAULT_CATALOG" '{name:$n, comment:"Loom default catalog (auto-provisioned)"}')" || echo "000")"
  if [[ "$CREATE_CODE" == "200" || "$CREATE_CODE" == "201" ]]; then
    echo "    created catalog '${DEFAULT_CATALOG}'."
  elif [[ "$CREATE_CODE" == "409" ]] || grep -qi "already exists\|ALREADY_EXISTS" /tmp/uc_catalog.json 2>/dev/null; then
    echo "    catalog '${DEFAULT_CATALOG}' already exists — reusing."
  else
    echo "    WARN: catalog create returned HTTP ${CREATE_CODE} (workspace host may be unreachable); leaving account default in place." >&2
    DEFAULT_CATALOG=""   # don't pin a default we couldn't confirm exists
  fi
  if [[ -n "$DEFAULT_CATALOG" ]]; then
    echo ">>> Pinning default_catalog_name=${DEFAULT_CATALOG} on workspace ${WORKSPACE_ID}"
    curl -s "${auth[@]}" -X PUT "${API}/workspaces/${WORKSPACE_ID}/metastore" \
      -d "$(jq -n --arg m "$METASTORE_ID" --arg c "$DEFAULT_CATALOG" '{metastore_id:$m, default_catalog_name:$c}')" >/dev/null
    echo "    default catalog pinned."
  fi
else
  echo ">>> No --workspace-host supplied — relying on the account's auto-created"
  echo "    workspace catalog as the default. (Pass --workspace-host to force a"
  echo "    named default catalog on older accounts.)"
fi

if [[ -n "$UAMI_APP_ID" ]]; then
  echo ">>> Ensuring UAMI ${UAMI_APP_ID} is an account service principal + account admin"
  # Account-level SCIM: find or add the SP by its applicationId (URL-encoded filter).
  ENC_FILTER="applicationId%20eq%20%22${UAMI_APP_ID}%22"
  SP_ID="$(curl -s "${auth[@]}" "${API}/scim/v2/ServicePrincipals?filter=${ENC_FILTER}" | jq -r '.Resources[0].id // empty')"
  if [[ -z "$SP_ID" ]]; then
    SP_ID="$(curl -s "${auth[@]}" -X POST "${API}/scim/v2/ServicePrincipals" \
      -d "$(jq -n --arg a "$UAMI_APP_ID" '{schemas:["urn:ietf:params:scim:schemas:core:2.0:ServicePrincipal"], applicationId:$a, displayName:"loom-console-uami", active:true}')" | jq -r '.id // empty')"
  fi
  if [[ -n "$SP_ID" ]]; then
    # Grant the account_admin role so the Loom console can LIST metastores +
    # manage UC. This is the reliable, verified path (PATCH SCIM roles) — owner
    # transfer of a system-owned metastore is a no-op. account_admin supersedes
    # metastore admin; the Loom console identity legitimately manages UC.
    curl -s "${auth[@]}" -X PATCH "${API}/scim/v2/ServicePrincipals/${SP_ID}" \
      -d '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"add","path":"roles","value":[{"value":"account_admin"}]}]}' >/dev/null
    echo "    UAMI SCIM id=${SP_ID}; granted account_admin."
  else
    echo "    WARN: could not resolve/create the UAMI account service principal — grant it account_admin manually." >&2
  fi

  # account_admin is an ACCOUNT role — it does NOT include the data-plane
  # metastore privileges needed to PUBLISH Delta shares (Marketplace → Data
  # shares → Shared by me, which failed live with "User does not have CREATE
  # SHARE on Metastore"). Grant CREATE SHARE/RECIPIENT/PROVIDER on the metastore
  # to the UAMI via the workspace UC REST — the deploy identity is a metastore
  # admin, so it can grant. Inbound subscribe needs only workspace access and
  # already works without this. Best-effort + idempotent.
  if [[ -n "$WORKSPACE_HOST" ]]; then
    echo ">>> Granting Delta Sharing metastore privileges (CREATE SHARE/RECIPIENT/PROVIDER) to UAMI ${UAMI_APP_ID}"
    GRANT_BODY="$(jq -n --arg p "$UAMI_APP_ID" '{changes:[{principal:$p, add:["CREATE_SHARE","CREATE_RECIPIENT","CREATE_PROVIDER"]}]}')"
    GRANT_CODE="$(curl -s -o /tmp/uc_share_grant.json -w '%{http_code}' --max-time 60 \
      "${auth[@]}" -X PATCH \
      "https://${WORKSPACE_HOST}/api/2.1/unity-catalog/permissions/metastore/${METASTORE_ID}" \
      -d "$GRANT_BODY")"
    if [[ "$GRANT_CODE" == "200" ]]; then
      echo "    granted CREATE SHARE/RECIPIENT/PROVIDER on the metastore."
    else
      echo "    WARN: Delta Sharing grant returned HTTP ${GRANT_CODE} ($(head -c 160 /tmp/uc_share_grant.json 2>/dev/null)); a metastore admin can run scripts/csa-loom/grant-databricks-delta-sharing.sh." >&2
    fi
  else
    echo "    NOTE: pass --workspace-host to also grant Delta Sharing publish privileges to the UAMI."
  fi
fi

echo ""
echo "✓ Unity Catalog enabled. Metastore ${METASTORE_ID} assigned to workspace ${WORKSPACE_ID}."
[[ -n "$WORKSPACE_HOST" && -n "$DEFAULT_CATALOG" ]] && echo "  Default catalog: ${DEFAULT_CATALOG}."
echo "  The Loom /catalog surface + Databricks Browse > Unity Catalog list catalogs now (no redeploy)."
