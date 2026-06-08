#!/usr/bin/env bash
# Grant the Loom console app registration the Azure SQL Database
# `user_impersonation` DELEGATED permission so users can authenticate to a
# Synapse SQL analytics endpoint with their OWN identity ("user's identity"
# data-access mode — F10). Without this, the per-user SQL token is never issued
# at sign-in and the query route surfaces the NO_USER_SQL_TOKEN gate.
#
# This only affects "user's identity" mode. The DEFAULT "delegated (service
# identity)" mode needs none of this — it uses the console UAMI and always works.
#
# Azure SQL Database resource (first-party) appId by cloud:
#   Commercial / GCC : 022907d3-0f1b-48f7-badc-1ba6abab6d66
#   GCC-High / IL5   : varies — pass SQL_APP_ID explicitly, or the script will
#                      resolve the SP by display name "Azure SQL Database".
# The user_impersonation scope GUID is resolved dynamically from the SP so we
# never hard-code a stale value.
#
# Usage:
#   az login            # as a user/SP with Application.ReadWrite.All on the app
#   MSAL_APP_ID=<loom console app registration appId> \
#     [SQL_APP_ID=022907d3-0f1b-48f7-badc-1ba6abab6d66] \
#     ./grant-sql-delegated-permission.sh

set -euo pipefail

MSAL_APP_ID="${MSAL_APP_ID:?Set MSAL_APP_ID to the Loom console app registration appId}"
SQL_APP_ID="${SQL_APP_ID:-022907d3-0f1b-48f7-badc-1ba6abab6d66}"

echo "Loom console app registration: $MSAL_APP_ID"
echo "Azure SQL Database resource appId: $SQL_APP_ID"

# Resolve the SQL Database service principal (by appId; fall back to name).
SQL_SP=$(az ad sp show --id "$SQL_APP_ID" 2>/dev/null || true)
if [[ -z "$SQL_SP" ]]; then
  echo "appId lookup failed; resolving by display name 'Azure SQL Database'..."
  SQL_SP=$(az ad sp list --filter "displayName eq 'Azure SQL Database'" --query "[0]" -o json)
fi
SQL_APP_ID=$(echo "$SQL_SP" | python3 -c "import sys,json;print(json.load(sys.stdin)['appId'])")

# Find the user_impersonation delegated scope id on the SQL DB SP.
SCOPE_ID=$(echo "$SQL_SP" | python3 -c "
import sys, json
sp = json.load(sys.stdin)
for s in sp.get('oauth2PermissionScopes', []):
    if s.get('value') == 'user_impersonation':
        print(s['id']); break
")
if [[ -z "${SCOPE_ID:-}" ]]; then
  echo "ERROR: could not find the user_impersonation scope on the Azure SQL Database SP." >&2
  exit 1
fi
echo "user_impersonation scope id: $SCOPE_ID"

# Add the delegated permission (Scope=delegated) to the Loom app registration.
echo "Adding delegated permission to $MSAL_APP_ID..."
az ad app permission add \
  --id "$MSAL_APP_ID" \
  --api "$SQL_APP_ID" \
  --api-permissions "${SCOPE_ID}=Scope"

cat <<EOF

Delegated permission added.

Next step (Tenant Administrator — the only step an SP without Application
Administrator at tenant scope cannot perform): open

    Entra ID -> App registrations -> Loom console ($MSAL_APP_ID)
      -> API permissions -> "Grant admin consent for <tenant>"

OR run:

    az ad app permission admin-consent --id "$MSAL_APP_ID"

Until consent is issued, AAD silently omits the SQL scope at sign-in, users
have no cached SQL token, and "user's identity" mode shows the NO_USER_SQL_TOKEN
gate. "Delegated (service identity)" mode is unaffected and keeps working.

Per-user provisioning in the SQL endpoint is still required for the user's
queries to succeed once they have a token:

  Dedicated pool (run as Synapse AAD admin / the console UAMI):
    CREATE USER [user@tenant.onmicrosoft.com] FROM EXTERNAL PROVIDER;
    ALTER ROLE db_datareader ADD MEMBER [user@tenant.onmicrosoft.com];
    ALTER ROLE db_datawriter ADD MEMBER [user@tenant.onmicrosoft.com];

  Serverless (OPENROWSET over ADLS): grant the user "Storage Blob Data Reader"
  on the lake storage account (Azure RBAC). Workspace members often already
  hold this — then no extra step is needed.
EOF
