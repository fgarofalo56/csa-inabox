#!/usr/bin/env bash
# =============================================================================
# CSA-in-a-Box: Platform Teardown (FinOps Safety)
#
# Destroys CSA-in-a-Box platform resources for a given environment.
# Deletes in dependency-safe order:
#   1. Diagnostic settings
#   2. Private endpoints
#   3. Data services (Synapse, Databricks, Purview, ADX, ML, ADF)
#   4. Storage accounts
#   5. Key Vault (soft-delete + purge where allowed)
#   6. VNets
#   7. Resource group (last)
#
# Cost-safety: demands typed DESTROY-<env> confirmation. Use --yes only
# in CI pipelines with short-lived ephemeral environments. NEVER use --yes
# against production.
#
# Usage:
#   ./teardown-platform.sh --env dev
#   ./teardown-platform.sh --env dev --dry-run
#   ./teardown-platform.sh --env dev --resource-group rg-csa-dev
#   ./teardown-platform.sh --env dev --yes   (CI automation only)
#   ./teardown-platform.sh --validate
#   ./teardown-platform.sh --help
# =============================================================================
set -euo pipefail

# --- Color codes ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DEPLOY_DIR="${REPO_ROOT}/deploy"

# Defaults
ENVIRONMENT=""
RESOURCE_GROUP=""
SUBSCRIPTION=""
DRY_RUN=false
ASSUME_YES=false
VALIDATE_ONLY=false

print_help() {
    cat <<EOF
CSA-in-a-Box Platform Teardown

Usage: $0 [OPTIONS]

Options:
  --env <dev|staging|prod>    Target environment (required unless --validate)
  --resource-group <name>     Override the resource group name (default: rg-csa-<env>)
  --subscription <id>         Subscription override (default: currently selected)
  --dry-run                   Enumerate resources and print plan; delete nothing
  --yes                       Skip typed confirmation (CI automation only)
  --validate                  Check prerequisites (az, jq, login) and exit 0
  --help                      Show this help

Exit codes:
  0   Clean teardown / validation OK
  1   Prerequisite or argument error
  2   User aborted confirmation
  3   One or more resource deletions failed

Cost safety:
  - Typed confirmation "DESTROY-<env>" is required unless --yes passed.
  - Never use --yes against prod unless the pipeline is explicitly gated
    by a change-approval workflow.
  - All actions are logged to reports/teardown/<env>-<timestamp>.log.
EOF
}

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
    case $1 in
        --env|-e)
            ENVIRONMENT="${2:-}"; shift 2 ;;
        --resource-group|-g)
            RESOURCE_GROUP="${2:-}"; shift 2 ;;
        --subscription|-s)
            SUBSCRIPTION="${2:-}"; shift 2 ;;
        --dry-run|-n)
            DRY_RUN=true; shift ;;
        --yes|-y)
            ASSUME_YES=true; shift ;;
        --validate)
            VALIDATE_ONLY=true; shift ;;
        --help|-h)
            print_help; exit 0 ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}" >&2
            print_help >&2
            exit 1 ;;
    esac
done

# --- Helpers ---
log_step()  { echo -e "\n${BLUE}==>${NC} $1" | tee -a "$LOG_FILE" 2>/dev/null || echo -e "\n${BLUE}==>${NC} $1"; }
log_ok()    { echo -e "  ${GREEN}[OK]${NC}   $(date -u +'%Y-%m-%dT%H:%M:%SZ') $1" | tee -a "$LOG_FILE" 2>/dev/null || true; }
log_warn()  { echo -e "  ${YELLOW}[WARN]${NC} $(date -u +'%Y-%m-%dT%H:%M:%SZ') $1" | tee -a "$LOG_FILE" 2>/dev/null || true; }
log_err()   { echo -e "  ${RED}[FAIL]${NC} $(date -u +'%Y-%m-%dT%H:%M:%SZ') $1" | tee -a "$LOG_FILE" 2>/dev/null || true; }

validate_prereqs() {
    local errors=0
    if ! command -v az >/dev/null 2>&1; then
        echo -e "${RED}[FAIL]${NC} az CLI not installed" >&2
        errors=$((errors + 1))
    fi
    if ! command -v jq >/dev/null 2>&1; then
        echo -e "${RED}[FAIL]${NC} jq not installed (required for resource enumeration)" >&2
        errors=$((errors + 1))
    fi
    if command -v az >/dev/null 2>&1; then
        if ! az account show >/dev/null 2>&1; then
            echo -e "${RED}[FAIL]${NC} az CLI not logged in; run 'az login'" >&2
            errors=$((errors + 1))
        fi
        local sub
        sub="$(az account show --query id -o tsv 2>/dev/null || echo "")"
        if [[ -z "$sub" ]]; then
            echo -e "${RED}[FAIL]${NC} no active subscription selected" >&2
            errors=$((errors + 1))
        else
            echo -e "${GREEN}[OK]${NC}   active subscription: $sub"
        fi
    fi
    return $errors
}

# --- Validate-only short-circuit ---
if [[ "$VALIDATE_ONLY" == "true" ]]; then
    echo -e "${BLUE}Validating teardown prerequisites...${NC}"
    if validate_prereqs; then
        echo -e "${GREEN}All prerequisites satisfied.${NC}"
        exit 0
    else
        exit 1
    fi
fi

# --- Argument validation ---
if [[ -z "$ENVIRONMENT" ]]; then
    echo -e "${RED}--env is required${NC}" >&2
    print_help >&2
    exit 1
fi

case "$ENVIRONMENT" in
    dev|staging|prod) ;;
    *)
        echo -e "${RED}--env must be dev, staging, or prod${NC}" >&2
        exit 1 ;;
esac

# Resolve resource group
if [[ -z "$RESOURCE_GROUP" ]]; then
    PARAMS_FILE="${DEPLOY_DIR}/params.${ENVIRONMENT}.json"
    if [[ -f "$PARAMS_FILE" ]] && command -v jq >/dev/null 2>&1; then
        RESOURCE_GROUP="$(jq -r '.parameters.resourceGroupName.value // empty' "$PARAMS_FILE" 2>/dev/null || echo "")"
    fi
    if [[ -z "$RESOURCE_GROUP" ]]; then
        RESOURCE_GROUP="rg-csa-${ENVIRONMENT}"
    fi
fi

# --- Prerequisites ---
if ! validate_prereqs; then
    exit 1
fi

# Set subscription if provided
if [[ -n "$SUBSCRIPTION" ]]; then
    az account set --subscription "$SUBSCRIPTION"
fi
ACTIVE_SUB="$(az account show --query id -o tsv)"

# --- Prepare log file ---
TIMESTAMP="$(date -u +'%Y%m%dT%H%M%SZ')"
LOG_DIR="${REPO_ROOT}/reports/teardown"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/${ENVIRONMENT}-${TIMESTAMP}.log"
touch "$LOG_FILE"

{
    echo "CSA-in-a-Box Platform Teardown"
    echo "  Environment:     $ENVIRONMENT"
    echo "  Resource group:  $RESOURCE_GROUP"
    echo "  Subscription:    $ACTIVE_SUB"
    echo "  Dry run:         $DRY_RUN"
    echo "  Assume yes:      $ASSUME_YES"
    echo "  Started:         $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    echo "  Log file:        $LOG_FILE"
} | tee -a "$LOG_FILE"

# --- Check RG exists ---
if ! az group show --name "$RESOURCE_GROUP" >/dev/null 2>&1; then
    log_warn "Resource group '$RESOURCE_GROUP' does not exist. Nothing to tear down."
    exit 0
fi

# --- Enumerate resources ---
log_step "Enumerating resources in '$RESOURCE_GROUP'..."
RESOURCES_JSON="$(az resource list -g "$RESOURCE_GROUP" -o json 2>/dev/null || echo '[]')"
RESOURCE_COUNT="$(echo "$RESOURCES_JSON" | jq 'length')"
log_ok "Found $RESOURCE_COUNT resources"

echo "$RESOURCES_JSON" | jq -r '.[] | "  - \(.type) :: \(.name)"' | tee -a "$LOG_FILE"

if [[ "$DRY_RUN" == "true" ]]; then
    log_ok "Dry run complete; no resources deleted."
    exit 0
fi

# --- Typed confirmation ---
if [[ "$ASSUME_YES" != "true" ]]; then
    EXPECTED="DESTROY-${ENVIRONMENT}"
    echo ""
    echo -e "${YELLOW}!!  WARNING: This will DELETE every resource in '$RESOURCE_GROUP'.${NC}"
    echo -e "${YELLOW}!!  Subscription: $ACTIVE_SUB${NC}"
    echo -e "${YELLOW}!!  Log: $LOG_FILE${NC}"
    echo ""
    # Use /dev/tty so a piped stdin cannot bypass the prompt.
    if [[ -t 0 ]]; then
        read -rp "Type exactly '$EXPECTED' to proceed: " CONFIRM
    else
        read -rp "Type exactly '$EXPECTED' to proceed: " CONFIRM </dev/tty
    fi
    if [[ "$CONFIRM" != "$EXPECTED" ]]; then
        log_err "Confirmation failed. Aborted."
        exit 2
    fi
    log_ok "Confirmation accepted."
fi

FAILURES=0

# --- Helper: delete resources matching a jq filter ---
delete_by_type() {
    local label="$1"
    local jq_filter="$2"
    log_step "Deleting: $label"
    local ids
    ids="$(echo "$RESOURCES_JSON" | jq -r "$jq_filter // empty | .id // empty" | sed '/^$/d')"
    if [[ -z "$ids" ]]; then
        log_ok "none"
        return 0
    fi
    while IFS= read -r id; do
        [[ -z "$id" ]] && continue
        log_ok "deleting $id"
        if ! az resource delete --ids "$id" --verbose 2>&1 | tee -a "$LOG_FILE" >/dev/null; then
            log_err "failed: $id"
            FAILURES=$((FAILURES + 1))
        fi
    done <<< "$ids"
}

# --- Phase 1: Diagnostic settings (per-resource) ---
log_step "Phase 1: Removing diagnostic settings"
# Diagnostic settings live as child resources on each parent; best-effort cleanup.
while IFS= read -r parent_id; do
    [[ -z "$parent_id" ]] && continue
    local_settings="$(az monitor diagnostic-settings list --resource "$parent_id" --query "[].name" -o tsv 2>/dev/null || true)"
    if [[ -n "$local_settings" ]]; then
        while IFS= read -r setting; do
            [[ -z "$setting" ]] && continue
            log_ok "removing diagnostic-setting '$setting' on $parent_id"
            az monitor diagnostic-settings delete --resource "$parent_id" --name "$setting" 2>&1 | tee -a "$LOG_FILE" >/dev/null || \
                { log_warn "could not remove diagnostic-setting $setting"; }
        done <<< "$local_settings"
    fi
done < <(echo "$RESOURCES_JSON" | jq -r '.[].id')

# --- Phase 2: Private endpoints ---
delete_by_type "Phase 2: Private endpoints" '.[] | select(.type == "Microsoft.Network/privateEndpoints")'

# --- Phase 3: Data services ---
# Order: ADF pipelines first, then higher-level data workspaces.
delete_by_type "Phase 3a: Data Factory" '.[] | select(.type == "Microsoft.DataFactory/factories")'
delete_by_type "Phase 3b: Synapse workspaces" '.[] | select(.type == "Microsoft.Synapse/workspaces")'
delete_by_type "Phase 3c: Databricks workspaces" '.[] | select(.type == "Microsoft.Databricks/workspaces")'
delete_by_type "Phase 3d: Purview accounts" '.[] | select(.type == "Microsoft.Purview/accounts")'
delete_by_type "Phase 3e: Azure Data Explorer clusters" '.[] | select(.type == "Microsoft.Kusto/clusters")'
delete_by_type "Phase 3f: ML workspaces" '.[] | select(.type == "Microsoft.MachineLearningServices/workspaces")'
delete_by_type "Phase 3g: Event Hubs namespaces" '.[] | select(.type == "Microsoft.EventHub/namespaces")'
delete_by_type "Phase 3h: IoT Hubs" '.[] | select(.type == "Microsoft.Devices/IotHubs")'
delete_by_type "Phase 3i: Stream Analytics jobs" '.[] | select(.type == "Microsoft.StreamAnalytics/streamingjobs")'
delete_by_type "Phase 3j: Cosmos DB accounts" '.[] | select(.type == "Microsoft.DocumentDB/databaseAccounts")'
delete_by_type "Phase 3k: Function apps" '.[] | select(.type == "Microsoft.Web/sites")'
delete_by_type "Phase 3l: App service plans" '.[] | select(.type == "Microsoft.Web/serverfarms")'

# --- Phase 4: Storage ---
delete_by_type "Phase 4: Storage accounts" '.[] | select(.type == "Microsoft.Storage/storageAccounts")'

# --- Phase 5: Key Vault (purge handling) ---
log_step "Phase 5: Key Vaults"
KV_NAMES="$(echo "$RESOURCES_JSON" | jq -r '.[] | select(.type == "Microsoft.KeyVault/vaults") | .name')"
if [[ -z "$KV_NAMES" ]]; then
    log_ok "none"
else
    while IFS= read -r kv; do
        [[ -z "$kv" ]] && continue
        log_ok "deleting Key Vault '$kv'"
        if ! az keyvault delete --name "$kv" --resource-group "$RESOURCE_GROUP" 2>&1 | tee -a "$LOG_FILE" >/dev/null; then
            log_err "delete failed: $kv"
            FAILURES=$((FAILURES + 1))
            continue
        fi
        # Purge if purge-protection not enforced; ignore failure.
        log_ok "attempting purge on soft-deleted KV '$kv' (best-effort)"
        az keyvault purge --name "$kv" 2>&1 | tee -a "$LOG_FILE" >/dev/null || \
            log_warn "purge skipped/failed for '$kv' (purge protection may be enabled)"
    done <<< "$KV_NAMES"
fi

# --- Phase 6: VNets ---
delete_by_type "Phase 6: Virtual networks" '.[] | select(.type == "Microsoft.Network/virtualNetworks")'
delete_by_type "Phase 6b: Network security groups" '.[] | select(.type == "Microsoft.Network/networkSecurityGroups")'
delete_by_type "Phase 6c: Public IPs" '.[] | select(.type == "Microsoft.Network/publicIPAddresses")'

# --- Phase 7: Resource group (last) ---
log_step "Phase 7: Resource group"
if az group show --name "$RESOURCE_GROUP" >/dev/null 2>&1; then
    log_ok "deleting resource group '$RESOURCE_GROUP' (async, --yes)"
    if ! az group delete --name "$RESOURCE_GROUP" --yes --no-wait 2>&1 | tee -a "$LOG_FILE" >/dev/null; then
        log_err "resource group delete failed"
        FAILURES=$((FAILURES + 1))
    else
        log_ok "resource group deletion scheduled"
    fi
else
    log_ok "resource group already gone"
fi

# --- Summary ---
log_step "Teardown summary"
if [[ "$FAILURES" -eq 0 ]]; then
    log_ok "Clean teardown: 0 failures"
    echo "Completed: $(date -u +'%Y-%m-%dT%H:%M:%SZ')" | tee -a "$LOG_FILE"
    exit 0
else
    log_err "$FAILURES resource(s) failed to delete. See $LOG_FILE"
    echo "Completed with failures: $(date -u +'%Y-%m-%dT%H:%M:%SZ')" | tee -a "$LOG_FILE"
    exit 3
fi
