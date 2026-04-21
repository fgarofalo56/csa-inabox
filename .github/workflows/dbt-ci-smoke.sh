#!/usr/bin/env bash
# Local smoke test for .github/workflows/dbt-ci.yml
#
# Mirrors what the CI workflow does for a single dbt project so developers
# can reproduce failures on their workstation. Runs `dbt deps`, `dbt parse`,
# and `dbt compile` against an offline DuckDB stub profile.
#
# Usage:
#   bash .github/workflows/dbt-ci-smoke.sh                       # default: iot-streaming
#   bash .github/workflows/dbt-ci-smoke.sh domains/finance/dbt   # any project
#
# Requirements:
#   - Python 3.12
#   - pip install "dbt-core>=1.7,<2.0" "dbt-duckdb>=1.7,<2.0"
#     (databricks/spark adapters are optional for local smoke tests)
#
# Exit codes:
#   0  success
#   2  missing dependency (dbt not installed) — skipped with a message
#   non-zero otherwise  parse/compile failed

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="${1:-examples/iot-streaming/domains/dbt}"
PROFILES_DIR="$REPO_ROOT/.dbt-ci-smoke"

cd "$REPO_ROOT"

if [ ! -f "$PROJECT/dbt_project.yml" ]; then
  echo "ERROR: $PROJECT/dbt_project.yml not found." >&2
  echo "Run from repo root; pass a valid dbt project path as the first arg." >&2
  exit 1
fi

if ! command -v dbt >/dev/null 2>&1; then
  cat >&2 <<EOF
SKIP: dbt is not installed in this environment.
To install:
  pip install "dbt-core>=1.7,<2.0" "dbt-duckdb>=1.7,<2.0"
Then re-run:
  bash .github/workflows/dbt-ci-smoke.sh $PROJECT
EOF
  exit 2
fi

echo "==> dbt version"
dbt --version || true

echo "==> Writing stub profiles.yml to $PROFILES_DIR"
mkdir -p "$PROFILES_DIR"
cat > "$PROFILES_DIR/profiles.yml" <<'PROFILES'
csa_analytics: &ci_duckdb
  target: ci
  outputs:
    ci:
      type: duckdb
      path: ":memory:"
      threads: 2
casino_analytics: *ci_duckdb
dot_analytics: *ci_duckdb
csa_iot_streaming: *ci_duckdb
tribal_health_analytics: *ci_duckdb
usps_analytics: *ci_duckdb
PROFILES

export DBT_PROFILES_DIR="$PROFILES_DIR"
export DBT_SEND_ANONYMOUS_USAGE_STATS="false"

cd "$PROJECT"

if [ -f packages.yml ] || [ -f dependencies.yml ]; then
  echo "==> dbt deps"
  dbt deps --profiles-dir "$PROFILES_DIR"
else
  echo "==> No packages.yml — skipping dbt deps."
fi

echo "==> dbt parse"
dbt parse --profiles-dir "$PROFILES_DIR" --target ci

echo "==> dbt compile"
dbt compile --profiles-dir "$PROFILES_DIR" --target ci

echo ""
echo "OK: $PROJECT parsed and compiled cleanly."
