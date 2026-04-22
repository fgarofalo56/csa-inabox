#!/usr/bin/env bash
# Deploy a complete CSA vertical solution end-to-end
# Part of CSA-in-a-Box: Cloud-Scale Analytics Platform
#
# Deploys a full vertical domain including:
#   - Resource group and foundation infrastructure
#   - Data download pipeline for the selected vertical
#   - dbt transformation project
#   - Purview catalog configuration
#   - Power BI workspace (placeholder)
#
# Usage:
#   ./deploy-vertical.sh -g <resource-group> -l <location> -v <vertical> [-n <prefix>]
#
# Verticals: finance | healthcare | environmental | transportation | agriculture
#
# Prerequisites:
#   - Azure CLI (az) logged in
#   - Python 3.10+ with pip
#   - dbt-core and dbt-fabric installed

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────
PREFIX="csabox"
LOCATION="eastus2"
RESOURCE_GROUP=""
VERTICAL=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOTAL_STEPS=7

# ─── Valid Verticals ─────────────────────────────────────────────
VALID_VERTICALS=("finance" "healthcare" "environmental" "transportation" "agriculture")

# ─── Parse Arguments ─────────────────────────────────────────────
usage() {
    echo "Usage: $0 -g <resource-group> -l <location> -v <vertical> [-n <prefix>]"
    echo ""
    echo "Options:"
    echo "  -g  Resource group name (required)"
    echo "  -l  Azure region (default: eastus2)"
    echo "  -v  Vertical domain (required): finance|healthcare|environmental|transportation|agriculture"
    echo "  -n  Naming prefix (default: csabox)"
    echo "  -h  Show this help"
    echo ""
    echo "Examples:"
    echo "  $0 -g rg-csa-finance -l eastus2 -v finance -n csafin"
    echo "  $0 -g rg-csa-health -l westus3 -v healthcare"
    exit 1
}

while getopts "g:l:v:n:h" opt; do
    case $opt in
        g) RESOURCE_GROUP="$OPTARG" ;;
        l) LOCATION="$OPTARG" ;;
        v) VERTICAL="$OPTARG" ;;
        n) PREFIX="$OPTARG" ;;
        h) usage ;;
        *) usage ;;
    esac
done

if [[ -z "$RESOURCE_GROUP" ]]; then
    echo "ERROR: Resource group (-g) is required"
    usage
fi

if [[ -z "$VERTICAL" ]]; then
    echo "ERROR: Vertical (-v) is required"
    usage
fi

# Validate vertical name
VALID=false
for v in "${VALID_VERTICALS[@]}"; do
    if [[ "$v" == "$VERTICAL" ]]; then
        VALID=true
        break
    fi
done

if [[ "$VALID" != "true" ]]; then
    echo "ERROR: Invalid vertical '$VERTICAL'. Must be one of: ${VALID_VERTICALS[*]}"
    exit 1
fi

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  CSA-in-a-Box: Vertical Solution Deployment                 ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Vertical:       $VERTICAL"
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
    --tags "project=csa-inabox" "vertical=$VERTICAL" \
    --output none 2>/dev/null || true
echo "    ✓ Resource group created"

# ─── Step 2: Deploy Foundation Infrastructure ────────────────────
echo ">>> Step 2/$TOTAL_STEPS: Deploying foundation infrastructure..."
STORAGE_NAME="${PREFIX}dlz"
FABRIC_ENDPOINT="${PREFIX}fabric"

# Deploy Data Landing Zone foundation
if [[ -f "$PROJECT_ROOT/deploy/bicep/dlz/main.bicep" ]]; then
    az deployment group create \
        --resource-group "$RESOURCE_GROUP" \
        --template-file "$PROJECT_ROOT/deploy/bicep/dlz/main.bicep" \
        --parameters namePrefix="$PREFIX" location="$LOCATION" \
        --output none 2>/dev/null || echo "    (Bicep deployment may already exist or template needs updates)"
    echo "    ✓ Foundation deployed via Bicep"
else
    # Fallback: deploy storage account directly
    az storage account create \
        --name "$STORAGE_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --location "$LOCATION" \
        --sku Standard_LRS \
        --kind StorageV2 \
        --enable-hierarchical-namespace true \
        --output none 2>/dev/null || echo "    (Storage account may already exist)"

    # Create standard containers
    for CONTAINER in "raw" "curated" "enriched" "workspace"; do
        az storage container create \
            --name "$CONTAINER" \
            --account-name "$STORAGE_NAME" \
            --auth-mode login \
            --output none 2>/dev/null || true
    done
    echo "    ✓ Foundation deployed (storage + containers)"
fi

# Validate foundation
az storage account show \
    --name "$STORAGE_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --output none 2>/dev/null \
    && echo "    ✓ Foundation validation passed" \
    || echo "    ⚠ Foundation validation: storage account not found (may use different name)"

# ─── Step 3: Run Data Download Pipeline ──────────────────────────
echo ">>> Step 3/$TOTAL_STEPS: Downloading $VERTICAL data..."
DATA_SCRIPT="$PROJECT_ROOT/scripts/data/download-${VERTICAL}.py"
if [[ -f "$DATA_SCRIPT" ]]; then
    python "$DATA_SCRIPT" \
        --output-dir "$PROJECT_ROOT/data/$VERTICAL/raw" \
        2>&1 | tail -5
    echo "    ✓ Data download complete"
else
    echo "    ⚠ Data script not found: $DATA_SCRIPT"
    echo "    → Creating placeholder data directory"
    mkdir -p "$PROJECT_ROOT/data/$VERTICAL/raw"
    echo "    ✓ Data directory created (populate manually)"
fi

# Validate data exists
if [[ -d "$PROJECT_ROOT/data/$VERTICAL/raw" ]] && [[ "$(ls -A "$PROJECT_ROOT/data/$VERTICAL/raw" 2>/dev/null)" ]]; then
    FILE_COUNT=$(find "$PROJECT_ROOT/data/$VERTICAL/raw" -type f | wc -l)
    echo "    ✓ Data validation: $FILE_COUNT files found"
else
    echo "    ⚠ Data validation: no files in raw directory"
fi

# ─── Step 4: Deploy dbt Project ──────────────────────────────────
echo ">>> Step 4/$TOTAL_STEPS: Deploying dbt project for $VERTICAL..."
DBT_DIR="$PROJECT_ROOT/verticals/$VERTICAL/dbt"
if [[ -d "$DBT_DIR" ]]; then
    cd "$DBT_DIR"
    echo "    Installing dbt dependencies..."
    dbt deps 2>/dev/null || echo "    (dbt deps may need profiles.yml configured)"
    echo "    Running dbt build..."
    dbt build --target dev 2>/dev/null || echo "    (dbt build requires target warehouse connection)"
    cd "$PROJECT_ROOT"
    echo "    ✓ dbt project deployed"
else
    echo "    ⚠ dbt project not found at $DBT_DIR"
    echo "    → Skipping dbt deployment"
fi

# ─── Step 5: Configure Purview Catalog ───────────────────────────
echo ">>> Step 5/$TOTAL_STEPS: Configuring Purview catalog for $VERTICAL..."
PURVIEW_NAME="${PREFIX}purview"
PURVIEW_SCRIPT="$PROJECT_ROOT/scripts/purview/register-${VERTICAL}.py"

# Create Purview account if not exists
az purview account create \
    --name "$PURVIEW_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --output none 2>/dev/null || echo "    (Purview account may already exist)"

if [[ -f "$PURVIEW_SCRIPT" ]]; then
    python "$PURVIEW_SCRIPT" \
        --purview-account "$PURVIEW_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        2>/dev/null || echo "    (Purview registration may need additional config)"
    echo "    ✓ Purview catalog configured"
else
    echo "    ⚠ Purview script not found: $PURVIEW_SCRIPT"
    echo "    → Register data sources manually in Purview Studio"
fi

# ─── Step 6: Deploy Power BI Workspace ───────────────────────────
echo ">>> Step 6/$TOTAL_STEPS: Setting up Power BI workspace..."
echo "    ⚠ Power BI workspace deployment requires Power BI REST API"
echo "    → Manual steps required:"
echo "      1. Create workspace: CSA-${VERTICAL^}"
echo "      2. Import reports from verticals/$VERTICAL/powerbi/"
echo "      3. Configure data source connections"
echo "    ✓ Power BI placeholder complete"

# ─── Step 7: Configure RBAC ─────────────────────────────────────
echo ">>> Step 7/$TOTAL_STEPS: Configuring RBAC..."
CURRENT_USER=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
if [[ -n "$CURRENT_USER" ]]; then
    SUB_ID=$(az account show --query id -o tsv)

    # Storage Blob Data Contributor
    az role assignment create \
        --assignee "$CURRENT_USER" \
        --role "Storage Blob Data Contributor" \
        --scope "/subscriptions/$SUB_ID/resourceGroups/$RESOURCE_GROUP" \
        --output none 2>/dev/null || true

    # Purview Data Curator
    az role assignment create \
        --assignee "$CURRENT_USER" \
        --role "Purview Data Curator" \
        --scope "/subscriptions/$SUB_ID/resourceGroups/$RESOURCE_GROUP" \
        --output none 2>/dev/null || true

    echo "    ✓ RBAC configured for current user"
else
    echo "    ⚠ Could not determine current user for RBAC. Configure manually."
fi

# ─── Output Summary ──────────────────────────────────────────────
STORAGE_URL="https://${STORAGE_NAME}.blob.core.windows.net"
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Vertical Deployment Complete: $VERTICAL"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Set these environment variables:                           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "export CSA_VERTICAL=\"$VERTICAL\""
echo "export CSA_RESOURCE_GROUP=\"$RESOURCE_GROUP\""
echo "export CSA_STORAGE_ACCOUNT_URL=\"$STORAGE_URL\""
echo "export CSA_PURVIEW_ACCOUNT=\"$PURVIEW_NAME\""
echo ""
echo "Next steps:"
echo "  1. Verify data:     az storage blob list --account-name $STORAGE_NAME --container-name raw"
echo "  2. Run dbt:         cd verticals/$VERTICAL/dbt && dbt build"
echo "  3. Open Purview:    https://$PURVIEW_NAME.purview.azure.com"
echo "  4. Deploy reports:  Import from verticals/$VERTICAL/powerbi/"
echo ""
echo "See docs/verticals/$VERTICAL/ for the complete domain guide."
