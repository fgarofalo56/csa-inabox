#!/usr/bin/env bash
# CSA-0052 — sample-up stage 1: validate
#
# Confirms that examples/<vertical>/ exists and has the minimum expected
# layout. No Azure calls. Safe to run repeatedly.
#
# Usage:
#   bash scripts/sample-up/01-validate.sh <vertical>

set -euo pipefail

VERTICAL="${1:-${NAME:-}}"
if [ -z "${VERTICAL}" ]; then
    echo "ERROR: vertical name required. Usage: $0 <vertical>" >&2
    exit 2
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
EXAMPLE_DIR="${REPO_ROOT}/examples/${VERTICAL}"

echo "[sample-up 1/5 validate] vertical=${VERTICAL}"

if [ ! -d "${EXAMPLE_DIR}" ]; then
    echo "ERROR: examples/${VERTICAL}/ does not exist. Known examples:" >&2
    ls -1 "${REPO_ROOT}/examples/" 2>/dev/null | grep -v '^README' || true
    exit 1
fi

MISSING=0
for required in README.md; do
    if [ ! -f "${EXAMPLE_DIR}/${required}" ]; then
        echo "ERROR: missing ${EXAMPLE_DIR}/${required}" >&2
        MISSING=1
    fi
done

# Soft warnings — not fatal, but surfaced so the operator sees them.
for optional in params.dev.json domains data; do
    if [ ! -e "${EXAMPLE_DIR}/${optional}" ]; then
        echo "  warn: no ${optional} in ${EXAMPLE_DIR}/ (continuing)"
    fi
done

if [ "${MISSING}" -ne 0 ]; then
    exit 1
fi

echo "[sample-up 1/5 validate] OK"
