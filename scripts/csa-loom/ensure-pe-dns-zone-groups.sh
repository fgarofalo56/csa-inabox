#!/usr/bin/env bash
# Ensure every DLZ private endpoint has a private-DNS-zone-group pointing at the
# hub-linked privatelink zone, so its FQDN resolves to the private IP from the
# hub VNet (and therefore over the admin P2S VPN — see docs/fiab/vpn-access.md).
#
# Why: a PE created WITHOUT a privateDnsZoneGroup never registers an A record,
# so the service is unreachable by name from the hub even though the zone is
# hub-linked. The DLZ data-service PEs (Cosmos, Synapse, Storage, Event Hubs,
# ADF) shipped without zone groups in some deploys — this back-fills them.
# Idempotent: re-running is a no-op (the group named `default` is updated in place).
#
# The admin-plane network module already creates + hub-links the privatelink
# zones; this only wires the DLZ PEs to them. Run in the post-deploy bootstrap
# after the DLZ + admin plane exist (deploy identity = account/network contributor).
#
# Usage:
#   ADMIN_SUB=<admin/hub sub> DLZ_SUB=<dlz sub> REGION=centralus \
#   ADMIN_RG=rg-csa-loom-admin-<region> DLZ_RG=rg-csa-loom-dlz-default-<region> \
#   ./ensure-pe-dns-zone-groups.sh
set -euo pipefail

: "${ADMIN_SUB:?set ADMIN_SUB}"; : "${DLZ_SUB:?set DLZ_SUB}"
: "${ADMIN_RG:?set ADMIN_RG (holds the hub-linked privatelink zones)}"
: "${DLZ_RG:?set DLZ_RG (holds the DLZ private endpoints)}"
ZBASE="/subscriptions/${ADMIN_SUB}/resourceGroups/${ADMIN_RG}/providers/Microsoft.Network/privateDnsZones"

# Map each PE groupId to its privatelink zone. Cosmos Sql + Synapse Sql/SqlOnDemand
# share a zone; Gremlin, Dev, blob, dfs, servicebus, dataFactory, databricks_ui_api
# each have their own.
zone_for() {
  case "$1" in
    Sql)              echo "privatelink.documents.azure.com" ;;          # Cosmos SQL/NoSQL
    Gremlin)          echo "privatelink.gremlin.cosmos.azure.com" ;;
    Dev)              echo "privatelink.dev.azuresynapse.net" ;;
    SqlOnDemand|sqlOnDemand) echo "privatelink.sql.azuresynapse.net" ;;
    blob)             echo "privatelink.blob.core.windows.net" ;;
    dfs)              echo "privatelink.dfs.core.windows.net" ;;
    namespace)        echo "privatelink.servicebus.windows.net" ;;
    dataFactory)      echo "privatelink.adf.azure.com" ;;
    databricks_ui_api) echo "privatelink.azuredatabricks.net" ;;
    *)                echo "" ;;
  esac
}
# Synapse "Sql" group maps to the Synapse SQL zone (not Cosmos). Disambiguate by PE name.
synapse_sql_zone() { echo "privatelink.sql.azuresynapse.net"; }

echo ">>> Enumerating DLZ private endpoints in ${DLZ_RG}"
az network private-endpoint list -g "$DLZ_RG" --subscription "$DLZ_SUB" \
  --query "[].{name:name, grp:privateLinkServiceConnections[0].groupIds[0]}" -o tsv 2>/dev/null \
| while read -r PE GRP; do
    [ -z "$PE" ] && continue
    ZONE="$(zone_for "$GRP")"
    # Synapse PEs use groupId 'Sql'/'SqlOnDemand'/'Dev' but the Synapse zones.
    case "$PE" in
      *syn*sql|*syn*Sql)      ZONE="$(synapse_sql_zone)" ;;
      *syn*ondemand|*SqlOnDemand) ZONE="privatelink.sql.azuresynapse.net" ;;
      *syn*dev|*Dev)          ZONE="privatelink.dev.azuresynapse.net" ;;
    esac
    if [ -z "$ZONE" ]; then echo "  SKIP $PE (group $GRP — no zone mapping)"; continue; fi
    RC=$(az network private-endpoint dns-zone-group create -g "$DLZ_RG" --subscription "$DLZ_SUB" \
          --endpoint-name "$PE" -n default --zone-name "$(echo "$ZONE" | tr '.' '-')" \
          --private-dns-zone "${ZBASE}/${ZONE}" --query "provisioningState" -o tsv 2>&1 | tail -1)
    echo "  $PE -> $ZONE : $RC"
  done
echo "✓ DLZ PE DNS zone groups ensured. VPN clients resolve every service by FQDN."
