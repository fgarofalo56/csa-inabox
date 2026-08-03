#!/usr/bin/env bash
# =============================================================================
# acr-firewall-sweep-all.sh — discover this subscription's Loom ACRs and sweep
# each one's firewall lease (#2603, #2836).
# =============================================================================
#
# This is the DISCOVERY half of .github/workflows/acr-firewall-sweeper.yml. It
# used to be inline YAML in two near-identical jobs (Commercial + Gov), which
# meant it could not be tested — and it was wrong (#2836):
#
#   RG=$(az group list --query ... -o tsv)   # under `set -uo pipefail`, no -e
#   if [[ -z "$RG" ]]; then
#     echo "::notice::... nothing to sweep."; exit 0
#   fi
#
# An `az` that FAILS (expired token, ARM throttling, transient 5xx) leaves $RG
# empty, so the failure took the same branch as a genuinely empty subscription
# and the scheduled run went GREEN. The identical hole sat one line below: if
# `az acr list` failed, the `for` iterated zero times, RC stayed 0, exit 0.
#
# That is the worst shape a security control can have. The sweeper is the ONLY
# thing that re-locks a registry whose lease holder crashed; a credential
# problem that breaks these `az` calls is also a plausible cause of the crash
# that left the registry open. Failing silently in exactly that correlated case
# leaves an ACR holding every Loom app image publicly reachable, indefinitely,
# with no alarm.
#
# So: this script NEVER infers "absent" from an empty string. Every `az` call
# has its exit status captured and its stderr surfaced. Only rc=0 WITH empty
# output may be read as "nothing here", and even then only for the resource
# group — an admin RG with zero acrloom* registries is a discovery bug, not an
# empty estate (admin-plane/registry.bicep puts the registry in that RG), and
# console-bluegreen-roll.yml already makes that same call.
#
# Usage:
#   scripts/csa-loom/acr-firewall-sweep-all.sh [--force] [--subscription <sub>]
#                                              [--rg-prefix <p>] [--acr-prefix <p>]
#
# Exit codes:
#   0  swept every discovered registry successfully, OR there is no admin RG in
#      this subscription and `az` said so successfully
#   1  an `az` discovery call failed, discovery returned an impossible estate,
#      or at least one registry's sweep failed
#
# Regression test: scripts/ci/test-acr-firewall-sweep-all.sh (Loom Guardrails).
# Related: docs/fiab/acr-firewall-lease.md, scripts/csa-loom/acr-firewall-lease.sh
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEASE_SCRIPT="${SCRIPT_DIR}/acr-firewall-lease.sh"

RG_PREFIX="rg-csa-loom-admin"
ACR_PREFIX="acrloom"
SUBSCRIPTION=""
FORCE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --force)        FORCE="--force"; shift ;;
    --subscription) SUBSCRIPTION="${2:-}"; shift 2 ;;
    --rg-prefix)    RG_PREFIX="${2:-}"; shift 2 ;;
    --acr-prefix)   ACR_PREFIX="${2:-}"; shift 2 ;;
    -h|--help)      sed -n '2,45p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "::error::acr-firewall-sweep-all: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

_sub_args() {
  # Emit the --subscription pair only when one was supplied, so the caller's
  # logged-in default is used otherwise.
  SUB_ARGS=()
  if [ -n "$SUBSCRIPTION" ]; then SUB_ARGS=(--subscription "$SUBSCRIPTION"); fi
}

# Run an `az` query, capturing stdout, stderr and rc SEPARATELY. Returns az's
# rc; stdout lands in $AZ_OUT (CR-stripped), stderr in $AZ_ERR. This separation
# IS the fix for #2836 — inferring "absent" from an empty $(...) cannot tell a
# real empty answer from a failed call.
AZ_OUT=""
AZ_ERR=""
SUB_ARGS=()
_az_query() {
  local out="$WORK/az.out" err="$WORK/az.err" rc=0
  _sub_args
  az "$@" "${SUB_ARGS[@]+"${SUB_ARGS[@]}"}" -o tsv > "$out" 2> "$err" || rc=$?
  AZ_OUT="$(tr -d '\r' < "$out")"
  AZ_ERR="$(cat "$err")"
  return "$rc"
}

# ── 1. the admin resource group ──────────────────────────────────────────────
rc=0
_az_query group list --query "[?starts_with(name, '${RG_PREFIX}')] | [0].name" || rc=$?
if [ "$rc" -ne 0 ]; then
  echo "::error::acr-firewall-sweeper: 'az group list' FAILED (rc=${rc}) — the sweep did not run and NO registry was checked. A registry left open by a crashed build is still open. This is NOT 'nothing to sweep'."
  [ -n "$AZ_ERR" ] && printf '%s\n' "$AZ_ERR" >&2
  exit 1
fi

RG="$AZ_OUT"
if [ -z "$RG" ]; then
  # rc=0 AND empty: Azure answered, and the answer is that this subscription
  # holds no Loom admin resource group. That is the only legitimate way to
  # reach the "nothing to sweep" path.
  echo "::notice::No ${RG_PREFIX}* resource group in this subscription — nothing to sweep."
  exit 0
fi
echo "::notice::admin RG = ${RG}"

# ── 2. the registries inside it ──────────────────────────────────────────────
rc=0
_az_query acr list --resource-group "$RG" --query "[?starts_with(name,'${ACR_PREFIX}')].name" || rc=$?
if [ "$rc" -ne 0 ]; then
  echo "::error::acr-firewall-sweeper: 'az acr list -g ${RG}' FAILED (rc=${rc}) — the sweep did not run and NO registry was checked. A registry left open by a crashed build is still open."
  [ -n "$AZ_ERR" ] && printf '%s\n' "$AZ_ERR" >&2
  exit 1
fi

if [ -z "$AZ_OUT" ]; then
  # An admin RG exists, so this estate has been deployed, but it reports zero
  # ${ACR_PREFIX}* registries. admin-plane/registry.bicep creates the registry
  # in this very RG, so that combination means discovery is looking in the
  # wrong place (renamed registry, wrong subscription, half-finished infra
  # phase) — NOT that there is nothing to protect. Exiting 0 here would be the
  # #2836 bug in a different costume: a green run that swept nothing.
  echo "::error::acr-firewall-sweeper: admin RG '${RG}' exists but holds NO ${ACR_PREFIX}* registry. Either the infra phase has not finished (deployAppsEnabled=false run), or registry discovery is pointed at the wrong subscription. The sweeper protected NOTHING this run — treat any open registry as unswept."
  exit 1
fi

# ── 3. sweep each ────────────────────────────────────────────────────────────
RC=0
SWEPT=0
while IFS= read -r ACR; do
  [ -n "$ACR" ] || continue
  SWEPT=$((SWEPT + 1))
  # shellcheck disable=SC2086 — $FORCE is a single literal flag or empty.
  # stdin is closed for the child: the loop is fed by a herestring, and any
  # child that read stdin would silently swallow the remaining registries.
  if ! bash "$LEASE_SCRIPT" sweep --acr "$ACR" \
        ${SUBSCRIPTION:+--subscription "$SUBSCRIPTION"} $FORCE < /dev/null; then
    echo "::error::acr-firewall-sweeper: sweep FAILED for registry '${ACR}' — it may still be publicly reachable."
    RC=1
  fi
done <<< "$AZ_OUT"

echo "::notice::acr-firewall-sweeper: examined ${SWEPT} registry/registries in ${RG}."
exit "$RC"
