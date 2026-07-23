#!/usr/bin/env bash
# CSA Loom — A11 drain + recreate a FAULTED Synapse Spark Big Data pool.
#
# WHY: a Synapse Spark pool can enter a state where ARM reports provisioningState
# 'Failed'/'Canceled' (a HARD fault) OR reports 'Succeeded' yet no Spark
# application will ever start (the "Succeeded but can't launch" fault — memory
# 2026-07-12 / 2026-07-14). The ONLY reliable fix for either is delete + recreate
# the pool with the SAME node spec (and, if sessions still wedge after that, a
# NEW pool name). The Console automates this on the keep-warm heartbeat
# (lib/azure/spark-pool-recovery.ts) and exposes a manual button on
# /admin/health → Spark pools; this script is the operator runbook equivalent for
# when the Console itself is down or you're recovering from a shell.
#
# WHAT IT DOES (idempotent):
#   1. Reads the pool's current spec (location, node size/count, autoscale,
#      autopause, Spark version) from ARM so the recreate is identical.
#   2. Cancels/deletes the pool (ARM delete waits for the async op).
#   3. Recreates the pool from the captured spec.
#   4. Prints the new provisioningState.
#
# Draining sessions: the delete tears down every live Livy session on the pool,
# so there is no separate drain step — recreate IS the drain. If you only want to
# kill leaked sessions WITHOUT recreating, use the in-VNet Console route instead:
#   POST /api/admin/spark/chaos { "action":"kill-sessions", "poolName":"…", "count":N }
#   (tenant-admin + LOOM_SPARK_CHAOS_ENABLED=true + LOOM_INTERNAL_TOKEN) — a
#   non-prod drill tool — or the #1796 reaper, which runs automatically.
#
# REQUIRES: az CLI logged in with Contributor on the Synapse workspace RG (the
#   Console UAMI / limitlessdata_deploy SP both have it). + jq. Synapse Spark
#   bigDataPools ARM is GA in Commercial + Gov (GCC-High) + IL5 — set the right
#   cloud with `az cloud set` first in a sovereign boundary.
#
# USAGE (env overridable; discovers the workspace when SYNAPSE_WS is unset):
#   ./scripts/csa-loom/recreate-spark-pool.sh POOL_NAME
#   SYNAPSE_WS=syn-loom-… SYNAPSE_RG=… ./scripts/csa-loom/recreate-spark-pool.sh loompool
set -uo pipefail

POOL_NAME="${1:-${POOL_NAME:-${LOOM_SYNAPSE_SPARK_POOL:-loompool}}}"
SYNAPSE_WS="${SYNAPSE_WS:-${LOOM_SYNAPSE_WORKSPACE:-}}"
SYNAPSE_RG="${SYNAPSE_RG:-${LOOM_DLZ_RG:-}}"
SUBSCRIPTION="${SUBSCRIPTION:-${LOOM_SYNAPSE_SUB:-${LOOM_SUBSCRIPTION_ID:-}}}"

command -v az >/dev/null 2>&1 || { echo "ERROR: az CLI not found." >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq not found." >&2; exit 1; }

[ -n "$SUBSCRIPTION" ] && az account set --subscription "$SUBSCRIPTION" >/dev/null 2>&1 || true

# --- Discover the workspace + RG if not provided ---------------------------
if [ -z "$SYNAPSE_WS" ]; then
  echo "Discovering the Synapse workspace…"
  SYNAPSE_WS="$(az synapse workspace list --query '[0].name' -o tsv 2>/dev/null || true)"
fi
[ -z "$SYNAPSE_WS" ] && { echo "ERROR: set SYNAPSE_WS (or LOOM_SYNAPSE_WORKSPACE)." >&2; exit 1; }
if [ -z "$SYNAPSE_RG" ]; then
  SYNAPSE_RG="$(az synapse workspace show --name "$SYNAPSE_WS" --query 'id' -o tsv 2>/dev/null | sed -n 's#.*/resourceGroups/\([^/]*\)/.*#\1#p')"
fi
[ -z "$SYNAPSE_RG" ] && { echo "ERROR: set SYNAPSE_RG (or LOOM_DLZ_RG)." >&2; exit 1; }

echo "Workspace : $SYNAPSE_WS  (RG $SYNAPSE_RG)"
echo "Pool      : $POOL_NAME"

# --- 1) Capture the current pool spec --------------------------------------
echo "Reading current pool spec…"
SPEC_JSON="$(az synapse spark pool show --workspace-name "$SYNAPSE_WS" --name "$POOL_NAME" -o json 2>/dev/null || true)"
if [ -z "$SPEC_JSON" ]; then
  echo "ERROR: pool '$POOL_NAME' not found on workspace '$SYNAPSE_WS'." >&2
  exit 1
fi

PROV="$(echo "$SPEC_JSON" | jq -r '.provisioningState // "Unknown"')"
NODE_SIZE="$(echo "$SPEC_JSON" | jq -r '.nodeSize // "Medium"')"
NODE_FAMILY="$(echo "$SPEC_JSON" | jq -r '.nodeSizeFamily // "MemoryOptimized"')"
SPARK_VER="$(echo "$SPEC_JSON" | jq -r '.sparkVersion // "3.4"')"
AUTOSCALE_ENABLED="$(echo "$SPEC_JSON" | jq -r '.autoScale.enabled // false')"
MIN_NODES="$(echo "$SPEC_JSON" | jq -r '.autoScale.minNodeCount // 3')"
MAX_NODES="$(echo "$SPEC_JSON" | jq -r '.autoScale.maxNodeCount // 3')"
NODE_COUNT="$(echo "$SPEC_JSON" | jq -r '.nodeCount // 3')"
AUTOPAUSE_ENABLED="$(echo "$SPEC_JSON" | jq -r '.autoPause.enabled // true')"
AUTOPAUSE_DELAY="$(echo "$SPEC_JSON" | jq -r '.autoPause.delayInMinutes // 15')"

echo "  provisioningState=$PROV nodeSize=$NODE_SIZE sparkVersion=$SPARK_VER autoscale=$AUTOSCALE_ENABLED ($MIN_NODES-$MAX_NODES) nodeCount=$NODE_COUNT autopause=$AUTOPAUSE_ENABLED/${AUTOPAUSE_DELAY}m"

# --- 2) Delete the pool (drains every live session) ------------------------
echo "Deleting pool '$POOL_NAME' (this drains all live Spark sessions)…"
az synapse spark pool delete --workspace-name "$SYNAPSE_WS" --name "$POOL_NAME" --yes 2>&1 || {
  echo "WARN: delete returned non-zero (may already be deleting); continuing to poll." >&2
}

echo "Waiting for the pool to disappear…"
for _ in $(seq 1 60); do
  if ! az synapse spark pool show --workspace-name "$SYNAPSE_WS" --name "$POOL_NAME" -o none 2>/dev/null; then
    echo "  deleted."
    break
  fi
  sleep 10
done

# --- 3) Recreate the pool from the captured spec ---------------------------
echo "Recreating pool '$POOL_NAME'…"
CREATE_ARGS=(
  --workspace-name "$SYNAPSE_WS"
  --resource-group "$SYNAPSE_RG"
  --name "$POOL_NAME"
  --node-size "$NODE_SIZE"
  --node-size-family "$NODE_FAMILY"
  --spark-version "$SPARK_VER"
)
if [ "$AUTOSCALE_ENABLED" = "true" ]; then
  CREATE_ARGS+=( --enable-auto-scale true --min-node-count "$MIN_NODES" --max-node-count "$MAX_NODES" )
else
  CREATE_ARGS+=( --enable-auto-scale false --node-count "$NODE_COUNT" )
fi
if [ "$AUTOPAUSE_ENABLED" = "true" ]; then
  CREATE_ARGS+=( --enable-auto-pause true --delay "$AUTOPAUSE_DELAY" )
else
  CREATE_ARGS+=( --enable-auto-pause false )
fi

az synapse spark pool create "${CREATE_ARGS[@]}" 2>&1 || {
  echo "ERROR: recreate failed. Retry, or (if sessions still wedge after a clean recreate) create a NEW pool NAME and point LOOM_SYNAPSE_SPARK_POOL at it." >&2
  exit 1
}

# --- 4) Report the new state -----------------------------------------------
NEW_PROV="$(az synapse spark pool show --workspace-name "$SYNAPSE_WS" --name "$POOL_NAME" --query 'provisioningState' -o tsv 2>/dev/null || echo Unknown)"
echo "Done. Pool '$POOL_NAME' provisioningState=$NEW_PROV"
if [ "$NEW_PROV" != "Succeeded" ]; then
  echo "NOTE: not yet 'Succeeded' — it may still be provisioning. Re-check with:"
  echo "  az synapse spark pool show --workspace-name '$SYNAPSE_WS' --name '$POOL_NAME' --query provisioningState -o tsv"
fi
