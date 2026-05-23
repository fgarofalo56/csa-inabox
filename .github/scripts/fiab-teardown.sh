#!/usr/bin/env bash
# CSA Loom teardown — removes a CI-test deployment
#
# Strategy:
#   1. Identify all RGs starting with "rg-csa-loom-" in the current
#      subscription (or per-DLZ subs if multi-sub mode).
#   2. For each RG, purge soft-deletable resources (Key Vault, Cosmos
#      restorable accounts) before deletion — otherwise the names
#      remain reserved for 90 days and the next CI run collides.
#   3. Delete RGs with --no-wait + capture the request IDs.
#   4. Poll until all RGs are gone (or 30 min timeout).

set -euo pipefail

RG_NAME="${RG_NAME:?RG_NAME must be set}"
DLZ_SUBS="${DLZ_SUBS:-}"  # comma-separated list of DLZ sub IDs
TIMEOUT_MINUTES="${TIMEOUT_MINUTES:-30}"

echo "🧹 Tearing down CI-test deployment"
echo "   Admin Plane RG: $RG_NAME"
echo "   DLZ subs:       ${DLZ_SUBS:-(none)}"
echo "   Timeout:        ${TIMEOUT_MINUTES}m"

# Build the set of (sub_id, rg_name) pairs to delete
declare -a TARGETS
TARGETS+=("$(az account show --query id -o tsv):${RG_NAME}")

if [[ -n "$DLZ_SUBS" ]]; then
  IFS=',' read -ra SUBS <<< "$DLZ_SUBS"
  for sub in "${SUBS[@]}"; do
    RGS=$(az group list --subscription "$sub" --query "[?starts_with(name, 'rg-csa-loom-')].name" -o tsv)
    for rg in $RGS; do
      TARGETS+=("${sub}:${rg}")
    done
  done
fi

# Also pick up any CSA Loom RGs in the current sub beyond the admin RG
CUR_SUB=$(az account show --query id -o tsv)
ADDL=$(az group list --query "[?starts_with(name, 'rg-csa-loom-') && name != '${RG_NAME}'].name" -o tsv)
for rg in $ADDL; do
  TARGETS+=("${CUR_SUB}:${rg}")
done

echo "  Targets:"
for t in "${TARGETS[@]}"; do echo "    - $t"; done

# Purge soft-deletable resources first
for target in "${TARGETS[@]}"; do
  IFS=':' read -r sub rg <<< "$target"
  echo "  🔑 Purging Key Vaults in ${rg}..."
  KVS=$(az keyvault list --subscription "$sub" --resource-group "$rg" --query "[].name" -o tsv 2>/dev/null || true)
  for kv in $KVS; do
    az keyvault delete --subscription "$sub" --name "$kv" 2>/dev/null || true
    az keyvault purge --subscription "$sub" --name "$kv" 2>/dev/null || true
  done

  echo "  🌐 Purging Managed HSMs in ${rg}..."
  HSMS=$(az keyvault list --subscription "$sub" --resource-group "$rg" --resource-type hsm --query "[].name" -o tsv 2>/dev/null || true)
  for hsm in $HSMS; do
    az keyvault delete --subscription "$sub" --hsm-name "$hsm" 2>/dev/null || true
    az keyvault purge --subscription "$sub" --hsm-name "$hsm" --no-wait 2>/dev/null || true
  done
done

# Delete RGs (async)
echo "  🗑️  Submitting RG deletions..."
for target in "${TARGETS[@]}"; do
  IFS=':' read -r sub rg <<< "$target"
  az group delete --subscription "$sub" --name "$rg" --yes --no-wait 2>/dev/null || \
    echo "    (rg ${rg} already gone)"
done

# Poll until all gone or timeout
echo "  ⏳ Polling for deletion completion..."
START=$(date +%s)
DEADLINE=$((START + TIMEOUT_MINUTES * 60))

while [[ $(date +%s) -lt $DEADLINE ]]; do
  REMAINING=0
  for target in "${TARGETS[@]}"; do
    IFS=':' read -r sub rg <<< "$target"
    if az group exists --subscription "$sub" --name "$rg" 2>/dev/null | grep -q true; then
      REMAINING=$((REMAINING + 1))
    fi
  done
  if [[ $REMAINING -eq 0 ]]; then
    echo
    echo "🧹 All target RGs deleted"
    exit 0
  fi
  echo "    $REMAINING RG(s) remaining..."
  sleep 30
done

echo
echo "⚠️  Teardown timeout reached after ${TIMEOUT_MINUTES}m — some RGs may still be in 'Deleting' state"
echo "    Check Azure portal for status; nightly cleanup job will retry"
exit 1
