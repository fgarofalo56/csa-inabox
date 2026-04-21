#!/usr/bin/env bash
# new-vertical.sh - scaffold a new CSA-in-a-Box vertical from the
# cookiecutter template at templates/example-vertical/.
#
# Usage:
#   bash scripts/new-vertical.sh                # interactive
#   bash scripts/new-vertical.sh --no-input \   # non-interactive
#       vertical_slug=my-vertical vertical_name="My Vertical" ...
#
# The resulting vertical lands in examples/<slug>/ and is immediately
# lintable with scripts/lint-vertical.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TEMPLATE_DIR="${REPO_ROOT}/templates/example-vertical"
OUTPUT_DIR="${REPO_ROOT}/examples"

if [[ ! -d "${TEMPLATE_DIR}" ]]; then
    echo "ERROR: template not found at ${TEMPLATE_DIR}" >&2
    exit 1
fi

if ! command -v cookiecutter >/dev/null 2>&1; then
    echo "ERROR: 'cookiecutter' is not installed." >&2
    echo "  Install it first:  pip install 'cookiecutter>=2.6.0,<3.0.0'" >&2
    echo "  Or install the repo dev extras:  pip install -e \".[dev]\"" >&2
    exit 2
fi

echo "Scaffolding a new vertical from ${TEMPLATE_DIR}"
echo "Output directory:  ${OUTPUT_DIR}"
echo ""

# Forward any extra args (e.g. --no-input vertical_slug=... ) to cookiecutter.
cookiecutter "${TEMPLATE_DIR}" -o "${OUTPUT_DIR}" "$@"

echo ""
echo "Scaffold complete."
echo ""
echo "Next steps:"
echo "  1. cd examples/<your-slug>"
echo "  2. Review README.md, ARCHITECTURE.md, and contracts/*.yaml."
echo "  3. Run the lint:  bash scripts/lint-vertical.sh examples/<your-slug>"
echo "  4. Run the generator tests:"
echo "       python -m pytest examples/<your-slug>/data/generators/tests/ -v"
echo "  5. Parse the dbt project:  (cd examples/<your-slug>/domains/dbt && dbt parse)"
echo ""
echo "Then commit the new vertical and open a PR."
