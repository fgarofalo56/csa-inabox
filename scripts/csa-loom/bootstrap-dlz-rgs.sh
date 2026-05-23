#!/usr/bin/env bash
# CSA Loom — bootstrap DLZ resource groups in multi-sub mode
#
# In multi-sub mode, each DLZ lives in its own subscription. The
# top-level subscription-scope Bicep can't create RGs in *other*
# subscriptions in one deployment, so this script creates them
# beforehand.
#
# Usage:
#   scripts/csa-loom/bootstrap-dlz-rgs.sh <location> <sub-id-list> <domain-list>
#
# Example:
#   scripts/csa-loom/bootstrap-dlz-rgs.sh eastus2 \
#     "00000000-...,11111111-..." \
#     "finance,procurement"

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <location> <comma-sub-ids> <comma-domain-names>"
  exit 1
fi

LOCATION="$1"
SUBS_CSV="$2"
DOMAINS_CSV="$3"

IFS=',' read -ra SUBS <<< "${SUBS_CSV}"
IFS=',' read -ra DOMAINS <<< "${DOMAINS_CSV}"

if [[ ${#SUBS[@]} -ne ${#DOMAINS[@]} ]]; then
  echo "❌ sub-id count (${#SUBS[@]}) must match domain count (${#DOMAINS[@]})"
  exit 1
fi

for i in "${!SUBS[@]}"; do
  SUB="${SUBS[$i]}"
  DOMAIN="${DOMAINS[$i]}"
  RG="rg-csa-loom-dlz-${DOMAIN}-${LOCATION}"
  echo "📦 Bootstrapping RG ${RG} in sub ${SUB}..."
  az account set --subscription "${SUB}"
  az group create \
    --name "${RG}" \
    --location "${LOCATION}" \
    --tags "csa-loom-tier=dlz" "csa-loom-domain=${DOMAIN}" \
    --only-show-errors
done

echo "✅ All ${#SUBS[@]} DLZ resource groups bootstrapped"
