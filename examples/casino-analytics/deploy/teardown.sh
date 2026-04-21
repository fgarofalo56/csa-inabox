#!/usr/bin/env bash
# =============================================================================
# CSA-in-a-Box: Per-Example Teardown — casino-analytics
#
# Destroys resources deployed by this vertical's deploy steps (see README).
# Default resource group: rg-casino-analytics
#
# Usage:
#   ./teardown.sh                     # interactive confirmation
#   ./teardown.sh --env dev
#   ./teardown.sh --resource-group rg-casino-analytics
#   ./teardown.sh --dry-run
#   ./teardown.sh --yes               # CI automation only
# =============================================================================
set -euo pipefail

VERTICAL="casino-analytics"
DEFAULT_RG="rg-casino-analytics"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

ENVIRONMENT="dev"
RESOURCE_GROUP=""
DRY_RUN=false
ASSUME_YES=false

print_help() {
    cat <<EOF
Teardown for $VERTICAL

Usage: $0 [OPTIONS]

Options:
  --env <dev|gov|prod>        Environment (default: dev)
  --resource-group <name>     Override RG (default: $DEFAULT_RG)
  --dry-run                   Enumerate resources; delete nothing
  --yes                       Skip typed confirmation (CI only)
  --help                      Show this help
EOF
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --env|-e)            ENVIRONMENT="${2:-}"; shift 2 ;;
        --resource-group|-g) RESOURCE_GROUP="${2:-}"; shift 2 ;;
        --dry-run|-n)        DRY_RUN=true; shift ;;
        --yes|-y)            ASSUME_YES=true; shift ;;
        --help|-h)           print_help; exit 0 ;;
        *) echo -e "${RED}Unknown option: $1${NC}" >&2; print_help >&2; exit 1 ;;
    esac
done

[[ -z "$RESOURCE_GROUP" ]] && RESOURCE_GROUP="$DEFAULT_RG"

# Prereqs
for bin in az jq; do
    if ! command -v "$bin" >/dev/null 2>&1; then
        echo -e "${RED}[FAIL]${NC} $bin not installed" >&2
        exit 1
    fi
done
if ! az account show >/dev/null 2>&1; then
    echo -e "${RED}[FAIL]${NC} not logged in: run 'az login'" >&2
    exit 1
fi
ACTIVE_SUB="$(az account show --query id -o tsv)"

TIMESTAMP="$(date -u +'%Y%m%dT%H%M%SZ')"
LOG_DIR="${REPO_ROOT}/reports/teardown"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/${VERTICAL}-${TIMESTAMP}.log"
touch "$LOG_FILE"

log_step() { echo -e "\n${BLUE}==>${NC} $1" | tee -a "$LOG_FILE"; }
log_ok()   { echo -e "  ${GREEN}[OK]${NC}   $(date -u +'%Y-%m-%dT%H:%M:%SZ') $1" | tee -a "$LOG_FILE"; }
log_warn() { echo -e "  ${YELLOW}[WARN]${NC} $(date -u +'%Y-%m-%dT%H:%M:%SZ') $1" | tee -a "$LOG_FILE"; }
log_err()  { echo -e "  ${RED}[FAIL]${NC} $(date -u +'%Y-%m-%dT%H:%M:%SZ') $1" | tee -a "$LOG_FILE"; }

{
    echo "Teardown: $VERTICAL"
    echo "  Environment:    $ENVIRONMENT"
    echo "  Resource group: $RESOURCE_GROUP"
    echo "  Subscription:   $ACTIVE_SUB"
    echo "  Dry run:        $DRY_RUN"
    echo "  Started:        $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    echo "  Log:            $LOG_FILE"
} | tee -a "$LOG_FILE"

if ! az group show --name "$RESOURCE_GROUP" >/dev/null 2>&1; then
    log_warn "Resource group '$RESOURCE_GROUP' does not exist. Nothing to tear down."
    exit 0
fi

log_step "Enumerating resources"
RESOURCES_JSON="$(az resource list -g "$RESOURCE_GROUP" -o json 2>/dev/null || echo '[]')"
COUNT="$(echo "$RESOURCES_JSON" | jq 'length')"
log_ok "Found $COUNT resources in '$RESOURCE_GROUP'"
echo "$RESOURCES_JSON" | jq -r '.[] | "  - \(.type) :: \(.name)"' | tee -a "$LOG_FILE"

if [[ "$DRY_RUN" == "true" ]]; then
    log_ok "Dry run complete; no resources deleted."
    exit 0
fi

if [[ "$ASSUME_YES" != "true" ]]; then
    EXPECTED="DESTROY-${VERTICAL}"
    echo ""
    echo -e "${YELLOW}!!  WARNING: This will DELETE every resource in '$RESOURCE_GROUP'.${NC}"
    echo -e "${YELLOW}!!  Subscription: $ACTIVE_SUB${NC}"
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

# Prefer azd teardown when an azd env exists in this vertical.
if command -v azd >/dev/null 2>&1 && [[ -f "${SCRIPT_DIR}/../azure.yaml" || -f "${SCRIPT_DIR}/azure.yaml" ]]; then
    log_step "Using 'azd down --purge --force'"
    (cd "${SCRIPT_DIR}" && azd down --purge --force 2>&1 | tee -a "$LOG_FILE") || {
        log_err "azd down failed; falling back to az group delete"
    }
fi

log_step "Deleting resource group '$RESOURCE_GROUP' (--yes --no-wait)"
if az group delete --name "$RESOURCE_GROUP" --yes --no-wait 2>&1 | tee -a "$LOG_FILE" >/dev/null; then
    log_ok "Deletion scheduled."
else
    log_err "Resource group delete failed."
    exit 3
fi

# Best-effort: remove any subscription-scope deployments that named the vertical.
log_step "Cleaning subscription-scope deployments (best-effort)"
SUB_DEPLOYMENTS="$(az deployment sub list --query "[?contains(name, '${VERTICAL}')].name" -o tsv 2>/dev/null || true)"
if [[ -n "$SUB_DEPLOYMENTS" ]]; then
    while IFS= read -r dep; do
        [[ -z "$dep" ]] && continue
        log_ok "deleting subscription deployment $dep"
        az deployment sub delete --name "$dep" 2>&1 | tee -a "$LOG_FILE" >/dev/null || \
            log_warn "could not delete deployment $dep"
    done <<< "$SUB_DEPLOYMENTS"
else
    log_ok "none"
fi

echo "Completed: $(date -u +'%Y-%m-%dT%H:%M:%SZ')" | tee -a "$LOG_FILE"
exit 0
