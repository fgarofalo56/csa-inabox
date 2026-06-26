#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CSA Loom — provision the scale-to-zero GitHub Actions runner (ACA Job)
# ---------------------------------------------------------------------------
# Builds platform/runners/github-actions/Dockerfile to the Loom ACR, then
# create-or-updates an EVENT-driven Azure Container Apps Job that registers an
# ephemeral self-hosted runner whenever a workflow targeting `loom-aca` is
# queued. Scale-to-zero (minExecutions 0): no cost when CI is idle.
#
# WHY in-VNet:
#   The job runs in the console's VNet-integrated Container Apps environment
#   (peered to the DLZ), so CI build/roll/UAT can reach PE-only resources (lake,
#   Purview, ADF, Synapse, the private ACR/KV) that a cloud GitHub runner can't.
#   It reuses the CONSOLE UAMI for ACR pull + `az login --identity`, so CI auth
#   == the same identity the console runs as.
#
# NOTE: This does NOT reduce Anthropic API spend. It only moves GitHub Actions
#   *compute* in-VNet (and to scale-to-zero ACA). LLM usage is unaffected.
#
# Secrets: the GitHub PAT is read from env GITHUB_PAT or from Key Vault
#   (KEYVAULT_NAME + PAT_SECRET_NAME). It is stored ONLY as an ACA Job secret
#   (`github-pat`) and referenced via secretref — never written to the repo,
#   never echoed.
#
# Idempotent: `az containerapp job create` || `az containerapp job update`.
#
# Run (from a shell with Contributor on the admin RG):
#   GITHUB_PAT=github_pat_xxx \
#   ./scripts/csa-loom/provision-gh-runner.sh
# or read the PAT from Key Vault:
#   KEYVAULT_NAME=kv-csa-loom-... PAT_SECRET_NAME=gh-actions-pat \
#   ./scripts/csa-loom/provision-gh-runner.sh
#
# Verify the runner registers (after a workflow targeting loom-aca is queued):
#   gh api repos/fgarofalo56/csa-inabox/actions/runners --jq '.runners[].name'
#   az containerapp job execution list -n gh-aca-runner -g <admin-rg> -o table
# ---------------------------------------------------------------------------
set -euo pipefail
export PYTHONUTF8=1   # Windows az CLI: avoid cp1252 'charmap' crashes on Unicode

# ---------------------------------------------------------------------------
# Parameters (override via env)
# ---------------------------------------------------------------------------
SUB="${SUB:-e093f4fd-5047-4ee4-968d-a56942c665f3}"
ADMIN_RG="${ADMIN_RG:-rg-csa-loom-admin-centralus}"
CAE="${CAE:-cae-csa-loom-centralus}"
LOCATION="${LOCATION:-centralus}"
JOB_NAME="${JOB_NAME:-gh-aca-runner}"

# ACR (login server) + bare name for `az acr` commands.
ACR="${ACR:-acrloomk6mvh5sm6z7do.azurecr.io}"
ACR_NAME="${ACR%%.*}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
RUNNER_IMAGE="${ACR}/gh-aca-runner:${IMAGE_TAG}"

# Console UAMI (reused for ACR pull + az login). Resource id + clientId.
CONSOLE_UAMI_ID="${CONSOLE_UAMI_ID:-/subscriptions/${SUB}/resourceGroups/${ADMIN_RG}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami-loom-console-centralus}"

# GitHub target (repo scope).
GH_OWNER="${GH_OWNER:-fgarofalo56}"
GH_REPO="${GH_REPO:-csa-inabox}"
RUNNER_LABELS="${RUNNER_LABELS:-loom-aca,linux,x64}"
RUNNER_NAME_PREFIX="${RUNNER_NAME_PREFIX:-loom-aca}"
GITHUB_API_URL="${GITHUB_API_URL:-https://api.github.com}"   # GH Enterprise: set to your API URL

# KEDA github-runner scaler knobs.
SCALE_LABELS="${SCALE_LABELS:-loom-aca}"             # only count runs requesting these labels
TARGET_QUEUE_LEN="${TARGET_QUEUE_LEN:-1}"            # 1 pending run -> 1 execution
MAX_EXECUTIONS="${MAX_EXECUTIONS:-5}"
MIN_EXECUTIONS="${MIN_EXECUTIONS:-0}"                # scale-to-zero
POLLING_INTERVAL="${POLLING_INTERVAL:-30}"
REPLICA_TIMEOUT="${REPLICA_TIMEOUT:-1800}"
CPU="${CPU:-1.0}"
MEMORY="${MEMORY:-2.0Gi}"

# Runner image build pins (passed through to the Dockerfile ARGs).
RUNNER_VERSION="${RUNNER_VERSION:-2.328.0}"
RUNNER_SHA256="${RUNNER_SHA256:-}"   # optional override; Dockerfile has a pinned default

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNNER_DIR="$REPO_ROOT/platform/runners/github-actions"

echo "[provision-gh-runner] sub        : $SUB"
echo "[provision-gh-runner] admin rg   : $ADMIN_RG"
echo "[provision-gh-runner] env (CAE)  : $CAE"
echo "[provision-gh-runner] job        : $JOB_NAME"
echo "[provision-gh-runner] image      : $RUNNER_IMAGE"
echo "[provision-gh-runner] gh target  : $GH_OWNER/$GH_REPO (labels: $RUNNER_LABELS)"

# ---------------------------------------------------------------------------
# Step 0 — Resolve the GitHub PAT (env OR Key Vault). FAIL LOUDLY if missing.
# ---------------------------------------------------------------------------
if [[ -z "${GITHUB_PAT:-}" ]]; then
  if [[ -n "${KEYVAULT_NAME:-}" ]]; then
    PAT_SECRET_NAME="${PAT_SECRET_NAME:-gh-actions-pat}"
    echo "[provision-gh-runner] reading PAT from Key Vault ${KEYVAULT_NAME}/${PAT_SECRET_NAME}..."
    GITHUB_PAT="$(az keyvault secret show \
        --vault-name "$KEYVAULT_NAME" \
        --name "$PAT_SECRET_NAME" \
        --query value -o tsv | tr -d '\r\n')" \
      || { echo "[provision-gh-runner][FATAL] could not read PAT from Key Vault." >&2; exit 1; }
  fi
fi
if [[ -z "${GITHUB_PAT:-}" ]]; then
  cat >&2 <<'ERR'
[provision-gh-runner][FATAL] GITHUB_PAT is not set and no Key Vault source given.
  Provide a repo-scoped GitHub PAT one of two ways:
    1) export GITHUB_PAT=github_pat_xxx           (fine-grained or classic)
    2) KEYVAULT_NAME=<kv> PAT_SECRET_NAME=<name>  (read from Key Vault)
  Fine-grained PAT on fgarofalo56/csa-inabox needs Repository permissions:
    Administration: Read & Write   (runner registration)
    Actions:        Read           (scaler reads the workflow queue)
    Metadata:       Read           (implicit)
  Classic PAT alternative: `repo` scope. Runner scope = repo.
ERR
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1 — Build the runner image via ACR Tasks (server-side `az acr build`).
#   Toggle ACR public access on/off around the build (the Loom ACR is
#   PE-only / publicNetworkAccess=Disabled), mirroring deploy-loom-uat-job.sh.
# ---------------------------------------------------------------------------
echo ""
echo "[provision-gh-runner] 1/3 Enabling ACR public access (temporary)..."
az acr update --name "$ACR_NAME" --public-network-enabled true \
  --subscription "$SUB" -o tsv --query "publicNetworkAccess" || true
az acr update --name "$ACR_NAME" --default-action Allow \
  --subscription "$SUB" -o tsv --query "networkRuleSet.defaultAction" || true
echo "[provision-gh-runner] Waiting 35s for ACR network rule propagation..."
sleep 35

echo "[provision-gh-runner] Building gh-aca-runner:${IMAGE_TAG} via ACR Tasks..."
BUILD_ARGS=( "RUNNER_VERSION=${RUNNER_VERSION}" )
[[ -n "$RUNNER_SHA256" ]] && BUILD_ARGS+=( "RUNNER_SHA256=${RUNNER_SHA256}" )
BUILD_ARG_FLAGS=()
for a in "${BUILD_ARGS[@]}"; do BUILD_ARG_FLAGS+=( --build-arg "$a" ); done

# Run from inside the runner dir with a relative context (".") + relative
# --file so the Windows `az` CLI gets a path it understands. --no-logs avoids
# the Windows cp1252 log-render crash; az still waits for + reports build status.
build_rc=0
( cd "$RUNNER_DIR" && az acr build \
    --registry "$ACR_NAME" \
    --image "gh-aca-runner:${IMAGE_TAG}" \
    --file "Dockerfile" \
    --subscription "$SUB" \
    --no-logs \
    "${BUILD_ARG_FLAGS[@]}" \
    . ) || build_rc=$?

# ---------------------------------------------------------------------------
# Step 2 — Restore ACR public access=Disabled (ALWAYS, even on build failure).
# ---------------------------------------------------------------------------
echo ""
echo "[provision-gh-runner] 2/3 Restoring ACR public access=Disabled..."
az acr update --name "$ACR_NAME" --default-action Deny \
  --subscription "$SUB" -o tsv --query "networkRuleSet.defaultAction" || true
az acr update --name "$ACR_NAME" --public-network-enabled false \
  --subscription "$SUB" -o tsv --query "publicNetworkAccess" || true

if [[ $build_rc -ne 0 ]]; then
  echo "[provision-gh-runner][FATAL] az acr build failed (rc=$build_rc). Job not deployed." >&2
  exit "$build_rc"
fi
echo "[provision-gh-runner] Image built: $RUNNER_IMAGE"

# ---------------------------------------------------------------------------
# Step 3 — Create-or-update the event-driven ACA Job (idempotent).
# ---------------------------------------------------------------------------
echo ""
echo "[provision-gh-runner] 3/3 Deploying event-driven job '$JOB_NAME'..."

# Resource-id args common to every sub-command below.
ID_ARGS=(
  --name "$JOB_NAME"
  --resource-group "$ADMIN_RG"
  --subscription "$SUB"
)

# Container + scale-rule knobs. Every flag here is accepted by BOTH
# `az containerapp job create` AND `az containerapp job update`, so the update
# path can re-assert them to correct drift on a re-run. (Grounded against the
# `az containerapp job update` CLI reference — Scale/Container arg groups.)
TUNABLE_ARGS=(
  --image "$RUNNER_IMAGE"
  --cpu "$CPU"
  --memory "$MEMORY"
  --replica-timeout "$REPLICA_TIMEOUT"
  --replica-retry-limit 1
  --replica-completion-count 1
  --parallelism 1
  --min-executions "$MIN_EXECUTIONS"
  --max-executions "$MAX_EXECUTIONS"
  --polling-interval "$POLLING_INTERVAL"
  --scale-rule-name "github-runner"
  --scale-rule-type "github-runner"
  --scale-rule-metadata
      "githubAPIURL=${GITHUB_API_URL}"
      "owner=${GH_OWNER}"
      "runnerScope=repo"
      "repos=${GH_REPO}"
      "labels=${SCALE_LABELS}"
      "targetWorkflowQueueLength=${TARGET_QUEUE_LEN}"
  --scale-rule-auth "personalAccessToken=github-pat"
)

# Runner-container env. The scaler reads the workflow queue via the `github-pat`
# ACA secret (scale-rule-auth above); the container reads the PAT via secretref
# to mint a short-lived runner registration token at startup (entrypoint.sh).
ENV_PAIRS=(
  "GH_OWNER=${GH_OWNER}"
  "GH_REPO=${GH_REPO}"
  "GITHUB_API_URL=${GITHUB_API_URL}"
  "RUNNER_LABELS=${RUNNER_LABELS}"
  "RUNNER_NAME_PREFIX=${RUNNER_NAME_PREFIX}"
  "GITHUB_PAT=secretref:github-pat"
)

# IMPORTANT — create-only vs update-valid flags:
#   `az containerapp job update` does NOT accept the create-only flags
#   --environment, --trigger-type, --registry-server, --registry-identity,
#   --mi-user-assigned, --secrets, or --env-vars (it uses --set-env-vars).
#   So the two paths intentionally diverge — feeding the full create flag set
#   to `update` would fail at runtime with "unrecognized arguments":
#     create -> environment + trigger + registry + identity + secret + env
#     update -> tunables + scale rule + --set-env-vars, with the PAT refreshed
#               first via `job secret set` (handles PAT rotation on a re-run).
if az containerapp job show "${ID_ARGS[@]}" -o none 2>/dev/null; then
  echo "[provision-gh-runner] job exists -> update (refresh secret + tunables)"
  az containerapp job secret set "${ID_ARGS[@]}" \
    --secrets "github-pat=${GITHUB_PAT}" -o none
  az containerapp job update "${ID_ARGS[@]}" \
    "${TUNABLE_ARGS[@]}" \
    --set-env-vars "${ENV_PAIRS[@]}" -o none
else
  echo "[provision-gh-runner] job not found -> create"
  az containerapp job create "${ID_ARGS[@]}" \
    --environment "$CAE" \
    --trigger-type Event \
    "${TUNABLE_ARGS[@]}" \
    --secrets "github-pat=${GITHUB_PAT}" \
    --env-vars "${ENV_PAIRS[@]}" \
    --registry-server "$ACR" \
    --registry-identity "$CONSOLE_UAMI_ID" \
    --mi-user-assigned "$CONSOLE_UAMI_ID" \
    -o none
fi

unset GITHUB_PAT

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "[provision-gh-runner] '$JOB_NAME' deployed (scale-to-zero, ephemeral)."
echo ""
echo "  Target it from a workflow:"
echo "    jobs:"
echo "      build:"
echo "        runs-on: [self-hosted, loom-aca]"
echo ""
echo "  Verify a runner registers when a loom-aca workflow is queued:"
echo "    gh api repos/${GH_OWNER}/${GH_REPO}/actions/runners --jq '.runners[].name'"
echo "    az containerapp job execution list -n $JOB_NAME -g $ADMIN_RG --subscription $SUB \\"
echo "      --query '[].{Status:properties.status,Name:name,Start:properties.startTime}' -o table"
