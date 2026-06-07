#!/usr/bin/env bash
# CSA Loom — fix Synapse Spark notebook "Hive metastore" failures:
#   org.apache.hadoop.fs.azurebfs.contracts.exceptions.InvalidAbfsRestOperationException
#   Status code: -1  (HiveExternalCatalog.createDatabase on SHOW NAMESPACES / first SQL)
#
# ROOT CAUSE: when a Synapse Spark session starts it initializes the Hive
# external catalog and creates the default-database directory under the
# workspace's DEFAULT ADLS Gen2 filesystem (abfss). That fails when:
#   (a) the Synapse workspace MANAGED IDENTITY lacks "Storage Blob Data
#       Contributor" on the default storage account (→ 403), AND/OR
#   (b) the workspace runs in a MANAGED VNET with the storage locked down
#       (publicNetworkAccess Disabled + preventDataExfiltration) and there is
#       NO approved MANAGED PRIVATE ENDPOINT from the managed VNet to the
#       default storage's dfs+blob endpoints (→ status -1: the ABFS driver
#       can't even reach the endpoint).
#
# This script fixes BOTH, idempotently:
#   1. grants the workspace MSI Storage Blob Data Contributor on the default SA
#   2. creates managed private endpoints (dfs + blob) from the Synapse managed
#      VNet to the default SA, then AUTO-APPROVES them on the storage side
#
# REQUIRES: az CLI logged in with rights to (a) write roleAssignments on the
#   storage account and (b) approve private-endpoint connections on it
#   (the limitlessdata_deploy SP works after the one-time human grant). + jq.
#
# USAGE (env overridable; defaults target the live Commercial deployment):
#   ./scripts/csa-loom/fix-synapse-spark-storage-access.sh
#   SYNAPSE_WS=syn-loom-… SYNAPSE_RG=… STORAGE_ACCOUNT=… STORAGE_RG=… ./…sh
set -uo pipefail

SYNAPSE_WS="${SYNAPSE_WS:-}"
SYNAPSE_RG="${SYNAPSE_RG:-}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-}"
STORAGE_RG="${STORAGE_RG:-}"
SUBSCRIPTION="${SUBSCRIPTION:-${LOOM_SUBSCRIPTION_ID:-}}"

[ -n "$SUBSCRIPTION" ] && az account set --subscription "$SUBSCRIPTION" >/dev/null 2>&1 || true

# --- Discover the workspace if not provided -------------------------------
if [ -z "$SYNAPSE_WS" ] || [ -z "$SYNAPSE_RG" ]; then
  echo "Discovering the Synapse workspace…"
  read -r SYNAPSE_WS SYNAPSE_RG < <(az synapse workspace list \
    --query "[?starts_with(name,'syn-loom')].[name,resourceGroup] | [0]" -o tsv 2>/dev/null)
fi
if [ -z "$SYNAPSE_WS" ] || [ -z "$SYNAPSE_RG" ]; then
  echo "ERROR: could not find the Synapse workspace. Set SYNAPSE_WS + SYNAPSE_RG." >&2
  exit 1
fi
echo "Synapse workspace: $SYNAPSE_WS (rg: $SYNAPSE_RG)"

WS_JSON="$(az synapse workspace show --name "$SYNAPSE_WS" --resource-group "$SYNAPSE_RG" -o json)"
MSI_OID="$(echo "$WS_JSON" | jq -r '.identity.principalId')"
DEFAULT_URL="$(echo "$WS_JSON" | jq -r '.defaultDataLakeStorage.accountUrl')"
# Derive the default storage account name from its dfs URL if not provided.
if [ -z "$STORAGE_ACCOUNT" ]; then
  STORAGE_ACCOUNT="$(echo "$DEFAULT_URL" | sed -E 's#^https?://##; s#\.dfs\..*$##')"
fi
echo "Workspace MSI principal: $MSI_OID"
echo "Default storage account:  $STORAGE_ACCOUNT"

# Resolve the storage account resource id (+ RG) across the subscription.
SA_ID="$(az storage account list --query "[?name=='$STORAGE_ACCOUNT'].id | [0]" -o tsv 2>/dev/null)"
if [ -z "$SA_ID" ]; then
  echo "ERROR: storage account '$STORAGE_ACCOUNT' not found in this subscription." >&2
  exit 1
fi
[ -z "$STORAGE_RG" ] && STORAGE_RG="$(echo "$SA_ID" | sed -E 's#.*/resourceGroups/([^/]+)/.*#\1#')"
echo "Storage account id: $SA_ID (rg: $STORAGE_RG)"

# --- 1) RBAC: Storage Blob Data Contributor for the workspace MSI ----------
echo
echo "==> Granting the Synapse MSI 'Storage Blob Data Contributor' on the default SA…"
az role assignment create \
  --assignee-object-id "$MSI_OID" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" \
  --scope "$SA_ID" >/dev/null 2>&1 \
  && echo "   granted (or already present)." \
  || echo "   role assignment may already exist — continuing."

# --- 2) Managed private endpoints (dfs + blob) + auto-approval -------------
MV="$(echo "$WS_JSON" | jq -r '.managedVirtualNetwork // empty')"
if [ -z "$MV" ] || [ "$MV" = "null" ]; then
  echo
  echo "Workspace is NOT in a managed VNet — no managed private endpoint needed."
  echo "Done. Restart the Spark session and re-run the notebook."
  exit 0
fi

create_mpe () {
  local sub_res="$1"   # dfs | blob
  local name="loom-default-sa-${sub_res}"
  echo
  echo "==> Managed private endpoint to ${STORAGE_ACCOUNT} (${sub_res}): $name"
  az synapse managed-private-endpoints show --workspace-name "$SYNAPSE_WS" --pe-name "$name" >/dev/null 2>&1 \
    || az synapse managed-private-endpoints create \
         --workspace-name "$SYNAPSE_WS" --pe-name "$name" \
         --resource-id "$SA_ID" --group-Id "$sub_res" >/dev/null 2>&1 \
    && echo "   created (or already exists)."
}
create_mpe dfs
create_mpe blob

echo
echo "==> Auto-approving the pending private-endpoint connections on the storage side…"
PENDING="$(az network private-endpoint-connection list --id "$SA_ID" \
  --query "[?properties.privateLinkServiceConnectionState.status=='Pending'].id" -o tsv 2>/dev/null)"
if [ -z "$PENDING" ]; then
  echo "   no pending connections (already approved, or approval is delegated to the SA owner)."
else
  for pcid in $PENDING; do
    az network private-endpoint-connection approve --id "$pcid" \
      --description "Approved for Synapse Spark Hive metastore (CSA Loom)" >/dev/null 2>&1 \
      && echo "   approved: $(basename "$pcid")"
  done
fi

echo
echo "Done. Restart the Spark session (notebook → restart) and re-run — the Hive"
echo "metastore can now reach the default storage over the managed private endpoint."
