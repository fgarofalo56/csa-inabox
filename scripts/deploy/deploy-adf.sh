#!/usr/bin/env bash
# deploy-adf.sh — Deploy ADF pipeline artifacts (linked services, datasets,
# pipelines, triggers) from the local repo into an Azure Data Factory instance.
#
# Usage:
#   ./scripts/deploy/deploy-adf.sh \
#       --factory-name csadlzdevdf \
#       --resource-group rg-csadlz-dev \
#       [--dry-run]
#
# Prerequisites:
#   - Azure CLI >= 2.50 with the datafactory extension
#   - az login (or OIDC in CI)
#
# The script discovers JSON definitions from domains/*/pipelines/adf/ and
# deploys them in dependency order:
#   1. Linked Services  2. Datasets  3. Pipelines  4. Triggers

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Retry wrapper for transient failures ────────────────────────────
retry_cmd() {
  local max_retries=3
  local delay=10
  local attempt=1
  while [ $attempt -le $max_retries ]; do
    if "$@"; then return 0; fi
    echo "Attempt $attempt/$max_retries failed. Retrying in ${delay}s..."
    sleep $delay
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done
  echo "Command failed after $max_retries attempts: $*"
  return 1
}

# ── Defaults ─────────────────────────────────────────────────────────
FACTORY_NAME=""
RESOURCE_GROUP=""
DRY_RUN=false

# ── Parse arguments ──────────────────────────────────────────────────
usage() {
    echo "Usage: $0 --factory-name <name> --resource-group <rg> [--dry-run]"
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --factory-name)  FACTORY_NAME="$2"; shift 2 ;;
        --resource-group) RESOURCE_GROUP="$2"; shift 2 ;;
        --dry-run)       DRY_RUN=true; shift ;;
        -h|--help)       usage ;;
        *)               echo "Unknown option: $1"; usage ;;
    esac
done

[[ -z "$FACTORY_NAME" ]]  && { echo "ERROR: --factory-name is required"; usage; }
[[ -z "$RESOURCE_GROUP" ]] && { echo "ERROR: --resource-group is required"; usage; }

# ── Helper ───────────────────────────────────────────────────────────
deploy_artifact() {
    local kind="$1"      # linked-service | dataset | pipeline | trigger
    local json_file="$2"
    local name
    name="$(basename "$json_file" .json)"

    if $DRY_RUN; then
        echo "[DRY-RUN] Would deploy $kind: $name  (from $json_file)"
        return 0
    fi

    echo "Deploying $kind: $name ..."
    case "$kind" in
        linked-service)
            retry_cmd az datafactory linked-service create \
                --factory-name "$FACTORY_NAME" \
                --resource-group "$RESOURCE_GROUP" \
                --linked-service-name "$name" \
                --properties "@$json_file" \
                --only-show-errors
            ;;
        dataset)
            retry_cmd az datafactory dataset create \
                --factory-name "$FACTORY_NAME" \
                --resource-group "$RESOURCE_GROUP" \
                --dataset-name "$name" \
                --properties "@$json_file" \
                --only-show-errors
            ;;
        pipeline)
            retry_cmd az datafactory pipeline create \
                --factory-name "$FACTORY_NAME" \
                --resource-group "$RESOURCE_GROUP" \
                --pipeline-name "$name" \
                --pipeline "@$json_file" \
                --only-show-errors
            ;;
        trigger)
            retry_cmd az datafactory trigger create \
                --factory-name "$FACTORY_NAME" \
                --resource-group "$RESOURCE_GROUP" \
                --trigger-name "$name" \
                --properties "@$json_file" \
                --only-show-errors
            ;;
    esac
    echo "  -> $kind '$name' deployed."
}

# ── Discover artifacts ───────────────────────────────────────────────
# Collects from all domain directories: domains/*/pipelines/adf/
find_artifacts() {
    local subdir="$1"
    local pattern="$2"
    find "$REPO_ROOT/domains" -path "*pipelines/adf/$subdir/$pattern" -type f 2>/dev/null | sort
}

find_root_pipelines() {
    find "$REPO_ROOT/domains" -path "*pipelines/adf/pl_*.json" -type f 2>/dev/null | sort
}

find_triggers() {
    find "$REPO_ROOT/domains" -path "*pipelines/adf/triggers/tr_*.json" -type f 2>/dev/null | sort
}

# ── Main ─────────────────────────────────────────────────────────────
echo "============================================="
echo "CSA-in-a-Box: ADF Artifact Deployment"
echo "============================================="
echo "Factory:        $FACTORY_NAME"
echo "Resource Group: $RESOURCE_GROUP"
echo "Dry Run:        $DRY_RUN"
echo "---------------------------------------------"

# Ensure ADF extension is available
if ! az datafactory --help &>/dev/null; then
    echo "Installing Azure CLI datafactory extension ..."
    az extension add --name datafactory --only-show-errors
fi

# Step 1: Linked Services
echo ""
echo "=== Step 1/4: Linked Services ==="
LS_FILES=$(find_artifacts "linkedServices" "ls_*.json")
if [[ -z "$LS_FILES" ]]; then
    echo "  (none found)"
else
    while IFS= read -r f; do
        deploy_artifact "linked-service" "$f"
    done <<< "$LS_FILES"
fi

# Step 2: Datasets
echo ""
echo "=== Step 2/4: Datasets ==="
DS_FILES=$(find_artifacts "datasets" "ds_*.json")
if [[ -z "$DS_FILES" ]]; then
    echo "  (none found)"
else
    while IFS= read -r f; do
        deploy_artifact "dataset" "$f"
    done <<< "$DS_FILES"
fi

# Step 3: Pipelines
echo ""
echo "=== Step 3/4: Pipelines ==="
PL_FILES=$(find_root_pipelines)
if [[ -z "$PL_FILES" ]]; then
    echo "  (none found)"
else
    while IFS= read -r f; do
        deploy_artifact "pipeline" "$f"
    done <<< "$PL_FILES"
fi

# Step 4: Triggers
echo ""
echo "=== Step 4/4: Triggers ==="
TR_FILES=$(find_triggers)
if [[ -z "$TR_FILES" ]]; then
    echo "  (none found)"
else
    while IFS= read -r f; do
        deploy_artifact "trigger" "$f"
    done <<< "$TR_FILES"

    # Start triggers (skip in dry-run)
    if ! $DRY_RUN; then
        echo ""
        echo "Starting triggers ..."
        while IFS= read -r f; do
            name="$(basename "$f" .json)"
            echo "  Starting trigger: $name"
            az datafactory trigger start \
                --factory-name "$FACTORY_NAME" \
                --resource-group "$RESOURCE_GROUP" \
                --trigger-name "$name" \
                --only-show-errors || echo "  WARNING: Could not start $name (may already be started)"
        done <<< "$TR_FILES"
    fi
fi

echo ""
echo "============================================="
echo "ADF deployment complete."
echo "============================================="
