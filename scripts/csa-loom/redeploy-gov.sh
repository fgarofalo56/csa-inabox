#!/usr/bin/env bash
# =============================================================================
# CSA Loom — IL5 / GCC-High full-stack teardown -> redeploy (A-4 / PMF-64)
#
# Drives the gov .bicepparam path end-to-end so the IL5/GCC-High full-stack
# deploy is reproducible and verifiable in a clean Azure Government sub:
#
#   Phase 0  Guard rails    — confirm az is on AzureUSGovernment + a Gov sub
#   Phase 1  Teardown       — delete prior rg-csa-loom-* RGs (purges KV/HSM)
#   Phase 2  Redeploy       — az deployment sub create against the gov param file
#   Phase 3  Post-deploy    — Console UAMI ARM RBAC grants (idempotent)
#   Phase 4  Smoke test     — Console/MCP/orchestrator/MAF health on Gov endpoints
#
# This is the orchestration the no-vaporware "teardown + 1-button redeploy in a
# clean sub (Commercial AND Gov)" acceptance test calls for, scoped to the two
# sovereign boundaries. Per loom-no-freeform-config, every per-boundary value
# lives in the .bicepparam file — this script takes only the boundary selector.
#
# USAGE:
#   ./scripts/csa-loom/redeploy-gov.sh --boundary il5
#   ./scripts/csa-loom/redeploy-gov.sh --boundary gcc-high --skip-teardown
#   ./scripts/csa-loom/redeploy-gov.sh --boundary il5 --what-if   # validate only
#
# ENV (image tags + secrets the .bicepparam reads via readEnvironmentVariable):
#   LOOM_VERSION, LOOM_CONSOLE_TAG, LOOM_MCP_TAG, LOOM_ORCHESTRATOR_TAG, ...
#   LOOM_MSAL_CLIENT_ID, LOOM_MSAL_CLIENT_SECRET   (gov tenant app reg)
#   FIAB_GOV_ADMIN_GROUP_ID                        (overrides the param placeholder)
#   AZURE_LOCATION (default usgovvirginia)
#
# REQUIRES: az logged into the Gov sub (e.g. the limitlessdata_deploy SP) with
#   Owner / User Access Administrator so Phase 3 can write role assignments.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BICEP_DIR="${REPO_ROOT}/platform/fiab/bicep"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

BOUNDARY=""
SKIP_TEARDOWN="false"
WHAT_IF="false"
ASSUME_YES="${ASSUME_YES:-false}"
AZURE_LOCATION="${AZURE_LOCATION:-usgovvirginia}"

usage() { grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --boundary) BOUNDARY="$2"; shift 2 ;;
    --skip-teardown) SKIP_TEARDOWN="true"; shift ;;
    --what-if) WHAT_IF="true"; shift ;;
    --yes|-y) ASSUME_YES="true"; shift ;;
    -h|--help) usage 0 ;;
    *) echo -e "${RED}Unknown arg: $1${NC}"; usage 1 ;;
  esac
done

case "$BOUNDARY" in
  il5)      PARAM_FILE="${BICEP_DIR}/params/il5.bicepparam";      BOUNDARY_LABEL="IL5" ;;
  gcc-high|gcch) PARAM_FILE="${BICEP_DIR}/params/gcc-high.bicepparam"; BOUNDARY_LABEL="GCC-High" ;;
  *) echo -e "${RED}--boundary must be 'il5' or 'gcc-high'${NC}"; usage 1 ;;
esac

[[ -f "$PARAM_FILE" ]] || { echo -e "${RED}Missing param file: $PARAM_FILE${NC}"; exit 1; }

echo -e "${BLUE}== CSA Loom gov redeploy — ${BOUNDARY_LABEL} ==${NC}"
echo "  Param file:  $PARAM_FILE"
echo "  Location:    $AZURE_LOCATION"
echo "  Teardown:    $([[ $SKIP_TEARDOWN == true ]] && echo skip || echo yes)"
echo "  Mode:        $([[ $WHAT_IF == true ]] && echo what-if || echo deploy)"

# ---------------------------------------------------------------------------
# Phase 0 — guard rails. NEVER let a gov param land on a commercial sub.
# ---------------------------------------------------------------------------
CLOUD="$(az cloud show --query name -o tsv 2>/dev/null || echo unknown)"
if [[ "$CLOUD" != "AzureUSGovernment" ]]; then
  echo -e "${RED}Active az cloud is '$CLOUD', not AzureUSGovernment.${NC}"
  echo "  Run: az cloud set --name AzureUSGovernment && az login"
  exit 1
fi
SUB_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
SUB_NAME="$(az account show --query name -o tsv 2>/dev/null || true)"
[[ -z "$SUB_ID" ]] && { echo -e "${RED}Not logged in to a Gov subscription.${NC}"; exit 1; }
echo -e "  Sub:         ${SUB_NAME} (${SUB_ID})"

if [[ "$ASSUME_YES" != "true" && "$WHAT_IF" != "true" ]]; then
  read -r -p "$(echo -e "${YELLOW}This will TEARDOWN + REDEPLOY in the above Gov sub. Type the boundary (${BOUNDARY_LABEL}) to proceed: ${NC}")" CONFIRM
  [[ "$CONFIRM" == "$BOUNDARY_LABEL" ]] || { echo "Aborted."; exit 1; }
fi

# Extra params the .bicepparam expects from outside (gov admin group GUID).
EXTRA_PARAMS=()
if [[ -n "${FIAB_GOV_ADMIN_GROUP_ID:-}" ]]; then
  EXTRA_PARAMS+=(--parameters "adminEntraGroupId=${FIAB_GOV_ADMIN_GROUP_ID}")
fi

DEPLOY_NAME="csa-loom-${BOUNDARY}-redeploy-$(date +%Y%m%d%H%M%S)"

# ---------------------------------------------------------------------------
# Phase 1 — teardown prior deployment (reuse the CI teardown helper).
# ---------------------------------------------------------------------------
if [[ "$SKIP_TEARDOWN" != "true" && "$WHAT_IF" != "true" ]]; then
  echo -e "${BLUE}[1/4] Teardown${NC}"
  RG_NAME="rg-csa-loom-admin-${AZURE_LOCATION}" \
  TIMEOUT_MINUTES="${TEARDOWN_TIMEOUT_MINUTES:-40}" \
    bash "${REPO_ROOT}/.github/scripts/fiab-teardown.sh" || {
      echo -e "${YELLOW}Teardown reported a non-zero exit (RGs may still be deleting). Continuing.${NC}"
    }
else
  echo -e "${YELLOW}[1/4] Teardown skipped${NC}"
fi

# ---------------------------------------------------------------------------
# Phase 2 — (re)deploy from the gov .bicepparam.
# ---------------------------------------------------------------------------
if [[ "$WHAT_IF" == "true" ]]; then
  echo -e "${BLUE}[2/4] What-if (no resources provisioned)${NC}"
  az deployment sub what-if \
    --name "$DEPLOY_NAME" \
    --location "$AZURE_LOCATION" \
    --template-file "${BICEP_DIR}/main.bicep" \
    --parameters "$PARAM_FILE" \
    "${EXTRA_PARAMS[@]}" || { echo -e "${RED}what-if failed${NC}"; exit 1; }
  echo -e "${GREEN}what-if complete — bicep + auth validated.${NC}"
  exit 0
fi

echo -e "${BLUE}[2/4] Redeploy (az deployment sub create)${NC}"
az deployment sub create \
  --name "$DEPLOY_NAME" \
  --location "$AZURE_LOCATION" \
  --template-file "${BICEP_DIR}/main.bicep" \
  --parameters "$PARAM_FILE" \
  "${EXTRA_PARAMS[@]}" || { echo -e "${RED}Deployment failed${NC}"; exit 1; }

# Pull the Console URL + MAF endpoint from deployment outputs for the smoke test.
CONSOLE_URL="$(az deployment sub show --name "$DEPLOY_NAME" --query 'properties.outputs.consoleUrl.value' -o tsv 2>/dev/null || true)"
MAF_ENDPOINT="$(az deployment sub show --name "$DEPLOY_NAME" --query 'properties.outputs.copilotMafEndpoint.value' -o tsv 2>/dev/null || true)"
echo "  consoleUrl:        ${CONSOLE_URL:-(empty)}"
echo "  copilotMafEndpoint:${MAF_ENDPOINT:-(empty — MAF inactive on this compute path)}"

# ---------------------------------------------------------------------------
# Phase 3 — post-deploy RBAC grants (idempotent; safe to re-run).
# ---------------------------------------------------------------------------
echo -e "${BLUE}[3/4] Post-deploy Console RBAC grants${NC}"
if [[ -f "${SCRIPT_DIR}/grant-console-rbac.sh" ]]; then
  SUBS="$SUB_ID" bash "${SCRIPT_DIR}/grant-console-rbac.sh" || \
    echo -e "${YELLOW}grant-console-rbac.sh returned non-zero (check principal permissions).${NC}"
else
  echo -e "${YELLOW}grant-console-rbac.sh not found — skipping.${NC}"
fi

# ---------------------------------------------------------------------------
# Phase 4 — smoke test against the live Gov endpoints.
# ---------------------------------------------------------------------------
echo -e "${BLUE}[4/4] Smoke test${NC}"
# On the AKS compute path main.bicep emits a non-resolvable placeholder
# (https://loom-console.<loc>.csa-loom.internal) rather than an empty string,
# because there is no in-repo AKS workload deployment for the Loom apps (see
# runbook gap #2). Treat both an empty value AND the .internal sentinel as "no
# reachable app endpoint" and exit cleanly instead of curling an unresolvable
# host (which would surface as spurious Test 1-8 failures, curl exit 6/000).
if [[ -z "$CONSOLE_URL" || "$CONSOLE_URL" == *.csa-loom.internal ]]; then
  echo -e "${YELLOW}No reachable Console endpoint (consoleUrl='${CONSOLE_URL:-empty}').${NC}"
  echo -e "${YELLOW}On the AKS compute path the Loom apps have no in-repo workload deployment,${NC}"
  echo -e "${YELLOW}so the platform deploys but no app host is exposed.${NC}"
  echo -e "${YELLOW}See docs/fiab/runbooks/il5-gcch-fullstack-verification.md (gap #2).${NC}"
  exit 2
fi
CONSOLE_URL="$CONSOLE_URL" BOUNDARY="$BOUNDARY_LABEL" MAF_ENDPOINT="$MAF_ENDPOINT" \
  bash "${REPO_ROOT}/.github/scripts/fiab-smoke-test.sh"

echo -e "${GREEN}== ${BOUNDARY_LABEL} teardown -> redeploy complete ==${NC}"
