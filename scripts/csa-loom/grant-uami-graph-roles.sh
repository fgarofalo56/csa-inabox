#!/usr/bin/env bash
# Idempotently grant the Console UAMI the Microsoft Graph app-roles it needs
# for read-only Entra user enrichment in /admin/users:
#
#   - Directory.Read.All  → required for display name + department + the
#                           /subscribedSkus tenant license roll-up (F17)
#   - User.Read.All       → required for /users?$select=...,assignedLicenses
#                           (per-user license assignments + accountEnabled, F17)
#
# Optional (for the Help-Copilot widget + Security & Governance surfaces):
#   - InformationProtectionPolicy.Read.All → sensitivity label catalog
#   - Policy.Read.All                       → conditional-access + DLP read
#
# Microsoft Graph app-role assignment is not in bicep; we use Microsoft Graph
# PowerShell or az ad app permission add+grant. This script uses pure `az`
# CLI calls so it runs in any deploymentScript / GitHub Action / Azure
# DevOps pipeline without Graph PowerShell module load time.
#
# Run after the platform bicep deploys the Console UAMI but before declaring
# the deploy complete. Safe to re-run.
#
# Required env:
#   LOOM_UAMI_OBJECT_ID    Object ID of the uami-loom-console UAMI
#                          (output of identity module: uamiConsoleObjectId)
#   AZURE_TENANT_ID        Tenant the UAMI lives in
#
# Optional env:
#   LOOM_GRAPH_EXTRA_ROLES  Comma-separated extra role names beyond the
#                           default set, e.g.
#                           "InformationProtectionPolicy.Read.All,Policy.Read.All"

set -euo pipefail

: "${LOOM_UAMI_OBJECT_ID:?LOOM_UAMI_OBJECT_ID required (uami-loom-console objectId)}"
: "${AZURE_TENANT_ID:?AZURE_TENANT_ID required}"

GRAPH_SP_APP_ID="00000003-0000-0000-c000-000000000000"   # Microsoft Graph SP

echo "Resolving Microsoft Graph servicePrincipal id in tenant $AZURE_TENANT_ID..."
GRAPH_SP_ID=$(az ad sp show --id "$GRAPH_SP_APP_ID" --query id -o tsv)
echo "Graph SP id: $GRAPH_SP_ID"

# Default app-role set
DEFAULT_ROLES=(
  "Directory.Read.All"
  "User.Read.All"
)

EXTRA_ROLES=()
if [ -n "${LOOM_GRAPH_EXTRA_ROLES:-}" ]; then
  IFS=',' read -ra EXTRA_ROLES <<< "$LOOM_GRAPH_EXTRA_ROLES"
fi

ALL_ROLES=("${DEFAULT_ROLES[@]}" "${EXTRA_ROLES[@]}")

# Resolve each role name → role id (one-time per Graph SP)
declare -A ROLE_ID_MAP
for role_name in "${ALL_ROLES[@]}"; do
  role_id=$(az ad sp show --id "$GRAPH_SP_APP_ID" \
    --query "appRoles[?value=='$role_name'].id" -o tsv | head -n1)
  if [ -z "$role_id" ]; then
    echo "WARN: role $role_name not found on Microsoft Graph SP — skipping"
    continue
  fi
  ROLE_ID_MAP["$role_name"]="$role_id"
done

# Read existing assignments once to make this idempotent
echo "Reading current app-role assignments on UAMI $LOOM_UAMI_OBJECT_ID..."
EXISTING=$(az rest \
  --method GET \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$LOOM_UAMI_OBJECT_ID/appRoleAssignments" \
  --headers "ConsistencyLevel=eventual" \
  --query "value[].appRoleId" -o tsv 2>/dev/null || echo "")

echo "Current role assignments: $(echo "$EXISTING" | wc -l | tr -d ' ') existing"

GRANTED=()
SKIPPED=()
FAILED=()
for role_name in "${!ROLE_ID_MAP[@]}"; do
  role_id="${ROLE_ID_MAP[$role_name]}"
  if echo "$EXISTING" | grep -q "$role_id"; then
    SKIPPED+=("$role_name")
    continue
  fi
  echo "Granting $role_name ($role_id)..."
  body=$(jq -n \
    --arg principalId "$LOOM_UAMI_OBJECT_ID" \
    --arg resourceId  "$GRAPH_SP_ID" \
    --arg appRoleId   "$role_id" \
    '{principalId:$principalId, resourceId:$resourceId, appRoleId:$appRoleId}')
  if az rest \
    --method POST \
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$LOOM_UAMI_OBJECT_ID/appRoleAssignments" \
    --headers "Content-Type=application/json" \
    --body "$body" > /dev/null 2>&1; then
    GRANTED+=("$role_name")
  else
    FAILED+=("$role_name")
  fi
done

echo ""
echo "==================================="
echo " UAMI Graph role assignments — done"
echo "==================================="
echo "Granted: ${#GRANTED[@]} (${GRANTED[*]:-})"
echo "Skipped (already present): ${#SKIPPED[@]} (${SKIPPED[*]:-})"
echo "Failed: ${#FAILED[@]} (${FAILED[*]:-})"

if [ ${#FAILED[@]} -ne 0 ]; then
  echo ""
  echo "FAILED grants are usually a tenant-admin-consent issue. The caller of"
  echo "this script (the deploy SP or admin) must have one of:"
  echo "  - Global Administrator"
  echo "  - Privileged Role Administrator"
  echo "  - Application Administrator (limited)"
  echo "to assign Graph app-roles to a service principal."
  exit 1
fi

echo ""
echo "OK. /admin/users will now show displayName + department from Entra."
