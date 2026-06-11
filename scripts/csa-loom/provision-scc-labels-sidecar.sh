#!/usr/bin/env bash
# Provision the SCC sensitivity-label sidecar so /admin/security label & policy
# CRUD (create/edit/delete) works end-to-end.
#
# Microsoft Graph has NO write API for sensitivity-label definitions or label
# policies — those flows live ONLY in Security & Compliance PowerShell
# (New-/Set-/Remove-Label and *-LabelPolicy). The Loom Console therefore proxies
# CRUD to a PowerShell Function app (azure-functions/scc-labels) that connects to
# SCC with certificate-based app-only auth.
#
# This script performs the automatable parts of the one-time setup and prints
# the steps that require an interactive Tenant/Compliance Administrator.
#
# Prereqs:
#   az login   # as a user/SP with Application.Administrator + the ability to
#              # assign directory roles (Privileged Role Administrator).
#
# Inputs (env):
#   SCC_APP_DISPLAY_NAME   default "CSA Loom SCC Labels Sidecar"
#   SCC_FUNCTION_APP       name of the deployed func-scclbl-* Function app (for code publish)
#   SCC_FUNCTION_RG        resource group of the Function app (admin-plane RG)
#   SCC_CERT_PATH          optional path to a .cer (public) to upload as the app credential
#
# Grounded in Microsoft Learn:
#   App-only auth for unattended scripts (Connect-IPPSSession)
#     https://learn.microsoft.com/powershell/exchange/app-only-auth-powershell-v2
#   Exchange.ManageAsApp + Compliance Administrator requirement
#     https://learn.microsoft.com/powershell/exchange/app-only-auth-powershell-v2#assign-azure-ad-roles-to-the-application

set -euo pipefail

APP_NAME="${SCC_APP_DISPLAY_NAME:-CSA Loom SCC Labels Sidecar}"
EXO_SP_APPID="00000002-0000-0ff1-ce00-000000000000"          # Office 365 Exchange Online
EXO_MANAGEASAPP_APPROLE="dc50a0fb-09a3-484d-be87-e023b12c6440" # Exchange.ManageAsApp (app role)
COMPLIANCE_ADMIN_ROLE_TEMPLATE="17315797-102d-40b4-93e0-432062caca18" # Compliance Administrator

echo "==> Ensuring SCC sidecar app registration exists: $APP_NAME"
APP_ID=$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv)
if [ -z "$APP_ID" ]; then
  APP_ID=$(az ad app create --display-name "$APP_NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)
  echo "    Created app: $APP_ID"
else
  echo "    Reusing app: $APP_ID"
fi

# Ensure a service principal exists for the app (needed for role assignments).
SP_ID=$(az ad sp list --filter "appId eq '$APP_ID'" --query "[0].id" -o tsv)
if [ -z "$SP_ID" ]; then
  SP_ID=$(az ad sp create --id "$APP_ID" --query id -o tsv)
  echo "    Created service principal: $SP_ID"
fi

echo "==> Granting Graph/EXO app role Exchange.ManageAsApp to the app"
EXO_SP_ID=$(az ad sp list --filter "appId eq '$EXO_SP_APPID'" --query "[0].id" -o tsv)
if [ -n "$EXO_SP_ID" ]; then
  PAYLOAD=$(printf '{"principalId":"%s","resourceId":"%s","appRoleId":"%s"}' "$SP_ID" "$EXO_SP_ID" "$EXO_MANAGEASAPP_APPROLE")
  R=$(curl -sS -w "%{http_code}" -o /tmp/scc_approle.json -X POST \
    "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/appRoleAssignments" \
    -H "Authorization: Bearer $(az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv)" \
    -H "Content-Type: application/json" -d "$PAYLOAD")
  if [[ "$R" == "201" ]]; then echo "    Exchange.ManageAsApp granted"
  elif grep -q "already exists" /tmp/scc_approle.json 2>/dev/null; then echo "    Exchange.ManageAsApp already granted"
  else echo "    grant returned $R: $(cat /tmp/scc_approle.json)"; fi
else
  echo "    Could not resolve Office 365 Exchange Online SP — grant Exchange.ManageAsApp manually."
fi

echo "==> Assigning the Compliance Administrator directory role to the app"
# Activate the role template if not already active, then add the SP as a member.
ROLE_ID=$(az rest --method get \
  --url "https://graph.microsoft.com/v1.0/directoryRoles?\$filter=roleTemplateId eq '$COMPLIANCE_ADMIN_ROLE_TEMPLATE'" \
  --query "value[0].id" -o tsv 2>/dev/null || true)
if [ -z "$ROLE_ID" ]; then
  ROLE_ID=$(az rest --method post --url "https://graph.microsoft.com/v1.0/directoryRoles" \
    --body "{\"roleTemplateId\":\"$COMPLIANCE_ADMIN_ROLE_TEMPLATE\"}" --query id -o tsv 2>/dev/null || true)
fi
if [ -n "$ROLE_ID" ]; then
  az rest --method post --url "https://graph.microsoft.com/v1.0/directoryRoles/$ROLE_ID/members/\$ref" \
    --body "{\"@odata.id\":\"https://graph.microsoft.com/v1.0/directoryObjects/$SP_ID\"}" 2>/dev/null \
    && echo "    Compliance Administrator assigned" \
    || echo "    Compliance Administrator assignment skipped (already a member, or needs Privileged Role Administrator)."
else
  echo "    Could not resolve/activate Compliance Administrator role — assign it to the app SP manually in Entra."
fi

if [ -n "${SCC_CERT_PATH:-}" ] && [ -f "$SCC_CERT_PATH" ]; then
  echo "==> Uploading public cert as an app credential ($SCC_CERT_PATH)"
  az ad app credential reset --id "$APP_ID" --cert "@$SCC_CERT_PATH" --append || \
    echo "    cert upload failed — upload the .cer under App registrations → Certificates & secrets manually."
fi

if [ -n "${SCC_FUNCTION_APP:-}" ] && [ -n "${SCC_FUNCTION_RG:-}" ]; then
  echo "==> Publishing scc-labels Function code to $SCC_FUNCTION_APP"
  HERE="$(cd "$(dirname "$0")/../.." && pwd)"
  SRC="$HERE/azure-functions/scc-labels"
  TMPZIP="$(mktemp -d)/scc-labels.zip"
  ( cd "$SRC" && zip -qr "$TMPZIP" . -x "*.git*" )
  az functionapp deployment source config-zip -g "$SCC_FUNCTION_RG" -n "$SCC_FUNCTION_APP" --src "$TMPZIP" \
    && echo "    code published" || echo "    code publish failed — deploy manually with func azure functionapp publish."
fi

cat <<EOF

================================================================================
Remaining one-time admin actions for the SCC labels sidecar
================================================================================
App (client) id ............ $APP_ID
Service principal id ....... $SP_ID

1. Create / obtain an auth CERTIFICATE (self-signed is fine for app auth) and:
     - upload the PUBLIC key (.cer) to the app registration's
       "Certificates & secrets" (or pass SCC_CERT_PATH to this script);
     - install the PFX into the Function app so the worker can load it:
         az webapp config ssl upload -g <rg> -n <func-scclbl-*> \\
           --certificate-file scc.pfx --certificate-password <pwd>
       then set WEBSITE_LOAD_CERTIFICATES to the cert thumbprint (the bicep
       param sccCertThumbprint already wires this app setting).

2. Re-deploy with:
     loomMipAdminEnabled = true
     sccAppId            = $APP_ID
     sccCertThumbprint   = <thumbprint>
     sccOrganization     = <tenant>.onmicrosoft.com
   (sovereign clouds also set sccConnectionUri, e.g.
    https://ps.compliance.protection.office365.us for GCC-High/DoD.)

3. A Tenant Administrator clicks "Grant admin consent" for the app's
   Exchange.ManageAsApp permission in Entra → App registrations → API permissions.

Until these complete, /admin/security label & policy CRUD returns the honest
'mip_admin_not_configured' gate; reads continue to work.
================================================================================
EOF
