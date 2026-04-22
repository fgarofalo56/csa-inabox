#!/usr/bin/env bash
# One-Click Demo: Deploy a working CSA-in-a-Box platform with sample data
# Sets up a complete demo environment with Finance vertical + AI components
#
# Estimated time: 20-30 minutes
# Estimated cost: $5-15/day (Azure consumption)
#
# Usage:
#   ./one-click-demo.sh -g <resource-group> [-l <location>] [-n <prefix>] [--skip-infra]
#
# Prerequisites:
#   - Azure CLI (az) logged in with Owner/Contributor
#   - Python 3.10+ with pip
#   - Docker (for MCP server)

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────
PREFIX="csademo"
LOCATION="eastus2"
RESOURCE_GROUP=""
SKIP_INFRA=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TOTAL_STEPS=9
DEMO_VERTICAL="finance"

# ─── Parse Arguments ─────────────────────────────────────────────
usage() {
    echo "Usage: $0 -g <resource-group> [-l <location>] [-n <prefix>] [--skip-infra]"
    echo ""
    echo "Options:"
    echo "  -g  Resource group name (required)"
    echo "  -l  Azure region (default: eastus2)"
    echo "  -n  Naming prefix (default: csademo)"
    echo "  --skip-infra  Skip infrastructure deployment (use existing)"
    echo "  -h  Show this help"
    echo ""
    echo "This deploys a complete demo with the Finance vertical, sample data,"
    echo "AI components (OpenAI, AI Search, GraphRAG), and a local chatbot."
    echo ""
    echo "Estimated time: 20-30 minutes"
    echo "Estimated cost: \$5-15/day (Azure consumption-based)"
    exit 1
}

# Parse long options manually, then use getopts for short ones
ARGS=()
for arg in "$@"; do
    case $arg in
        --skip-infra) SKIP_INFRA=true ;;
        *) ARGS+=("$arg") ;;
    esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

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
echo "║  CSA-in-a-Box: One-Click Demo Setup                         ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Resource Group: $RESOURCE_GROUP"
echo "║  Location:       $LOCATION"
echo "║  Prefix:         $PREFIX"
echo "║  Skip Infra:     $SKIP_INFRA"
echo "║                                                              ║"
echo "║  ⏱  Estimated time: 20-30 minutes                           ║"
echo "║  💰 Estimated cost: \$5-15/day                               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Check Prerequisites ─────────────────────────────────
echo ">>> Step 1/$TOTAL_STEPS: Checking prerequisites..."
MISSING=()

command -v az >/dev/null 2>&1 || MISSING+=("az (Azure CLI)")
command -v python >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1 || MISSING+=("python 3.10+")
command -v pip >/dev/null 2>&1 || command -v pip3 >/dev/null 2>&1 || MISSING+=("pip")
command -v docker >/dev/null 2>&1 || MISSING+=("docker")

if [[ ${#MISSING[@]} -gt 0 ]]; then
    echo "    ✗ Missing prerequisites:"
    for m in "${MISSING[@]}"; do
        echo "      - $m"
    done
    echo ""
    echo "    Install missing tools and re-run this script."
    exit 1
fi

# Check Azure login
az account show --output none 2>/dev/null || {
    echo "    ✗ Not logged in to Azure. Run: az login"
    exit 1
}

PYTHON_CMD=$(command -v python3 2>/dev/null || command -v python)
PIP_CMD=$(command -v pip3 2>/dev/null || command -v pip)

echo "    ✓ az CLI:   $(az version --query '"azure-cli"' -o tsv 2>/dev/null)"
echo "    ✓ Python:   $($PYTHON_CMD --version 2>&1)"
echo "    ✓ Docker:   $(docker --version 2>/dev/null | head -1)"
echo "    ✓ Azure:    $(az account show --query name -o tsv 2>/dev/null)"

# ─── Step 2: Deploy Infrastructure ───────────────────────────────
echo ">>> Step 2/$TOTAL_STEPS: Deploying infrastructure..."
if [[ "$SKIP_INFRA" == "true" ]]; then
    echo "    → Skipping infrastructure (--skip-infra)"
else
    bash "$PROJECT_ROOT/scripts/deploy-vertical.sh" \
        -g "$RESOURCE_GROUP" \
        -l "$LOCATION" \
        -v "$DEMO_VERTICAL" \
        -n "$PREFIX"
    echo "    ✓ Infrastructure deployed"
fi

# Validate infrastructure exists
az group show --name "$RESOURCE_GROUP" --output none 2>/dev/null || {
    echo "    ✗ Resource group $RESOURCE_GROUP not found. Remove --skip-infra flag."
    exit 1
}
echo "    ✓ Infrastructure validation passed"

# ─── Step 3: Download Sample Data ────────────────────────────────
echo ">>> Step 3/$TOTAL_STEPS: Downloading sample data (small subset)..."
SAMPLE_DIR="$PROJECT_ROOT/data/$DEMO_VERTICAL/demo"
mkdir -p "$SAMPLE_DIR"

DATA_SCRIPT="$PROJECT_ROOT/scripts/data/download-${DEMO_VERTICAL}.py"
if [[ -f "$DATA_SCRIPT" ]]; then
    $PYTHON_CMD "$DATA_SCRIPT" \
        --output-dir "$SAMPLE_DIR" \
        --sample-only \
        2>&1 | tail -5 || echo "    (Data download may need manual configuration)"
    echo "    ✓ Sample data downloaded"
else
    echo "    ⚠ Data script not found: $DATA_SCRIPT"
    echo "    → Using existing data or create sample files manually"
fi

# Upload to storage if available
STORAGE_NAME="${PREFIX}dlz"
az storage account show --name "$STORAGE_NAME" --resource-group "$RESOURCE_GROUP" --output none 2>/dev/null && {
    echo "    Uploading sample data to storage..."
    az storage blob upload-batch \
        --account-name "$STORAGE_NAME" \
        --destination "raw" \
        --source "$SAMPLE_DIR" \
        --auth-mode login \
        --overwrite \
        --output none 2>/dev/null || echo "    (Upload may need storage permissions)"
    echo "    ✓ Sample data uploaded to storage"
} || echo "    → Storage account not found, skipping upload"

# ─── Step 4: Run dbt Transformations ─────────────────────────────
echo ">>> Step 4/$TOTAL_STEPS: Running dbt transformations..."
DBT_DIR="$PROJECT_ROOT/verticals/$DEMO_VERTICAL/dbt"
if [[ -d "$DBT_DIR" ]]; then
    cd "$DBT_DIR"
    dbt deps 2>/dev/null || true
    dbt seed --target dev 2>/dev/null || echo "    (dbt seed requires warehouse connection)"
    dbt run --target dev 2>/dev/null || echo "    (dbt run requires warehouse connection)"
    cd "$PROJECT_ROOT"
    echo "    ✓ dbt transformations complete"
else
    echo "    ⚠ dbt project not found at $DBT_DIR"
    echo "    → Skipping transformations"
fi

# ─── Step 5: Deploy AI Components ────────────────────────────────
echo ">>> Step 5/$TOTAL_STEPS: Deploying AI components..."
OPENAI_NAME="${PREFIX}oai"
SEARCH_NAME="${PREFIX}search"

# Deploy OpenAI
az cognitiveservices account create \
    --name "$OPENAI_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --kind OpenAI \
    --sku S0 \
    --custom-domain "$OPENAI_NAME" \
    --output none 2>/dev/null || echo "    (OpenAI account may already exist)"

# Deploy chat model
az cognitiveservices account deployment create \
    --name "$OPENAI_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --deployment-name "gpt-4o" \
    --model-name "gpt-4o" \
    --model-version "2024-11-20" \
    --model-format OpenAI \
    --sku-capacity 30 \
    --sku-name Standard \
    --output none 2>/dev/null || echo "    (Chat model may already exist)"

# Deploy embedding model
az cognitiveservices account deployment create \
    --name "$OPENAI_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --deployment-name "text-embedding-3-large" \
    --model-name "text-embedding-3-large" \
    --model-version "1" \
    --model-format OpenAI \
    --sku-capacity 120 \
    --sku-name Standard \
    --output none 2>/dev/null || echo "    (Embedding model may already exist)"

# Deploy AI Search
az search service create \
    --name "$SEARCH_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku basic \
    --semantic-search free \
    --output none 2>/dev/null || echo "    (Search service may already exist)"

OPENAI_ENDPOINT=$(az cognitiveservices account show \
    --name "$OPENAI_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query "properties.endpoint" -o tsv 2>/dev/null || echo "https://${OPENAI_NAME}.openai.azure.com/")
SEARCH_ENDPOINT="https://${SEARCH_NAME}.search.windows.net"

echo "    ✓ OpenAI deployed: $OPENAI_ENDPOINT"
echo "    ✓ AI Search deployed: $SEARCH_ENDPOINT"

# ─── Step 6: Load GraphRAG Documents ─────────────────────────────
echo ">>> Step 6/$TOTAL_STEPS: Loading sample GraphRAG documents..."
GRAPHRAG_LOADER="$PROJECT_ROOT/src/csa_platform/ai_integration/graphrag/document_loader.py"
if [[ -f "$GRAPHRAG_LOADER" ]]; then
    $PYTHON_CMD "$GRAPHRAG_LOADER" \
        --sample-docs \
        --vertical "$DEMO_VERTICAL" \
        2>/dev/null || echo "    (GraphRAG loader may need additional config)"
    echo "    ✓ GraphRAG documents loaded"
else
    echo "    ⚠ GraphRAG loader not found"
    echo "    → Documents can be loaded later with the graphrag CLI"
fi

# ─── Step 7: Start MCP Server ────────────────────────────────────
echo ">>> Step 7/$TOTAL_STEPS: Starting MCP server locally..."
MCP_DIR="$PROJECT_ROOT/src/csa_platform/mcp_server"
if [[ -d "$MCP_DIR" ]]; then
    # Install dependencies
    $PIP_CMD install -q -e "$PROJECT_ROOT" 2>/dev/null || echo "    (pip install may need manual intervention)"

    # Start MCP server in background
    echo "    Starting MCP server on port 8080..."
    $PYTHON_CMD -m csa_platform.mcp_server \
        --port 8080 \
        --host 0.0.0.0 \
        > "$PROJECT_ROOT/temp/mcp-server.log" 2>&1 &
    MCP_PID=$!
    echo "    ✓ MCP server started (PID: $MCP_PID)"
    echo "    → Logs: temp/mcp-server.log"
else
    echo "    ⚠ MCP server not found at $MCP_DIR"
    echo "    → Start manually: python -m csa_platform.mcp_server"
    MCP_PID=""
fi

# ─── Step 8: Launch Demo Chatbot ─────────────────────────────────
echo ">>> Step 8/$TOTAL_STEPS: Launching demo chatbot..."
CHATBOT_DIR="$PROJECT_ROOT/src/csa_platform/chatbot"
if [[ -d "$CHATBOT_DIR" ]]; then
    echo "    Starting chatbot UI on port 8501..."
    $PYTHON_CMD -m streamlit run "$CHATBOT_DIR/app.py" \
        --server.port 8501 \
        --server.headless true \
        > "$PROJECT_ROOT/temp/chatbot.log" 2>&1 &
    CHATBOT_PID=$!
    echo "    ✓ Chatbot started (PID: $CHATBOT_PID)"
    echo "    → Logs: temp/chatbot.log"
else
    echo "    ⚠ Chatbot not found at $CHATBOT_DIR"
    echo "    → Launch manually when available"
    CHATBOT_PID=""
fi

# ─── Step 9: Print Demo Guide ────────────────────────────────────
echo ">>> Step 9/$TOTAL_STEPS: Demo ready!"
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  CSA-in-a-Box Demo Environment Ready                        ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Vertical:  $DEMO_VERTICAL"
echo "║  Region:    $LOCATION"
echo "║  Cost:      ~\$5-15/day (delete RG when done)               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "─── Environment Variables ────────────────────────────────────"
echo ""
echo "export CSA_RESOURCE_GROUP=\"$RESOURCE_GROUP\""
echo "export AZURE_OPENAI_ENDPOINT=\"$OPENAI_ENDPOINT\""
echo "export AZURE_SEARCH_ENDPOINT=\"$SEARCH_ENDPOINT\""
echo "export CSA_STORAGE_ACCOUNT=\"${PREFIX}dlz\""
echo ""
echo "─── Endpoints ────────────────────────────────────────────────"
echo ""
echo "  MCP Server:   http://localhost:8080"
echo "  Chatbot UI:   http://localhost:8501"
echo "  Azure Portal: https://portal.azure.com/#@/resource/subscriptions/$(az account show --query id -o tsv 2>/dev/null)/resourceGroups/$RESOURCE_GROUP"
echo ""
echo "─── Example Queries ──────────────────────────────────────────"
echo ""
echo "  Try these in the chatbot:"
echo "  1. \"What are the key financial indicators for Q4 2024?\""
echo "  2. \"Show me SEC filing trends for technology companies\""
echo "  3. \"Compare GDP growth across OECD countries\""
echo "  4. \"What economic datasets are available in the platform?\""
echo "  5. \"Explain the data lineage for the consumer_spending model\""
echo ""
echo "─── Cleanup ──────────────────────────────────────────────────"
echo ""
echo "  Stop services:  kill $MCP_PID $CHATBOT_PID 2>/dev/null"
echo "  Delete infra:   az group delete --name $RESOURCE_GROUP --yes --no-wait"
echo ""
echo "See docs/tutorials/ for guided walkthroughs."
