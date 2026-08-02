#!/usr/bin/env bash
# Deploy/refresh the `loom-secret-expiry-monitor` Container App Job — the
# in-VNet, scheduled MSAL/Key-Vault credential-expiry monitor (S1).
#
# WHY a CA Job (NOT a Y1 Function) — B-FN, operator decision 2026-07-23:
#   Y1 Linux Consumption Functions are structurally broken on this estate —
#   Azure Policy seals the storage data-plane (publicNetworkAccess=Disabled,
#   AAD-only, no private endpoint) and the multitenant Y1 runtime is not a
#   trusted service, so host keys / timer leases fail. The in-VNet ACA-job
#   pattern (this script mirrors deploy-lineage-extractor-job.sh) reuses the
#   console UAMI — already AcrPull + Key Vault Secrets User + Monitoring
#   Contributor — and runs entirely inside the VNet. No keys, no host storage.
#
# WHAT it does:
#   1. Temporarily enables ACR public access so `az acr build` can upload the
#      source tarball (mirrors the loom-uat / lineage-extractor pattern).
#   2. Builds loom-secret-expiry-monitor:latest from
#      azure-functions/secret-expiry-monitor/Dockerfile via `az acr build`.
#   3. Restores ACR public access=Disabled (always, even on build failure).
#   4. Creates/updates the `loom-secret-expiry-monitor` CA Job (Schedule
#      trigger, default 5-field cron `0 6 * * *`) using the console UAMI for
#      registry pull + managed identity.
#
# NOTE: bicep (modules/admin-plane/secret-expiry-monitor-job.bicep, wired via
#   functionAppsConfig.secretExpiryEnabled) already creates the Job on a full
#   deploy; this script is the image-build + out-of-band refresh path (the Job's
#   first scheduled execution fails honestly until the image exists).
#
# ONE-TIME operator action: the Graph app role Application.Read.All must be
#   admin-consented on the CONSOLE UAMI — the same grant
#   scripts/csa-loom/grant-identity-graph-approles.sh performs for the Identity
#   Picker. Until it is granted, the Graph half honest-gates in the logs while
#   the Key Vault half keeps working. See docs/fiab/runbooks/secret-rotation.md.
#
# Run (from a shell with Contributor on the admin RG):
#   ADMIN_RG=rg-csa-loom-admin-centralus \
#   SUB=<admin-sub-id> \
#   CAE=cae-csa-loom-centralus \
#   CONSOLE_UAMI_ID=/subscriptions/<sub>/resourcegroups/<rg>/providers/Microsoft.ManagedIdentity/userAssignedIdentities/<name> \
#   CONSOLE_UAMI_CLIENT_ID=<uami-client-id> \
#   ACR=acrloomk6mvh5sm6z7do.azurecr.io \
#   LOOM_MSAL_CLIENT_ID=<console-msal-app-id> \
#   LOOM_KEY_VAULT_URI=https://<vault>.vault.azure.net/ \
#   LOOM_ALERT_ACTION_GROUP_ID=<action-group-arm-id> \
#   LOOM_OPS_STATE_ACCOUNT=<loom-lake-storage-account> \
#   ./scripts/csa-loom/deploy-secret-expiry-job.sh
#
# Trigger a one-shot run:
#   az containerapp job start -n loom-secret-expiry-monitor -g $ADMIN_RG --subscription $SUB
#
# Results: Container logs (Log Analytics linked to the CAE),
#   ContainerAppConsoleLogs_CL, ContainerName_s == 'secret-expiry'. Look for the
#   "[secret-expiry] pass complete ... worst=<band>" line.

set -euo pipefail

ADMIN_RG="${ADMIN_RG:-rg-csa-loom-admin-centralus}"
SUB="${SUB:?set SUB to the admin-plane subscription id}"
CAE="${CAE:-cae-csa-loom-centralus}"
CONSOLE_UAMI_ID="${CONSOLE_UAMI_ID:?set CONSOLE_UAMI_ID to the console UAMI resource id}"
CONSOLE_UAMI_CLIENT_ID="${CONSOLE_UAMI_CLIENT_ID:?set CONSOLE_UAMI_CLIENT_ID to the console UAMI clientId}"
ACR="${ACR:?set ACR to the ACR login server (e.g. acrloomk6mvh5sm6z7do.azurecr.io)}"
ACR_NAME="${ACR%%.*}"

LOOM_MSAL_CLIENT_ID="${LOOM_MSAL_CLIENT_ID:-}"
LOOM_KEY_VAULT_URI="${LOOM_KEY_VAULT_URI:-}"
LOOM_SECRET_EXPIRY_KV_SECRETS="${LOOM_SECRET_EXPIRY_KV_SECRETS:-loom-msal-client-secret,synthetic-login-secret}"
LOOM_SECRET_EXPIRY_WARN_DAYS="${LOOM_SECRET_EXPIRY_WARN_DAYS:-60}"
LOOM_ALERT_ACTION_GROUP_ID="${LOOM_ALERT_ACTION_GROUP_ID:-}"
LOOM_GRAPH_BASE="${LOOM_GRAPH_BASE:-https://graph.microsoft.com}"
LOOM_ARM_ENDPOINT="${LOOM_ARM_ENDPOINT:-https://management.azure.com}"
LOOM_STORAGE_SUFFIX="${LOOM_STORAGE_SUFFIX:-core.windows.net}"
LOOM_OPS_STATE_ACCOUNT="${LOOM_OPS_STATE_ACCOUNT:-}"
LOOM_OPS_STATE_CONTAINER="${LOOM_OPS_STATE_CONTAINER:-ops-state}"
SECRET_EXPIRY_CRON="${SECRET_EXPIRY_CRON:-0 6 * * *}"

IMAGE="${ACR}/loom-secret-expiry-monitor:latest"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="$REPO_ROOT/azure-functions/secret-expiry-monitor"

echo "[deploy-secret-expiry] repo root : $REPO_ROOT"
echo "[deploy-secret-expiry] app dir   : $APP_DIR"
echo "[deploy-secret-expiry] image     : $IMAGE"

# 1 — take the ACR firewall lease (opens the registry)
#
# #2603: the old bare open + unconditional `restore_acr` EXIT trap was a shared
# mutex with no ownership check — this script's cleanup would re-lock the
# registry under a CI build that was mid-push, and vice versa. The lease records
# ownership as ARM tags on the registry; `release` re-locks only if this process
# is still the holder, and re-locks unconditionally when nobody is (fail
# closed). See docs/fiab/acr-firewall-lease.md.
echo "[deploy-secret-expiry] 1/4 Acquiring the ACR firewall lease (opens the registry)..."
bash "$SCRIPT_DIR/acr-firewall-lease.sh" acquire --acr "$ACR_NAME" --subscription "$SUB"

# 2 — build + push (release the lease even on failure)
restore_acr() {
  bash "$SCRIPT_DIR/acr-firewall-lease.sh" release --acr "$ACR_NAME" --subscription "$SUB"
}
trap restore_acr EXIT

echo "[deploy-secret-expiry] 2/4 Building loom-secret-expiry-monitor:latest via ACR Tasks..."
( cd "$APP_DIR" && az acr build \
  --registry "$ACR_NAME" \
  --image "loom-secret-expiry-monitor:latest" \
  --file "Dockerfile" \
  --subscription "$SUB" \
  --no-logs \
  . )
echo "[deploy-secret-expiry] Image built: $IMAGE"

# 3 — restore ACR (also runs via trap on any exit)
restore_acr
trap - EXIT

# 4 — create/update the CA Job
echo "[deploy-secret-expiry] 4/4 Resolving CAE + deploying the job..."
CAEID="$(az containerapp env show -n "$CAE" -g "$ADMIN_RG" --subscription "$SUB" --query id -o tsv | tr -d '\r')"

ENV_ARGS=(
  "AZURE_CLIENT_ID=$CONSOLE_UAMI_CLIENT_ID"
  "LOOM_UAMI_CLIENT_ID=$CONSOLE_UAMI_CLIENT_ID"
  "LOOM_MSAL_CLIENT_ID=$LOOM_MSAL_CLIENT_ID"
  "LOOM_KEY_VAULT_URI=$LOOM_KEY_VAULT_URI"
  "LOOM_SECRET_EXPIRY_KV_SECRETS=$LOOM_SECRET_EXPIRY_KV_SECRETS"
  "LOOM_SECRET_EXPIRY_WARN_DAYS=$LOOM_SECRET_EXPIRY_WARN_DAYS"
  "LOOM_ALERT_ACTION_GROUP_ID=$LOOM_ALERT_ACTION_GROUP_ID"
  "LOOM_GRAPH_BASE=$LOOM_GRAPH_BASE"
  "LOOM_ARM_ENDPOINT=$LOOM_ARM_ENDPOINT"
  "LOOM_STORAGE_SUFFIX=$LOOM_STORAGE_SUFFIX"
  "LOOM_OPS_STATE_ACCOUNT=$LOOM_OPS_STATE_ACCOUNT"
  "LOOM_OPS_STATE_CONTAINER=$LOOM_OPS_STATE_CONTAINER"
  "SECRET_EXPIRY_CRON=$SECRET_EXPIRY_CRON"
)

if az containerapp job show -n loom-secret-expiry-monitor -g "$ADMIN_RG" --subscription "$SUB" >/dev/null 2>&1; then
  echo "[deploy-secret-expiry] Updating existing job image + env..."
  # NO --container-name here, deliberately: with exactly one container the CLI
  # adopts the EXISTING container's name (containerapp_job_decorator.set_up_container),
  # so this update retargets whatever the job already has — including a job
  # created by an older revision of this script under a different name. Passing
  # a name that does not match would ADD A SECOND CONTAINER instead of updating.
  az containerapp job update -n loom-secret-expiry-monitor -g "$ADMIN_RG" --subscription "$SUB" \
    --image "$IMAGE" --set-env-vars "${ENV_ARGS[@]}"
else
  echo "[deploy-secret-expiry] Creating job..."
  # --container-name is REQUIRED on create. Without it the CLI names the
  # container after the JOB (`container_def["name"] = container_name or job_name`),
  # producing `loom-secret-expiry-monitor` — which diverges from the bicep module
  # (modules/admin-plane/secret-expiry-monitor-job.bicep names it `secret-expiry`)
  # and silently breaks this script's own documented log query,
  # `ContainerName_s == 'secret-expiry'`, which would then return zero rows and
  # be indistinguishable from "no credentials are near expiry".
  az containerapp job create -n loom-secret-expiry-monitor -g "$ADMIN_RG" --subscription "$SUB" \
    --environment "$CAEID" \
    --trigger-type Schedule \
    --cron-expression "$SECRET_EXPIRY_CRON" \
    --replica-timeout 600 \
    --replica-retry-limit 1 \
    --parallelism 1 \
    --replica-completion-count 1 \
    --container-name secret-expiry \
    --image "$IMAGE" \
    --cpu 0.5 --memory 1.0Gi \
    --mi-user-assigned "$CONSOLE_UAMI_ID" \
    --registry-server "$ACR" \
    --registry-identity "$CONSOLE_UAMI_ID" \
    --env-vars "${ENV_ARGS[@]}"
fi

echo "[deploy-secret-expiry] Done. Trigger a run with:"
echo "  az containerapp job start -n loom-secret-expiry-monitor -g $ADMIN_RG --subscription $SUB"
