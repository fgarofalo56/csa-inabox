#!/usr/bin/env bash
# Grant the Microsoft Graph application AppRole the Console UAMI needs to browse
# and read SharePoint / OneDrive document libraries for Lakehouse shortcuts.
#
# Powers: lakehouse editor -> Shortcuts -> New -> "SharePoint / OneDrive"
#         GET  /api/lakehouse/shortcuts/browse?sourceType=sharepoint
#         POST /api/lakehouse/shortcuts            (targetType=sharepoint)
#         POST /api/lakehouse/shortcuts/test       (sharepoint reachability)
#   backed by lib/azure/sharepoint-graph-client.ts (Microsoft Graph, app-only).
#
# This is an Azure/M365-native feature — NO Microsoft Fabric / Power BI
# dependency (per .claude/rules/no-fabric-dependency.md). It works with
# LOOM_DEFAULT_FABRIC_WORKSPACE UNSET.
#
# Grant (Application app-role, type=Role, under the Graph SP appRoles[]):
#   Sites.Read.All  332a536c-c7ef-4017-ab91-336970924f0d
#     -> search SharePoint sites, list a site's document libraries (drives),
#        and read driveItem children. Available in ALL national clouds.
#
# Idempotent — Graph returns 201 on first grant, then "permission already
# exists" on subsequent runs (treated as success).
#
# After this script runs, a Tenant Administrator MUST grant admin consent:
#   Entra ID -> Enterprise applications -> Console UAMI -> Permissions
#     -> "Grant admin consent for <tenant>"
# Until consent is issued, Graph returns 403 and the SharePoint shortcut source
# renders its honest-gate MessageBar naming exactly this grant.
#
# Sovereign clouds: the Graph host is derived from AZURE_CLOUD (AzureUSGovernment
# -> graph.microsoft.us). Override with GRAPH_HOST for DoD/IL5 (dod-graph.microsoft.us).
#
# Usage:
#   az login    # as a user/SP with Application.ReadWrite.All on Graph
#   CONSOLE_UAMI_PRINCIPAL=<console UAMI object id> ./grant-sharepoint-graph-approle.sh
#
# Default principal: the c-loom-console-eastus2 UAMI object id used by the
# limitlessdata sub. Override via env if you're in a different deployment.

set -euo pipefail

CONSOLE_UAMI_PRINCIPAL="${CONSOLE_UAMI_PRINCIPAL:-e61f3eb3-c646-4183-8198-4c4a34cd9a01}"

# Derive the sovereign Graph host (token resource + REST host must match).
CLOUD_LC="$(echo "${AZURE_CLOUD:-}" | tr '[:upper:]' '[:lower:]')"
if [[ -n "${GRAPH_HOST:-}" ]]; then
  GRAPH="$GRAPH_HOST"
elif [[ "$CLOUD_LC" == *usgov* || "$CLOUD_LC" == *government* ]]; then
  GRAPH="graph.microsoft.us"
else
  GRAPH="graph.microsoft.com"
fi
echo "Microsoft Graph host: https://$GRAPH"
echo "Target Console UAMI principal: $CONSOLE_UAMI_PRINCIPAL"

GRAPH_SP_ID=$(az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query "[0].id" -o tsv)
echo "Microsoft Graph SP object id: $GRAPH_SP_ID"

declare -a ROLES=(
  "Sites.Read.All:332a536c-c7ef-4017-ab91-336970924f0d"
)

TOKEN=$(az account get-access-token --resource "https://$GRAPH" --query accessToken -o tsv)

for ROLE in "${ROLES[@]}"; do
  NAME="${ROLE%%:*}"
  APPROLE_ID="${ROLE##*:}"
  echo "Granting $NAME ($APPROLE_ID)..."
  PAYLOAD=$(printf '{"principalId":"%s","resourceId":"%s","appRoleId":"%s"}' \
    "$CONSOLE_UAMI_PRINCIPAL" "$GRAPH_SP_ID" "$APPROLE_ID")
  STATUS=$(curl -sS -w "%{http_code}" -o /tmp/sharepoint-approle.json -X POST \
    "https://$GRAPH/v1.0/servicePrincipals/$CONSOLE_UAMI_PRINCIPAL/appRoleAssignments" \
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

and click "Grant admin consent for <tenant>". Until consent is issued, the
SharePoint / OneDrive shortcut source shows its honest-gate MessageBar
("403 - Sites.Read.All not consented") instead of the site browser.

Then set on the Console Container App:

    LOOM_SHAREPOINT_SHORTCUTS_ENABLED=true

(or set loomSharePointShortcutsEnabled=true in the bicepparam and redeploy
admin-plane).

EOF
