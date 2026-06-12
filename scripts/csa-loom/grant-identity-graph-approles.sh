#!/usr/bin/env bash
# Grant Microsoft Graph application AppRoles to the Console UAMI so the
# reusable Identity Picker (Entra user / group / service-principal search +
# transitive nested-group resolution) can call real Graph endpoints.
#
# Powers: GET /api/governance/identities/search  (graph-identity-client.ts)
#         <IdentityPicker> component
#
# Idempotent — Graph returns 201 on first grant, then a clear "permission
# already exists" error on subsequent runs (treated as success).
#
# After this script runs, a Tenant Administrator MUST click
#   Entra ID → Enterprise applications → Console UAMI → Permissions
#     → Grant admin consent for <tenant>
# Without that consent, every Graph call returns 403 and the picker renders
# its honest-gate MessageBar naming exactly these three grants.
#
# Usage:
#   az login    # as a user/SP with Application.ReadWrite.All on Graph
#   CONSOLE_UAMI_PRINCIPAL=<console UAMI object id> ./grant-identity-graph-approles.sh
#
# Default principal: the c-loom-console-eastus2 UAMI object id used by the
# limitlessdata sub. Override via env if you're in a different deployment.

set -euo pipefail

CONSOLE_UAMI_PRINCIPAL="${CONSOLE_UAMI_PRINCIPAL:-e61f3eb3-c646-4183-8198-4c4a34cd9a01}"

echo "Target Console UAMI principal: $CONSOLE_UAMI_PRINCIPAL"
GRAPH_SP_ID=$(az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query "[0].id" -o tsv)
echo "Microsoft Graph SP object id: $GRAPH_SP_ID"

# Application app-role (type=Role) ids under the Graph SP's appRoles[] — NOT the
# delegated oauth2PermissionScopes ids. Verified against the Microsoft Graph
# permissions reference. The Identity Picker calls Graph app-only with the
# Console UAMI, so these MUST be the Application app-role ids.
#   User.Read.All        -> search users by displayName / UPN
#   Group.Read.All       -> search groups + expand transitiveMembers (nesting)
#   Application.Read.All -> search service principals / managed identities
declare -a ROLES=(
  "User.Read.All:df021288-bdef-4463-88db-98f22de89214"
  "Group.Read.All:5b567255-7703-4780-807c-7be8301ae99b"
  "Application.Read.All:9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30"
)

# Group.ReadWrite.All (62a82d76-...) — kept IN SYNC with the bicep
# identity-graph-rbac module, which ORs this AppRole into requiredAppRoles when
# workspaceM365LinkEnabled OR domainGroupProvisioningEnabled. Grant it here when
# either feature is being turned on:
#   • LOOM_WORKSPACE_M365_LINK=true       -> create an M365 group for a workspace
#   • LOOM_DOMAIN_GROUP_PROVISIONING=true -> create per-domain admin/contributor
#                                            security groups (D2 RBAC tiers)
if [[ "${LOOM_DOMAIN_GROUP_PROVISIONING:-false}" == "true" || "${LOOM_WORKSPACE_M365_LINK:-false}" == "true" ]]; then
  echo "Group.ReadWrite.All requested (LOOM_DOMAIN_GROUP_PROVISIONING / LOOM_WORKSPACE_M365_LINK) — adding to grant set."
  ROLES+=("Group.ReadWrite.All:62a82d76-70ea-41e2-9197-370581804d09")
fi

TOKEN=$(az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv)

for ROLE in "${ROLES[@]}"; do
  NAME="${ROLE%%:*}"
  APPROLE_ID="${ROLE##*:}"
  echo "Granting $NAME ($APPROLE_ID)..."
  PAYLOAD=$(printf '{"principalId":"%s","resourceId":"%s","appRoleId":"%s"}' \
    "$CONSOLE_UAMI_PRINCIPAL" "$GRAPH_SP_ID" "$APPROLE_ID")
  STATUS=$(curl -sS -w "%{http_code}" -o /tmp/identity-approle.json -X POST \
    "https://graph.microsoft.com/v1.0/servicePrincipals/$CONSOLE_UAMI_PRINCIPAL/appRoleAssignments" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")
  if [[ "$STATUS" == "201" ]]; then
    echo "  $NAME granted"
  elif grep -q "Permission being assigned already exists" /tmp/identity-approle.json 2>/dev/null; then
    echo "  $NAME already granted (idempotent)"
  else
    echo "  $NAME grant returned $STATUS: $(cat /tmp/identity-approle.json)"
  fi
done

cat <<'EOF'

Next step: have a Tenant Administrator open

    Entra ID -> Enterprise applications -> Console UAMI -> Permissions

and click "Grant admin consent for <tenant>". This is the only step that
cannot be performed by an SP without Application Administrator role at
tenant scope. Until consent is issued, the Identity Picker shows its
honest-gate MessageBar ("403 — AppRole not consented") instead of results.

Then set on the Console Container App:

    LOOM_IDENTITY_PICKER_ENABLED=true

(or set loomIdentityPickerEnabled=true in the bicepparam and redeploy
admin-plane).

For the D2 domain-admin / domain-contributor RBAC tiers, also re-run this
script with LOOM_DOMAIN_GROUP_PROVISIONING=true (adds Group.ReadWrite.All),
have a Tenant Admin grant consent, then set on the Console Container App:

    LOOM_DOMAIN_GROUP_PROVISIONING=true

(or loomDomainGroupProvisioningEnabled=true in the bicepparam + redeploy).

EOF
