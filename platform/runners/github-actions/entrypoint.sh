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
# Uses the PRE-MINTED remove token, never the PAT -- see the exec below. The
# token is minted while the PAT is still in scope and survives into the
# replacement process image; nothing after that point can reach the PAT.
cleanup() {
  local rc=$?
  log "cleanup: de-registering runner ${RUNNER_NAME} (exit=${rc})"
  if [ -n "${RUNNER_REMOVE_TOKEN:-}" ]; then
    ./config.sh remove --token "${RUNNER_REMOVE_TOKEN}" >/dev/null 2>&1 || true
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

# Drop the registration token from the env.
unset REG_TOKEN

# --- THE PAT MUST NOT SURVIVE INTO THE JOB ---------------------------------
#
# It used to. This block is the fix, and the defect it replaces was real and
# live: `GITHUB_PAT` is injected as a container env var (secretref), this script
# is PID 1, and `./run.sh` was its CHILD -- so every `run:` block in every job
# inherited a PAT scoped `Administration: Read & Write`. It is not a GitHub
# Actions secret, so the log masker does not redact it, and this repository is
# PUBLIC. `printenv GITHUB_PAT` in any step would have printed a repo-admin
# credential into a world-readable log.
#
# The previous comment here said the PAT "lives in the container env regardless
# and is never echoed" -- true of THIS script, and not the property that
# mattered. Before the CI migration ~10 mostly-dispatch jobs ran here; the
# migration took that to ~167, including `pull_request`-triggered ones. Found
# by two independent reviewers, separately, on the migration PR.
#
# WHY `exec env -u` AND NOT JUST `unset`. `unset GITHUB_PAT` would clear it for
# children, but `/proc/1/environ` is a snapshot taken at process START and does
# not change -- a job running as root could still read it there. `exec` REPLACES
# the process image, and the new environ is the one `env -u` composed, so the
# PAT is gone from the process table entirely rather than merely out of scope.
#
# The remove token is minted here, while the PAT is still reachable, and carried
# across the exec. That is a deliberate downgrade, not an oversight: a
# runner-removal token is short-lived and can only de-register a runner, so the
# worst an attacker gains from it is a nuisance -- whereas the PAT it replaces
# administers the repository. The residual is stated rather than hidden.
log "pre-minting the remove token, then dropping the PAT from the process image"
REMOVE_TOKEN="$(mint_token "${REMOVE_TOKEN_API_URL}" 2>/dev/null || true)"
[ -n "${REMOVE_TOKEN}" ] || log "WARNING: could not pre-mint a remove token; a crashed runner will rely on GitHub's own offline reaping"

# --- run exactly one job (ephemeral), then exit ----------------------------
log "starting runner (ephemeral — processes one job then exits)"
exec env -u GITHUB_PAT -u REGISTRATION_TOKEN_API_URL -u REMOVE_TOKEN_API_URL \
     RUNNER_REMOVE_TOKEN="${REMOVE_TOKEN}" \
     RUNNER_NAME="${RUNNER_NAME}" \
     bash -c '
       cleanup() {
         rc=$?
         if [ -n "${RUNNER_REMOVE_TOKEN:-}" ]; then
           ./config.sh remove --token "${RUNNER_REMOVE_TOKEN}" >/dev/null 2>&1 || true
         fi
         exit "${rc}"
       }
       trap cleanup INT TERM EXIT
       ./run.sh
     '
