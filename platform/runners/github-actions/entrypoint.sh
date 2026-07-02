#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CSA Loom — ephemeral GitHub Actions self-hosted runner entrypoint
# ---------------------------------------------------------------------------
# Runs as the container ENTRYPOINT inside a scale-to-zero Azure Container Apps
# Job (one job execution == one ephemeral runner == one workflow run).
#
# Flow (matches the Microsoft "self-hosted CI/CD runners with ACA jobs"
# tutorial + the KEDA github-runner scaler contract):
#   1. Exchange the repo-scoped PAT for a short-lived REGISTRATION token via the
#      GitHub REST API (POST .../actions/runners/registration-token).
#   2. Configure the runner --ephemeral --unattended --replace.
#   3. trap -> on exit, de-register the runner (best-effort remove token).
#   4. ./run.sh — process exactly one job, then exit (ephemeral) so the ACA
#      job execution completes and the replica is reclaimed.
#
# Required env (injected by the ACA Job — see provision-gh-runner.sh / bicep):
#   GH_OWNER             repo owner          (e.g. fgarofalo56)
#   GH_REPO              repo name           (e.g. csa-inabox)
#   GITHUB_PAT           secretref -> github-pat   (NEVER logged)
# Optional env:
#   RUNNER_LABELS        comma list          (default: loom-aca,linux,x64)
#   RUNNER_NAME_PREFIX   name prefix         (default: loom-aca)
#   GITHUB_API_URL       API base            (default: https://api.github.com)
#   GITHUB_SERVER_URL    web base            (default: https://github.com)
#   REGISTRATION_TOKEN_API_URL  full override for the reg-token endpoint
#
# Fails loudly (set -euo pipefail) — no silent no-op. A missing PAT, a 401 from
# GitHub, or a config.sh failure aborts the container with a non-zero exit so
# the ACA job execution is marked Failed (visible, retried per policy).
# ---------------------------------------------------------------------------
set -euo pipefail

log()  { printf '[gh-aca-runner] %s\n' "$*"; }
fail() { printf '[gh-aca-runner][FATAL] %s\n' "$*" >&2; exit 1; }

# --- validate required inputs ---------------------------------------------
: "${GH_OWNER:?GH_OWNER not set (repo owner, e.g. fgarofalo56)}"
: "${GH_REPO:?GH_REPO not set (repo name, e.g. csa-inabox)}"
: "${GITHUB_PAT:?GITHUB_PAT not set (inject as secretref:github-pat)}"

RUNNER_LABELS="${RUNNER_LABELS:-loom-aca,linux,x64}"
RUNNER_NAME_PREFIX="${RUNNER_NAME_PREFIX:-loom-aca}"
GITHUB_API_URL="${GITHUB_API_URL:-https://api.github.com}"
GITHUB_SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"
REGISTRATION_TOKEN_API_URL="${REGISTRATION_TOKEN_API_URL:-${GITHUB_API_URL}/repos/${GH_OWNER}/${GH_REPO}/actions/runners/registration-token}"
REMOVE_TOKEN_API_URL="${GITHUB_API_URL}/repos/${GH_OWNER}/${GH_REPO}/actions/runners/remove-token"

RUNNER_URL="${GITHUB_SERVER_URL}/${GH_OWNER}/${GH_REPO}"
RUNNER_NAME="${RUNNER_NAME_PREFIX}-$(hostname)"

cd "$(dirname "$0")"

# --- helper: mint a short-lived runner token from the PAT ------------------
# Echoes the token to stdout; callers capture it. The PAT itself is sent only
# in the Authorization header and is never echoed.
mint_token() {
  local url="$1" resp token
  resp="$(curl -fsSL -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "Authorization: Bearer ${GITHUB_PAT}" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            "${url}")" \
    || fail "GitHub API call failed: ${url} (check PAT scope: Administration:Read+Write, Actions:Read)"
  token="$(printf '%s' "${resp}" | jq -r '.token // empty')"
  [ -n "${token}" ] || fail "No .token in GitHub response from ${url} (PAT invalid/expired or insufficient scope)"
  printf '%s' "${token}"
}

# --- cleanup: de-register the ephemeral runner on any exit -----------------
cleanup() {
  local rc=$?
  log "cleanup: de-registering runner ${RUNNER_NAME} (exit=${rc})"
  # --ephemeral runners auto-remove after a job, but a crash before/at config
  # can leave a stale registration. Best-effort remove; never block exit.
  local remove_token
  if remove_token="$(mint_token "${REMOVE_TOKEN_API_URL}" 2>/dev/null)"; then
    ./config.sh remove --token "${remove_token}" >/dev/null 2>&1 || true
  fi
  exit "${rc}"
}
trap 'cleanup' INT TERM EXIT

# --- configure (ephemeral) -------------------------------------------------
log "registering ephemeral runner '${RUNNER_NAME}' on ${GH_OWNER}/${GH_REPO} (labels: ${RUNNER_LABELS})"
REG_TOKEN="$(mint_token "${REGISTRATION_TOKEN_API_URL}")"

./config.sh \
  --url "${RUNNER_URL}" \
  --token "${REG_TOKEN}" \
  --ephemeral \
  --unattended \
  --replace \
  --labels "${RUNNER_LABELS}" \
  --name "${RUNNER_NAME}" \
  --work _work \
  || fail "config.sh failed — runner not registered"

# Drop the registration token from the env. GITHUB_PAT is intentionally KEPT so
# the EXIT trap can mint a remove-token to de-register a crashed runner; it lives
# in the container env regardless and is never echoed.
unset REG_TOKEN

# --- run exactly one job (ephemeral), then exit ----------------------------
log "starting runner (ephemeral — processes one job then exits)"
./run.sh
