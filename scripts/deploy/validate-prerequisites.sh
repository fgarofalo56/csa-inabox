#!/usr/bin/env bash
# =============================================================================
# CSA-in-a-Box: Prerequisite Validation
#
# Checks that all required tools and permissions are available before
# deploying the platform.  Run this before deploy-platform.sh.
#
# Usage:
#   ./validate-prerequisites.sh
# =============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0

check() {
    local name="$1"
    local cmd="$2"
    local min_version="${3:-}"

    if eval "$cmd" &>/dev/null; then
        local version
        version=$(eval "$cmd" 2>/dev/null | head -1)
        echo -e "  ${GREEN}[OK]${NC} ${name}: ${version}"
    else
        echo -e "  ${RED}[MISSING]${NC} ${name}"
        ERRORS=$((ERRORS + 1))
    fi
}

echo "Checking prerequisites for CSA-in-a-Box deployment..."
echo ""

# --- CLI Tools ---
echo "CLI Tools:"
check "Azure CLI" "az version --output tsv 2>/dev/null | head -1"
check "Bicep CLI" "az bicep version 2>/dev/null"
check "Python 3" "python3 --version 2>/dev/null || python --version 2>/dev/null"
check "dbt" "dbt --version 2>/dev/null | head -1"
check "git" "git --version"
echo ""

# --- Azure Login ---
echo "Azure Authentication:"
if az account show &>/dev/null; then
    ACCOUNT=$(az account show --query name -o tsv 2>/dev/null)
    SUB_ID=$(az account show --query id -o tsv 2>/dev/null)
    echo -e "  ${GREEN}[OK]${NC} Logged in: ${ACCOUNT} (${SUB_ID})"
else
    echo -e "  ${RED}[MISSING]${NC} Not logged in. Run: az login"
    ERRORS=$((ERRORS + 1))
fi
echo ""

# --- Resource Providers ---
echo "Resource Providers:"
REQUIRED_PROVIDERS=(
    "Microsoft.Compute"
    "Microsoft.Network"
    "Microsoft.Storage"
    "Microsoft.KeyVault"
    "Microsoft.DataFactory"
    "Microsoft.Databricks"
    "Microsoft.Synapse"
    "Microsoft.EventHub"
    "Microsoft.Kusto"
    "Microsoft.Purview"
    "Microsoft.Web"
    "Microsoft.EventGrid"
    "Microsoft.OperationalInsights"
    "Microsoft.DocumentDB"
)

for provider in "${REQUIRED_PROVIDERS[@]}"; do
    state=$(az provider show --namespace "$provider" --query registrationState -o tsv 2>/dev/null || echo "NotFound")
    if [[ "$state" == "Registered" ]]; then
        echo -e "  ${GREEN}[OK]${NC} ${provider}"
    else
        echo -e "  ${YELLOW}[WARN]${NC} ${provider} (${state}) — register with: az provider register --namespace ${provider}"
        ERRORS=$((ERRORS + 1))
    fi
done
echo ""

# --- Summary ---
if [[ $ERRORS -eq 0 ]]; then
    echo -e "${GREEN}All prerequisites met. Ready to deploy!${NC}"
    exit 0
else
    echo -e "${YELLOW}${ERRORS} issue(s) found. Fix them before deploying.${NC}"
    exit 1
fi
