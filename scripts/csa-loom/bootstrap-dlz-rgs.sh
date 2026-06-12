#!/usr/bin/env bash
# CSA Loom — bootstrap DLZ resource groups in multi-sub mode
#
# In multi-sub mode, each DLZ lives in its own subscription. The
# top-level subscription-scope Bicep can't create RGs in *other*
# subscriptions in one deployment, so this script creates them
# beforehand.
#
# Usage:
#   scripts/csa-loom/bootstrap-dlz-rgs.sh <location> <sub-id-list> <domain-list> [cost-center-list]
#
# Example:
#   scripts/csa-loom/bootstrap-dlz-rgs.sh eastus2 \
#     "00000000-...,11111111-..." \
#     "finance,procurement" \
#     "CC-1001,CC-2002"
#
# The optional 4th arg (comma-separated, parallel to the domain list) stamps a
# `costCenter` tag on each RG for chargeback (D4). When omitted/short, the
# unmatched domains get costCenter=unassigned. The `csa-loom-domain` + costCenter
# tags here MUST match the dlzTags var in modules/landing-zone/main.bicep — RG
# tags are not visible to Cost Management grouping (resource-level tags drive the
# per-domain rollup), but they keep the RG self-describing + match the bicep path.

set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "usage: $0 <location> <comma-sub-ids> <comma-domain-names> [comma-cost-centers]"
  exit 1
fi

LOCATION="$1"
SUBS_CSV="$2"
DOMAINS_CSV="$3"
COST_CENTERS_CSV="${4:-}"

IFS=',' read -ra SUBS <<< "${SUBS_CSV}"
IFS=',' read -ra DOMAINS <<< "${DOMAINS_CSV}"
IFS=',' read -ra COST_CENTERS <<< "${COST_CENTERS_CSV}"

if [[ ${#SUBS[@]} -ne ${#DOMAINS[@]} ]]; then
  echo "❌ sub-id count (${#SUBS[@]}) must match domain count (${#DOMAINS[@]})"
  exit 1
fi

for i in "${!SUBS[@]}"; do
  SUB="${SUBS[$i]}"
  DOMAIN="${DOMAINS[$i]}"
  COST_CENTER="${COST_CENTERS[$i]:-unassigned}"
  RG="rg-csa-loom-dlz-${DOMAIN}-${LOCATION}"
  echo "📦 Bootstrapping RG ${RG} in sub ${SUB} (costCenter=${COST_CENTER})..."
  az account set --subscription "${SUB}"
  az group create \
    --name "${RG}" \
    --location "${LOCATION}" \
    --tags "csa-loom-tier=dlz" "csa-loom-domain=${DOMAIN}" "costCenter=${COST_CENTER}" \
    --only-show-errors
done

echo "✅ All ${#SUBS[@]} DLZ resource groups bootstrapped"
