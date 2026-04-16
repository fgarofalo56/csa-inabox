#!/usr/bin/env bash
# =============================================================================
# CSA-in-a-Box: Master Platform Deployment
#
# Deploys all landing zones in the correct order:
#   1. Management (ALZ)  — logging, monitoring, shared policies
#   2. Connectivity       — hub VNet, DNS, firewall  (part of ALZ)
#   3. DMLZ              — Purview, shared services, Key Vault
#   4. DLZ               — data workloads (ADF, Databricks, Synapse, ADLS)
#
# Usage:
#   ./deploy-platform.sh --environment dev
#   ./deploy-platform.sh --environment prod --dry-run
#   ./deploy-platform.sh --environment dev --skip alz
# =============================================================================
set -euo pipefail

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BICEP_DIR="${REPO_ROOT}/deploy/bicep"

# Defaults
ENVIRONMENT="dev"
DRY_RUN=false
SKIP_ZONES=()
LOCATION="eastus"

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
    case $1 in
        --environment|-e)
            ENVIRONMENT="$2"; shift 2 ;;
        --dry-run|-n)
            DRY_RUN=true; shift ;;
        --skip|-s)
            SKIP_ZONES+=("$2"); shift 2 ;;
        --location|-l)
            LOCATION="$2"; shift 2 ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -e, --environment ENV   Target environment: dev|prod (default: dev)"
            echo "  -n, --dry-run           Run what-if only, do not deploy"
            echo "  -s, --skip ZONE         Skip a landing zone (alz|dmlz|dlz)"
            echo "  -l, --location LOC      Azure region (default: eastus)"
            echo "  -h, --help              Show this help"
            exit 0 ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
    esac
done

# --- Helper functions ---
log_step() { echo -e "\n${BLUE}==>${NC} $1"; }
log_ok()   { echo -e "  ${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "  ${YELLOW}[WARN]${NC} $1"; }
log_err()  { echo -e "  ${RED}[FAIL]${NC} $1"; }
timer_start() { TIMER_START=$(date +%s); }
timer_end() {
    local elapsed=$(( $(date +%s) - TIMER_START ))
    echo -e "  ${BLUE}[TIME]${NC} ${elapsed}s"
}

should_skip() {
    local zone="$1"
    for skip in "${SKIP_ZONES[@]}"; do
        [[ "${skip,,}" == "${zone,,}" ]] && return 0
    done
    return 1
}

deploy_zone() {
    local zone_name="$1"
    local zone_dir="$2"
    local main_bicep="${zone_dir}/main.bicep"
    local params_file="${zone_dir}/params.${ENVIRONMENT}.json"

    if should_skip "$zone_name"; then
        log_warn "Skipping ${zone_name} (--skip)"
        return 0
    fi

    log_step "Deploying ${zone_name} (${ENVIRONMENT})"
    timer_start

    if [[ ! -f "$main_bicep" ]]; then
        log_err "main.bicep not found: ${main_bicep}"
        return 1
    fi

    # Build parameter arguments
    local params_arg=""
    if [[ -f "$params_file" ]]; then
        params_arg="--parameters ${params_file}"
        log_ok "Using params: ${params_file}"
    else
        log_warn "No params file found: ${params_file} — using defaults"
    fi

    if [[ "$DRY_RUN" == true ]]; then
        echo -e "  ${YELLOW}[DRY RUN]${NC} az deployment sub what-if ..."
        az deployment sub what-if \
            --location "$LOCATION" \
            --template-file "$main_bicep" \
            "${params_arg}" \
            --name "csa-${zone_name,,}-${ENVIRONMENT}-$(date +%Y%m%d%H%M)" \
            2>&1 | sed 's/^/    /'
    else
        az deployment sub create \
            --location "$LOCATION" \
            --template-file "$main_bicep" \
            "${params_arg}" \
            --name "csa-${zone_name,,}-${ENVIRONMENT}-$(date +%Y%m%d%H%M)" \
            2>&1 | sed 's/^/    /'
    fi

    timer_end
    log_ok "${zone_name} deployment complete"
}

# --- Main ---
echo -e "${BLUE}╔═══════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  CSA-in-a-Box Platform Deployment             ║${NC}"
echo -e "${BLUE}║  Environment: ${GREEN}${ENVIRONMENT}${BLUE}                           ║${NC}"
echo -e "${BLUE}║  Location:    ${GREEN}${LOCATION}${BLUE}                        ║${NC}"
echo -e "${BLUE}║  Dry Run:     ${GREEN}${DRY_RUN}${BLUE}                          ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════╝${NC}"

TOTAL_START=$(date +%s)

# Step 0: Validate prerequisites
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log_step "Validating prerequisites..."
bash "${SCRIPT_DIR}/validate-prerequisites.sh" || {
    log_err "Prerequisites validation failed. Run 'make prerequisites' to check details."
    exit 1
}

# Step 1: Management / ALZ (landing zone policies, logging, monitoring)
deploy_zone "ALZ" "${BICEP_DIR}/landing-zone-alz"

# Step 2: DMLZ (Data Management Landing Zone — Purview, Key Vault, shared services)
deploy_zone "DMLZ" "${BICEP_DIR}/DMLZ"

# Step 3: DLZ (Data Landing Zone — ADF, Databricks, Synapse, ADLS, Event Hub)
deploy_zone "DLZ" "${BICEP_DIR}/DLZ"

TOTAL_ELAPSED=$(( $(date +%s) - TOTAL_START ))
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Deployment complete!  Total: ${TOTAL_ELAPSED}s             ${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════╝${NC}"
echo ""
echo "Next steps:"
echo "  1. Load sample data:  python scripts/seed/load_sample_data.py --storage-account <name>"
echo "  2. Trigger ADF:       az datafactory pipeline create-run ..."
echo "  3. Verify dbt:        cd domains/shared/dbt && dbt run && dbt test"
