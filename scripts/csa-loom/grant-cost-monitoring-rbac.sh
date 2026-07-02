#!/usr/bin/env bash
# CSA Loom — authorize the Console UAMI for Cost Management + Diagnostics.
#
# Two subscription-scoped grants the admin console needs and that the
# RG-scoped admin-plane bicep can't express:
#
#   • Cost Management Reader  — the /monitor Cost surface queries
#     Microsoft.CostManagement across every CSA Loom subscription. Without this
#     a sub returns 403 and the Cost UI honest-gates it ("grant the Console UAMI
#     Cost Management Reader there").
#   • Monitoring Contributor  — the "diagnostics on by default" sweep writes
#     microsoft.insights/diagnosticSettings on resources across the estate.
#     Without it the sweep 403s on each resource
#     ("does not have authorization to perform 'microsoft.insights/diagnosticSettings/write'").
#
# Run once per subscription the console should see. Idempotent.
# REQUIRES: az logged in as a principal that can create role assignments
# (Owner / User Access Administrator) on the target subscription.
#
# Usage:
#   scripts/csa-loom/grant-cost-monitoring-rbac.sh [subscriptionId ...]
#     (no args → the current `az account` subscription)
set -uo pipefail

# Console UAMI object id (the identity the BFF runs as). Override via env.
UAMI_PRINCIPAL="${CONSOLE_UAMI_PRINCIPAL:-00000000-0000-0000-0000-00000000000a}"

# Built-in role definition GUIDs.
COST_MGMT_READER="72fafb9e-0641-4937-9268-a91bfd8191a3"  # Cost Management Reader
MONITORING_CONTRIB="749f88d5-cbae-40b8-bcfc-e573ddc772fa" # Monitoring Contributor

SUBS=("$@")
if [[ ${#SUBS[@]} -eq 0 ]]; then
  SUBS=("$(az account show --query id -o tsv)")
fi

grant() { # role-guid scope label
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' az role assignment create \
    --assignee-object-id "$UAMI_PRINCIPAL" --assignee-principal-type ServicePrincipal \
    --role "$1" --scope "$2" -o none 2>&1 \
    | grep -viE "already exists|RoleAssignmentExists" || true
  echo "  ✓ $3"
}

for SUB in "${SUBS[@]}"; do
  SCOPE="/subscriptions/$SUB"
  echo "== Authorizing Console UAMI on sub $SUB =="
  grant "$COST_MGMT_READER"  "$SCOPE" "Cost Management Reader (Cost surface)"
  grant "$MONITORING_CONTRIB" "$SCOPE" "Monitoring Contributor (diagnostics sweep)"
done

echo "Done. RBAC can take a few minutes to propagate."
