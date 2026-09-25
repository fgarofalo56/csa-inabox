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
#   discover-dlz-adopt-plan.sh --dlz-subscription <id> --dlz-rg <name> \
#                              [--admin-subscription <id>] [--admin-rg <name>]
#
# The admin coordinates are OPTIONAL and are used only as a FALLBACK for the two
# deploy-planner services that can legitimately sit outside the landing zone —
# see the `#4665` block near the bottom. Supplying them never changes a lookup
# the DLZ already answered.
set -euo pipefail

DLZ_SUB=""; DLZ_RG=""; ADMIN_SUB=""; ADMIN_RG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dlz-subscription) DLZ_SUB="${2:-}"; shift 2 ;;
    --dlz-rg)           DLZ_RG="${2:-}"; shift 2 ;;
    --admin-subscription) ADMIN_SUB="${2:-}"; shift 2 ;;
    --admin-rg)         ADMIN_RG="${2:-}"; shift 2 ;;
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
# Azure Data Factory. Read through `az resource list` rather than `az datafactory
# list` on purpose: `datafactory` is an az EXTENSION, and a lookup that needs one
# installed would silently return nothing on a runner that lacks it — the same
# unknown-reported-as-absent shape the header refuses.
#
# WHY THIS ENTRY WAS MISSING, AND WHAT IT COST (auto-bind-by-default.md §5).
# The four lookups above adopt the DLZ's lake, Event Hubs, Synapse and
# Databricks. The factory sits in the SAME resource group and was not adopted.
# Measured ON THIS TREE (not on any live estate — this note asserts only what the
# code establishes): with `adopt.adf` absent, main.bicep's `existingAdfFactory`
# is '' and admin-plane/main.bicep falls through to
#   effAdfName = deAdfEnabled ? loomAdfName : ''    // 'adf-loom-default-<region>'
#   effAdfRg   = loomAdfRg || loomDlzRg             // the ADMIN rg on tenant
#   byoAdfSub  = subscription().subscriptionId      // the ADMIN sub
# On a `topology='tenant'` estate no landing zone is deployed by that run, so
# those three coordinates name a factory this deployment did not create, in a
# resource group and subscription it is not in. Two consequences:
#   1. LOOM_ADF_NAME / _RG / _SUB address the wrong place on any estate whose
#      factory lives in a separately-deployed landing zone;
#   2. main.bicep cannot grant that factory ANYTHING, because it does not know
#      which factory it is — so `adf-keyvault-rbac.bicep` (the Key Vault Secrets
#      User grant every Snowflake mirror needs to read its credential) had no
#      reachable call site on any shipped boundary at all.
# Adopting the factory here is what makes `main.bicep`'s `adoptedAdfKeyVaultRbac`
# reachable with the checked-in param files.
ADF="$(q resource list --subscription "$DLZ_SUB" -g "$DLZ_RG" --resource-type Microsoft.DataFactory/factories --query "[0].name" -o tsv)"
# Service Bus namespace + Azure Batch account (#3317). Both are read by
# RESOURCE TYPE, never by a derived name, and that distinction is the whole
# point of these two entries.
#
# WHY THEY WERE MISSING, AND WHAT IT COST (auto-bind-by-default.md §5).
# main.bicep derived both coordinates from the single-sub naming convention
# alone — `(useSingleDlz && deployServiceBus) ? 'sbns-loom-default-<region>' : ''`
# and the matching `take('batchloom<hash>',24)` for Batch. `useSingleDlz` is
# `deployLandingZones && effectiveTopology == 'single-sub'`, and every shipped
# params file pins `topology='tenant'` (commercial, commercial-full, gcc,
# gcc-high, il5), so BOTH expressions evaluate to '' on every boundary Loom
# ships. LOOM_SERVICEBUS_NAMESPACE and LOOM_BATCH_ACCOUNT therefore rendered
# empty everywhere and svc-servicebus / svc-batch honest-gated on every cloud.
#
# Even on a `single-sub` estate the Service Bus convention would not have
# matched: deploy-planner/service-bus.bicep names its namespace
# `sb-loom-<uniqueString(rg.id)>`, not `sbns-loom-default-<region>`. A convention
# that two modules spell differently cannot be the binding mechanism — which is
# exactly why these are DISCOVERED, like the lake in #3327.
SB="$(q resource list --subscription "$DLZ_SUB" -g "$DLZ_RG" --resource-type Microsoft.ServiceBus/namespaces --query "[0].name" -o tsv)"
BATCH="$(q resource list --subscription "$DLZ_SUB" -g "$DLZ_RG" --resource-type Microsoft.Batch/batchAccounts --query "[0].name" -o tsv)"

# Where each adopted service was FOUND. Defaults to the DLZ for every lookup
# above; the #4665 fallback below overrides only the two it actually resolves.
SB_RG="$DLZ_RG";    SB_SUB="$DLZ_SUB"
BATCH_RG="$DLZ_RG"; BATCH_SUB="$DLZ_SUB"

# ── ADMIN-RG FALLBACK for Service Bus + Batch (#4665) ────────────────────────
#
# WHY. The two lookups above read the DLZ resource group, which is where a
# landing-zone deploy puts these. But deploy-planner/service-bus.bicep and
# deploy-planner/batch.bicep are ORDINARY resource-group-scoped modules: nothing
# stops an operator deploying them straight at the admin RG, and on the
# Commercial estate somebody did — `loom-servicebus-1784162471` and
# `loom-batch-1784162511`, both Succeeded 2026-07-16, both into
# rg-csa-loom-admin-centralus. Measured 2026-09-22: that estate owns
# `sb-loom-k6mvh5sm6z7do` (queue `loom-queue`, exactly what service-bus.bicep:56
# creates) and `batchloomk6mvh5sm6z7do`, while the DLZ resource group in the
# OTHER subscription holds neither — so discovery looked only where they were
# not, the plan omitted both keys, and LOOM_SERVICEBUS_NAMESPACE /
# LOOM_BATCH_ACCOUNT rendered '' with svc-servicebus and svc-batch honest-gating
# on an estate that owned both resources. Same shape as the #3327 lake and the
# #3317 entries above: the resource exists, the binding does not.
#
# This does NOT widen the other five lookups. The lake, Event Hubs, Synapse,
# Databricks and ADF belong to a landing zone by construction, and adopting an
# admin-RG namesake for any of them would bind the console to the wrong tier.
#
# PRECEDENCE: the DLZ always wins. This only fills a key the DLZ left empty.
#
# WHAT IT STILL DOES NOT COVER, stated rather than implied: this block sits after
# the DLZ-coordinate and RG-readability guards above, so it runs only when a DLZ
# resource group was resolved and read. An estate with NO landing zone at all
# never reaches here — and could not anyway, because all four deploy workflows
# call this script only inside `if [ -n "$DLZ_SUB" ] && [ -n "$DLZ_RG" ]`.
# Admin-RG-only resources on a landing-zone-less estate are therefore still
# unadopted. That is a real hole, deliberately left: closing it means relaxing a
# gate that also guards the fail-closed lake-binding backstop (#3701), which is
# a bigger change than the defect being fixed here warrants.
if [ -n "$ADMIN_SUB" ] && [ -n "$ADMIN_RG" ]; then
  # Unlike q(), this separates UNREADABLE from ABSENT. A subscription the deploy
  # identity cannot read must not render as "the estate does not have one" —
  # that is the unknown-as-negative shape this file's header refuses, and the
  # reason the lake has a fail-closed backstop in the calling workflow.
  admin_names() { # admin_names <resource-type> → names on stdout, rc 1 if unreadable
    local err out rc=0
    err="$(mktemp)"
    out="$(az resource list --subscription "$ADMIN_SUB" -g "$ADMIN_RG" \
             --resource-type "$1" --query "[].name" -o tsv 2>"$err")" || rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "::warning::[discover-dlz-adopt] could NOT read $1 in admin RG '$ADMIN_RG' — that is UNKNOWN, not 'absent'. Skipping the admin-RG fallback for it; the DLZ answer (empty) stands. az stderr:" >&2
      sed 's/^/  /' "$err" >&2 || true
      rm -f "$err"
      return 1
    fi
    rm -f "$err"
    printf '%s' "$out" | tr -d '\r' | sed '/^[[:space:]]*$/d'
  }

  # Exactly one candidate, or nothing. Picking `[0]` out of several would bind
  # the console to whichever namespace ARM happened to list first, which is a
  # coin flip dressed as a measurement.
  admin_pick() { # admin_pick <key> <candidates…> → the single name, or ''
    local key="$1"; shift
    local n; n="$(printf '%s\n' "$@" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
    if [ "$n" -eq 1 ]; then printf '%s' "$1"; return 0; fi
    if [ "$n" -gt 1 ]; then
      echo "::warning::[discover-dlz-adopt] admin RG '$ADMIN_RG' holds $n candidates for '$key' ($*) and the DLZ held none, so there is no unambiguous resource to adopt. Adopting NONE rather than guessing — set LOOM_ADOPT_JSON explicitly to name the intended one (an explicit plan always wins over discovery)." >&2
    fi
    return 0
  }

  if [ -z "$SB" ]; then
    if SB_CAND="$(admin_names Microsoft.ServiceBus/namespaces)"; then
      # admin-plane/aas.bicep ALSO creates a Service Bus namespace in this very
      # resource group — the direct-lake-shim's, named `sb-loom-dlshim-<region>`
      # (admin-plane/main.bicep:2223). It carries the shim's own queue and is not
      # what the svc-servicebus navigator binds, so it is excluded by name before
      # the count is taken. This is the ONE place a name is used, and it is used
      # to EXCLUDE a known sibling, never to construct the thing being adopted.
      SB_CAND="$(printf '%s\n' "$SB_CAND" | grep -v '^sb-loom-dlshim-' || true)"
      # shellcheck disable=SC2086 # deliberate word-split: one candidate per line
      SB_PICK="$(admin_pick servicebus $SB_CAND)"
      if [ -n "$SB_PICK" ]; then
        SB="$SB_PICK"; SB_RG="$ADMIN_RG"; SB_SUB="$ADMIN_SUB"
        echo "[discover-dlz-adopt] servicebus not in the DLZ RG — adopting '$SB' from the admin RG '$ADMIN_RG'" >&2
      fi
    fi
  fi

  if [ -z "$BATCH" ]; then
    if BATCH_CAND="$(admin_names Microsoft.Batch/batchAccounts)"; then
      # No exclusion needed: deploy-planner/batch.bicep is the ONLY declaration
      # of Microsoft.Batch/batchAccounts in the tree, so any account here is one
      # of ours. The exactly-one rule still applies.
      # shellcheck disable=SC2086 # deliberate word-split: one candidate per line
      BATCH_PICK="$(admin_pick batch $BATCH_CAND)"
      if [ -n "$BATCH_PICK" ]; then
        BATCH="$BATCH_PICK"; BATCH_RG="$ADMIN_RG"; BATCH_SUB="$ADMIN_SUB"
        echo "[discover-dlz-adopt] batch not in the DLZ RG — adopting '$BATCH' from the admin RG '$ADMIN_RG'" >&2
      fi
    fi
  fi
fi

entries=""
add() { # add <key> <name> <rg> <sub> [extraJson]
  [ -n "${2:-}" ] || return 0
  local extra="${5:-}"
  local one
  one="$(printf '"%s":{"mode":"adopt","target":{"name":"%s","rg":"%s","sub":"%s"}%s}' \
        "$1" "$2" "$3" "$4" "${extra:+,\"extra\":$extra}")"
  entries="${entries:+$entries,}$one"
  echo "[discover-dlz-adopt] adopt $1 = $2 (rg=$3)" >&2
}

add "storage-adls" "$SA"    "$DLZ_RG"    "$DLZ_SUB"
add "eventhubs"    "$EH"    "$DLZ_RG"    "$DLZ_SUB"
add "synapse"      "$SYN"   "$DLZ_RG"    "$DLZ_SUB"
add "databricks"   "$DBX_N" "$DLZ_RG"    "$DLZ_SUB" "${DBX_H:+{\"hostname\":\"$DBX_H\"}}"
add "adf"          "$ADF"   "$DLZ_RG"    "$DLZ_SUB"
add "servicebus"   "$SB"    "$SB_RG"     "$SB_SUB"
add "batch"        "$BATCH" "$BATCH_RG"  "$BATCH_SUB"

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
