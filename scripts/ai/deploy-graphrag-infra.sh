#!/usr/bin/env bash
# Deploy GraphRAG infrastructure to Azure
# Part of CSA-in-a-Box WS-5: AI-First Analytics Landing Zone
#
# Deploys:
#   - Azure OpenAI (gpt-5.4 + text-embedding-3-large)
#   - Azure Blob Storage (for GraphRAG document store)
#   - Azure Cosmos DB Gremlin API (for knowledge graph persistence)
#   - Azure AI Search (for graph embeddings)
#
# Usage:
#   ./deploy-graphrag-infra.sh -g <resource-group> -l <location> [-n <name-prefix>]
#
# Prerequisites:
#   - Azure CLI (az) logged in
#   - Subscription with OpenAI access

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────
PREFIX="csagraphrag"
LOCATION="eastus2"
RESOURCE_GROUP=""
OPENAI_MODEL="gpt-5.4"
EMBEDDING_MODEL="text-embedding-3-large"

# ─── Parse Arguments ─────────────────────────────────────────────
usage() {
    echo "Usage: $0 -g <resource-group> [-l <location>] [-n <name-prefix>]"
    echo ""
    echo "Options:"
    echo "  -g  Resource group name (required)"
    echo "  -l  Azure region (default: eastus2)"
    echo "  -n  Naming prefix (default: csagraphrag)"
    echo "  -h  Show this help"
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
echo "║  CSA-in-a-Box: GraphRAG Infrastructure Deployment          ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Resource Group: $RESOURCE_GROUP"
echo "║  Location:       $LOCATION"
echo "║  Prefix:         $PREFIX"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Create Resource Group ───────────────────────────────
echo ">>> Step 1/6: Creating resource group..."
az group create \
    --name "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --output none
echo "    ✓ Resource group created"

# ─── Step 2: Deploy Azure OpenAI ─────────────────────────────────
OPENAI_NAME="${PREFIX}oai"
echo ">>> Step 2/6: Deploying Azure OpenAI ($OPENAI_NAME)..."
az cognitiveservices account create \
    --name "$OPENAI_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --kind OpenAI \
    --sku S0 \
    --custom-domain "$OPENAI_NAME" \
    --output none 2>/dev/null || echo "    (OpenAI account may already exist)"

echo "    Deploying $OPENAI_MODEL model..."
az cognitiveservices account deployment create \
    --name "$OPENAI_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --deployment-name "$OPENAI_MODEL" \
    --model-name "$OPENAI_MODEL" \
    --model-version "2026-03-05" \
    --model-format OpenAI \
    --sku-capacity 30 \
    --sku-name Standard \
    --output none 2>/dev/null || echo "    (Model deployment may already exist)"

echo "    Deploying $EMBEDDING_MODEL model..."
az cognitiveservices account deployment create \
    --name "$OPENAI_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --deployment-name "$EMBEDDING_MODEL" \
    --model-name "$EMBEDDING_MODEL" \
    --model-version "1" \
    --model-format OpenAI \
    --sku-capacity 120 \
    --sku-name Standard \
    --output none 2>/dev/null || echo "    (Embedding deployment may already exist)"

OPENAI_ENDPOINT=$(az cognitiveservices account show \
    --name "$OPENAI_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query "properties.endpoint" -o tsv)
echo "    ✓ Azure OpenAI deployed: $OPENAI_ENDPOINT"

# ─── Step 3: Deploy Storage Account ─────────────────────────────
STORAGE_NAME="${PREFIX}store"
echo ">>> Step 3/6: Deploying Storage Account ($STORAGE_NAME)..."
az storage account create \
    --name "$STORAGE_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku Standard_LRS \
    --kind StorageV2 \
    --enable-hierarchical-namespace true \
    --output none 2>/dev/null || echo "    (Storage account may already exist)"

# Create containers for GraphRAG
az storage container create \
    --name "graphrag-input" \
    --account-name "$STORAGE_NAME" \
    --auth-mode login \
    --output none 2>/dev/null || true
az storage container create \
    --name "graphrag-output" \
    --account-name "$STORAGE_NAME" \
    --auth-mode login \
    --output none 2>/dev/null || true

STORAGE_URL="https://${STORAGE_NAME}.blob.core.windows.net"
echo "    ✓ Storage deployed: $STORAGE_URL"

# ─── Step 4: Deploy Cosmos DB Gremlin ────────────────────────────
COSMOS_NAME="${PREFIX}cosmos"
echo ">>> Step 4/6: Deploying Cosmos DB Gremlin ($COSMOS_NAME)..."
az cosmosdb create \
    --name "$COSMOS_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --capabilities EnableGremlin \
    --default-consistency-level Session \
    --locations regionName="$LOCATION" failoverPriority=0 \
    --output none 2>/dev/null || echo "    (Cosmos account may already exist)"

az cosmosdb gremlin database create \
    --account-name "$COSMOS_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --name "graphrag" \
    --output none 2>/dev/null || true

az cosmosdb gremlin graph create \
    --account-name "$COSMOS_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --database-name "graphrag" \
    --name "knowledge" \
    --partition-key-path "/pk" \
    --throughput 400 \
    --output none 2>/dev/null || true

COSMOS_ENDPOINT=$(az cosmosdb show \
    --name "$COSMOS_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query "documentEndpoint" -o tsv)
GREMLIN_ENDPOINT="wss://${COSMOS_NAME}.gremlin.cosmos.azure.com:443/"
echo "    ✓ Cosmos DB Gremlin deployed: $GREMLIN_ENDPOINT"

# ─── Step 5: Deploy Azure AI Search ──────────────────────────────
SEARCH_NAME="${PREFIX}search"
echo ">>> Step 5/6: Deploying Azure AI Search ($SEARCH_NAME)..."
az search service create \
    --name "$SEARCH_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku standard \
    --semantic-search free \
    --output none 2>/dev/null || echo "    (Search service may already exist)"

SEARCH_ENDPOINT="https://${SEARCH_NAME}.search.windows.net"
echo "    ✓ AI Search deployed: $SEARCH_ENDPOINT"

# ─── Step 6: Configure RBAC ─────────────────────────────────────
echo ">>> Step 6/6: Configuring RBAC..."
CURRENT_USER=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
if [[ -n "$CURRENT_USER" ]]; then
    # Storage Blob Data Contributor on storage
    az role assignment create \
        --assignee "$CURRENT_USER" \
        --role "Storage Blob Data Contributor" \
        --scope "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Storage/storageAccounts/$STORAGE_NAME" \
        --output none 2>/dev/null || true

    # Cognitive Services OpenAI User on OpenAI
    az role assignment create \
        --assignee "$CURRENT_USER" \
        --role "Cognitive Services OpenAI User" \
        --scope "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.CognitiveServices/accounts/$OPENAI_NAME" \
        --output none 2>/dev/null || true

    echo "    ✓ RBAC configured for current user"
else
    echo "    ⚠ Could not determine current user for RBAC. Configure manually."
fi

# ─── Output Summary ──────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Deployment Complete                                        ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Set these environment variables:                           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "export AZURE_OPENAI_ENDPOINT=\"$OPENAI_ENDPOINT\""
echo "export AZURE_STORAGE_ACCOUNT_URL=\"$STORAGE_URL\""
echo "export COSMOS_GREMLIN_ENDPOINT=\"$GREMLIN_ENDPOINT\""
echo "export AZURE_SEARCH_ENDPOINT=\"$SEARCH_ENDPOINT\""
echo ""
echo "Next steps:"
echo "  1. Import documents:  python -m csa_platform.ai_integration.graphrag.document_loader"
echo "  2. Build index:       graphrag index --root ./graphrag-workspace"
echo "  3. Query:             python -m csa_platform.ai_integration.graphrag.search"
echo ""
echo "See docs/tutorials/09-graphrag-knowledge/ for the complete walkthrough."
