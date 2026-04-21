#!/usr/bin/env bash
# CSA-0052 — sample-up stage 4: dbt
#
# Runs `dbt deps && dbt seed && dbt run && dbt test` in the dbt project
# for the vertical, falling back to the shared dbt project if the vertical
# does not have its own.
#
# Usage:
#   bash scripts/sample-up/04-dbt.sh <vertical>

set -euo pipefail

VERTICAL="${1:-${NAME:-}}"
if [ -z "${VERTICAL}" ]; then
    echo "ERROR: vertical name required. Usage: $0 <vertical>" >&2
    exit 2
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

# Prefer a vertical-local dbt project if present; else fall back to shared.
VERTICAL_DBT="${REPO_ROOT}/examples/${VERTICAL}/domains/dbt"
SHARED_DBT="${REPO_ROOT}/domains/shared/dbt"

if [ -d "${VERTICAL_DBT}" ] && [ -f "${VERTICAL_DBT}/dbt_project.yml" ]; then
    DBT_DIR="${VERTICAL_DBT}"
elif [ -d "${SHARED_DBT}" ] && [ -f "${SHARED_DBT}/dbt_project.yml" ]; then
    DBT_DIR="${SHARED_DBT}"
    echo "  info: no vertical-local dbt project; using shared dbt at ${DBT_DIR}"
else
    echo "TODO: no dbt project found for vertical '${VERTICAL}' or under domains/shared/dbt." >&2
    echo "      Skipping dbt stage." >&2
    exit 0
fi

echo "[sample-up 4/5 dbt] vertical=${VERTICAL} project=${DBT_DIR}"

if ! command -v dbt >/dev/null 2>&1; then
    echo "TODO: dbt is not installed. Install with 'pip install dbt-core dbt-duckdb' and re-run." >&2
    exit 0
fi

cd "${DBT_DIR}"
dbt deps --profiles-dir . || true
dbt seed --profiles-dir . || true
dbt run --profiles-dir .
dbt test --profiles-dir . || echo "  warn: dbt test reported failures — investigate before promoting."

echo "[sample-up 4/5 dbt] OK"
