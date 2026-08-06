#!/usr/bin/env bash
# Deploy/refresh the `loom-copilot-evaluator` Container App Job — the in-VNet,
# scheduled + on-demand Copilot quality eval harness (loom-next-level E2, plus
# SRCH1 search relevance and E6 tier-router evals on the same execution).
#
# WHY a CA Job (NOT a Y1 Function) — B-FN, operator decision 2026-07-23:
#   Y1 Linux Consumption Functions are structurally broken on this estate —
#   Azure Policy seals the storage data-plane (publicNetworkAccess=Disabled,
#   AAD-only, no private endpoint) and the multitenant Y1 runtime is not a
#   trusted service, so host keys / timer leases fail. The in-VNet ACA-job
#   pattern (this script mirrors deploy-lineage-extractor-job.sh) reuses the
#   console UAMI — already AcrPull + Cognitive Services OpenAI User + Search
#   Index Data Reader + Cosmos Data Contributor — and runs entirely inside the
#   VNet, so the eval probe no longer has to leave through Front Door and there
#   is no Function host key to manage.
#
# WHAT it does:
#   1. Temporarily enables ACR public access so `az acr build` can upload the
#      source tarball (mirrors the loom-uat / lineage-extractor pattern).
#   2. Builds loom-copilot-evaluator:latest from
#      azure-functions/copilot-evaluator/Dockerfile via `az acr build`.
#      IMPORTANT: the build context is the REPO ROOT — the evaluator imports
#      two shared pure console modules and stages content/evals into the image.
#      That context is STAGED FROM HEAD via `git archive` into temp/, never
#      taken from the live working tree (#2564) — see the comment at the build
#      step for the Windows MAX_PATH failure that forces this.
#   3. Restores ACR public access=Disabled (always, even on build failure).
#   4. Creates/updates the `loom-copilot-evaluator` CA Job (Schedule trigger,
#      default 5-field cron `0 7 * * *`) using the console UAMI for registry
#      pull + managed identity.
#
# CONTAINER NAME IS LOAD-BEARING: it must be `evaluator`, matching
#   modules/admin-plane/copilot-evaluator-job.bicep. `az containerapp job create`
#   defaults the container name to the JOB name, and a job created that way still
#   RUNS fine — but `az containerapp job logs show --container evaluator` (how
#   .github/workflows/copilot-quality-evals.yml lifts the `::eval-run::` receipt)
#   then matches nothing, so the CI gate goes GREEN having measured ZERO surfaces.
#   Same for the `ContainerName_s == 'evaluator'` Log Analytics query documented
#   below. Do not let this drift from the bicep.
#
# NOTE: bicep (modules/admin-plane/copilot-evaluator-job.bicep, wired via
#   functionAppsConfig.copilotEvaluatorEnabled) already creates the Job on a
#   full deploy — including the Contributor-on-the-job grant that lets the
#   Console's "Run now" start an execution. This script is the image-build +
#   out-of-band refresh path (the Job's first scheduled execution fails
#   honestly until the image exists).
#
# Run (from a shell with Contributor on the admin RG):
#   ADMIN_RG=rg-csa-loom-admin-centralus \
#   SUB=<admin-sub-id> \
#   CAE=cae-csa-loom-centralus \
#   CONSOLE_UAMI_ID=/subscriptions/<sub>/resourcegroups/<rg>/providers/Microsoft.ManagedIdentity/userAssignedIdentities/<name> \
#   CONSOLE_UAMI_CLIENT_ID=<uami-client-id> \
#   ACR=acrloomk6mvh5sm6z7do.azurecr.io \
#   LOOM_COSMOS_ENDPOINT=https://<acct>.documents.azure.com:443/ \
#   LOOM_AOAI_ENDPOINT=https://<foundry>.openai.azure.com/ \
#   LOOM_INTERNAL_TOKEN=<shared internal token> \
#   ./scripts/csa-loom/deploy-copilot-evaluator-job.sh
#
# Trigger a one-shot run (all modes):
#   az containerapp job start -n loom-copilot-evaluator -g $ADMIN_RG --subscription $SUB
# Trigger one surface only:
#   az containerapp job start -n loom-copilot-evaluator -g $ADMIN_RG --subscription $SUB \
#     --env-vars COPILOT_EVAL_MODE=copilot COPILOT_EVAL_TRIGGER=manual COPILOT_EVAL_SURFACES=<surface>
#
# Results: Cosmos `loom-copilot-evals` (the /admin/copilot-quality page reads
#   it), plus container logs in Log Analytics (ContainerAppConsoleLogs_CL,
#   ContainerName_s == 'evaluator'). The last line of a copilot-mode execution
#   is the `::eval-run::{json}` receipt the CI gate lifts.

set -euo pipefail

# Git Bash / MSYS rewrites any argument that looks like a POSIX absolute path
# into a Windows path before the child process sees it, so an ARM resource id
# `/subscriptions/.../userAssignedIdentities/x` arrives at az as
# `C:/Program Files/Git/subscriptions/.../userAssignedIdentities/x` and is
# rejected with the misleading "--registry-identity must be an identity resource
# ID or 'system' or 'system-environment'".
#
# This CANNOT be a blanket `export` — git.exe and tar are native Windows
# binaries that RELY on the conversion to understand `/e/Repos/...`, so exporting
# it globally breaks the `git archive` staging below. Use this prefix on the az
# calls that carry an ARM id, and nowhere else. No-op on Linux/CI.
AZ_ARM='MSYS_NO_PATHCONV=1'

ADMIN_RG="${ADMIN_RG:-rg-csa-loom-admin-centralus}"
SUB="${SUB:?set SUB to the admin-plane subscription id}"
CAE="${CAE:-cae-csa-loom-centralus}"
CONSOLE_UAMI_ID="${CONSOLE_UAMI_ID:?set CONSOLE_UAMI_ID to the console UAMI resource id}"
CONSOLE_UAMI_CLIENT_ID="${CONSOLE_UAMI_CLIENT_ID:?set CONSOLE_UAMI_CLIENT_ID to the console UAMI clientId}"
ACR="${ACR:?set ACR to the ACR login server (e.g. acrloomk6mvh5sm6z7do.azurecr.io)}"
ACR_NAME="${ACR%%.*}"

LOOM_COSMOS_ENDPOINT="${LOOM_COSMOS_ENDPOINT:-}"
LOOM_COSMOS_DATABASE="${LOOM_COSMOS_DATABASE:-loom}"
LOOM_EVAL_PROBE_URL="${LOOM_EVAL_PROBE_URL:-http://loom-console}"
LOOM_INTERNAL_TOKEN="${LOOM_INTERNAL_TOKEN:-}"
LOOM_AOAI_ENDPOINT="${LOOM_AOAI_ENDPOINT:-}"
LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT="${LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT:-}"
LOOM_AOAI_STRONG_DEPLOYMENT="${LOOM_AOAI_STRONG_DEPLOYMENT:-}"
LOOM_AOAI_MINI_DEPLOYMENT="${LOOM_AOAI_MINI_DEPLOYMENT:-}"
LOOM_AOAI_DEPLOYMENT="${LOOM_AOAI_DEPLOYMENT:-}"
# Default must match copilot-evaluator-job.bicep judgeDailyCap (E1 2026-08-06:
# 500 was exhausted daily by the merge-train's eval volume, zero-judging the gate).
LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP="${LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP:-5000}"
LOOM_ARM_ENDPOINT="${LOOM_ARM_ENDPOINT:-https://management.azure.com}"
COPILOT_EVALUATOR_CRON="${COPILOT_EVALUATOR_CRON:-0 7 * * *}"

IMAGE="${ACR}/loom-copilot-evaluator:latest"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "[deploy-copilot-evaluator] repo root : $REPO_ROOT"
echo "[deploy-copilot-evaluator] image     : $IMAGE"

# 1 — take the ACR firewall lease (opens the registry)
#
# #2603: this used to be a bare `az acr update --public-network-enabled true`
# with an unconditional `restore_acr` EXIT trap. That trap re-locked the
# registry no matter who had opened it — so running this script while CI was
# mid-`az acr build` denied that build's push after minutes of work, and vice
# versa. `acquire` records an ownership lease as ARM tags on the registry and
# waits (bounded) if someone else holds it; `release` only re-locks when this
# process is still the recorded holder, and re-locks unconditionally when
# nobody is (fail closed). See docs/fiab/acr-firewall-lease.md.
echo "[deploy-copilot-evaluator] 1/4 Acquiring the ACR firewall lease (opens the registry)..."
bash "$SCRIPT_DIR/acr-firewall-lease.sh" acquire --acr "$ACR_NAME" --subscription "$SUB"

# 2 — build + push (release the lease even on failure)
restore_acr() {
  bash "$SCRIPT_DIR/acr-firewall-lease.sh" release --acr "$ACR_NAME" --subscription "$SUB"
}
trap restore_acr EXIT

# Build context = REPO ROOT (see the Dockerfile header for why) — but staged
# from COMMITTED state via `git archive`, never the live working tree (#2564).
#
# Two reasons, one of which is a hard failure:
#   1. `az acr build` tars the whole context, and its walker descends into
#      directories even when .dockerignore lists them (it emits per-file
#      "Excluding ..." lines rather than pruning). A single agent worktree under
#      .claude/worktrees/ therefore drags the walker through a nested pnpm store
#      whose paths exceed Windows MAX_PATH, and the upload dies with
#      `[WinError 3] The system cannot find the path specified`. Because that
#      depends on whether a worktree happens to exist, it presents as a flake.
#   2. Building from the working tree bakes whatever untracked/dirty state is
#      lying around into the image. Staging from HEAD makes the image
#      reproducible from a commit, matching how CI builds it.
STAGE_DIR="$REPO_ROOT/temp/acr-ctx-copilot-evaluator.$$"
cleanup_stage() { rm -rf "$STAGE_DIR"; }
trap 'restore_acr; cleanup_stage' EXIT

if ! git -C "$REPO_ROOT" diff --quiet HEAD -- azure-functions/copilot-evaluator 2>/dev/null; then
  echo "[deploy-copilot-evaluator] WARNING: uncommitted changes under" \
       "azure-functions/copilot-evaluator/ will NOT be in the image —" \
       "the context is staged from HEAD ($(git -C "$REPO_ROOT" rev-parse --short HEAD))."
fi

echo "[deploy-copilot-evaluator] 2/4 Staging build context from HEAD..."
mkdir -p "$STAGE_DIR"
git -C "$REPO_ROOT" archive --format=tar HEAD | tar -x -C "$STAGE_DIR"

echo "[deploy-copilot-evaluator] 2/4 Building loom-copilot-evaluator:latest via ACR Tasks..."
( cd "$STAGE_DIR" && az acr build \
  --registry "$ACR_NAME" \
  --image "loom-copilot-evaluator:latest" \
  --file "azure-functions/copilot-evaluator/Dockerfile" \
  --subscription "$SUB" \
  --no-logs \
  . )
echo "[deploy-copilot-evaluator] Image built: $IMAGE"

# 3 — restore ACR (also runs via trap on any exit)
restore_acr
trap - EXIT

# 4 — create/update the CA Job
echo "[deploy-copilot-evaluator] 4/4 Resolving CAE + deploying the job..."
CAEID="$(az containerapp env show -n "$CAE" -g "$ADMIN_RG" --subscription "$SUB" --query id -o tsv | tr -d '\r')"

ENV_ARGS=(
  "AZURE_CLIENT_ID=$CONSOLE_UAMI_CLIENT_ID"
  "LOOM_UAMI_CLIENT_ID=$CONSOLE_UAMI_CLIENT_ID"
  "LOOM_COSMOS_ENDPOINT=$LOOM_COSMOS_ENDPOINT"
  "LOOM_COSMOS_DATABASE=$LOOM_COSMOS_DATABASE"
  "LOOM_EVAL_PROBE_URL=$LOOM_EVAL_PROBE_URL"
  "LOOM_AOAI_ENDPOINT=$LOOM_AOAI_ENDPOINT"
  "LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT=$LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT"
  "LOOM_AOAI_STRONG_DEPLOYMENT=$LOOM_AOAI_STRONG_DEPLOYMENT"
  "LOOM_AOAI_MINI_DEPLOYMENT=$LOOM_AOAI_MINI_DEPLOYMENT"
  "LOOM_AOAI_DEPLOYMENT=$LOOM_AOAI_DEPLOYMENT"
  "LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP=$LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP"
  "LOOM_COPILOT_EVAL_ENABLED=true"
  "LOOM_ARM_ENDPOINT=$LOOM_ARM_ENDPOINT"
  "COPILOT_EVALUATOR_CRON=$COPILOT_EVALUATOR_CRON"
  "COPILOT_EVAL_MODE=all"
  "COPILOT_EVAL_TRIGGER=nightly"
)

if az containerapp job show -n loom-copilot-evaluator -g "$ADMIN_RG" --subscription "$SUB" >/dev/null 2>&1; then
  echo "[deploy-copilot-evaluator] Updating existing job image + env..."
  az containerapp job update -n loom-copilot-evaluator -g "$ADMIN_RG" --subscription "$SUB" \
    --image "$IMAGE" --set-env-vars "${ENV_ARGS[@]}"
else
  echo "[deploy-copilot-evaluator] Creating job..."
  env $AZ_ARM az containerapp job create -n loom-copilot-evaluator -g "$ADMIN_RG" --subscription "$SUB" \
    --environment "$CAEID" \
    --trigger-type Schedule \
    --cron-expression "$COPILOT_EVALUATOR_CRON" \
    --replica-timeout 2700 \
    --replica-retry-limit 1 \
    --parallelism 1 \
    --replica-completion-count 1 \
    --image "$IMAGE" \
    --container-name evaluator \
    --cpu 1.0 --memory 2.0Gi \
    --mi-user-assigned "$CONSOLE_UAMI_ID" \
    --registry-server "$ACR" \
    --registry-identity "$CONSOLE_UAMI_ID" \
    --env-vars "${ENV_ARGS[@]}"
fi

# The shared internal trust token is a Container Apps SECRET, never a plain env
# var (it authenticates the console's internal eval-probe route).
if [ -n "$LOOM_INTERNAL_TOKEN" ]; then
  echo "[deploy-copilot-evaluator] Wiring LOOM_INTERNAL_TOKEN as a job secret..."
  az containerapp job secret set -n loom-copilot-evaluator -g "$ADMIN_RG" --subscription "$SUB" \
    --secrets "loom-internal-token=$LOOM_INTERNAL_TOKEN"
  az containerapp job update -n loom-copilot-evaluator -g "$ADMIN_RG" --subscription "$SUB" \
    --set-env-vars "LOOM_INTERNAL_TOKEN=secretref:loom-internal-token"
else
  echo "[deploy-copilot-evaluator] LOOM_INTERNAL_TOKEN unset - the eval probe will honest-gate until it is wired."
fi

echo "[deploy-copilot-evaluator] Done. Trigger a run with:"
echo "  az containerapp job start -n loom-copilot-evaluator -g $ADMIN_RG --subscription $SUB"
