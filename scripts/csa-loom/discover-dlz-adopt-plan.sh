#!/usr/bin/env bash
# discover-dlz-adopt-plan.sh — turn a resolved DLZ into an ADOPT plan.
#
# WHY (auto-bind-by-default.md §5, deploy-integrity.md R5)
# --------------------------------------------------------
# `main.bicep` used to derive the lake account name from the single-sub
# convention alone:
#
#     loomStorageAccount: useSingleDlz ? take('saloomdefault…',24) : ''
#
# On a MULTI-SUB / dlz-attach estate `useSingleDlz` is false, so it passed ''.
# Measured on Commercial 2026-08-10: the lake `saloomdefaulttr4nm4dcgsq` was
# fully deployed in the DLZ subscription — next to Databricks, Event Hubs,
# Synapse and the Weave Postgres — while LOOM_ADLS_ACCOUNT rendered EMPTY, so
# svc-adls, medallion Silver/Gold, sample-data, RTI-export, CSV-imports and the
# S3 gateway were all hard-blocked on an estate that owned every resource they
# needed. The documented workaround was `patch-navigator-env.sh` AFTER the
# deploy — a manual step the NEXT deploy then reverted, because a bicep deploy
# re-renders the container app's env array and drops anything not in the
# template. That is the same mechanism that blanked the bootstrap admin OID.
#
# This script closes it at the source: DISCOVER what the estate already owns and
# emit it as an `adopt` plan, so the deploy BINDS to it. Adopt, never duplicate.
#
# WHAT IT DOES NOT DO
#   - It never CREATES anything and never grants anything.
#   - It never invents a name. A service it cannot find is simply absent from the
#     plan, and `adoptMode()` then defaults that key to 'create' exactly as before
#     — so a greenfield estate is completely unaffected by this script existing.
#   - It does not decide whether grants may run. main.bicep derives
#     `loomStorageAccountSameSub` from the plan's `sub`, and the grant modules
#     gate on that: binding is safe cross-subscription, RBAC is not.
#
# OUTPUT: one line of compact JSON on stdout, suitable for LOOM_ADOPT_JSON.
# Emits `{}` — never a partial or malformed document — when nothing is found.
#
# Usage:
#   discover-dlz-adopt-plan.sh --dlz-subscription <id> --dlz-rg <name> [--admin-subscription <id>]
set -euo pipefail

DLZ_SUB=""; DLZ_RG=""; ADMIN_SUB=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dlz-subscription) DLZ_SUB="${2:-}"; shift 2 ;;
    --dlz-rg)           DLZ_RG="${2:-}"; shift 2 ;;
    --admin-subscription) ADMIN_SUB="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$DLZ_SUB" ] || [ -z "$DLZ_RG" ]; then
  # Not an error: the caller may have no DLZ yet (greenfield/tenant first run).
  echo "[discover-dlz-adopt] no DLZ coordinates supplied — emitting an empty plan" >&2
  echo '{}'
  exit 0
fi

# A resource group that does not exist is a legitimate answer ("no DLZ yet"),
# NOT a failure — but an UNREADABLE one is different and must not be silently
# reported as absent (deploy-integrity R7, and the unknown-as-negative class).
RG_ERR="$(mktemp)"
if ! az group show -n "$DLZ_RG" --subscription "$DLZ_SUB" -o none 2>"$RG_ERR"; then
  if grep -qiE "ResourceGroupNotFound|could not be found" "$RG_ERR"; then
    echo "[discover-dlz-adopt] DLZ RG '$DLZ_RG' does not exist in that subscription — empty plan" >&2
    echo '{}'
    exit 0
  fi
  echo "::warning::[discover-dlz-adopt] could NOT read DLZ RG '$DLZ_RG' — this is UNKNOWN, not 'no DLZ'. Adoption is skipped for this run and the deploy will fall back to its create/convention path. az stderr:" >&2
  sed 's/^/  /' "$RG_ERR" >&2 || true
  echo '{}'
  exit 0
fi

# Every lookup is best-effort and independent: one service being absent must not
# suppress the others.
q() { az "$@" 2>/dev/null | tr -d '\r' || true; }

SA="$(q storage account list --subscription "$DLZ_SUB" -g "$DLZ_RG" --query "[?isHnsEnabled]|[0].name" -o tsv)"
EH="$(q eventhubs namespace list --subscription "$DLZ_SUB" -g "$DLZ_RG" --query "[0].name" -o tsv)"
SYN="$(q synapse workspace list --subscription "$DLZ_SUB" -g "$DLZ_RG" --query "[0].name" -o tsv)"
DBX_N="$(q databricks workspace list --subscription "$DLZ_SUB" -g "$DLZ_RG" --query "[0].name" -o tsv)"
DBX_H="$(q databricks workspace list --subscription "$DLZ_SUB" -g "$DLZ_RG" --query "[0].workspaceUrl" -o tsv)"

entries=""
add() { # add <key> <name> [extraJson]
  [ -n "${2:-}" ] || return 0
  local extra="${3:-}"
  local one
  one="$(printf '"%s":{"mode":"adopt","target":{"name":"%s","rg":"%s","sub":"%s"}%s}' \
        "$1" "$2" "$DLZ_RG" "$DLZ_SUB" "${extra:+,\"extra\":$extra}")"
  entries="${entries:+$entries,}$one"
  echo "[discover-dlz-adopt] adopt $1 = $2" >&2
}

add "storage-adls" "$SA"
add "eventhubs"    "$EH"
add "synapse"      "$SYN"
add "databricks"   "$DBX_N" "${DBX_H:+{\"hostname\":\"$DBX_H\"}}"

if [ -z "$entries" ]; then
  echo "[discover-dlz-adopt] DLZ RG exists but held none of the adoptable services — empty plan" >&2
  echo '{}'
  exit 0
fi

PLAN="{$entries}"
# Never emit a document the param file cannot parse: a malformed plan would take
# `json()` down inside bicep compilation and fail the whole deploy.
if command -v python >/dev/null 2>&1; then
  printf '%s' "$PLAN" | python -c 'import json,sys; json.load(sys.stdin)' \
    || { echo "::error::[discover-dlz-adopt] composed an INVALID adopt plan — refusing to emit it"; exit 1; }
fi
printf '%s\n' "$PLAN"
