#!/usr/bin/env bash
# Grant Microsoft Graph application AppRoles to the Console UAMI so the Lakehouse
# shortcut wizard can create SharePoint / OneDrive shortcuts (Files-only,
# zero-copy pointers resolved through Microsoft Graph drives — Azure-native
# parity with Fabric OneLake's SharePoint / OneDrive shortcut sources, NO Fabric
# dependency).
#
# Powers: GET  /api/lakehouse/shortcuts/sharepoint   (sharepoint-graph-client.ts)
#         POST /api/lakehouse/shortcuts (targetType=sharepoint|onedrive)
#         <SharePointPicker> / <OneDrivePicker> in the lakehouse editor
#
# Idempotent — Graph returns 201 on first grant, then a clear "permission
# already exists" error on subsequent runs (treated as success).
#
# After this script runs, a Tenant Administrator MUST click
#   Entra ID -> Enterprise applications -> Console UAMI -> Permissions
#     -> Grant admin consent for <tenant>
# Without that consent, every Graph call returns 403 and the picker renders its
# honest-gate MessageBar naming exactly these two grants.
#
# Usage:
#   az login    # as a user/SP with Application.ReadWrite.All on Graph
#   CONSOLE_UAMI_PRINCIPAL=<console UAMI object id> ./grant-sharepoint-graph-approles.sh
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
# permissions reference. The shortcut connector calls Graph app-only with the
# Console UAMI, so these MUST be the Application app-role ids.
#   Sites.Read.All  -> search SharePoint sites + list their document libraries
#   Files.Read.All  -> list + read SharePoint / OneDrive drive items
declare -a ROLES=(
  "Sites.Read.All:332a536c-c7ef-4017-ab91-336970924f0d"
  "Files.Read.All:01d4889c-1287-42c6-ac1f-5d1e02578ef6"
)

TOKEN=$(az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv)

for ROLE in "${ROLES[@]}"; do
  NAME="${ROLE%%:*}"
  APPROLE_ID="${ROLE##*:}"
  echo "Granting $NAME ($APPROLE_ID)..."
  PAYLOAD=$(printf '{"principalId":"%s","resourceId":"%s","appRoleId":"%s"}' \
    "$CONSOLE_UAMI_PRINCIPAL" "$GRAPH_SP_ID" "$APPROLE_ID")
  STATUS=$(curl -sS -w "%{http_code}" -o /tmp/sharepoint-approle.json -X POST \
    "https://graph.microsoft.com/v1.0/servicePrincipals/$CONSOLE_UAMI_PRINCIPAL/appRoleAssignments" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")
  if [[ "$STATUS" == "201" ]]; then
    echo "  $NAME granted"
  elif grep -q "Permission being assigned already exists" /tmp/sharepoint-approle.json 2>/dev/null; then
    echo "  $NAME already granted (idempotent)"
  else
    echo "  $NAME grant returned $STATUS: $(cat /tmp/sharepoint-approle.json)"
  fi
done

cat <<'EOF'

Next step: have a Tenant Administrator open

    Entra ID -> Enterprise applications -> Console UAMI -> Permissions

and click "Grant admin consent for <tenant>". This is the only step that
cannot be performed by an SP without Application Administrator role at tenant
scope. Until consent is issued, SharePoint / OneDrive shortcuts show their
honest-gate MessageBar ("403 — AppRole not consented") instead of results.

Then set on the Console Container App:

    LOOM_SHAREPOINT_SHORTCUTS_ENABLED=true

(or set loomSharePointShortcutsEnabled=true in the bicepparam and redeploy
admin-plane).

EOF
