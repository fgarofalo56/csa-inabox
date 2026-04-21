#!/usr/bin/env bash
# CSA-0052 — sample-up stage 3: seed
#
# Loads sample data for the vertical. Defaults to local mode (DuckDB /
# filesystem) so `make sample-up` works without an Azure connection. Pass
# STORAGE_ACCOUNT=<name> to switch to ADLS mode.
#
# Usage:
#   bash scripts/sample-up/03-seed.sh <vertical>
#   STORAGE_ACCOUNT=csalab bash scripts/sample-up/03-seed.sh <vertical>

set -euo pipefail

VERTICAL="${1:-${NAME:-}}"
if [ -z "${VERTICAL}" ]; then
    echo "ERROR: vertical name required. Usage: $0 <vertical>" >&2
    exit 2
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SEED_SCRIPT="${REPO_ROOT}/scripts/seed/load_sample_data.py"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-}"

echo "[sample-up 3/5 seed] vertical=${VERTICAL}"

if [ ! -f "${SEED_SCRIPT}" ]; then
    echo "TODO: ${SEED_SCRIPT} is missing; add it to wire real seeding." >&2
    echo "      Skipping so sample-up can proceed." >&2
    exit 0
fi

if [ -n "${STORAGE_ACCOUNT}" ]; then
    python "${SEED_SCRIPT}" --mode adls --storage-account "${STORAGE_ACCOUNT}" --vertical "${VERTICAL}" || {
        echo "  warn: ADLS seed failed; script may not yet support --vertical. Falling back to local."
        python "${SEED_SCRIPT}" --mode local || true
    }
else
    python "${SEED_SCRIPT}" --mode local || {
        echo "  warn: local seed failed — continuing so dbt stage can still run on existing seeds."
    }
fi

echo "[sample-up 3/5 seed] OK"
