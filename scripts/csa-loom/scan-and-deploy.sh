#!/usr/bin/env bash
# =====================================================================
# CSA Loom — pre-deploy scan-and-choose orchestrator (PRP deploy-readiness)
# =====================================================================
# A single push-button entry that, for each Loom-integrable backend, SCANS the
# target subscription(s) for existing instances, then asks the operator to:
#   use-existing / provision-new / disable — with a RECOMMENDATION.
# The chosen wiring is emitted to a generated .bicepparam override file and then
# `az deployment sub create` is run (unless --emit-only).
#
# Default posture = everything ON (opt-out). `--defaults` skips all prompts and
# provisions the full stack new (everything-new + signed-in user as bootstrap
# admin + new session secret).
#
# This orchestrator is intentionally MODULAR: every domain contributes a file
# under scripts/csa-loom/scan-modules/<domain>.sh exposing a `scan_<domain>`
# function. New domains drop in a module without touching this file (keeps the
# multi-agent build merge-friendly).
#
# Usage:
#   scan-and-deploy.sh [--defaults] [--emit-only] [--sub <id>] [--out <file>]
# =====================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULES_DIR="${HERE}/scan-modules"

DEFAULTS=0
EMIT_ONLY=0
SUB="${LOOM_SUBSCRIPTION_ID:-}"
OUT="${HERE}/../../platform/fiab/bicep/params/_generated.scan.bicepparam"

while [ $# -gt 0 ]; do
  case "$1" in
    --defaults) DEFAULTS=1 ;;
    --emit-only) EMIT_ONLY=1 ;;
    --sub) SUB="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

export LOOM_SCAN_DEFAULTS="${DEFAULTS}"
export LOOM_SCAN_SUB="${SUB}"

# Accumulator file the modules append `param x = y` lines to.
PARAM_OUT="$(mktemp)"
export LOOM_SCAN_PARAM_OUT="${PARAM_OUT}"
trap 'rm -f "${PARAM_OUT}"' EXIT

# Shared prompt helper: scan_choice <label> <recommendation:existing|new|disable>
# Echoes the chosen mode on stdout. Honors --defaults (always the recommendation,
# or "new" when the recommendation is empty).
scan_choice() {
  local label="$1" rec="${2:-new}"
  if [ "${LOOM_SCAN_DEFAULTS}" = "1" ]; then echo "${rec}"; return; fi
  echo "  ${label} — [e]xisting / [n]ew / [d]isable (recommended: ${rec})" >&2
  read -r -p "  choice [${rec}]: " ans </dev/tty || ans=""
  case "${ans:-}" in
    e|existing) echo existing ;;
    n|new) echo new ;;
    d|disable) echo disable ;;
    "") echo "${rec}" ;;
    *) echo "${rec}" ;;
  esac
}
export -f scan_choice

echo "==> CSA Loom scan-and-deploy (sub=${SUB:-<default>}, defaults=${DEFAULTS})"

# Source + run every domain module's scan_* function.
if [ -d "${MODULES_DIR}" ]; then
  for m in "${MODULES_DIR}"/*.sh; do
    [ -e "$m" ] || continue
    # shellcheck disable=SC1090
    source "$m"
  done
  # Each module defines a function named scan_<domain>; run all of them.
  while read -r fn; do
    echo "==> ${fn}"
    "${fn}" || echo "  WARN: ${fn} reported an issue (continuing)"
  done < <(declare -F | awk '{print $3}' | grep '^scan_' || true)
else
  echo "  no scan-modules/ directory found — nothing to scan" >&2
fi

cat "${PARAM_OUT}" > "${OUT}"
echo "==> Wrote chosen wiring to ${OUT}"
echo "----------------------------------------"
cat "${OUT}"
echo "----------------------------------------"

if [ "${EMIT_ONLY}" = "1" ]; then
  echo "==> --emit-only: skipping az deployment sub create"
  exit 0
fi

echo "==> Run: az deployment sub create -l <region> -f platform/fiab/bicep/main.bicep -p ${OUT}"
echo "    (review the generated params above first; re-run with --emit-only to only emit)"
