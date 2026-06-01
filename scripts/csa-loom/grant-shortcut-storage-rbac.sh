#!/usr/bin/env bash
# CSA Loom — authorize a storage account for Lakehouse SHORTCUTS.
#
# A Lakehouse shortcut to an ADLS Gen2 OR blob-only storage account resolves on
# the Console UAMI (no copied credential). For that to work the UAMI needs
# **Storage Blob Data Reader** on the target account. Loom's own DLZ storage is
# granted at deploy time; this script authorizes ANY OTHER account a customer
# wants to surface as a shortcut — in any sub/RG the deploy principal can see.
#
# Usage:
#   scripts/csa-loom/grant-shortcut-storage-rbac.sh <storageAccountName> [resourceGroup] [subscriptionId] [--writer]
#     <storageAccountName>  required — the account to authorize
#     [resourceGroup]       optional — else discovered across all visible subs
#     [subscriptionId]      optional — else discovered
#     --writer              also grant Storage Blob Data Contributor (write-back)
#
# Idempotent. REQUIRES: az logged in as a principal that can create role
# assignments on the target storage account.
set -uo pipefail

ACCT="${1:?usage: grant-shortcut-storage-rbac.sh <storageAccountName> [rg] [sub] [--writer]}"
RG="${2:-}"; SUB_ARG="${3:-}"
WRITER=false; for a in "$@"; do [[ "$a" == "--writer" ]] && WRITER=true; done

# Console UAMI object id (the identity the BFF runs as). Override via env.
UAMI_PRINCIPAL="${CONSOLE_UAMI_PRINCIPAL:-e61f3eb3-c646-4183-8198-4c4a34cd9a01}"
SBDR="2a2b9908-6ea1-4ae2-8e65-a410df84e7d1"  # Storage Blob Data Reader
SBDC="ba92f5b4-2d11-453d-a403-e96b0029c9fe"  # Storage Blob Data Contributor

# Discover the account's sub+rg if not supplied (scan every visible sub).
if [[ -z "$SUB_ARG" || -z "$RG" ]]; then
  for s in $(az account list --query "[].id" -o tsv 2>/dev/null); do
    found="$(az storage account show -n "$ACCT" --subscription "$s" --query "{rg:resourceGroup,id:id}" -o tsv 2>/dev/null)"
    if [[ -n "$found" ]]; then
      RG="$(echo "$found" | awk '{print $1}')"; SUB_ARG="$s"; break
    fi
  done
fi
[[ -z "$SUB_ARG" || -z "$RG" ]] && { echo "ERROR: storage account '$ACCT' not found in any visible subscription." >&2; exit 1; }

SCOPE="/subscriptions/$SUB_ARG/resourceGroups/$RG/providers/Microsoft.Storage/storageAccounts/$ACCT"
HNS="$(az storage account show -n "$ACCT" -g "$RG" --subscription "$SUB_ARG" --query isHnsEnabled -o tsv 2>/dev/null)"
echo "== Authorizing '$ACCT' (HNS/ADLS-Gen2=$HNS) in sub $SUB_ARG / $RG for Loom shortcuts =="

grant() { # role-guid label
  MSYS_NO_PATHCONV=1 az role assignment create --assignee-object-id "$UAMI_PRINCIPAL" \
    --assignee-principal-type ServicePrincipal --role "$1" --scope "$SCOPE" -o none 2>&1 \
    | grep -viE "already exists|RoleAssignmentExists" || true
  echo "  ✓ $2"
}
grant "$SBDR" "Storage Blob Data Reader (read shortcuts)"
$WRITER && grant "$SBDC" "Storage Blob Data Contributor (--writer)"

# ---------------------------------------------------------------------------
# NETWORK authorization. The Console Container App runs in a locked-down VNet
# with NO stable public egress IP (no NAT gateway / UDR), so IP allow-lists
# don't work. If the target account's firewall is defaultAction=Deny, allow the
# Loom Container-Apps subnet via a VNet rule (Microsoft.Storage service
# endpoint). Verified working live 2026-06-01: a Deny account became reachable
# to shortcuts via exactly this rule, with NO open firewall.
# ---------------------------------------------------------------------------
CAE_SUBNET_ID="${LOOM_CAE_SUBNET_ID:-/subscriptions/363ef5d1-0e77-4594-a530-f51af23dbf8c/resourceGroups/rg-csa-loom-admin-eastus2/providers/Microsoft.Network/virtualNetworks/vnet-csa-loom-hub-eastus2/subnets/snet-container-platform}"
DEF_ACTION="$(az storage account show -n "$ACCT" -g "$RG" --subscription "$SUB_ARG" --query "networkRuleSet.defaultAction" -o tsv 2>/dev/null)"
if [[ "$DEF_ACTION" == "Deny" ]]; then
  MSYS_NO_PATHCONV=1 az network vnet subnet update --ids "$CAE_SUBNET_ID" --service-endpoints Microsoft.Storage -o none 2>&1 | tail -0 || true
  MSYS_NO_PATHCONV=1 az storage account network-rule add --account-name "$ACCT" -g "$RG" --subscription "$SUB_ARG" \
    --subnet "$CAE_SUBNET_ID" -o none 2>&1 | grep -viE "already" || true
  echo "  ✓ VNet rule: allowed the Loom Container-Apps subnet (account stays defaultAction=Deny)"
else
  echo "  - Storage firewall defaultAction=$DEF_ACTION (not Deny) — no VNet rule needed"
fi

# ---------------------------------------------------------------------------
# MANAGED PRIVATE ENDPOINT. If the account is private-endpoint-locked
# (publicNetworkAccess=Disabled), its public name CNAMEs to
# privatelink.dfs.core.windows.net and won't resolve from the Loom VNet
# ('ENOTFOUND') — a VNet rule isn't enough. Create a managed PE from the Loom
# hub VNet's snet-private-endpoints to the account's `dfs` sub-resource and
# register it in the hub-linked privatelink.dfs zone. This is the same
# managed-private-endpoint model Fabric uses for firewalled sources. Verified
# working live 2026-06-01 (dlzdlzstorageraw: ENOTFOUND -> shortcut created).
# Forced on with --managed-pe; auto-enabled when publicNetworkAccess=Disabled.
# ---------------------------------------------------------------------------
PUB="$(az storage account show -n "$ACCT" -g "$RG" --subscription "$SUB_ARG" --query publicNetworkAccess -o tsv 2>/dev/null)"
WANT_PE=false; for a in "$@"; do [[ "$a" == "--managed-pe" ]] && WANT_PE=true; done
if [[ "$WANT_PE" == true || "$PUB" == "Disabled" ]]; then
  PE_SUBNET="${LOOM_PE_SUBNET_ID:-/subscriptions/363ef5d1-0e77-4594-a530-f51af23dbf8c/resourceGroups/rg-csa-loom-admin-eastus2/providers/Microsoft.Network/virtualNetworks/vnet-csa-loom-hub-eastus2/subnets/snet-private-endpoints}"
  PE_RG="${LOOM_HUB_RG:-rg-csa-loom-admin-eastus2}"
  DNS_ZONE_ID="${LOOM_DFS_PRIVDNS_ID:-/subscriptions/363ef5d1-0e77-4594-a530-f51af23dbf8c/resourceGroups/rg-csa-loom-admin-eastus2/providers/Microsoft.Network/privateDnsZones/privatelink.dfs.core.windows.net}"
  PE_NAME="pe-loomsc-${ACCT}"
  echo "  Creating managed Private Endpoint $PE_NAME (snet-private-endpoints -> $ACCT/dfs)…"
  MSYS_NO_PATHCONV=1 az network private-endpoint create --name "$PE_NAME" -g "$PE_RG" \
    --vnet-name vnet-csa-loom-hub-eastus2 --subnet snet-private-endpoints \
    --private-connection-resource-id "$SCOPE" --group-id dfs \
    --connection-name "loomsc-${ACCT}" -l "${LOOM_LOCATION:-eastus2}" -o none 2>&1 | grep -viE "already exists" || true
  MSYS_NO_PATHCONV=1 az network private-endpoint dns-zone-group create --name default -g "$PE_RG" \
    --endpoint-name "$PE_NAME" --private-dns-zone "$DNS_ZONE_ID" --zone-name dfs -o none 2>&1 | grep -viE "already exists" || true
  echo "  ✓ Managed Private Endpoint + privatelink DNS record created for $ACCT"
  echo "    (if the connection shows Pending, approve it on the storage account's"
  echo "    Networking → Private endpoint connections — auto-approves when you own the account.)"
fi

echo
echo "Done. $ACCT is authorized for Loom Lakehouse shortcuts (UAMI read + network)."
echo "ADLS Gen2, blob-only, AND private-endpoint-locked accounts all work."
echo "Allow ~60s, then create it in Lakehouse → Shortcuts:"
echo "  abfss://<container>@$ACCT.dfs.core.windows.net/<path>"
