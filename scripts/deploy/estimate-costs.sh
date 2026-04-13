#!/usr/bin/env bash
# =============================================================================
# CSA-in-a-Box: Cost Estimation for Bicep Deployments
#
# Converts Bicep → ARM JSON, extracts resource types and SKUs, and queries
# the Azure Retail Prices API to produce a monthly cost estimate.
#
# Because Infracost does not natively support Bicep, this script provides a
# best-effort estimate using the public pricing API.  For exact figures, use
# the Terraform path with native Infracost support.
#
# Usage:
#   ./estimate-costs.sh deploy/bicep/DLZ/main.bicep
#   ./estimate-costs.sh deploy/bicep/DLZ/main.bicep --params deploy/bicep/DLZ/params.dev.json
#   ./estimate-costs.sh deploy/bicep/DLZ/main.bicep --format json
#   ./estimate-costs.sh deploy/bicep/DLZ/main.bicep --budget 5000
#   ./estimate-costs.sh deploy/bicep/DLZ/main.bicep --environment dev --currency USD
#
# Requirements:
#   - Azure CLI with Bicep extension (az bicep build)
#   - jq (JSON processing)
#   - curl (API calls)
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Color codes (consistent with deploy-platform.sh / validate-prerequisites.sh)
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
POLICY_FILE="${REPO_ROOT}/.infracost/policy.yml"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
BICEP_FILE=""
PARAMS_FILE=""
OUTPUT_FORMAT="table"       # table | json
BUDGET=""
ENVIRONMENT="dev"
CURRENCY="USD"
REGION="eastus"
API_BASE="https://prices.azure.com/api/retail/prices"

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
log_step() { echo -e "\n${BLUE}==>${NC} $1"; }
log_ok()   { echo -e "  ${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "  ${YELLOW}[WARN]${NC} $1"; }
log_err()  { echo -e "  ${RED}[FAIL]${NC} $1"; }

usage() {
    cat <<EOF
Usage: $(basename "$0") <bicep-file> [OPTIONS]

Arguments:
  <bicep-file>                Path to a .bicep file

Options:
  -p, --params FILE           Bicep parameters file (.json)
  -f, --format FORMAT         Output format: table (default) | json
  -b, --budget AMOUNT         Budget threshold (monthly USD)
  -e, --environment ENV       Environment name for policy lookup (default: dev)
  -r, --region REGION         Azure region for pricing (default: eastus)
  -c, --currency CURRENCY     Currency code (default: USD)
  -h, --help                  Show this help
EOF
    exit 0
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case $1 in
        --params|-p)     PARAMS_FILE="$2"; shift 2 ;;
        --format|-f)     OUTPUT_FORMAT="$2"; shift 2 ;;
        --budget|-b)     BUDGET="$2"; shift 2 ;;
        --environment|-e) ENVIRONMENT="$2"; shift 2 ;;
        --region|-r)     REGION="$2"; shift 2 ;;
        --currency|-c)   CURRENCY="$2"; shift 2 ;;
        --help|-h)       usage ;;
        -*)              log_err "Unknown option: $1"; usage ;;
        *)
            if [[ -z "$BICEP_FILE" ]]; then
                BICEP_FILE="$1"; shift
            else
                log_err "Unexpected argument: $1"; usage
            fi
            ;;
    esac
done

if [[ -z "$BICEP_FILE" ]]; then
    log_err "A Bicep file path is required."
    usage
fi

if [[ ! -f "$BICEP_FILE" ]]; then
    log_err "Bicep file not found: ${BICEP_FILE}"
    exit 1
fi

# ---------------------------------------------------------------------------
# Prerequisites check
# ---------------------------------------------------------------------------
for cmd in az jq curl; do
    if ! command -v "$cmd" &>/dev/null; then
        log_err "Required command not found: ${cmd}"
        exit 1
    fi
done

# ---------------------------------------------------------------------------
# ARM type → Azure Retail Prices API filter mapping
#
# Each entry maps an ARM resource type to the API query fields used to look
# up a representative unit price.  The "hours_per_month" key controls how
# raw per-hour prices are converted to monthly estimates (730 h default).
#
# Structure:  ARM_TYPE -> "serviceName|skuName|meterName|productName"
#   - Fields left blank are omitted from the filter.
#   - Multiple mappings per ARM type are separated by a semicolon.
# ---------------------------------------------------------------------------
declare -A RESOURCE_PRICE_MAP=(
    # Storage Accounts
    ["Microsoft.Storage/storageAccounts"]="Storage|Standard_LRS|LRS Data Stored|Blob Storage"
    # Event Hubs
    ["Microsoft.EventHub/namespaces"]="Event Hubs|Standard|Throughput Unit|Event Hubs"
    # Data Factory
    ["Microsoft.DataFactory/factories"]="Azure Data Factory v2||Cloud Data Movement|Azure Data Factory v2"
    # Databricks
    ["Microsoft.Databricks/workspaces"]="Azure Databricks|premium|All-purpose Compute DBU|Azure Databricks"
    # Data Explorer (Kusto)
    ["Microsoft.Kusto/clusters"]="Azure Data Explorer|Dev(No SLA)_Standard_E2a_v4||Azure Data Explorer"
    # Key Vault
    ["Microsoft.KeyVault/vaults"]="Key Vault|Standard|Operations|Key Vault"
    # Cosmos DB
    ["Microsoft.DocumentDB/databaseAccounts"]="Azure Cosmos DB|Autoscale - Provisioned Throughput|100 Multi-master RU/s|Azure Cosmos DB"
    # Azure Functions
    ["Microsoft.Web/sites"]="Functions||Execution Time|Functions"
    # Stream Analytics
    ["Microsoft.StreamAnalytics/streamingjobs"]="Stream Analytics|Standard|Streaming Unit|Stream Analytics"
    # Log Analytics
    ["Microsoft.OperationalInsights/workspaces"]="Log Analytics|Per GB||Azure Monitor"
    # Machine Learning
    ["Microsoft.MachineLearningServices/workspaces"]="Azure Machine Learning||Basic|Azure Machine Learning"
    # Synapse Analytics
    ["Microsoft.Synapse/workspaces"]="Azure Synapse Analytics||Built-in Serverless SQL Pool|Azure Synapse Analytics"
    # Application Insights
    ["Microsoft.Insights/components"]="Application Insights||Enterprise Overage Data|Application Insights"
    # Resource Groups (no cost)
    ["Microsoft.Resources/resourceGroups"]=""
)

# Hours in a month (730 = 365.25 * 24 / 12)
HOURS_PER_MONTH=730

# ---------------------------------------------------------------------------
# Step 1: Convert Bicep to ARM JSON
# ---------------------------------------------------------------------------
log_step "Compiling Bicep → ARM JSON"

ARM_JSON=$(az bicep build --file "$BICEP_FILE" --stdout 2>/dev/null) || {
    log_err "Failed to compile Bicep file: ${BICEP_FILE}"
    log_warn "Ensure the Azure CLI Bicep extension is installed: az bicep install"
    exit 1
}
log_ok "Compiled ${BICEP_FILE}"

# ---------------------------------------------------------------------------
# Step 2: Extract resource types from the ARM template
# ---------------------------------------------------------------------------
log_step "Extracting resources from ARM template"

# Collect all resource types (including nested) and count occurrences
RESOURCE_TYPES=$(echo "$ARM_JSON" | jq -r '
    [.. | objects | select(.type? and (.type | test("^Microsoft\\."))) | .type] |
    group_by(.) |
    map({type: .[0], count: length}) |
    .[] |
    "\(.type)|\(.count)"
' 2>/dev/null | sort -u)

if [[ -z "$RESOURCE_TYPES" ]]; then
    log_warn "No Azure resource types found in the template."
    log_warn "The template may use only parameters/variables without inline resources."
    # Try top-level resources array as fallback
    RESOURCE_TYPES=$(echo "$ARM_JSON" | jq -r '
        .resources[]? | "\(.type)|1"
    ' 2>/dev/null | sort -u)
fi

RESOURCE_COUNT=$(echo "$RESOURCE_TYPES" | grep -c . || true)
log_ok "Found ${RESOURCE_COUNT} distinct resource type(s)"

# ---------------------------------------------------------------------------
# Step 3: Query Azure Retail Prices API for each resource type
# ---------------------------------------------------------------------------
log_step "Querying Azure Retail Prices API"

# Normalize region name for the API (e.g., "eastus" → "East US")
region_display() {
    case "${1,,}" in
        eastus)         echo "US East" ;;
        eastus2)        echo "US East 2" ;;
        westus)         echo "US West" ;;
        westus2)        echo "US West 2" ;;
        centralus)      echo "US Central" ;;
        southcentralus) echo "US South Central" ;;
        northcentralus) echo "US North Central" ;;
        westcentralus)  echo "US West Central" ;;
        usgovvirginia)  echo "US Gov Virginia" ;;
        usgoviowa)      echo "US Gov Iowa" ;;
        usgovarizona)   echo "US Gov Arizona" ;;
        usgovtexas)     echo "US Gov Texas" ;;
        *)              echo "$1" ;;
    esac
}

AZURE_REGION=$(region_display "$REGION")

# Results array for JSON output
declare -a RESULTS=()
TOTAL_MONTHLY=0

query_price() {
    local service_name="$1"
    local sku_name="$2"
    local meter_name="$3"
    local product_name="$4"

    # Build OData filter
    local filter="currencyCode eq '${CURRENCY}'"

    if [[ -n "$service_name" ]]; then
        filter="${filter} and serviceName eq '${service_name}'"
    fi
    if [[ -n "$sku_name" ]]; then
        filter="${filter} and skuName eq '${sku_name}'"
    fi
    if [[ -n "$meter_name" ]]; then
        filter="${filter} and contains(meterName, '${meter_name}')"
    fi
    if [[ -n "$product_name" ]]; then
        filter="${filter} and contains(productName, '${product_name}')"
    fi

    # Prefer the specified region, fall back to any
    local region_filter="${filter} and armRegionName eq '${REGION}'"

    local encoded_filter
    encoded_filter=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''${region_filter}'''))" 2>/dev/null || \
                     printf '%s' "$region_filter" | jq -sRr @uri 2>/dev/null || \
                     printf '%s' "$region_filter")

    local url="${API_BASE}?\$filter=${encoded_filter}&\$top=1"

    local response
    response=$(curl -s --retry 2 --retry-delay 1 "$url" 2>/dev/null) || return 1

    local price
    price=$(echo "$response" | jq -r '.Items[0].retailPrice // empty' 2>/dev/null)

    if [[ -z "$price" ]]; then
        # Retry without region constraint
        encoded_filter=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''${filter}'''))" 2>/dev/null || \
                         printf '%s' "$filter" | jq -sRr @uri 2>/dev/null || \
                         printf '%s' "$filter")
        url="${API_BASE}?\$filter=${encoded_filter}&\$top=1"
        response=$(curl -s --retry 2 --retry-delay 1 "$url" 2>/dev/null) || return 1
        price=$(echo "$response" | jq -r '.Items[0].retailPrice // empty' 2>/dev/null)
    fi

    if [[ -n "$price" ]]; then
        local unit_of_measure
        unit_of_measure=$(echo "$response" | jq -r '.Items[0].unitOfMeasure // "Unknown"' 2>/dev/null)
        local actual_sku
        actual_sku=$(echo "$response" | jq -r '.Items[0].skuName // "N/A"' 2>/dev/null)
        echo "${price}|${unit_of_measure}|${actual_sku}"
    fi
}

# Calculate monthly cost from unit price and unit of measure
calc_monthly() {
    local unit_price="$1"
    local unit_of_measure="$2"
    local quantity="$3"

    case "$unit_of_measure" in
        *Hour*|*hr*)
            echo "$unit_price * $HOURS_PER_MONTH * $quantity" | bc -l 2>/dev/null || echo "0"
            ;;
        *Day*)
            echo "$unit_price * 30.4375 * $quantity" | bc -l 2>/dev/null || echo "0"
            ;;
        *Month*|*mo*)
            echo "$unit_price * $quantity" | bc -l 2>/dev/null || echo "0"
            ;;
        *GB*|*TB*)
            # Per-GB pricing — assume a baseline consumption (1 GB for estimation)
            echo "$unit_price * $quantity" | bc -l 2>/dev/null || echo "0"
            ;;
        *10K*|*10,000*)
            # Per 10K operations — assume 100K operations/month baseline
            echo "$unit_price * 10 * $quantity" | bc -l 2>/dev/null || echo "0"
            ;;
        *1M*|*1,000,000*)
            # Per million executions — assume 1M baseline
            echo "$unit_price * $quantity" | bc -l 2>/dev/null || echo "0"
            ;;
        *)
            # Default: treat as monthly
            echo "$unit_price * $quantity" | bc -l 2>/dev/null || echo "0"
            ;;
    esac
}

# Process each resource type
while IFS='|' read -r res_type res_count; do
    [[ -z "$res_type" ]] && continue

    mapping="${RESOURCE_PRICE_MAP[$res_type]:-}"

    if [[ -z "$mapping" ]]; then
        # No mapping — mark as unpriced
        RESULTS+=("{\"resource_type\":\"${res_type}\",\"sku\":\"N/A\",\"unit_price\":0,\"quantity\":${res_count},\"monthly_cost\":0,\"note\":\"No pricing mapping\"}")
        log_warn "${res_type} (×${res_count}) — no pricing mapping"
        continue
    fi

    IFS='|' read -r svc_name sku_name meter_name prod_name <<< "$mapping"

    price_result=$(query_price "$svc_name" "$sku_name" "$meter_name" "$prod_name" 2>/dev/null || true)

    if [[ -z "$price_result" ]]; then
        RESULTS+=("{\"resource_type\":\"${res_type}\",\"sku\":\"${sku_name:-N/A}\",\"unit_price\":0,\"quantity\":${res_count},\"monthly_cost\":0,\"note\":\"Price not found\"}")
        log_warn "${res_type} (×${res_count}) — price not found via API"
        continue
    fi

    IFS='|' read -r unit_price unit_of_measure actual_sku <<< "$price_result"

    monthly=$(calc_monthly "$unit_price" "$unit_of_measure" "$res_count")
    monthly=$(printf "%.2f" "$monthly" 2>/dev/null || echo "0.00")

    TOTAL_MONTHLY=$(echo "$TOTAL_MONTHLY + $monthly" | bc -l 2>/dev/null || echo "$TOTAL_MONTHLY")

    RESULTS+=("{\"resource_type\":\"${res_type}\",\"sku\":\"${actual_sku}\",\"unit_price\":${unit_price},\"unit_of_measure\":\"${unit_of_measure}\",\"quantity\":${res_count},\"monthly_cost\":${monthly}}")
    log_ok "${res_type} (×${res_count}): \$${monthly}/mo"

done <<< "$RESOURCE_TYPES"

TOTAL_MONTHLY=$(printf "%.2f" "$TOTAL_MONTHLY" 2>/dev/null || echo "0.00")

# ---------------------------------------------------------------------------
# Step 4: Output results
# ---------------------------------------------------------------------------
echo ""

if [[ "$OUTPUT_FORMAT" == "json" ]]; then
    # --- JSON output ---
    jq -n \
        --arg file "$BICEP_FILE" \
        --arg env "$ENVIRONMENT" \
        --arg region "$REGION" \
        --arg currency "$CURRENCY" \
        --arg total "$TOTAL_MONTHLY" \
        --arg budget "${BUDGET:-null}" \
        --argjson resources "$(printf '[%s]' "$(IFS=,; echo "${RESULTS[*]}")")" \
        '{
            file: $file,
            environment: $env,
            region: $region,
            currency: $currency,
            resources: $resources,
            total_monthly_cost: ($total | tonumber),
            budget: (if $budget == "null" then null else ($budget | tonumber) end),
            budget_exceeded: (if $budget == "null" then null else (($total | tonumber) > ($budget | tonumber)) end),
            timestamp: (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
        }'
else
    # --- Table output ---
    echo -e "${BLUE}╔══════════════════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║${NC}  ${BOLD}Cost Estimate: ${BICEP_FILE}${NC}"
    echo -e "${BLUE}║${NC}  Environment: ${GREEN}${ENVIRONMENT}${NC}  Region: ${GREEN}${REGION}${NC}  Currency: ${GREEN}${CURRENCY}${NC}"
    echo -e "${BLUE}╠══════════════════════════════════════════════════════════════════════════════════════╣${NC}"
    printf "${BLUE}║${NC}  ${BOLD}%-45s %-18s %8s %5s %12s${NC}\n" "Resource Type" "SKU" "Unit \$" "Qty" "Monthly \$"
    echo -e "${BLUE}╠══════════════════════════════════════════════════════════════════════════════════════╣${NC}"

    for entry in "${RESULTS[@]}"; do
        res_type=$(echo "$entry" | jq -r '.resource_type')
        sku=$(echo "$entry" | jq -r '.sku')
        unit_price=$(echo "$entry" | jq -r '.unit_price')
        quantity=$(echo "$entry" | jq -r '.quantity')
        monthly=$(echo "$entry" | jq -r '.monthly_cost')
        note=$(echo "$entry" | jq -r '.note // empty')

        # Shorten resource type for display
        short_type="${res_type#Microsoft.}"

        if [[ -n "$note" ]]; then
            printf "${BLUE}║${NC}  ${YELLOW}%-45s %-18s %8s %5s %12s${NC}\n" \
                "$short_type" "$sku" "-" "$quantity" "(${note})"
        else
            printf "${BLUE}║${NC}  %-45s %-18s %8.4f %5s %12.2f\n" \
                "$short_type" "$sku" "$unit_price" "$quantity" "$monthly"
        fi
    done

    echo -e "${BLUE}╠══════════════════════════════════════════════════════════════════════════════════════╣${NC}"
    printf "${BLUE}║${NC}  ${BOLD}%-45s %-18s %8s %5s ${GREEN}%12.2f${NC}\n" \
        "TOTAL ESTIMATED MONTHLY COST" "" "" "" "$TOTAL_MONTHLY"
    echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════════════════════════╝${NC}"
fi

# ---------------------------------------------------------------------------
# Step 5: Budget comparison
# ---------------------------------------------------------------------------
if [[ -n "$BUDGET" ]]; then
    echo ""
    log_step "Budget Check"
    OVER=$(echo "$TOTAL_MONTHLY > $BUDGET" | bc -l 2>/dev/null || echo "0")
    if [[ "$OVER" == "1" ]]; then
        DIFF=$(echo "$TOTAL_MONTHLY - $BUDGET" | bc -l 2>/dev/null || echo "0")
        DIFF=$(printf "%.2f" "$DIFF")
        log_err "OVER BUDGET by \$${DIFF}  (estimate: \$${TOTAL_MONTHLY}, budget: \$${BUDGET})"
        if [[ "$OUTPUT_FORMAT" != "json" ]]; then
            exit 2
        fi
    else
        REMAINING=$(echo "$BUDGET - $TOTAL_MONTHLY" | bc -l 2>/dev/null || echo "0")
        REMAINING=$(printf "%.2f" "$REMAINING")
        PCT=$(echo "scale=1; $TOTAL_MONTHLY * 100 / $BUDGET" | bc -l 2>/dev/null || echo "0")
        log_ok "Within budget — \$${REMAINING} remaining (${PCT}% used)"
    fi
elif [[ -f "$POLICY_FILE" ]] && command -v python3 &>/dev/null; then
    # Try to load budget from policy file
    POLICY_BUDGET=$(python3 -c "
import yaml, sys
try:
    with open('${POLICY_FILE}') as f:
        p = yaml.safe_load(f)
    for policy in p.get('policies', []):
        envs = policy.get('environments', {})
        if '${ENVIRONMENT}' in envs:
            print(envs['${ENVIRONMENT}'].get('monthly_budget', ''))
            sys.exit(0)
except Exception:
    pass
" 2>/dev/null || true)

    if [[ -n "$POLICY_BUDGET" ]]; then
        echo ""
        log_step "Budget Check (from policy: ${ENVIRONMENT})"
        OVER=$(echo "$TOTAL_MONTHLY > $POLICY_BUDGET" | bc -l 2>/dev/null || echo "0")
        if [[ "$OVER" == "1" ]]; then
            DIFF=$(echo "$TOTAL_MONTHLY - $POLICY_BUDGET" | bc -l 2>/dev/null || echo "0")
            DIFF=$(printf "%.2f" "$DIFF")
            log_err "OVER BUDGET by \$${DIFF}  (estimate: \$${TOTAL_MONTHLY}, policy budget: \$${POLICY_BUDGET})"
        else
            REMAINING=$(echo "$POLICY_BUDGET - $TOTAL_MONTHLY" | bc -l 2>/dev/null || echo "0")
            REMAINING=$(printf "%.2f" "$REMAINING")
            PCT=$(echo "scale=1; $TOTAL_MONTHLY * 100 / $POLICY_BUDGET" | bc -l 2>/dev/null || echo "0")
            log_ok "Within budget — \$${REMAINING} remaining (${PCT}% of \$${POLICY_BUDGET} budget)"
        fi
    fi
fi

echo ""
echo -e "${CYAN}Note:${NC} These are best-effort estimates from the Azure Retail Prices API."
echo -e "      Actual costs depend on consumption, reserved instances, and negotiated rates."
echo -e "      For precise estimates, use the Terraform path with Infracost: deploy/terraform/"
echo ""
