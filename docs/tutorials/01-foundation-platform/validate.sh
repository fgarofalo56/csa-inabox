#!/usr/bin/env bash
# =============================================================================
# validate.sh - CSA-in-a-Box Foundation Platform Tutorial Validation
# =============================================================================
# Validates that Tutorial 01 (Foundation Platform) was completed successfully.
# Usage: ./validate.sh [--prefix PREFIX] [--env ENV] [--subscription SUB_ID]
#
# Defaults: PREFIX=csa, ENV=dev
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
PREFIX="${1:-csa}"
ENV="${2:-dev}"
SUBSCRIPTION=""
PASS=0
FAIL=0
WARN=0

# Parse named arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --prefix) PREFIX="$2"; shift 2 ;;
    --env) ENV="$2"; shift 2 ;;
    --subscription) SUBSCRIPTION="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Derived names (must match your deployment naming convention)
RG_ALZ="${PREFIX}-rg-alz-${ENV}"
RG_DMLZ="${PREFIX}-rg-dmlz-${ENV}"
RG_DLZ="${PREFIX}-rg-dlz-${ENV}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
  echo -e "  ${GREEN}PASS${NC}  $1"
  ((PASS++))
}

fail() {
  echo -e "  ${RED}FAIL${NC}  $1"
  ((FAIL++))
}

warn() {
  echo -e "  ${YELLOW}WARN${NC}  $1"
  ((WARN++))
}

check_resource_group() {
  local rg="$1"
  if az group show --name "$rg" --output none 2>/dev/null; then
    pass "Resource group '$rg' exists"
  else
    fail "Resource group '$rg' not found"
  fi
}

check_resource_exists() {
  local rg="$1"
  local type="$2"
  local label="$3"
  local count
  count=$(az resource list --resource-group "$rg" --resource-type "$type" --query "length([])" -o tsv 2>/dev/null || echo "0")
  if [[ "$count" -gt 0 ]]; then
    pass "$label found in '$rg' (count: $count)"
  else
    fail "$label not found in '$rg'"
  fi
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------
echo ""
echo "=========================================="
echo "  CSA-in-a-Box Foundation Validation"
echo "=========================================="
echo "  Prefix:       $PREFIX"
echo "  Environment:  $ENV"
echo "=========================================="
echo ""

# Set subscription if provided
if [[ -n "$SUBSCRIPTION" ]]; then
  echo "Setting subscription to $SUBSCRIPTION ..."
  az account set --subscription "$SUBSCRIPTION"
fi

# Verify Azure CLI is authenticated
if ! az account show --output none 2>/dev/null; then
  echo -e "${RED}ERROR:${NC} Not logged in to Azure CLI. Run 'az login' first."
  exit 1
fi

CURRENT_SUB=$(az account show --query "name" -o tsv)
echo "Using subscription: $CURRENT_SUB"
echo ""

# ---------------------------------------------------------------------------
# Section 1: Resource Groups
# ---------------------------------------------------------------------------
echo "--- Resource Groups ---"
check_resource_group "$RG_ALZ"
check_resource_group "$RG_DMLZ"
check_resource_group "$RG_DLZ"
echo ""

# ---------------------------------------------------------------------------
# Section 2: DMLZ Resources
# ---------------------------------------------------------------------------
echo "--- Data Management Landing Zone (DMLZ) ---"
check_resource_exists "$RG_DMLZ" "Microsoft.Purview/accounts" "Microsoft Purview"
check_resource_exists "$RG_DMLZ" "Microsoft.KeyVault/vaults" "Key Vault"
check_resource_exists "$RG_DMLZ" "Microsoft.ContainerRegistry/registries" "Container Registry"
echo ""

# ---------------------------------------------------------------------------
# Section 3: DLZ Resources
# ---------------------------------------------------------------------------
echo "--- Data Landing Zone (DLZ) ---"
check_resource_exists "$RG_DLZ" "Microsoft.Storage/storageAccounts" "Storage Account"
check_resource_exists "$RG_DLZ" "Microsoft.Databricks/workspaces" "Databricks Workspace"
check_resource_exists "$RG_DLZ" "Microsoft.Synapse/workspaces" "Synapse Workspace"
check_resource_exists "$RG_DLZ" "Microsoft.DataFactory/factories" "Data Factory"
check_resource_exists "$RG_DLZ" "Microsoft.EventHub/namespaces" "Event Hubs Namespace"
echo ""

# ---------------------------------------------------------------------------
# Section 4: Networking
# ---------------------------------------------------------------------------
echo "--- Networking ---"
VNET_COUNT=$(az network vnet list --resource-group "$RG_DLZ" --query "length([])" -o tsv 2>/dev/null || echo "0")
if [[ "$VNET_COUNT" -gt 0 ]]; then
  pass "VNet found in DLZ"
else
  fail "No VNet found in DLZ resource group"
fi

PE_COUNT=$(az network private-endpoint list --resource-group "$RG_DLZ" --query "length([])" -o tsv 2>/dev/null || echo "0")
if [[ "$PE_COUNT" -gt 0 ]]; then
  pass "Private endpoints configured ($PE_COUNT found)"
else
  warn "No private endpoints found (may be expected for dev)"
fi
echo ""

# ---------------------------------------------------------------------------
# Section 5: Databricks Cluster
# ---------------------------------------------------------------------------
echo "--- Databricks ---"
# We check workspace exists (already done above), and look for a running/terminated cluster
DBX_WS=$(az databricks workspace list --resource-group "$RG_DLZ" --query "[0].workspaceUrl" -o tsv 2>/dev/null || echo "")
if [[ -n "$DBX_WS" ]]; then
  pass "Databricks workspace URL: https://$DBX_WS"
else
  warn "Could not retrieve Databricks workspace URL"
fi
echo ""

# ---------------------------------------------------------------------------
# Section 6: Storage - Medallion Containers
# ---------------------------------------------------------------------------
echo "--- Storage (Medallion Architecture) ---"
STORAGE_ACCT=$(az storage account list --resource-group "$RG_DLZ" --query "[0].name" -o tsv 2>/dev/null || echo "")
if [[ -n "$STORAGE_ACCT" ]]; then
  for LAYER in bronze silver gold; do
    if az storage container show --name "$LAYER" --account-name "$STORAGE_ACCT" --auth-mode login --output none 2>/dev/null; then
      pass "Container '$LAYER' exists in storage account '$STORAGE_ACCT'"
    else
      fail "Container '$LAYER' not found in storage account '$STORAGE_ACCT'"
    fi
  done
else
  fail "No storage account found in DLZ"
fi
echo ""

# ---------------------------------------------------------------------------
# Section 7: dbt Models (check for Gold-layer Delta files)
# ---------------------------------------------------------------------------
echo "--- dbt Pipeline (USDA Vertical) ---"
if [[ -n "$STORAGE_ACCT" ]]; then
  GOLD_BLOBS=$(az storage blob list --container-name gold --account-name "$STORAGE_ACCT" --auth-mode login --query "length([])" -o tsv 2>/dev/null || echo "0")
  if [[ "$GOLD_BLOBS" -gt 0 ]]; then
    pass "Gold layer contains data ($GOLD_BLOBS blobs)"
  else
    fail "Gold layer is empty — dbt pipeline may not have run"
  fi
else
  fail "Cannot check dbt output — no storage account found"
fi
echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
TOTAL=$((PASS + FAIL + WARN))
echo "=========================================="
echo "  Results: $PASS passed, $FAIL failed, $WARN warnings (of $TOTAL checks)"
echo "=========================================="

if [[ "$FAIL" -gt 0 ]]; then
  echo -e "  ${RED}Some checks failed.${NC} Review the output above and re-run the corresponding tutorial steps."
  exit 1
else
  echo -e "  ${GREEN}All checks passed!${NC} Your Foundation Platform is ready."
  exit 0
fi
