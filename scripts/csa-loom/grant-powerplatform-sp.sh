#!/usr/bin/env bash
# Register the Console UAMI service principal as a Power Platform admin
# management application so it can call the BusinessAppPlatform / Power Automate
# / Power Apps admin APIs (environments list, flow/app CRUD).
#
# WHY: Power Platform admin APIs reject any service principal that is not
# registered as a "management application" — the exact 403 the console surfaces:
#   "The service principal <objId> for application <appId> does not have
#    permission to access .../Microsoft.BusinessAppPlatform/scopes/admin/
#    environments ... Confirm the Console UAMI SP is added to the 'Service
#    principals can use Power Platform APIs' allow group ..."
# This grant is a TENANT-ADMIN action that cannot be expressed in Bicep/ARM —
# it lives in the Power Platform control plane (api.bap.microsoft.com). Run it
# ONCE as a Power Platform Administrator / Global Administrator.
#
# Docs:
#   https://learn.microsoft.com/power-platform/admin/powershell-create-service-principal
#   PUT https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/adminApplications/{appId}?api-version=2020-10-01
#
# Usage (as a Power Platform admin — e.g. `az login` with your admin account):
#   APP_ID=<console-uami-appId> bash scripts/csa-loom/grant-powerplatform-sp.sh
# Default APP_ID is the centralus Console UAMI client id.
#
# For Dataverse (Power Apps / Dataverse-table / Power Pages metadata), the SAME
# (or a dedicated LOOM_DATAVERSE_CLIENT_ID) SP must ALSO be added as an
# Application User with the System Administrator security role in each target
# environment — that step is per-environment and is done in the Power Platform
# admin centre (Environments > Settings > Users + permissions > Application
# users > New app user) or via `pac admin application-user create`.
set -euo pipefail

APP_ID="${APP_ID:-f4f25dd9-e7aa-4ba0-ae18-6c902217964d}"   # Console UAMI client id (centralus)
BAP="https://api.bap.microsoft.com"
API_VERSION="2020-10-01"

echo "[grant-pp-sp] Acquiring a BAP admin token (must be a Power Platform / Global admin)..."
TOKEN="$(az account get-access-token --resource "$BAP" --query accessToken -o tsv)"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: could not get a token for $BAP. Run 'az login' as a Power Platform admin first." >&2
  exit 1
fi

echo "[grant-pp-sp] Registering app '$APP_ID' as a Power Platform admin management application..."
HTTP=$(curl -s -o /tmp/pp-grant-resp.json -w "%{http_code}" -X PUT \
  "$BAP/providers/Microsoft.BusinessAppPlatform/adminApplications/${APP_ID}?api-version=${API_VERSION}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}')

echo "[grant-pp-sp] HTTP $HTTP"
cat /tmp/pp-grant-resp.json 2>/dev/null | head -c 800; echo
if [[ "$HTTP" == "200" || "$HTTP" == "201" ]]; then
  echo "[grant-pp-sp] OK — '$APP_ID' is now a Power Platform management application."
  echo "[grant-pp-sp] NEXT (per-environment, for Dataverse/Power Apps/Power Pages):"
  echo "  pac admin application-user create --application-id $APP_ID \\"
  echo "      --environment <env-id> --role 'System Administrator'"
else
  echo "ERROR: registration failed (HTTP $HTTP). You must be signed in as a Power Platform / Global Administrator." >&2
  exit 1
fi
