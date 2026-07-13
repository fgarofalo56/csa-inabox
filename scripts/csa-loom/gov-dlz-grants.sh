#!/usr/bin/env bash
# gov-dlz-grants.sh — apply the data-plane RBAC grants that a dlz-attach deploy
# run with skipRoleGrants=true intentionally defers (the deploy SP is
# Contributor-only and cannot write role assignments).
#
# WHY: after a Gov (or any) dlz-attach, the Console managed identity (UAMI) can
# reach the new Data Landing Zone's ARM control plane but has NO data-plane
# roles — so the lakehouse provisioner can't write Delta/CSV seeds to the lake,
# Event Hubs/Service Bus navigators 403, and the report auto-bind chain never
# starts. This script grants the minimal data-plane roles the Console UAMI needs.
#
# RUN AS A SUBSCRIPTION OWNER of the DLZ sub:
#   az cloud set --name AzureUSGovernment   # (omit for Commercial)
#   az login
#   bash scripts/csa-loom/gov-dlz-grants.sh
#
# All values are overridable via env; the defaults below match the 2026-07-13
# Gov dlz-attach (rg-csa-loom-dlz--usgovvirginia, sub c36bc643…). For a different
# DLZ, export the vars first or edit them.
set -u

SUB="${DLZ_SUB:-c36bc643-b071-42f8-8197-4c787fcf5549}"
DLZ_RG="${DLZ_RG:-rg-csa-loom-dlz--usgovvirginia}"
UAMI_OID="${CONSOLE_UAMI_OID:-791fb231-cbba-4e49-b6ac-c812e0c6ec3f}"  # uami-loom-console principalId
SA="${DLZ_STORAGE:-saloomlv6hjg46gtu66}"
EVHNS="${DLZ_EVENTHUB_NS:-evhns-loom-usgovvirginia}"
SBNS="${DLZ_SERVICEBUS_NS:-sbns-loom-usgovvirginia}"
SYN_WS="${DLZ_SYNAPSE_WS:-syn-loom--usgovvirginia}"

az account set --subscription "$SUB" || { echo "ERROR: cannot select sub $SUB — are you logged in to the right cloud?"; exit 1; }

grant() { # role, scope
  az role assignment create --assignee-object-id "$UAMI_OID" --assignee-principal-type ServicePrincipal \
    --role "$1" --scope "$2" -o none 2>&1 | grep -viE "already exists|RoleAssignmentExists" && echo "  ! $1 (check output above)" || echo "  ✓ $1"
}

echo "== Console UAMI ($UAMI_OID) data-plane grants on DLZ $DLZ_RG =="
grant "Storage Blob Data Contributor" "/subscriptions/$SUB/resourceGroups/$DLZ_RG/providers/Microsoft.Storage/storageAccounts/$SA"
grant "Azure Event Hubs Data Owner"   "/subscriptions/$SUB/resourceGroups/$DLZ_RG/providers/Microsoft.EventHub/namespaces/$EVHNS"
grant "Azure Service Bus Data Owner"  "/subscriptions/$SUB/resourceGroups/$DLZ_RG/providers/Microsoft.ServiceBus/namespaces/$SBNS"
grant "Reader"                        "/subscriptions/$SUB/resourceGroups/$DLZ_RG"
grant "Monitoring Reader"             "/subscriptions/$SUB"
grant "Cost Management Reader"        "/subscriptions/$SUB"

echo ""
echo "== Synapse Administrator (data-plane) for the Console UAMI =="
echo "   $SYN_WS is typically a MANAGED-VNET workspace — its data plane is reachable"
echo "   only from inside the VNet, so this grant must run in-VNet or via the portal:"
echo "     • Synapse Studio > Manage > Access control > + Add > Synapse Administrator > uami-loom-console"
echo "     • or from an in-VNet context (gh-aca-runner / jumpbox on vnet-csa-loom-dlz-…):"
echo "       az synapse role assignment create --workspace-name $SYN_WS \\"
echo "         --role 'Synapse Administrator' --assignee-object-id $UAMI_OID --assignee-principal-type ServicePrincipal"

echo ""
echo "DONE (ARM grants). After the Synapse grant lands too, re-run the Gov demo app"
echo "installs so lakehouse seeding + report auto-binding complete:"
echo "  .github/workflows/csa-loom-demo-seed.yml (or the demo-seed.mjs script) against the Gov console."
