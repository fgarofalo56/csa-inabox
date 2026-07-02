#!/usr/bin/env bash
# CSA Loom — BI stack data-plane grants for the Direct Lake shim UAMI.
#
# The Storage Blob Data Reader grant (shim → DLZ ADLS) is authored in Bicep
# (modules/admin-plane/aas-adls-rbac.bicep). The two grants below are DATA-plane
# role assignments that CANNOT be expressed as ARM/Azure RBAC and so run here as
# a post-deploy step (same pattern as grant-navigator-rbac.sh + the Synapse
# sqlcmd steps in csa-loom-post-deploy-bootstrap.yml):
#
#   1. Cosmos DB Built-in Data Contributor (00000000-0000-0000-0000-000000000002)
#      on the DLZ Cosmos account — so SemanticModelConfigStore can read the
#      direct-lake-config/refresh-policies container.
#   2. Synapse Dedicated SQL pool db_datareader — so DirectQueryFallback tables
#      and partition-boundary reads work for the AAS model. T-SQL CREATE USER …
#      FROM EXTERNAL PROVIDER (the dedicated pool must be RESUMED to connect).
#
# Idempotent. REQUIRES: az CLI logged in as a principal that can create Cosmos
# SQL role assignments + is a Synapse SQL Administrator on the pool.
set -uo pipefail

SUB="${SUB:-00000000-0000-0000-0000-000000000001}"
ADMIN_RG="${ADMIN_RG:-rg-csa-loom-admin-eastus2}"
DLZ_RG="${DLZ_RG:-rg-csa-loom-dlz-single-eastus2}"
LOCATION="${LOCATION:-eastus2}"
# Direct Lake shim UAMI — discovered by the deterministic name unless overridden.
DL_UAMI_NAME="${DIRECT_LAKE_UAMI_NAME:-uami-loom-direct-lake-$LOCATION}"
TENANT_ID="${AZURE_TENANT_ID:-$(az account show --query tenantId -o tsv 2>/dev/null)}"

az account set --subscription "$SUB" 2>/dev/null || true
echo "== CSA Loom BI-stack RBAC (Direct Lake shim) =="
echo "   sub=$SUB admin_rg=$ADMIN_RG dlz_rg=$DLZ_RG uami=$DL_UAMI_NAME"
echo

q() { az "$@" 2>/dev/null || true; }

# Resolve the Direct Lake UAMI principal (object) id.
DL_PRINCIPAL="${DIRECT_LAKE_UAMI_PRINCIPAL:-$(q identity show -n "$DL_UAMI_NAME" -g "$ADMIN_RG" --query principalId -o tsv)}"
if [[ -z "$DL_PRINCIPAL" ]]; then
  echo "  - Direct Lake UAMI '$DL_UAMI_NAME' not found in $ADMIN_RG — is the BI stack deployed (aasEnabled=true)? Skipping."
  exit 0
fi

# 1) Cosmos DB Built-in Data Contributor on the DLZ Cosmos account.
COSMOS_ACCT="${LOOM_COSMOS_ACCOUNT:-$(q cosmosdb list -g "$DLZ_RG" --query "[0].name" -o tsv)}"
if [[ -n "$COSMOS_ACCT" ]]; then
  echo "  Cosmos data-plane: Built-in Data Contributor for the Direct Lake shim UAMI"
  MSYS_NO_PATHCONV=1 az cosmosdb sql role assignment create \
    --account-name "$COSMOS_ACCT" -g "$DLZ_RG" \
    --role-definition-id "00000000-0000-0000-0000-000000000002" \
    --principal-id "$DL_PRINCIPAL" --scope "/" -o none 2>&1 \
    | grep -vi "already\|exists\|Conflict" || true
  echo "  ✓ Cosmos DB Built-in Data Contributor ($COSMOS_ACCT)"
else
  echo "  - Cosmos account not found in $DLZ_RG — skipping Cosmos grant"
fi

# 2) Synapse Dedicated SQL pool db_datareader (DirectQuery + partition reads).
SYNAPSE_WS="${LOOM_SYNAPSE_WORKSPACE:-$(q synapse workspace list -g "$DLZ_RG" --query "[0].name" -o tsv)}"
POOL="${LOOM_SYNAPSE_DEDICATED_POOL:-loompool}"
if [[ -n "$SYNAPSE_WS" ]]; then
  if ! command -v sqlcmd >/dev/null 2>&1 && [[ ! -x /opt/mssql-tools18/bin/sqlcmd ]]; then
    echo "  - sqlcmd not installed — install mssql-tools18 to run the Synapse db_datareader grant. Skipping."
  else
    export PATH="$PATH:/opt/mssql-tools18/bin"
    TOKEN=$(az account get-access-token --resource https://database.windows.net --query accessToken -o tsv)
    # The dedicated pool must be RESUMED for this to connect.
    echo "  Synapse db_datareader: granting [$DL_UAMI_NAME] on $SYNAPSE_WS/$POOL"
    sqlcmd -S "$SYNAPSE_WS.sql.azuresynapse.net" -d "$POOL" -G -P "$TOKEN" -I -b -Q "
    IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = '$DL_UAMI_NAME')
      CREATE USER [$DL_UAMI_NAME] FROM EXTERNAL PROVIDER;
    IF IS_ROLEMEMBER('db_datareader','$DL_UAMI_NAME') = 0
      EXEC sp_addrolemember 'db_datareader', '$DL_UAMI_NAME';
    " || echo "::warning::Synapse db_datareader grant incomplete — ensure pool '$POOL' is resumed and the deployer is Synapse SQL Administrator."
    echo "  ✓ Synapse db_datareader attempted on $SYNAPSE_WS/$POOL"
  fi
else
  echo "  - Synapse workspace not found in $DLZ_RG — skipping db_datareader grant"
fi

echo
echo "== BI-stack RBAC done =="
