#!/usr/bin/env bash
# Deploy/refresh the `loom-lineage-extractor` Container App Job — the in-VNet,
# scheduled column-lineage extractor (loom-next-level WS-L, L3).
#
# WHY a CA Job (NOT a Y1 Function):
#   Y1 Linux Consumption Functions are structurally broken on this estate —
#   Azure Policy seals the storage data-plane (publicNetworkAccess=Disabled,
#   AAD-only, no private endpoint) and the multitenant Y1 runtime is not a
#   trusted service, so host keys / timer leases fail. The in-VNet ACA-job
#   pattern (this script mirrors deploy-loom-uat-job.sh) reuses the console UAMI
#   — already AcrPull + Cosmos Data Contributor + Data Factory/Synapse Reader —
#   and runs entirely inside the VNet. No keys, no user credentials.
#
# WHAT it does:
#   1. Temporarily enables ACR public access so `az acr build` can upload the
#      source tarball (mirrors the loom-uat / gh-runner pattern).
#   2. Builds loom-lineage-extractor:latest from
#      azure-functions/lineage-extractor/Dockerfile via `az acr build`.
#   3. Restores ACR public access=Disabled (always, even on build failure).
#   4. Creates/updates the `loom-lineage-extractor` CA Job (Schedule trigger,
#      default */15 * * * *) using the console UAMI for registry pull + MI.
#
# NOTE: bicep (modules/admin-plane/lineage-extractor-job.bicep, wired via
#   observabilityConfig.lineageExtractorEnabled) already creates the Job on a
#   full deploy; this script is the image-build + out-of-band refresh path
#   (the Job's first scheduled execution exits cleanly until the image exists).
#
# Run (from a shell with Contributor on the admin RG):
#   ADMIN_RG=rg-csa-loom-admin-centralus \
#   SUB=<admin-sub-id> \
#   CAE=cae-csa-loom-centralus \
#   CONSOLE_UAMI_ID=/subscriptions/<sub>/resourcegroups/<rg>/providers/Microsoft.ManagedIdentity/userAssignedIdentities/<name> \
#   CONSOLE_UAMI_CLIENT_ID=<uami-client-id> \
#   ACR=acrloomk6mvh5sm6z7do.azurecr.io \
#   LOOM_COSMOS_ENDPOINT=https://<acct>.documents.azure.com:443/ \
#   LOOM_ADF_NAME=<adf-factory> LOOM_ADF_RG=<adf-rg> LOOM_ADF_SUB=<sub> \
#   LOOM_SYNAPSE_WORKSPACE=<synapse-ws> \
#   ./scripts/csa-loom/deploy-lineage-extractor-job.sh
#
# Trigger a one-shot run:
#   az containerapp job start -n loom-lineage-extractor -g $ADMIN_RG --subscription $SUB
#
# Results: Container logs (Log Analytics linked to the CAE),
#   ContainerAppConsoleLogs_CL, ContainerName_s == 'extractor'. Look for the
#   "[lineage-extractor] processed <n> run(s), wrote <n> edge(s)" line.

set -euo pipefail

ADMIN_RG="${ADMIN_RG:-rg-csa-loom-admin-centralus}"
SUB="${SUB:?set SUB to the admin-plane subscription id}"
CAE="${CAE:-cae-csa-loom-centralus}"
CONSOLE_UAMI_ID="${CONSOLE_UAMI_ID:?set CONSOLE_UAMI_ID to the console UAMI resource id}"
CONSOLE_UAMI_CLIENT_ID="${CONSOLE_UAMI_CLIENT_ID:?set CONSOLE_UAMI_CLIENT_ID to the console UAMI clientId}"
ACR="${ACR:?set ACR to the ACR login server (e.g. acrloomk6mvh5sm6z7do.azurecr.io)}"
ACR_NAME="${ACR%%.*}"

LOOM_COSMOS_ENDPOINT="${LOOM_COSMOS_ENDPOINT:?set LOOM_COSMOS_ENDPOINT}"
LOOM_COSMOS_DATABASE="${LOOM_COSMOS_DATABASE:-loom}"
LINEAGE_EXTRACTOR_CRON="${LINEAGE_EXTRACTOR_CRON:-*/15 * * * *}"
LOOM_ADF_NAME="${LOOM_ADF_NAME:-}"
LOOM_ADF_RG="${LOOM_ADF_RG:-}"
LOOM_ADF_SUB="${LOOM_ADF_SUB:-}"
LOOM_SYNAPSE_WORKSPACE="${LOOM_SYNAPSE_WORKSPACE:-}"
LOOM_ARM_ENDPOINT="${LOOM_ARM_ENDPOINT:-https://management.azure.com}"

IMAGE="${ACR}/loom-lineage-extractor:latest"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="$REPO_ROOT/azure-functions/lineage-extractor"

echo "[deploy-lineage-extractor] repo root : $REPO_ROOT"
echo "[deploy-lineage-extractor] app dir   : $APP_DIR"
echo "[deploy-lineage-extractor] image     : $IMAGE"

# 1 — enable ACR public access (temp)
echo "[deploy-lineage-extractor] 1/4 Enabling ACR public access (temporary)..."
az acr update --name "$ACR_NAME" --public-network-enabled true --default-action Allow \
  -o tsv --query "publicNetworkAccess" --subscription "$SUB" || true
echo "[deploy-lineage-extractor] Waiting 35s for ACR network rule propagation..."
sleep 35

# 2 — build + push (restore ACR access even on failure)
restore_acr() {
  echo "[deploy-lineage-extractor] Restoring ACR public access=Disabled..."
  az acr update --name "$ACR_NAME" --default-action Deny \
    -o tsv --query "networkRuleSet.defaultAction" --subscription "$SUB" || true
  az acr update --name "$ACR_NAME" --public-network-enabled false \
    -o tsv --query "publicNetworkAccess" --subscription "$SUB" || true
}
trap restore_acr EXIT

echo "[deploy-lineage-extractor] 2/4 Building loom-lineage-extractor:latest via ACR Tasks..."
( cd "$APP_DIR" && az acr build \
  --registry "$ACR_NAME" \
  --image "loom-lineage-extractor:latest" \
  --file "Dockerfile" \
  --subscription "$SUB" \
  --no-logs \
  . )
echo "[deploy-lineage-extractor] Image built: $IMAGE"

# 3 — restore ACR (also runs via trap on any exit)
restore_acr
trap - EXIT

# 4 — create/update the CA Job
echo "[deploy-lineage-extractor] 4/4 Resolving CAE + deploying the job..."
CAEID="$(az containerapp env show -n "$CAE" -g "$ADMIN_RG" --subscription "$SUB" --query id -o tsv | tr -d '\r')"

ENV_ARGS=(
  "AZURE_CLIENT_ID=$CONSOLE_UAMI_CLIENT_ID"
  "LOOM_UAMI_CLIENT_ID=$CONSOLE_UAMI_CLIENT_ID"
  "LOOM_COSMOS_ENDPOINT=$LOOM_COSMOS_ENDPOINT"
  "LOOM_COSMOS_DATABASE=$LOOM_COSMOS_DATABASE"
  "LINEAGE_EXTRACTOR_CRON=$LINEAGE_EXTRACTOR_CRON"
  "LOOM_ADF_NAME=$LOOM_ADF_NAME"
  "LOOM_ADF_RG=$LOOM_ADF_RG"
  "LOOM_ADF_SUB=$LOOM_ADF_SUB"
  "LOOM_SYNAPSE_WORKSPACE=$LOOM_SYNAPSE_WORKSPACE"
  "LOOM_ARM_ENDPOINT=$LOOM_ARM_ENDPOINT"
)

if az containerapp job show -n loom-lineage-extractor -g "$ADMIN_RG" --subscription "$SUB" >/dev/null 2>&1; then
  echo "[deploy-lineage-extractor] Updating existing job image + env..."
  az containerapp job update -n loom-lineage-extractor -g "$ADMIN_RG" --subscription "$SUB" \
    --image "$IMAGE" --set-env-vars "${ENV_ARGS[@]}"
else
  echo "[deploy-lineage-extractor] Creating job..."
  az containerapp job create -n loom-lineage-extractor -g "$ADMIN_RG" --subscription "$SUB" \
    --environment "$CAEID" \
    --trigger-type Schedule \
    --cron-expression "$LINEAGE_EXTRACTOR_CRON" \
    --replica-timeout 600 \
    --replica-retry-limit 1 \
    --parallelism 1 \
    --replica-completion-count 1 \
    --image "$IMAGE" \
    --cpu 0.5 --memory 1.0Gi \
    --mi-user-assigned "$CONSOLE_UAMI_ID" \
    --registry-server "$ACR" \
    --registry-identity "$CONSOLE_UAMI_ID" \
    --env-vars "${ENV_ARGS[@]}"
fi

echo "[deploy-lineage-extractor] Done. Trigger a run with:"
echo "  az containerapp job start -n loom-lineage-extractor -g $ADMIN_RG --subscription $SUB"
