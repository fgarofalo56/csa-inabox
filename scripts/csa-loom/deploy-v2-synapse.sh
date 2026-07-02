#!/usr/bin/env bash
# CSA Loom v2.0 — Synapse Dedicated + Serverless wiring deploy.
#
# Stages (idempotent, safe to re-run):
#   1. Create 2 new private DNS zones in the admin-plane RG + link to hub VNet
#   2. Deploy synapse.bicep (Dedicated pool + PEs + AAD admin + ARM RBAC)
#   3. Deploy synapse-auto-pause.bicep (Logic App + role assignment)
#   4. Initial pause of the Dedicated pool (so the costs start at $0)
#   5. Wire LOOM_SYNAPSE_* env vars on the loom-console Container App
#   6. Restart the Container App to pick up new env vars
#
# Run from repo root after `az login`.
set -euo pipefail
export MSYS_NO_PATHCONV=1

SUB="${LOOM_SUBSCRIPTION_ID:-00000000-0000-0000-0000-000000000001}"
ADMIN_RG="${LOOM_ADMIN_RG:-rg-csa-loom-admin-eastus2}"
DLZ_RG="${LOOM_DLZ_RG:-rg-csa-loom-dlz-single-eastus2}"
LOCATION="${LOOM_LOCATION:-eastus2}"
DOMAIN="${LOOM_DOMAIN:-default}"
WORKSPACE="syn-loom-${DOMAIN}-${LOCATION}"
DEDICATED_POOL_NAME="${LOOM_DEDICATED_POOL:-loompool}"
DEDICATED_POOL_SKU="${LOOM_DEDICATED_POOL_SKU:-DW100c}"
HUB_VNET="vnet-csa-loom-hub-eastus2"
SPOKE_VNET="vnet-csa-loom-dlz-${DOMAIN}-${LOCATION}"
SPOKE_PE_SUBNET_ID="/subscriptions/${SUB}/resourceGroups/${DLZ_RG}/providers/Microsoft.Network/virtualNetworks/${SPOKE_VNET}/subnets/snet-private-endpoints"
LOOM_CONSOLE_UAMI="uami-loom-console-${LOCATION}"
LAW_ID=""

echo "==> Setting subscription"
az account set --subscription "$SUB"

# ============================================================
# 1. Private DNS zones for Synapse SQL + Dev
# ============================================================
echo "==> [1/6] Private DNS zones"
for zone in privatelink.sql.azuresynapse.net privatelink.dev.azuresynapse.net; do
  if ! az network private-dns zone show -g "$ADMIN_RG" -n "$zone" -o none 2>/dev/null; then
    az network private-dns zone create -g "$ADMIN_RG" -n "$zone" -o none
    echo "    created $zone"
  else
    echo "    exists  $zone"
  fi
  link_name="link-hub-$(echo "$HUB_VNET" | tr '.' '-')"
  if ! az network private-dns link vnet show -g "$ADMIN_RG" -z "$zone" -n "$link_name" -o none 2>/dev/null; then
    HUB_VNET_ID="/subscriptions/${SUB}/resourceGroups/${ADMIN_RG}/providers/Microsoft.Network/virtualNetworks/${HUB_VNET}"
    az network private-dns link vnet create -g "$ADMIN_RG" -z "$zone" -n "$link_name" -v "$HUB_VNET_ID" -e false -o none
    echo "    linked  $zone → $HUB_VNET"
  fi
done

# ============================================================
# 2. Look up shared inputs for synapse.bicep
# ============================================================
echo "==> [2/6] Looking up shared inputs"
CONSOLE_PRINCIPAL_ID=$(az identity show -g "$ADMIN_RG" -n "$LOOM_CONSOLE_UAMI" --query principalId -o tsv)
STORAGE_ACCOUNT=$(az storage account list -g "$DLZ_RG" --query "[?starts_with(name,'saloom')].name | [0]" -o tsv)
LAW_ID=$(az monitor log-analytics workspace list -g "$ADMIN_RG" --query "[0].id" -o tsv)
SYNAPSE_SQL_DNS_ZONE_ID=$(az network private-dns zone show -g "$ADMIN_RG" -n privatelink.sql.azuresynapse.net --query id -o tsv)
SYNAPSE_DEV_DNS_ZONE_ID=$(az network private-dns zone show -g "$ADMIN_RG" -n privatelink.dev.azuresynapse.net --query id -o tsv)

echo "    consolePrincipalId      = $CONSOLE_PRINCIPAL_ID"
echo "    consoleUamiName         = $LOOM_CONSOLE_UAMI"
echo "    storageAccount          = $STORAGE_ACCOUNT"
echo "    lawId                   = $LAW_ID"
echo "    synapseSqlDnsZoneId     = $SYNAPSE_SQL_DNS_ZONE_ID"
echo "    privateEndpointSubnetId = $SPOKE_PE_SUBNET_ID"

# ============================================================
# 3. Deploy synapse.bicep (additive — Dedicated + PEs + AAD admin)
# ============================================================
echo "==> [3/6] Deploying synapse.bicep (Dedicated pool + PEs + AAD admin)"
az deployment group create \
  --name "loom-v2-synapse-$(date +%Y%m%d-%H%M%S)" \
  -g "$DLZ_RG" \
  -f platform/fiab/bicep/modules/landing-zone/synapse.bicep \
  -p location="$LOCATION" \
     domainName="$DOMAIN" \
     defaultStorageAccountName="$STORAGE_ACCOUNT" \
     adminEntraGroupId="" \
     consolePrincipalId="$CONSOLE_PRINCIPAL_ID" \
     consoleUamiName="$LOOM_CONSOLE_UAMI" \
     workspaceId="$LAW_ID" \
     deployDedicatedPool=true \
     dedicatedPoolName="$DEDICATED_POOL_NAME" \
     dedicatedPoolSku="$DEDICATED_POOL_SKU" \
     privateEndpointSubnetId="$SPOKE_PE_SUBNET_ID" \
     synapseSqlPrivateDnsZoneId="$SYNAPSE_SQL_DNS_ZONE_ID" \
     synapseDevPrivateDnsZoneId="$SYNAPSE_DEV_DNS_ZONE_ID" \
     complianceTags='{"CSA_Loom":"true","Environment":"Commercial","FedRAMP_Level":"High","Data_Classification":"Standard"}' \
  -o table

# ============================================================
# 4. Deploy synapse-auto-pause.bicep
# ============================================================
echo "==> [4/6] Deploying synapse-auto-pause.bicep (Logic App nightly pause)"
az deployment group create \
  --name "loom-v2-autopause-$(date +%Y%m%d-%H%M%S)" \
  -g "$DLZ_RG" \
  -f platform/fiab/bicep/modules/landing-zone/synapse-auto-pause.bicep \
  -p location="$LOCATION" \
     domainName="$DOMAIN" \
     synapseWorkspaceName="$WORKSPACE" \
     dedicatedPoolName="$DEDICATED_POOL_NAME" \
     complianceTags='{"CSA_Loom":"true","Environment":"Commercial","FedRAMP_Level":"High","Data_Classification":"Standard"}' \
  -o table

# ============================================================
# 5. Initial pause of the Dedicated pool
# ============================================================
echo "==> [5/6] Pausing Dedicated pool to start costs at $0"
POOL_STATE=$(az synapse sql pool show -g "$DLZ_RG" --workspace-name "$WORKSPACE" -n "$DEDICATED_POOL_NAME" --query status -o tsv 2>/dev/null || echo "Missing")
echo "    current state: $POOL_STATE"
if [[ "$POOL_STATE" == "Online" ]]; then
  az synapse sql pool pause -g "$DLZ_RG" --workspace-name "$WORKSPACE" -n "$DEDICATED_POOL_NAME" -o none
  echo "    paused"
fi

# ============================================================
# 6. Set env vars on the loom-console Container App
# ============================================================
echo "==> [6/6] Wiring LOOM_SYNAPSE_* env vars on loom-console"
BRONZE_URL="https://${STORAGE_ACCOUNT}.dfs.core.windows.net/bronze"
SILVER_URL="https://${STORAGE_ACCOUNT}.dfs.core.windows.net/silver"
GOLD_URL="https://${STORAGE_ACCOUNT}.dfs.core.windows.net/gold"
LANDING_URL="https://${STORAGE_ACCOUNT}.dfs.core.windows.net/landing"

az containerapp update \
  -g "$ADMIN_RG" -n loom-console \
  --set-env-vars \
    "LOOM_SUBSCRIPTION_ID=$SUB" \
    "LOOM_DLZ_RG=$DLZ_RG" \
    "LOOM_SYNAPSE_WORKSPACE=$WORKSPACE" \
    "LOOM_SYNAPSE_DEDICATED_POOL=$DEDICATED_POOL_NAME" \
    "LOOM_BRONZE_URL=$BRONZE_URL" \
    "LOOM_SILVER_URL=$SILVER_URL" \
    "LOOM_GOLD_URL=$GOLD_URL" \
    "LOOM_LANDING_URL=$LANDING_URL" \
  -o table

echo ""
echo "DONE. Summary:"
echo "  Synapse workspace:    $WORKSPACE"
echo "  Serverless endpoint:  ${WORKSPACE}-ondemand.sql.azuresynapse.net (via PE)"
echo "  Dedicated endpoint:   ${WORKSPACE}.sql.azuresynapse.net (via PE)"
echo "  Dedicated pool:       $DEDICATED_POOL_NAME ($DEDICATED_POOL_SKU)"
echo "  Pool state:           Paused (auto-pause Logic App fires nightly 04:00 UTC)"
echo ""
echo "Next: build + deploy v2.0 app image, then UAT."
