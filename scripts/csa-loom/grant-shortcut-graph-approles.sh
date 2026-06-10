#!/usr/bin/env bash
# Grant Microsoft Graph application AppRoles to the Console UAMI so OneLake
# shortcuts to SharePoint document libraries / OneDrive folders can call real
# Graph endpoints (site search, drive enumeration, drive-item listing/read).
#
# Powers: GET  /api/lakehouse/shortcuts/sharepoint   (graph-drive-client.ts)
#         POST /api/lakehouse/shortcuts               (targetType=sharepoint)
#         POST /api/lakehouse/shortcuts/test          (Test SharePoint shortcut)
#         lakehouse editor -> New shortcut -> SharePoint / OneDrive
#
# Azure-native parity with Fabric OneLake's OneDrive/SharePoint shortcuts, with
# NO Fabric dependency — Microsoft Graph is the data plane, on the Console UAMI.
#
# Idempotent — Graph returns 201 on first grant, then "Permission being assigned
# already exists" on subsequent runs (treated as success).
#
# After this script runs, a Tenant Administrator MUST click
#   Entra ID -> Enterprise applications -> Console UAMI -> Permissions
#     -> Grant admin consent for <tenant>
# Without that consent every Graph call returns 403 and the SharePoint source
# renders its honest-gate MessageBar naming exactly these two grants.
#
# Usage:
#   az login    # as a user/SP with Application.ReadWrite.All on Graph
#   CONSOLE_UAMI_PRINCIPAL=<console UAMI object id> ./grant-shortcut-graph-approles.sh
#
# Sovereign clouds: set GRAPH_HOST=https://graph.microsoft.us (GCC-High) or
# https://dod-graph.microsoft.us (IL5). Defaults to the commercial host.

set -euo pipefail

CONSOLE_UAMI_PRINCIPAL="${CONSOLE_UAMI_PRINCIPAL:-e61f3eb3-c646-4183-8198-4c4a34cd9a01}"
GRAPH_HOST="${GRAPH_HOST:-https://graph.microsoft.com}"
GRAPH_HOST="${GRAPH_HOST%/}"

echo "Target Console UAMI principal: $CONSOLE_UAMI_PRINCIPAL"
echo "Microsoft Graph host: $GRAPH_HOST"
GRAPH_SP_ID=$(az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query "[0].id" -o tsv)
echo "Microsoft Graph SP object id: $GRAPH_SP_ID"

# Application app-role (type=Role) ids under the Graph SP's appRoles[]. Verified
# against the Microsoft Graph permissions reference. The shortcut Graph-drive
# client calls Graph app-only with the Console UAMI, so these MUST be the
# Application app-role ids.
#   Sites.Read.All  -> enumerate SharePoint sites + document libraries (drives)
#   Files.Read.All  -> list + read OneDrive / SharePoint drive items
declare -a ROLES=(
  "Sites.Read.All:332a536c-c7ef-4017-ab91-336970924f0d"
  "Files.Read.All:01d4889c-1287-42c6-ac1f-5d1e02578ef6"
)

TOKEN=$(az account get-access-token --resource "$GRAPH_HOST" --query accessToken -o tsv)

for ROLE in "${ROLES[@]}"; do
  NAME="${ROLE%%:*}"
  APPROLE_ID="${ROLE##*:}"
  echo "Granting $NAME ($APPROLE_ID)..."
  PAYLOAD=$(printf '{"principalId":"%s","resourceId":"%s","appRoleId":"%s"}' \
    "$CONSOLE_UAMI_PRINCIPAL" "$GRAPH_SP_ID" "$APPROLE_ID")
  STATUS=$(curl -sS -w "%{http_code}" -o /tmp/shortcut-graph-approle.json -X POST \
    "$GRAPH_HOST/v1.0/servicePrincipals/$CONSOLE_UAMI_PRINCIPAL/appRoleAssignments" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")
  if [[ "$STATUS" == "201" ]]; then
    echo "  $NAME granted"
  elif grep -q "Permission being assigned already exists" /tmp/shortcut-graph-approle.json 2>/dev/null; then
    echo "  $NAME already granted (idempotent)"
  else
    echo "  $NAME grant returned $STATUS: $(cat /tmp/shortcut-graph-approle.json)"
  fi
done

cat <<'EOF'

Next step: have a Tenant Administrator open

    Entra ID -> Enterprise applications -> Console UAMI -> Permissions

and click "Grant admin consent for <tenant>". This is the only step that
cannot be performed by an SP without Application Administrator role at tenant
scope. Until consent is issued, the SharePoint / OneDrive shortcut source shows
its honest-gate MessageBar ("403 - AppRole not consented") instead of results.

Then set on the Console Container App:

    LOOM_SHAREPOINT_SHORTCUTS_ENABLED=true

(or set loomSharepointShortcutsEnabled=true in the bicepparam and redeploy
admin-plane).

EOF
