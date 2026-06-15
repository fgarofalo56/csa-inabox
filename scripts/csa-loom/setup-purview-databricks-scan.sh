#!/usr/bin/env bash
# CSA Loom — set up the Microsoft Purview CLASSIC Data Map scan of an Azure
# Databricks Unity Catalog source, so the Catalog → Metastores "Define + run a
# scan" green-path works end-to-end.
#
# Two auth modes (mirrors apps/fiab-console/lib/azure/purview-client.ts
# defineDatabricksUnityCatalogScan + the /api/catalog/metastores route):
#
#   MODE=mi  (DEFAULT — MI-first, NO Key Vault)
#     The Purview account's SYSTEM-ASSIGNED managed identity is used as the scan
#     credential. Per Microsoft Learn it must be registered as a Databricks
#     SERVICE PRINCIPAL (using Purview's Application ID) and granted Unity
#     Catalog SELECT/USE privileges. This script resolves Purview's Application
#     ID and prints the exact Databricks-side steps (they require a Databricks
#     ACCOUNT/metastore admin, so they can't be done with the Console UAMI).
#
#   MODE=pat (alternative — Key Vault Access Token)
#     A Databricks personal access token stored as a Key Vault secret, surfaced
#     to Purview as a Key Vault connection + Access-Token credential. This script
#     creates the Purview Key Vault connection (reference-confirmed scan-plane
#     PUT) and prints the credential-creation + secret steps.
#
# Grounded in:
#   https://learn.microsoft.com/purview/register-scan-azure-databricks-unity-catalog#authentication-for-a-scan
#   https://learn.microsoft.com/purview/data-map-data-scan-credentials#grant-microsoft-purview-access-to-your-azure-key-vault
#   https://learn.microsoft.com/rest/api/purview/scanningdataplane/key-vault-connections
#
# USAGE:
#   PURVIEW_ACCOUNT=purview-csa-loom-eastus2 ./scripts/csa-loom/setup-purview-databricks-scan.sh
#   MODE=pat PURVIEW_ACCOUNT=... KEYVAULT=kvloomdbx... SECRET_NAME=dbx-pat ./...sh
#
# REQUIRES: az CLI logged in with Data Source Administrator on the Purview
#           account (the limitlessdata_deploy SP) + jq.
set -uo pipefail

MODE="${MODE:-mi}"   # mi | pat
PURVIEW_ACCOUNT="${PURVIEW_ACCOUNT:-${LOOM_PURVIEW_ACCOUNT:-purview-csa-loom-eastus2}}"
# Normalize a pasted URL / -api host (Commercial .com OR US Gov .us) → short name.
PURVIEW_ACCOUNT="$(echo "$PURVIEW_ACCOUNT" | sed -E 's#^https?://##; s#-api\.purview\.azure\.(com|us).*$##; s#\.purview\.azure\.(com|us).*$##; s#/+$##')"

API_VERSION="2022-07-01-preview"
RESOURCE="https://purview.azure.net"
# Per-cloud Data Map host TLD — mirrors purviewBase()'s isGovCloud() switch.
PURVIEW_CLOUD="${PURVIEW_CLOUD:-${LOOM_CLOUD:-${AZURE_CLOUD:-AzureCloud}}}"
case "$(echo "$PURVIEW_CLOUD" | tr '[:upper:]' '[:lower:]')" in
  *usgov*|*government*|*gcc-high*|*gcchigh*|*il5*|*dod*) PURVIEW_TLD="us" ;;
  *) PURVIEW_TLD="com" ;;
esac
BASE="https://${PURVIEW_ACCOUNT}.purview.azure.${PURVIEW_TLD}"

echo "== CSA Loom — Purview ⇄ Databricks Unity Catalog scan setup =="
echo "   mode=$MODE  account=$PURVIEW_ACCOUNT  base=$BASE"
echo

# Resolve the Purview account's system-assigned MI Application (client) ID — the
# value Databricks needs when registering it as a service principal.
PURVIEW_OBJECT_ID="$(az resource show \
  --resource-type Microsoft.Purview/accounts -n "$PURVIEW_ACCOUNT" \
  --query identity.principalId -o tsv 2>/dev/null || true)"
PURVIEW_APP_ID=""
if [ -n "$PURVIEW_OBJECT_ID" ]; then
  PURVIEW_APP_ID="$(az ad sp show --id "$PURVIEW_OBJECT_ID" --query appId -o tsv 2>/dev/null || true)"
fi
echo "   Purview MI object id : ${PURVIEW_OBJECT_ID:-<not resolved — pass PURVIEW_OBJECT_ID>}"
echo "   Purview Application ID: ${PURVIEW_APP_ID:-<not resolved — find under Purview account → Properties → Managed identity application ID>}"
echo

if [ "$MODE" = "mi" ]; then
  cat <<EOF
MI-first scan path (no Key Vault). Complete these one-time Databricks-admin steps:

  1) In the Databricks workspace you want to scan:
       Settings → Workspace admin → Identity and access → Service principals
       → Add service principal → Microsoft Entra ID managed
       → Application ID: ${PURVIEW_APP_ID:-<Purview Application ID above>}
  2) Grant that service principal Unity Catalog read privileges (run in a SQL
     editor / on the SQL Warehouse you will scan), per object you want catalogued:
       GRANT USE CATALOG ON CATALOG <catalog> TO \`${PURVIEW_APP_ID:-<app-id>}\`;
       GRANT USE SCHEMA  ON SCHEMA  <catalog>.<schema> TO \`${PURVIEW_APP_ID:-<app-id>}\`;
       GRANT SELECT      ON ... ;
     (To scan the whole metastore, make it a metastore admin instead.)
  3) Start the SQL Warehouse and copy its HTTP path
       (SQL Warehouses → your warehouse → Connection details → HTTP path).
  4) (Lineage) Enable the system schema so lineage extraction works:
       ENABLE SCHEMA system.access;   -- requires account admin

Then on Catalog → Metastores: register the workspace as a Purview source,
choose "Define + run a scan", credential = "Managed identity (recommended)",
paste the SQL Warehouse HTTP path, and Register. No Key Vault required.
EOF
  exit 0
fi

if [ "$MODE" = "pat" ]; then
  KEYVAULT="${KEYVAULT:-}"
  SECRET_NAME="${SECRET_NAME:-dbx-pat}"
  CREDENTIAL_NAME="${CREDENTIAL_NAME:-dbx-pat-credential}"
  if [ -z "$KEYVAULT" ]; then
    echo "ERROR: MODE=pat needs KEYVAULT=<key-vault-name> (the dbxScanKeyVaultName from catalog.bicep)." >&2
    exit 2
  fi
  KV_URI="$(az keyvault show -n "$KEYVAULT" --query properties.vaultUri -o tsv 2>/dev/null || true)"
  if [ -z "$KV_URI" ]; then
    echo "ERROR: could not resolve Key Vault '$KEYVAULT' vaultUri (az keyvault show)." >&2
    exit 2
  fi
  TOKEN="$(az account get-access-token --resource "$RESOURCE" --query accessToken -o tsv)"
  if [ -z "$TOKEN" ]; then echo "ERROR: failed to acquire a Purview data-plane token." >&2; exit 2; fi

  echo "Registering the Key Vault connection '$KEYVAULT' in Purview..."
  KV_CONN_BODY="$(jq -n --arg url "$KV_URI" '{properties:{baseUrl:$url, description:"CSA Loom — Databricks UC scan PAT"}}')"
  curl -fsS -X PUT \
    "${BASE}/azureKeyVaults/${KEYVAULT}?api-version=${API_VERSION}" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    -d "$KV_CONN_BODY" >/dev/null && echo "  ✓ Key Vault connection registered." \
    || echo "  ! Key Vault connection PUT failed — verify Data Source Administrator + the secrets-user grant from catalog.bicep."
  echo

  cat <<EOF
Remaining one-time PAT steps:

  1) Generate a Databricks personal access token (User settings → Developer →
     Access tokens) for a principal with UC SELECT/USE on the objects to scan.
  2) Store it as the Key Vault secret:
       az keyvault secret set --vault-name ${KEYVAULT} --name ${SECRET_NAME} --value <PAT>
  3) Create the Purview Access-Token credential (portal: Management →
     Credentials → + New → Authentication method = Access Token,
     Key Vault connection = ${KEYVAULT}, Secret name = ${SECRET_NAME},
     name = ${CREDENTIAL_NAME}).
  4) Start the SQL Warehouse and copy its HTTP path.

Then on Catalog → Metastores: register the source, "Define + run a scan",
credential = "Access token (Key Vault PAT)", credential name = ${CREDENTIAL_NAME},
paste the SQL Warehouse HTTP path, and Register.
EOF
  exit 0
fi

echo "ERROR: unknown MODE='$MODE' (expected 'mi' or 'pat')." >&2
exit 2
