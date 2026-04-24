#!/usr/bin/env bash
# lint-vertical.sh - conformance lint for a CSA-in-a-Box vertical.
#
# Verifies a vertical under examples/<slug>/ matches the required structure
# and catches the CSA-0089 regression (sources: must live in
# models/schema.yml, NOT in dbt_project.yml).
#
# Usage:
#   bash scripts/lint-vertical.sh examples/noaa
#   bash scripts/lint-vertical.sh examples/iot-streaming
#   bash scripts/lint-vertical.sh examples/*    # lint all verticals
#
# Exit codes:
#   0  conformant
#   1  one or more violations (details printed to stdout)
#   2  usage error
#
# Required checks:
#   - README.md exists with required sections
#   - domains/dbt/dbt_project.yml exists
#   - NO top-level `sources:` block in dbt_project.yml (CSA-0089)
#   - deploy/bicep/ exists
#   - contracts/ exists
#   - Any generator generate_*.py supports --seed

set -uo pipefail

# --- Required sections in README.md (one of the aliases per row must match) ---
# Matches both plain "## Architecture" and decorated "## Architecture Overview"
# plus emoji-prefixed variants. Order-independent.
REQUIRED_SECTIONS=(
    "Architecture"
    "Directory Structure"
    "Deployment|Quick Start|Getting Started"
    "Related Documentation|Related|Acknowledgments|License"
)

# Streaming Patterns section: required when the vertical includes streaming;
# we treat it as optional but warn when absent (noaa has it inside README,
# iot-streaming has it explicitly).
OPTIONAL_SECTIONS=(
    "Streaming Patterns|Real-Time|Streaming Architecture|Streaming Quick Start"
)

usage() {
    cat >&2 <<EOF
Usage: $0 <path-to-vertical> [<path-to-vertical> ...]

Example:
    $0 examples/noaa
    $0 examples/*
EOF
    exit 2
}

if [[ $# -lt 1 ]]; then
    usage
fi

violations_total=0
verticals_total=0

lint_vertical() {
    local dir="$1"
    local name
    name="$(basename "${dir}")"
    local violations=0

    echo ""
    echo "==> Linting: ${dir}"

    if [[ ! -d "${dir}" ]]; then
        # Caller may have passed examples/* which expands to include
        # README.md and other files at examples/ root. Self-skip non-dirs.
        return 0
    fi

    # Skip non-vertical helpers like README.md at the examples/ root, plus
    # tutorial-style examples (ai-agents/, data-api-builder/, geoanalytics/,
    # streaming/) that ship as single-purpose scripts rather than full data
    # products. A "full vertical" must have a domains/ tree; without it the
    # conformance bar (dbt project layout, deployable bicep) does not apply.
    if [[ ! -d "${dir}/domains" ]]; then
        echo "  SKIP: not a full vertical (no domains/ tree)"
        return 0
    fi

    # 1. README.md exists + required sections
    local readme="${dir}/README.md"
    if [[ ! -f "${readme}" ]]; then
        echo "  FAIL: README.md is missing"
        violations=$((violations + 1))
    else
        for section_aliases in "${REQUIRED_SECTIONS[@]}"; do
            local found=0
            IFS='|' read -ra aliases <<< "${section_aliases}"
            for alias in "${aliases[@]}"; do
                if grep -E -q "^#{1,6}[[:space:]].*${alias}" "${readme}"; then
                    found=1
                    break
                fi
            done
            if [[ ${found} -eq 0 ]]; then
                echo "  FAIL: README.md missing a section heading matching '${section_aliases}'"
                violations=$((violations + 1))
            fi
        done
        for section_aliases in "${OPTIONAL_SECTIONS[@]}"; do
            local found=0
            IFS='|' read -ra aliases <<< "${section_aliases}"
            for alias in "${aliases[@]}"; do
                if grep -E -q "^#{1,6}[[:space:]].*${alias}" "${readme}"; then
                    found=1
                    break
                fi
            done
            if [[ ${found} -eq 0 ]]; then
                echo "  WARN: README.md has no '${section_aliases}' section (optional)"
            fi
        done
    fi

    # 2. domains/dbt/dbt_project.yml exists  (only required when the vertical
    #    actually has a domains/dbt/ tree — cybersecurity-style verticals run
    #    on Sentinel + KQL with bronze/silver/gold folders and no dbt).
    local dbt_project="${dir}/domains/dbt/dbt_project.yml"
    if [[ -d "${dir}/domains/dbt" ]]; then
        if [[ ! -f "${dbt_project}" ]]; then
            echo "  FAIL: domains/dbt/dbt_project.yml is missing"
            violations=$((violations + 1))
        else
            # 3. No top-level sources: block (CSA-0089).
            # Accept lines like "  sources:" inside `vars:` or as keys of other
            # sections. Match only a true top-level `sources:` at column 0.
            if grep -E -q '^sources:' "${dbt_project}"; then
                echo "  FAIL: dbt_project.yml contains a top-level 'sources:' block (CSA-0089)"
                echo "         sources belong in models/schema.yml, not dbt_project.yml"
                violations=$((violations + 1))
            fi
        fi
    else
        echo "  WARN: no domains/dbt/ tree (vertical does not use dbt) — skipping dbt_project.yml check"
    fi

    # 4. Vertical must be deployable. Either:
    #      - the vertical ships its own .bicep templates anywhere under deploy/,
    #      - OR deploy/ contains parameter files (params.*.json) that target
    #        the shared platform template at deploy/bicep/DLZ/main.bicep.
    #    Documentation-only verticals are not allowed.
    if [[ ! -d "${dir}/deploy" ]]; then
        echo "  FAIL: deploy/ directory is missing"
        violations=$((violations + 1))
    else
        local has_bicep
        has_bicep=$(find "${dir}/deploy" -type f -name "*.bicep" -print -quit)
        local has_params
        has_params=$(find "${dir}/deploy" -maxdepth 2 -type f -name "params.*.json" -print -quit)
        if [[ -z "${has_bicep}" && -z "${has_params}" ]]; then
            echo "  FAIL: deploy/ has no .bicep templates and no params.*.json (vertical is not deployable)"
            violations=$((violations + 1))
        fi
    fi

    # 5. contracts/ exists (and has at least one YAML).  Required for
    #    verticals that publish dbt sources/schemas; advisory for streaming-
    #    only or notebook-only verticals.
    if [[ ! -d "${dir}/contracts" ]]; then
        if [[ -d "${dir}/domains/dbt" ]]; then
            echo "  FAIL: contracts/ directory is missing (required when domains/dbt/ is present)"
            violations=$((violations + 1))
        else
            echo "  WARN: contracts/ directory is missing (advisory — no dbt domain present)"
        fi
    else
        if ! find "${dir}/contracts" -maxdepth 2 -type f \( -name "*.yaml" -o -name "*.yml" \) | grep -q .; then
            echo "  FAIL: contracts/ has no .yaml/.yml files"
            violations=$((violations + 1))
        fi
    fi

    # 6. Every generator generate_*.py must support --seed.
    #    Strategy: grep for a '--seed' argparse argument.  The exit status
    #    of grep is non-zero when there is no match, so we short-circuit.
    local gens=()
    if [[ -d "${dir}/data/generators" ]]; then
        while IFS= read -r -d '' f; do
            gens+=("$f")
        done < <(find "${dir}/data/generators" -maxdepth 2 -type f -name "generate_*.py" -print0)
    fi
    for gen in "${gens[@]}"; do
        if ! grep -E -q '"--seed"|'\''--seed'\''' "${gen}"; then
            echo "  FAIL: ${gen} does not expose a --seed CLI flag"
            violations=$((violations + 1))
        fi
    done

    if [[ ${violations} -eq 0 ]]; then
        echo "  PASS"
    else
        echo "  ${violations} violation(s)"
    fi

    return $violations
}

for target in "$@"; do
    # Handle glob expansion: caller may pass examples/* and include README.md
    # at the root.  lint_vertical() self-skips those.
    lint_vertical "${target}"
    v=$?
    verticals_total=$((verticals_total + 1))
    violations_total=$((violations_total + v))
done

echo ""
echo "============================================================"
echo "Summary: ${verticals_total} target(s), ${violations_total} violation(s)"
echo "============================================================"

if [[ ${violations_total} -gt 0 ]]; then
    exit 1
fi
exit 0
