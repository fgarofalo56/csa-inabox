#!/usr/bin/env bash
# Deploy GeoAnalytics landing zone infrastructure
# Part of CSA-in-a-Box: Geospatial analytics platform
#
# Two deployment paths:
#   OSS:    Databricks + PostGIS + Azure Maps + GeoParquet storage
#   ArcGIS: ArcGIS Enterprise VM (BYOL) + supporting infrastructure
#
# Usage:
#   ./deploy-geoanalytics.sh -g <resource-group> [-l <location>] [-n <prefix>] [--path oss|arcgis]
#
# Prerequisites:
#   - Azure CLI (az) logged in
#   - For ArcGIS path: valid ArcGIS Enterprise license (BYOL)

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────
PREFIX="csageo"
LOCATION="eastus2"
RESOURCE_GROUP=""
GEO_PATH="oss"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Parse Arguments ─────────────────────────────────────────────
usage() {
    echo "Usage: $0 -g <resource-group> [-l <location>] [-n <prefix>] [--path oss|arcgis]"
    echo ""
    echo "Options:"
    echo "  -g  Resource group name (required)"
    echo "  -l  Azure region (default: eastus2)"
    echo "  -n  Naming prefix (default: csageo)"
    echo "  --path  Deployment path: oss (default) or arcgis"
    echo "  -h  Show this help"
    echo ""
    echo "Paths:"
    echo "  oss     - Databricks + PostGIS + Azure Maps + GeoParquet"
    echo "  arcgis  - ArcGIS Enterprise VM (BYOL) + supporting infra"
    exit 1
}

# Parse long options
ARGS=()
for arg in "$@"; do
    case $arg in
        --path)   ARGS+=("-p") ;;
        --path=*) GEO_PATH="${arg#*=}" ;;
        *)        ARGS+=("$arg") ;;
    esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

while getopts "g:l:n:p:h" opt; do
    case $opt in
        g) RESOURCE_GROUP="$OPTARG" ;;
        l) LOCATION="$OPTARG" ;;
        n) PREFIX="$OPTARG" ;;
        p) GEO_PATH="$OPTARG" ;;
        h) usage ;;
        *) usage ;;
    esac
done

if [[ -z "$RESOURCE_GROUP" ]]; then
    echo "ERROR: Resource group (-g) is required"
    usage
fi

if [[ "$GEO_PATH" != "oss" && "$GEO_PATH" != "arcgis" ]]; then
    echo "ERROR: --path must be 'oss' or 'arcgis'"
    usage
fi

if [[ "$GEO_PATH" == "oss" ]]; then
    TOTAL_STEPS=6
else
    TOTAL_STEPS=5
fi

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  CSA-in-a-Box: GeoAnalytics Landing Zone Deployment         ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Path:           $GEO_PATH"
echo "║  Resource Group: $RESOURCE_GROUP"
echo "║  Location:       $LOCATION"
echo "║  Prefix:         $PREFIX"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Create Resource Group ───────────────────────────────
echo ">>> Step 1/$TOTAL_STEPS: Creating resource group..."
az group create \
    --name "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --tags "project=csa-inabox" "component=geoanalytics" "path=$GEO_PATH" \
    --output none 2>/dev/null || true
echo "    ✓ Resource group created"

# ═══════════════════════════════════════════════════════════════════
# OSS PATH: Databricks + PostGIS + Azure Maps + GeoParquet
# ═══════════════════════════════════════════════════════════════════
if [[ "$GEO_PATH" == "oss" ]]; then

    # ─── Step 2: Deploy Databricks Workspace ─────────────────────
    DBX_NAME="${PREFIX}dbx"
    DBX_MANAGED_RG="${RESOURCE_GROUP}-dbx-managed"
    echo ">>> Step 2/$TOTAL_STEPS: Deploying Databricks workspace ($DBX_NAME)..."
    az databricks workspace create \
        --name "$DBX_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --location "$LOCATION" \
        --sku premium \
        --managed-resource-group "$DBX_MANAGED_RG" \
        --output none 2>/dev/null || echo "    (Databricks workspace may already exist)"

    DBX_URL=$(az databricks workspace show \
        --name "$DBX_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --query "workspaceUrl" -o tsv 2>/dev/null || echo "${DBX_NAME}.azuredatabricks.net")
    echo "    ✓ Databricks deployed: https://$DBX_URL"
    echo "    → Install geospatial libraries (sedona, geopandas, rasterio) via cluster init script"

    # ─── Step 3: Deploy PostgreSQL with PostGIS ──────────────────
    PG_NAME="${PREFIX}pg"
    PG_ADMIN="csaadmin"
    echo ">>> Step 3/$TOTAL_STEPS: Deploying PostgreSQL Flexible Server with PostGIS ($PG_NAME)..."
    az postgres flexible-server create \
        --name "$PG_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --location "$LOCATION" \
        --admin-user "$PG_ADMIN" \
        --admin-password "$(openssl rand -base64 24 | tr -d '/+=' | head -c 20)Aa1!" \
        --sku-name Standard_B1ms \
        --tier Burstable \
        --storage-size 32 \
        --version 16 \
        --output none 2>/dev/null || echo "    (PostgreSQL server may already exist)"

    # Enable PostGIS extension
    az postgres flexible-server parameter set \
        --server-name "$PG_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --name "azure.extensions" \
        --value "POSTGIS,POSTGIS_RASTER,POSTGIS_TOPOLOGY" \
        --output none 2>/dev/null || echo "    (PostGIS extension may need manual enable)"

    PG_HOST="${PG_NAME}.postgres.database.azure.com"
    echo "    ✓ PostgreSQL with PostGIS deployed: $PG_HOST"
    echo "    → Run: CREATE EXTENSION postgis; on the target database"

    # ─── Step 4: Deploy Azure Maps ───────────────────────────────
    MAPS_NAME="${PREFIX}maps"
    echo ">>> Step 4/$TOTAL_STEPS: Deploying Azure Maps account ($MAPS_NAME)..."
    az maps account create \
        --name "$MAPS_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --sku G2 \
        --kind Gen2 \
        --output none 2>/dev/null || echo "    (Maps account may already exist)"

    MAPS_KEY=$(az maps account keys list \
        --name "$MAPS_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --query "primaryKey" -o tsv 2>/dev/null || echo "")
    echo "    ✓ Azure Maps deployed"

    # ─── Step 5: Deploy GeoParquet Storage ───────────────────────
    GEO_STORAGE="${PREFIX}geost"
    echo ">>> Step 5/$TOTAL_STEPS: Deploying GeoParquet storage ($GEO_STORAGE)..."
    az storage account create \
        --name "$GEO_STORAGE" \
        --resource-group "$RESOURCE_GROUP" \
        --location "$LOCATION" \
        --sku Standard_LRS \
        --kind StorageV2 \
        --enable-hierarchical-namespace true \
        --output none 2>/dev/null || echo "    (Storage account may already exist)"

    # Create containers for geospatial data
    GEO_CONTAINERS=("geoparquet" "raster" "vector" "tiles" "reference")
    for CONTAINER in "${GEO_CONTAINERS[@]}"; do
        az storage container create \
            --name "$CONTAINER" \
            --account-name "$GEO_STORAGE" \
            --auth-mode login \
            --output none 2>/dev/null || true
    done

    GEO_STORAGE_URL="https://${GEO_STORAGE}.dfs.core.windows.net"
    echo "    ✓ GeoParquet storage deployed: $GEO_STORAGE_URL"

    # ─── Step 6: Configure RBAC ──────────────────────────────────
    echo ">>> Step 6/$TOTAL_STEPS: Configuring RBAC..."
    CURRENT_USER=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
    if [[ -n "$CURRENT_USER" ]]; then
        SUB_ID=$(az account show --query id -o tsv)
        RG_SCOPE="/subscriptions/$SUB_ID/resourceGroups/$RESOURCE_GROUP"

        az role assignment create \
            --assignee "$CURRENT_USER" \
            --role "Storage Blob Data Contributor" \
            --scope "$RG_SCOPE" \
            --output none 2>/dev/null || true

        az role assignment create \
            --assignee "$CURRENT_USER" \
            --role "Azure Maps Data Reader" \
            --scope "$RG_SCOPE" \
            --output none 2>/dev/null || true

        echo "    ✓ RBAC configured for current user"
    else
        echo "    ⚠ Could not determine current user for RBAC. Configure manually."
    fi

    # ─── Output Summary (OSS) ───────────────────────────────────
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  GeoAnalytics (OSS) Deployment Complete                     ║"
    echo "╠══════════════════════════════════════════════════════════════╣"
    echo "║  Set these environment variables:                           ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    echo "export DATABRICKS_HOST=\"https://$DBX_URL\""
    echo "export POSTGIS_HOST=\"$PG_HOST\""
    echo "export POSTGIS_USER=\"$PG_ADMIN\""
    echo "export AZURE_MAPS_KEY=\"$MAPS_KEY\""
    echo "export GEO_STORAGE_URL=\"$GEO_STORAGE_URL\""
    echo ""
    echo "Next steps:"
    echo "  1. Configure Databricks cluster with geospatial init script"
    echo "  2. Create PostGIS database:  az postgres flexible-server db create --server-name $PG_NAME -g $RESOURCE_GROUP -d geodb"
    echo "  3. Enable PostGIS:           psql -h $PG_HOST -U $PG_ADMIN -d geodb -c 'CREATE EXTENSION postgis;'"
    echo "  4. Upload GeoParquet data:   az storage blob upload-batch --account-name $GEO_STORAGE -d geoparquet -s ./data/geo/"
    echo ""
    echo "See docs/geoanalytics/oss-setup.md for the complete guide."

# ═══════════════════════════════════════════════════════════════════
# ARCGIS PATH: ArcGIS Enterprise VM (BYOL) + supporting infra
# ═══════════════════════════════════════════════════════════════════
else

    # ─── Step 2: Deploy ArcGIS Enterprise VM ─────────────────────
    VM_NAME="${PREFIX}arcgis"
    echo ">>> Step 2/$TOTAL_STEPS: Deploying ArcGIS Enterprise VM ($VM_NAME)..."
    echo "    ⚠ This provisions infrastructure only. ArcGIS software is BYOL."

    # Create VNet for ArcGIS
    VNET_NAME="${PREFIX}vnet"
    az network vnet create \
        --name "$VNET_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --location "$LOCATION" \
        --address-prefix "10.0.0.0/16" \
        --subnet-name "arcgis-subnet" \
        --subnet-prefix "10.0.1.0/24" \
        --output none 2>/dev/null || true

    # NSG with ArcGIS ports
    NSG_NAME="${PREFIX}nsg"
    az network nsg create \
        --name "$NSG_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --location "$LOCATION" \
        --output none 2>/dev/null || true

    az network nsg rule create \
        --nsg-name "$NSG_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --name "AllowArcGISPorts" \
        --priority 100 \
        --direction Inbound \
        --access Allow \
        --protocol Tcp \
        --destination-port-ranges 6443 7443 443 \
        --output none 2>/dev/null || true

    # Deploy VM
    az vm create \
        --name "$VM_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --location "$LOCATION" \
        --image "MicrosoftWindowsServer:WindowsServer:2022-datacenter-g2:latest" \
        --size "Standard_D8s_v5" \
        --admin-username "csaadmin" \
        --admin-password "$(openssl rand -base64 24 | tr -d '/+=' | head -c 20)Aa1!" \
        --vnet-name "$VNET_NAME" \
        --subnet "arcgis-subnet" \
        --nsg "$NSG_NAME" \
        --os-disk-size-gb 256 \
        --data-disk-sizes-gb 512 \
        --output none 2>/dev/null || echo "    (VM may already exist)"

    VM_IP=$(az vm show \
        --name "$VM_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --show-details \
        --query "publicIps" -o tsv 2>/dev/null || echo "N/A")
    echo "    ✓ ArcGIS VM deployed: $VM_IP"

    # ─── Step 3: Deploy Supporting Storage ───────────────────────
    ARC_STORAGE="${PREFIX}arcst"
    echo ">>> Step 3/$TOTAL_STEPS: Deploying supporting storage ($ARC_STORAGE)..."
    az storage account create \
        --name "$ARC_STORAGE" \
        --resource-group "$RESOURCE_GROUP" \
        --location "$LOCATION" \
        --sku Standard_LRS \
        --kind StorageV2 \
        --output none 2>/dev/null || echo "    (Storage account may already exist)"

    for CONTAINER in "filestore" "raster-store" "scene-cache" "backups"; do
        az storage container create \
            --name "$CONTAINER" \
            --account-name "$ARC_STORAGE" \
            --auth-mode login \
            --output none 2>/dev/null || true
    done
    echo "    ✓ Supporting storage deployed"

    # ─── Step 4: Deploy PostgreSQL for Geodatabase ───────────────
    PG_NAME="${PREFIX}arcpg"
    PG_ADMIN="csaadmin"
    echo ">>> Step 4/$TOTAL_STEPS: Deploying PostgreSQL for geodatabase ($PG_NAME)..."
    az postgres flexible-server create \
        --name "$PG_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --location "$LOCATION" \
        --admin-user "$PG_ADMIN" \
        --admin-password "$(openssl rand -base64 24 | tr -d '/+=' | head -c 20)Aa1!" \
        --sku-name Standard_D2s_v3 \
        --tier GeneralPurpose \
        --storage-size 128 \
        --version 16 \
        --output none 2>/dev/null || echo "    (PostgreSQL server may already exist)"

    PG_HOST="${PG_NAME}.postgres.database.azure.com"
    echo "    ✓ PostgreSQL deployed: $PG_HOST"

    # ─── Step 5: Output Manual Configuration Steps ───────────────
    echo ">>> Step 5/$TOTAL_STEPS: ArcGIS Enterprise configuration..."
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  GeoAnalytics (ArcGIS) Infrastructure Deployed              ║"
    echo "╠══════════════════════════════════════════════════════════════╣"
    echo "║  Manual ArcGIS configuration required (BYOL):              ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    echo "export ARCGIS_VM_IP=\"$VM_IP\""
    echo "export ARCGIS_STORAGE=\"$ARC_STORAGE\""
    echo "export ARCGIS_PG_HOST=\"$PG_HOST\""
    echo "export ARCGIS_PG_USER=\"$PG_ADMIN\""
    echo ""
    echo "Manual ArcGIS Enterprise setup steps:"
    echo "  1. RDP into VM: $VM_IP (user: csaadmin)"
    echo "  2. Install ArcGIS Enterprise from your license media"
    echo "  3. Run ArcGIS Server setup wizard"
    echo "  4. Configure Portal for ArcGIS on port 7443"
    echo "  5. Register PostgreSQL as enterprise geodatabase:"
    echo "     - Host: $PG_HOST"
    echo "     - Create geodatabase: sde"
    echo "     - Enable ST_Geometry or PostGIS type"
    echo "  6. Configure data stores with blob storage:"
    echo "     - File store: $ARC_STORAGE/filestore"
    echo "     - Raster store: $ARC_STORAGE/raster-store"
    echo "  7. Federate Portal with ArcGIS Server"
    echo "  8. Configure SSL certificate for production use"
    echo ""
    echo "See docs/geoanalytics/arcgis-setup.md for detailed instructions."
fi
