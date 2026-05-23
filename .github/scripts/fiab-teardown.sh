#!/usr/bin/env bash
# CSA Loom teardown — removes a CI-test deployment
# Status: SCAFFOLDED — full teardown logic per PRP-11

set -euo pipefail

RG_NAME="${RG_NAME:?RG_NAME must be set}"

echo "🧹 Tearing down CI-test deployment"
echo "   Admin Plane RG: $RG_NAME"

# Find all CSA Loom RGs in the current sub (admin plane + per-DLZ
# RGs if multi-sub mode was used)
RGS=$(az group list --query "[?starts_with(name, 'rg-csa-loom-')].name" -o tsv)

for rg in $RGS; do
  echo "  Deleting RG: $rg"
  az group delete --name "$rg" --yes --no-wait
done

echo "🧹 Deletion submitted (async)"
