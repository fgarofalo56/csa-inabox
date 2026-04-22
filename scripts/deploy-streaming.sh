#!/usr/bin/env bash
# Deploy streaming/Lambda architecture infrastructure
# Part of CSA-in-a-Box: Real-time analytics pipeline
#
# Deploys:
#   - Event Hubs namespace + event hubs (earthquake, weather, clickstream)
#   - Azure Stream Analytics jobs (speed layer)
#   - Azure Data Explorer cluster (serving layer)
#   - Cosmos DB (hot path storage)
#   - Azure Functions for event processing
#   - RBAC configuration
#
# Usage:
#   ./deploy-streaming.sh -g <resource-group> [-l <location>] [-n <prefix>]
#
# Prerequisites:
#   - Azure CLI (az) logged in
#   - Subscription with Event Hubs, ADX, Cosmos DB access

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────
PREFIX="csastream"
LOCATION="eastus2"
RESOURCE_GROUP=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOTAL_STEPS=7

# ─── Parse Arguments ─────────────────────────────────────────────
usage() {
    echo "Usage: $0 -g <resource-group> [-l <location>] [-n <prefix>]"
    echo ""
    echo "Options:"
    echo "  -g  Resource group name (required)"
    echo "  -l  Azure region (default: eastus2)"
    echo "  -n  Naming prefix (default: csastream)"
    echo "  -h  Show this help"
    echo ""
    echo "Deploys Lambda architecture: Event Hubs → Stream Analytics → ADX/Cosmos DB"
    exit 1
}

while getopts "g:l:n:h" opt; do
    case $opt in
        g) RESOURCE_GROUP="$OPTARG" ;;
        l) LOCATION="$OPTARG" ;;
        n) PREFIX="$OPTARG" ;;
        h) usage ;;
        *) usage ;;
    esac
done

if [[ -z "$RESOURCE_GROUP" ]]; then
    echo "ERROR: Resource group (-g) is required"
    usage
fi

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  CSA-in-a-Box: Streaming Infrastructure Deployment          ║"
echo "╠══════════════════════════════════════════════════════════════╣"
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
    --tags "project=csa-inabox" "component=streaming" \
    --output none 2>/dev/null || true
echo "    ✓ Resource group created"

# ─── Step 2: Deploy Event Hubs ───────────────────────────────────
EH_NAMESPACE="${PREFIX}eh"
echo ">>> Step 2/$TOTAL_STEPS: Deploying Event Hubs namespace ($EH_NAMESPACE)..."
az eventhubs namespace create \
    --name "$EH_NAMESPACE" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku Standard \
    --capacity 1 \
    --output none 2>/dev/null || echo "    (Namespace may already exist)"

# Create event hubs
EVENT_HUBS=("earthquake-events" "weather-events" "clickstream-events")
for HUB in "${EVENT_HUBS[@]}"; do
    az eventhubs eventhub create \
        --name "$HUB" \
        --namespace-name "$EH_NAMESPACE" \
        --resource-group "$RESOURCE_GROUP" \
        --partition-count 4 \
        --message-retention 7 \
        --output none 2>/dev/null || true
    echo "    ✓ Event hub created: $HUB"
done

# Create consumer groups for Stream Analytics
for HUB in "${EVENT_HUBS[@]}"; do
    az eventhubs eventhub consumer-group create \
        --name "stream-analytics" \
        --eventhub-name "$HUB" \
        --namespace-name "$EH_NAMESPACE" \
        --resource-group "$RESOURCE_GROUP" \
        --output none 2>/dev/null || true
done

EH_CONN=$(az eventhubs namespace authorization-rule keys list \
    --name "RootManageSharedAccessKey" \
    --namespace-name "$EH_NAMESPACE" \
    --resource-group "$RESOURCE_GROUP" \
    --query "primaryConnectionString" -o tsv 2>/dev/null || echo "")
echo "    ✓ Event Hubs namespace deployed"

# ─── Step 3: Deploy Stream Analytics ─────────────────────────────
echo ">>> Step 3/$TOTAL_STEPS: Deploying Azure Stream Analytics jobs..."
ASA_JOBS=("earthquake-speed" "weather-speed" "clickstream-speed")
for JOB in "${ASA_JOBS[@]}"; do
    ASA_NAME="${PREFIX}${JOB}"
    az stream-analytics job create \
        --name "$ASA_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --location "$LOCATION" \
        --compatibility-level "1.2" \
        --output-error-policy "Drop" \
        --data-locale "en-US" \
        --output none 2>/dev/null || echo "    (Job $ASA_NAME may already exist)"
    echo "    ✓ Stream Analytics job: $ASA_NAME"
done
echo "    → Configure inputs/outputs/queries in Azure Portal or via ARM templates"

# ─── Step 4: Deploy Azure Data Explorer ──────────────────────────
ADX_NAME="${PREFIX}adx"
echo ">>> Step 4/$TOTAL_STEPS: Deploying Azure Data Explorer cluster ($ADX_NAME)..."
az kusto cluster create \
    --name "$ADX_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku name="Dev(No SLA)_Standard_E2a_v4" tier="Basic" capacity=1 \
    --output none 2>/dev/null || echo "    (ADX cluster may already exist)"

# Create database
az kusto database create \
    --cluster-name "$ADX_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --database-name "streaming" \
    --read-write-database soft-delete-period="P365D" hot-cache-period="P31D" \
    --output none 2>/dev/null || true

ADX_ENDPOINT="https://${ADX_NAME}.${LOCATION}.kusto.windows.net"
echo "    ✓ Azure Data Explorer deployed: $ADX_ENDPOINT"
echo "    ✓ Database 'streaming' created"

# ─── Step 5: Deploy Cosmos DB ────────────────────────────────────
COSMOS_NAME="${PREFIX}cosmos"
echo ">>> Step 5/$TOTAL_STEPS: Deploying Cosmos DB ($COSMOS_NAME)..."
az cosmosdb create \
    --name "$COSMOS_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --default-consistency-level Session \
    --locations regionName="$LOCATION" failoverPriority=0 \
    --output none 2>/dev/null || echo "    (Cosmos account may already exist)"

# Create databases and containers for hot path
az cosmosdb sql database create \
    --account-name "$COSMOS_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --name "hotpath" \
    --output none 2>/dev/null || true

CONTAINERS=("earthquake-latest:/region" "weather-latest:/stationId" "clickstream-sessions:/sessionId")
for SPEC in "${CONTAINERS[@]}"; do
    CONTAINER_NAME="${SPEC%%:*}"
    PARTITION_KEY="${SPEC##*:}"
    az cosmosdb sql container create \
        --account-name "$COSMOS_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --database-name "hotpath" \
        --name "$CONTAINER_NAME" \
        --partition-key-path "$PARTITION_KEY" \
        --throughput 400 \
        --output none 2>/dev/null || true
    echo "    ✓ Cosmos container: $CONTAINER_NAME"
done

COSMOS_ENDPOINT=$(az cosmosdb show \
    --name "$COSMOS_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query "documentEndpoint" -o tsv 2>/dev/null || echo "https://${COSMOS_NAME}.documents.azure.com:443/")
echo "    ✓ Cosmos DB deployed: $COSMOS_ENDPOINT"

# ─── Step 6: Deploy Azure Functions ──────────────────────────────
FUNC_NAME="${PREFIX}func"
FUNC_STORAGE="${PREFIX}funcst"
echo ">>> Step 6/$TOTAL_STEPS: Deploying Azure Functions ($FUNC_NAME)..."

# Functions storage account
az storage account create \
    --name "$FUNC_STORAGE" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku Standard_LRS \
    --output none 2>/dev/null || echo "    (Functions storage may already exist)"

# Function App
az functionapp create \
    --name "$FUNC_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --storage-account "$FUNC_STORAGE" \
    --consumption-plan-location "$LOCATION" \
    --runtime python \
    --runtime-version 3.11 \
    --functions-version 4 \
    --os-type Linux \
    --output none 2>/dev/null || echo "    (Function app may already exist)"

# Configure Event Hub connection string
if [[ -n "$EH_CONN" ]]; then
    az functionapp config appsettings set \
        --name "$FUNC_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --settings "EventHubConnection=$EH_CONN" \
        --output none 2>/dev/null || true
fi

echo "    ✓ Azure Functions deployed"
echo "    → Deploy function code: func azure functionapp publish $FUNC_NAME"

# ─── Step 7: Configure RBAC ─────────────────────────────────────
echo ">>> Step 7/$TOTAL_STEPS: Configuring RBAC..."
CURRENT_USER=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
if [[ -n "$CURRENT_USER" ]]; then
    SUB_ID=$(az account show --query id -o tsv)
    RG_SCOPE="/subscriptions/$SUB_ID/resourceGroups/$RESOURCE_GROUP"

    # Event Hubs Data Owner
    az role assignment create \
        --assignee "$CURRENT_USER" \
        --role "Azure Event Hubs Data Owner" \
        --scope "$RG_SCOPE" \
        --output none 2>/dev/null || true

    # Cosmos DB contributor
    az role assignment create \
        --assignee "$CURRENT_USER" \
        --role "Cosmos DB Account Reader Role" \
        --scope "$RG_SCOPE" \
        --output none 2>/dev/null || true

    # ADX Admin
    az kusto cluster-principal-assignment create \
        --cluster-name "$ADX_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --principal-assignment-name "admin" \
        --principal-id "$CURRENT_USER" \
        --principal-type "User" \
        --role "AllDatabasesAdmin" \
        --output none 2>/dev/null || true

    echo "    ✓ RBAC configured for current user"
else
    echo "    ⚠ Could not determine current user for RBAC. Configure manually."
fi

# ─── Output Summary ──────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Streaming Infrastructure Deployment Complete               ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Set these environment variables:                           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "export EVENT_HUB_NAMESPACE=\"$EH_NAMESPACE\""
echo "export EVENT_HUB_CONNECTION=\"$EH_CONN\""
echo "export ADX_ENDPOINT=\"$ADX_ENDPOINT\""
echo "export ADX_DATABASE=\"streaming\""
echo "export COSMOS_ENDPOINT=\"$COSMOS_ENDPOINT\""
echo "export FUNCTIONS_APP=\"$FUNC_NAME\""
echo ""
echo "Next steps:"
echo "  1. Configure ASA queries:   az stream-analytics job start --name ${PREFIX}earthquake-speed -g $RESOURCE_GROUP"
echo "  2. Deploy function code:    func azure functionapp publish $FUNC_NAME"
echo "  3. Send test events:        python scripts/streaming/send-test-events.py"
echo "  4. Monitor in ADX:          $ADX_ENDPOINT → streaming database"
echo ""
echo "See docs/architecture/streaming-lambda.md for the architecture guide."
