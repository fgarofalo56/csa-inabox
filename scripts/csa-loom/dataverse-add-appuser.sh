#!/usr/bin/env bash
#
# Loom Dataverse Application User registration
#
# For every environment in the tenant that has a Dataverse database,
# register the Loom MSAL Web App SP as an Application User with the
# System Administrator security role. Idempotent — re-running is safe
# (skips envs where the AppUser already exists).
#
# Prerequisites:
#   - Caller must have Dataverse System Administrator on each target env.
#     For the Default env, this requires the one-time manual "Promote To
#     Admin" click (see docs/fiab/dataverse-app-user.md).
#   - az CLI signed in as a tenant admin / env admin.
#   - LOOM_MSAL_CLIENT_ID env var set (the App Registration to register).
#
# Usage:
#   LOOM_MSAL_CLIENT_ID=9844c28c-... ./scripts/csa-loom/dataverse-add-appuser.sh
#   LOOM_MSAL_CLIENT_ID=9844c28c-... ./scripts/csa-loom/dataverse-add-appuser.sh --env-id <envId>
#
set -euo pipefail

APP_CLIENT_ID="${LOOM_MSAL_CLIENT_ID:-${1:-}}"
ENV_FILTER="${2:-}"
if [ -z "$APP_CLIENT_ID" ]; then
  echo "error: LOOM_MSAL_CLIENT_ID env var or first arg required" >&2
  exit 2
fi

# Discover every env with Dataverse provisioned
echo "==> Discovering envs with Dataverse via BAP admin API"
BAP_TOKEN=$(az account get-access-token --resource https://api.bap.microsoft.com --query accessToken -o tsv)
ENVS_JSON=$(curl -s -H "Authorization: Bearer $BAP_TOKEN" \
  'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2020-10-01&$expand=properties/linkedEnvironmentMetadata')

# Extract each env's Dataverse instance URL (only envs WITH Dataverse have linkedEnvironmentMetadata.instanceUrl)
ENVS=$(echo "$ENVS_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for e in d.get('value', []):
    name = e.get('name', '')
    if '$ENV_FILTER' and name != '$ENV_FILTER': continue
    instance = (e.get('properties', {}).get('linkedEnvironmentMetadata') or {}).get('instanceUrl', '').rstrip('/')
    if instance:
        print(f\"{name}\t{instance}\")
")

if [ -z "$ENVS" ]; then
  echo "  (no envs with Dataverse found)"
  exit 0
fi

ROLE_NAME="${LOOM_DATAVERSE_ROLE:-System Administrator}"

while IFS=$'\t' read -r ENV_ID DV_URL; do
  echo ""
  echo "==> $ENV_ID  ($DV_URL)"
  TOKEN=$(az account get-access-token --resource "$DV_URL" --query accessToken -o tsv 2>/dev/null || true)
  if [ -z "$TOKEN" ]; then
    echo "  ⚠ Cannot get Dataverse token — skip"
    continue
  fi

  # Check if AppUser already exists
  EXISTING=$(curl -s -H "Authorization: Bearer $TOKEN" -H "OData-Version: 4.0" \
    "$DV_URL/api/data/v9.2/systemusers?\$select=systemuserid&\$filter=applicationid%20eq%20$APP_CLIENT_ID" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['value'][0]['systemuserid'] if d.get('value') else '')" 2>/dev/null || echo "")

  if [ -n "$EXISTING" ]; then
    echo "  ✓ AppUser already exists ($EXISTING) — verifying role"
    APP_USER_ID="$EXISTING"
  else
    # Resolve root BU
    BU_ID=$(curl -s -H "Authorization: Bearer $TOKEN" -H "OData-Version: 4.0" \
      "$DV_URL/api/data/v9.2/businessunits?\$select=businessunitid&\$filter=parentbusinessunitid%20eq%20null" \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['value'][0]['businessunitid'])" 2>/dev/null || echo "")
    if [ -z "$BU_ID" ]; then
      echo "  ⚠ Could not resolve root BU — caller may lack SA; see docs/fiab/dataverse-app-user.md Step 1"
      continue
    fi
    echo "  → Creating AppUser (BU $BU_ID)"
    APP_USER_ID=$(curl -s -X POST \
      -H "Authorization: Bearer $TOKEN" -H "OData-Version: 4.0" \
      -H "Content-Type: application/json" -H "Prefer: return=representation" \
      -d "{\"applicationid\":\"$APP_CLIENT_ID\",\"businessunitid@odata.bind\":\"/businessunits($BU_ID)\",\"firstname\":\"CSA Loom\",\"lastname\":\"Console\"}" \
      "$DV_URL/api/data/v9.2/systemusers" \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('systemuserid',''))" 2>/dev/null || echo "")
    if [ -z "$APP_USER_ID" ]; then
      echo "  ✗ AppUser create failed"
      continue
    fi
    echo "  ✓ AppUser created: $APP_USER_ID"
  fi

  # Assign role (idempotent — Dataverse returns 200 on association even if it exists)
  ROLE_ID=$(curl -s -H "Authorization: Bearer $TOKEN" -H "OData-Version: 4.0" \
    "$DV_URL/api/data/v9.2/roles?\$select=roleid&\$filter=name%20eq%20'$(printf '%s' "$ROLE_NAME" | sed 's/ /%20/g')'&\$top=1" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['value'][0]['roleid'] if d.get('value') else '')" 2>/dev/null || echo "")
  if [ -z "$ROLE_ID" ]; then
    echo "  ⚠ Role '$ROLE_NAME' not found"
    continue
  fi
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "OData-Version: 4.0" -H "Content-Type: application/json" \
    -d "{\"@odata.id\": \"$DV_URL/api/data/v9.2/roles($ROLE_ID)\"}" \
    "$DV_URL/api/data/v9.2/systemusers($APP_USER_ID)/systemuserroles_association/\$ref")
  case "$STATUS" in
    204|200) echo "  ✓ Role '$ROLE_NAME' assigned" ;;
    412) echo "  ✓ Role '$ROLE_NAME' already assigned" ;;
    *) echo "  ✗ Role assignment HTTP $STATUS" ;;
  esac
done <<< "$ENVS"

echo ""
echo "Done. Re-run anytime — it's idempotent."
