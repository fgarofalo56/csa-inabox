#!/usr/bin/env bash
# Deploy/refresh the `loom-report-subscriptions` Container App Job — the
# in-VNet, scheduled report-subscription delivery runtime (WS-C2).
#
# WHY a CA Job (NOT a Y1 Function) — B-FN C3, operator decision 2026-07-23,
# re-measured 2026-08-06:
#   Y1 Linux Consumption Functions are structurally broken on this estate —
#   Azure Policy seals the storage data-plane (publicNetworkAccess=Disabled,
#   AAD-only, no private endpoint) and the multitenant Y1 runtime is not a
#   trusted service, so host keys / timer leases fail. This is measured, not
#   assumed: on 2026-08-06 `az functionapp function list` returned `[]` (exit 0)
#   for ALL SEVEN Function Apps in rg-csa-loom-admin-centralus — including
#   func-rptsub-*, so this timer had NEVER fired — and the ANONYMOUS health route
#   on func-csa-loom-mcp returned HTTP 404.
#   The in-VNet ACA-job pattern (this script mirrors deploy-secret-expiry-job.sh)
#   reuses the console UAMI — already AcrPull + Cosmos Built-in Data Contributor
#   + Storage Blob Data Contributor + Logic App Contributor on the delivery
#   workflow — and runs entirely inside the VNet. No keys, no host storage, and
#   NO post-deploy RBAC step (the retired Function needed three grants applied
#   after the fact by grant-navigator-rbac.sh).
#
# WHAT it does:
#   1. Takes the ACR firewall lease (opens the registry) so `az acr build` can
#      upload the source tarball.
#   2. Builds loom-report-subscriptions:latest from
#      azure-functions/report-subscriptions/Dockerfile via `az acr build`.
#   3. Releases the lease (always, even on build failure).
#   4. Creates/updates the `loom-report-subscriptions` CA Job (Schedule trigger,
#      default 5-field cron `*/15 * * * *`) using the console UAMI for registry
#      pull + managed identity.
#
# NOTE: bicep (modules/admin-plane/report-subscriptions-job.bicep, wired via
#   reportSubscriptionsEnabled) already creates the Job on a full deploy; this
#   script is the image-build + out-of-band refresh path (the Job's first
#   scheduled execution fails honestly until the image exists).
#
# Run (from a shell with Contributor on the admin RG):
#   ADMIN_RG=rg-csa-loom-admin-centralus \
#   SUB=<admin-sub-id> \
#   CAE=cae-csa-loom-centralus \
#   CONSOLE_UAMI_ID=/subscriptions/<sub>/resourcegroups/<rg>/providers/Microsoft.ManagedIdentity/userAssignedIdentities/<name> \
#   CONSOLE_UAMI_CLIENT_ID=<uami-client-id> \
#   ACR=acrloomk6mvh5sm6z7do.azurecr.io \
#   LOOM_COSMOS_ENDPOINT=https://<cosmos>.documents.azure.com:443/ \
#   LOOM_REPORT_RENDERER_URL=<paginated-report-renderer base url> \
#   LOOM_SUBSCRIPTION_LOGIC_APP_NAME=<delivery workflow name> \
#   ./scripts/csa-loom/deploy-report-subscriptions-job.sh
#
# Trigger a one-shot run:
#   az containerapp job start -n loom-report-subscriptions -g $ADMIN_RG --subscription $SUB
#
# Results: Container logs (Log Analytics linked to the CAE),
#   ContainerAppConsoleLogs_CL, ContainerName_s == 'report-subscriptions'. Look
#   for "[report-subscriptions] pass complete ... delivered=<n> failed=<n>", or
#   "pass gated" when configuration is incomplete.

set -euo pipefail

ADMIN_RG="${ADMIN_RG:-rg-csa-loom-admin-centralus}"
SUB="${SUB:?set SUB to the admin-plane subscription id}"
CAE="${CAE:-cae-csa-loom-centralus}"
CONSOLE_UAMI_ID="${CONSOLE_UAMI_ID:?set CONSOLE_UAMI_ID to the console UAMI resource id}"
CONSOLE_UAMI_CLIENT_ID="${CONSOLE_UAMI_CLIENT_ID:?set CONSOLE_UAMI_CLIENT_ID to the console UAMI clientId}"
ACR="${ACR:?set ACR to the ACR login server (e.g. acrloomk6mvh5sm6z7do.azurecr.io)}"
ACR_NAME="${ACR%%.*}"

LOOM_COSMOS_ENDPOINT="${LOOM_COSMOS_ENDPOINT:-}"
LOOM_COSMOS_DATABASE="${LOOM_COSMOS_DATABASE:-loom}"
LOOM_REPORT_RENDERER_URL="${LOOM_REPORT_RENDERER_URL:-}"
LOOM_ADLS_ACCOUNT="${LOOM_ADLS_ACCOUNT:-}"
LOOM_SUBSCRIPTION_ID="${LOOM_SUBSCRIPTION_ID:-$SUB}"
LOOM_SUBSCRIPTION_LOGIC_APP_NAME="${LOOM_SUBSCRIPTION_LOGIC_APP_NAME:-}"
LOOM_SUBSCRIPTION_LOGIC_APP_RG="${LOOM_SUBSCRIPTION_LOGIC_APP_RG:-$ADMIN_RG}"
LOOM_DLZ_RG="${LOOM_DLZ_RG:-}"
LOOM_ARM_ENDPOINT="${LOOM_ARM_ENDPOINT:-https://management.azure.com}"
LOOM_STORAGE_SUFFIX="${LOOM_STORAGE_SUFFIX:-core.windows.net}"
LOOM_AOAI_ENDPOINT="${LOOM_AOAI_ENDPOINT:-}"
LOOM_AOAI_DEPLOYMENT="${LOOM_AOAI_DEPLOYMENT:-}"
LOOM_AOAI_API_VERSION="${LOOM_AOAI_API_VERSION:-2024-10-21}"
REPORT_SUBSCRIPTIONS_CRON="${REPORT_SUBSCRIPTIONS_CRON:-*/15 * * * *}"

IMAGE="${ACR}/loom-report-subscriptions:latest"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="$REPO_ROOT/azure-functions/report-subscriptions"

echo "[deploy-report-subscriptions] repo root : $REPO_ROOT"
echo "[deploy-report-subscriptions] app dir   : $APP_DIR"
echo "[deploy-report-subscriptions] image     : $IMAGE"

# 1 — take the ACR firewall lease (opens the registry)
#
# #2603: a bare open + unconditional restore EXIT trap is a shared mutex with no
# ownership check — this script's cleanup would re-lock the registry under a CI
# build that was mid-push, and vice versa. The lease records ownership as ARM
# tags on the registry; `release` re-locks only if this process is still the
# holder, and re-locks unconditionally when nobody is (fail closed). See
# docs/fiab/acr-firewall-lease.md.
echo "[deploy-report-subscriptions] 1/4 Acquiring the ACR firewall lease (opens the registry)..."
bash "$SCRIPT_DIR/acr-firewall-lease.sh" acquire --acr "$ACR_NAME" --subscription "$SUB"

# 2 — build + push (release the lease even on failure)
restore_acr() {
  bash "$SCRIPT_DIR/acr-firewall-lease.sh" release --acr "$ACR_NAME" --subscription "$SUB"
}
trap restore_acr EXIT

echo "[deploy-report-subscriptions] 2/4 Building loom-report-subscriptions:latest via ACR Tasks..."
( cd "$APP_DIR" && az acr build \
  --registry "$ACR_NAME" \
  --image "loom-report-subscriptions:latest" \
  --file "Dockerfile" \
  --subscription "$SUB" \
  --no-logs \
  . )
echo "[deploy-report-subscriptions] Image built: $IMAGE"

# 3 — restore ACR (also runs via trap on any exit)
restore_acr
trap - EXIT

# 4 — create/update the CA Job
echo "[deploy-report-subscriptions] 4/4 Resolving CAE + deploying the job..."
CAEID="$(az containerapp env show -n "$CAE" -g "$ADMIN_RG" --subscription "$SUB" --query id -o tsv | tr -d '\r')"

ENV_ARGS=(
  "AZURE_CLIENT_ID=$CONSOLE_UAMI_CLIENT_ID"
  "LOOM_UAMI_CLIENT_ID=$CONSOLE_UAMI_CLIENT_ID"
  "LOOM_COSMOS_ENDPOINT=$LOOM_COSMOS_ENDPOINT"
  "LOOM_COSMOS_DATABASE=$LOOM_COSMOS_DATABASE"
  "LOOM_REPORT_RENDERER_URL=$LOOM_REPORT_RENDERER_URL"
  "LOOM_ADLS_ACCOUNT=$LOOM_ADLS_ACCOUNT"
  "LOOM_SUBSCRIPTION_ID=$LOOM_SUBSCRIPTION_ID"
  "LOOM_SUBSCRIPTION_LOGIC_APP_NAME=$LOOM_SUBSCRIPTION_LOGIC_APP_NAME"
  "LOOM_SUBSCRIPTION_LOGIC_APP_RG=$LOOM_SUBSCRIPTION_LOGIC_APP_RG"
  "LOOM_DLZ_RG=$LOOM_DLZ_RG"
  "LOOM_ARM_ENDPOINT=$LOOM_ARM_ENDPOINT"
  "LOOM_STORAGE_SUFFIX=$LOOM_STORAGE_SUFFIX"
  "LOOM_AOAI_ENDPOINT=$LOOM_AOAI_ENDPOINT"
  "LOOM_AOAI_DEPLOYMENT=$LOOM_AOAI_DEPLOYMENT"
  "LOOM_AOAI_API_VERSION=$LOOM_AOAI_API_VERSION"
  "REPORT_SUBSCRIPTIONS_CRON=$REPORT_SUBSCRIPTIONS_CRON"
)

if az containerapp job show -n loom-report-subscriptions -g "$ADMIN_RG" --subscription "$SUB" >/dev/null 2>&1; then
  echo "[deploy-report-subscriptions] Updating existing job image + env..."
  # NO --container-name here, deliberately: with exactly one container the CLI
  # adopts the EXISTING container's name (containerapp_job_decorator.set_up_container),
  # so this update retargets whatever the job already has — including a job
  # created by an older revision of this script under a different name. Passing
  # a name that does not match would ADD A SECOND CONTAINER instead of updating.
  az containerapp job update -n loom-report-subscriptions -g "$ADMIN_RG" --subscription "$SUB" \
    --image "$IMAGE" --set-env-vars "${ENV_ARGS[@]}"
else
  echo "[deploy-report-subscriptions] Creating job..."
  # --container-name is REQUIRED on create. Without it the CLI names the
  # container after the JOB (`container_def["name"] = container_name or job_name`),
  # producing `loom-report-subscriptions` — which diverges from the bicep module
  # (modules/admin-plane/report-subscriptions-job.bicep names it
  # `report-subscriptions`) and silently breaks this script's own documented log
  # query, `ContainerName_s == 'report-subscriptions'`, which would then return
  # zero rows and be indistinguishable from "nothing was due".
  #
  # --replica-retry-limit 0 matches the bicep module: a failed pass is retried by
  # the NEXT tick, and every per-subscription failure is already durable on the
  # delivery-log row. Retrying the whole batch would re-deliver the subscriptions
  # that succeeded before the fault — duplicate email is worse than a 15-minute
  # delay.
  az containerapp job create -n loom-report-subscriptions -g "$ADMIN_RG" --subscription "$SUB" \
    --environment "$CAEID" \
    --trigger-type Schedule \
    --cron-expression "$REPORT_SUBSCRIPTIONS_CRON" \
    --replica-timeout 840 \
    --replica-retry-limit 0 \
    --parallelism 1 \
    --replica-completion-count 1 \
    --container-name report-subscriptions \
    --image "$IMAGE" \
    --cpu 0.5 --memory 1.0Gi \
    --mi-user-assigned "$CONSOLE_UAMI_ID" \
    --registry-server "$ACR" \
    --registry-identity "$CONSOLE_UAMI_ID" \
    --env-vars "${ENV_ARGS[@]}"
fi

echo "[deploy-report-subscriptions] Done. Trigger a run with:"
echo "  az containerapp job start -n loom-report-subscriptions -g $ADMIN_RG --subscription $SUB"
