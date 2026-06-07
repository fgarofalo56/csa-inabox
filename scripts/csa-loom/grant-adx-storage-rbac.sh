#!/usr/bin/env bash
# CSA Loom — authorize the ADX (Azure Data Explorer) cluster's managed identity
# to natively ingest from the DLZ ADLS Gen2 storage account.
#
# The Get-Data wizard's "Storage path" source runs
#   .ingest into table T (h'abfss://<container>@<account>.dfs.../file')
# on the shared ADX cluster. ADX authenticates to storage with its OWN
# managed identity (not the Console UAMI). For that `.ingest` to land rows the
# cluster MI needs TWO grants:
#
#   1. RBAC: "Storage Blob Data Reader" on the target storage account.
#   2. Cluster policy: the MI object id registered for "NativeIngestion"
#      (.alter-merge cluster policy managed_identity).
#
# This script applies both, idempotently. Loom's own DLZ storage is the default
# target; pass a different account to authorize an external source.
#
# Usage:
#   scripts/csa-loom/grant-adx-storage-rbac.sh [storageAccountName] [resourceGroup] [subscriptionId]
#     [storageAccountName]  default: $LOOM_ADLS_ACCOUNT
#     [resourceGroup]       optional — else discovered across visible subs
#     [subscriptionId]      optional — else discovered
#
# Required env (or derived from the running Container App):
#   LOOM_KUSTO_CLUSTER_NAME   ADX cluster name (e.g. adx-csa-loom-shared)
#   LOOM_KUSTO_RG             ADX cluster resource group
#   LOOM_KUSTO_LOCATION       ADX cluster region (e.g. eastus2)
#
# REQUIRES: az logged in as a principal that can create role assignments on the
# storage account AND run cluster management commands on the ADX cluster.
set -uo pipefail

ACCT="${1:-${LOOM_ADLS_ACCOUNT:-}}"
RG="${2:-}"; SUB_ARG="${3:-}"
[[ -z "$ACCT" ]] && { echo "ERROR: storage account required (arg 1 or \$LOOM_ADLS_ACCOUNT)." >&2; exit 1; }

CLUSTER="${LOOM_KUSTO_CLUSTER_NAME:?set LOOM_KUSTO_CLUSTER_NAME}"
CLUSTER_RG="${LOOM_KUSTO_RG:-rg-csa-loom-admin-eastus2}"
LOCATION="${LOOM_KUSTO_LOCATION:-eastus2}"
SBDR="2a2b9908-6ea1-4ae2-8e65-a410df84e7d1"  # Storage Blob Data Reader

# --- Resolve the ADX cluster's system-assigned MI principal id ---
MI_PRINCIPAL="$(az kusto cluster show -n "$CLUSTER" -g "$CLUSTER_RG" \
  --query identity.principalId -o tsv 2>/dev/null)"
[[ -z "$MI_PRINCIPAL" || "$MI_PRINCIPAL" == "null" ]] && {
  echo "ERROR: could not read system-assigned MI principalId for cluster '$CLUSTER' in '$CLUSTER_RG'." >&2
  echo "       Ensure the cluster has a system-assigned identity (adx-cluster.bicep sets this)." >&2
  exit 1
}
echo "== ADX cluster '$CLUSTER' MI principal: $MI_PRINCIPAL =="

# --- Discover the storage account sub+rg if not supplied ---
if [[ -z "$SUB_ARG" || -z "$RG" ]]; then
  for s in $(az account list --query "[].id" -o tsv 2>/dev/null); do
    found="$(az storage account show -n "$ACCT" --subscription "$s" --query "resourceGroup" -o tsv 2>/dev/null)"
    if [[ -n "$found" ]]; then RG="$found"; SUB_ARG="$s"; break; fi
  done
fi
[[ -z "$SUB_ARG" || -z "$RG" ]] && { echo "ERROR: storage account '$ACCT' not found in any visible subscription." >&2; exit 1; }

SCOPE="/subscriptions/$SUB_ARG/resourceGroups/$RG/providers/Microsoft.Storage/storageAccounts/$ACCT"
echo "== Granting Storage Blob Data Reader on '$ACCT' (sub $SUB_ARG / $RG) =="
MSYS_NO_PATHCONV=1 az role assignment create --assignee-object-id "$MI_PRINCIPAL" \
  --assignee-principal-type ServicePrincipal --role "$SBDR" --scope "$SCOPE" -o none 2>&1 \
  | grep -viE "already exists|RoleAssignmentExists" || true
echo "  ✓ Storage Blob Data Reader"

# --- Register the MI for NativeIngestion on the cluster (data plane) ---
CLUSTER_URI="https://${CLUSTER}.${LOCATION}.kusto.windows.net"
TOKEN="$(az account get-access-token --resource "$CLUSTER_URI" --query accessToken -o tsv 2>/dev/null)"
[[ -z "$TOKEN" ]] && { echo "ERROR: failed to acquire ADX data-plane token for $CLUSTER_URI." >&2; exit 1; }

# .alter-merge cluster policy managed_identity adds (not replaces) the MI.
CSL=".alter-merge cluster policy managed_identity \"[{'ObjectId':'${MI_PRINCIPAL}','AllowedUsages':'NativeIngestion'}]\""
BODY="$(printf '{"db":"NetDefaultDB","csl":"%s"}' "${CSL//\"/\\\"}")"
echo "== Registering MI for NativeIngestion on cluster =="
HTTP="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${CLUSTER_URI}/v1/rest/mgmt" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" --data "${BODY}")"
if [[ "$HTTP" == "200" ]]; then echo "  ✓ NativeIngestion managed_identity policy merged";
else echo "  ! cluster policy call returned HTTP ${HTTP} (already set / insufficient perms?) — review manually."; fi

echo "== Done. ADX can now .ingest from abfss://${ACCT}... via managed identity. =="
