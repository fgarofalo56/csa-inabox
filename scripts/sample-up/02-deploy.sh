#!/usr/bin/env bash
# CSA-0052 — sample-up stage 2: deploy
#
# Delegates to scripts/deploy/deploy-platform.sh. Defaults to --dry-run so
# `make sample-up` never spends money by accident. Pass FULL_DEPLOY=1 to
# run a real deploy against the dev subscription.
#
# Usage:
#   bash scripts/sample-up/02-deploy.sh <vertical>
#   FULL_DEPLOY=1 bash scripts/sample-up/02-deploy.sh <vertical>

set -euo pipefail

VERTICAL="${1:-${NAME:-}}"
if [ -z "${VERTICAL}" ]; then
    echo "ERROR: vertical name required. Usage: $0 <vertical>" >&2
    exit 2
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ENVIRONMENT="${ENVIRONMENT:-dev}"
FULL_DEPLOY="${FULL_DEPLOY:-0}"
DEPLOY_SCRIPT="${REPO_ROOT}/scripts/deploy/deploy-platform.sh"

echo "[sample-up 2/5 deploy] vertical=${VERTICAL} env=${ENVIRONMENT} full=${FULL_DEPLOY}"

if [ ! -f "${DEPLOY_SCRIPT}" ]; then
    echo "TODO: ${DEPLOY_SCRIPT} is missing. Once implemented, this stage" >&2
    echo "      will call it with --environment ${ENVIRONMENT}." >&2
    echo "      Skipping for now so sample-up can proceed to seed/dbt." >&2
    exit 0
fi

if [ "${FULL_DEPLOY}" = "1" ]; then
    bash "${DEPLOY_SCRIPT}" --environment "${ENVIRONMENT}"
else
    bash "${DEPLOY_SCRIPT}" --environment "${ENVIRONMENT}" --dry-run
fi

echo "[sample-up 2/5 deploy] OK"
