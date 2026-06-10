// =====================================================================
// Copy Job watermark / CDC LSN checkpoint control table (F14 + T79)
//
// Creates dbo.copy_watermark + dbo.usp_write_watermark in an existing Azure
// SQL database, and (optionally) grants the ADF factory managed identity and
// the Loom console UAMI the rights they need to read/write the checkpoint.
//
// This is the Azure-native backing for the Fabric Copy job's incremental copy
// (no-fabric-dependency.md). The single last_value column stores EITHER an
// incremental high-water mark (Incremental mode) OR the last processed CDC
// log-sequence number as a 0x… hex string (CDC mode — native SQL Server change
// tracking via cdc.fn_cdc_get_net_changes_*). No schema change is needed for
// CDC — both modes share the (source, table_name) → last_value row. The Loom
// console ALSO self-heals the table + procedure on first incremental/CDC run
// (via TDS+AAD), so this module is primarily for pre-provisioning + granting the
// ADF factory identity — which the console cannot grant itself.
//
// Auth model: the deployment script runs as `scriptIdentity` (a UAMI that MUST
// be configured as an Entra admin on the target SQL server). It connects with
// go-sqlcmd using ActiveDirectoryManagedIdentity and applies idempotent DDL.
// =====================================================================

@description('Fully-qualified domain name of the Azure SQL server hosting the control DB, e.g. sql-loom-ctrl.database.windows.net (Commercial) or *.database.usgovcloudapi.net (Gov).')
param sqlServerFqdn string

@description('Control database name.')
param sqlDatabase string = 'loom-control'

@description('Resource ID of a UAMI that is an Entra admin on the SQL server. The deployment script runs as this identity and applies the DDL.')
param scriptIdentityId string

@description('Client (application) ID of scriptIdentityId — passed to sqlcmd for ManagedIdentity auth.')
param scriptIdentityClientId string

@description('Display name of the Loom console UAMI to grant db_owner on the control DB (so the console can self-heal + read the watermark). Empty = skip.')
param consoleUamiName string = ''

@description('Display name of the ADF factory whose managed identity executes the watermark stored procedure. Granted db_datareader+db_datawriter+EXECUTE. Empty = skip.')
param adfFactoryName string = ''

@description('Azure cloud for the script CLI environment (AzureCloud | AzureUSGovernment).')
@allowed(['AzureCloud', 'AzureUSGovernment'])
param azureCloud string = 'AzureCloud'

param location string = resourceGroup().location
param complianceTags object = {}

resource controlTable 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: 'copy-job-control-table'
  location: location
  tags: complianceTags
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${scriptIdentityId}': {}
    }
  }
  properties: {
    azCliVersion: '2.64.0'
    retentionInterval: 'PT1H'
    timeout: 'PT30M'
    environmentVariables: [
      { name: 'SQL_SERVER', value: sqlServerFqdn }
      { name: 'SQL_DB', value: sqlDatabase }
      { name: 'UAMI_CLIENT_ID', value: scriptIdentityClientId }
      { name: 'CONSOLE_UAMI', value: consoleUamiName }
      { name: 'ADF_FACTORY', value: adfFactoryName }
      { name: 'AZURE_CLOUD', value: azureCloud }
    ]
    scriptContent: '''
set -euo pipefail

# go-sqlcmd from packages.microsoft.com — static Go binary, supports
# ActiveDirectoryManagedIdentity natively (no ODBC driver needed).
echo "Installing sqlcmd (go-sqlcmd)…"
curl -sSL https://packages.microsoft.com/keys/microsoft.asc | tee /etc/apt/trusted.gpg.d/microsoft.asc >/dev/null 2>&1 || true
if command -v apt-get >/dev/null 2>&1; then
  curl -sSL https://packages.microsoft.com/config/debian/12/prod.list -o /etc/apt/sources.list.d/mssql-release.list 2>/dev/null \
    || curl -sSL https://packages.microsoft.com/config/debian/11/prod.list -o /etc/apt/sources.list.d/mssql-release.list 2>/dev/null || true
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y sqlcmd >/dev/null 2>&1 || true
fi
if ! command -v sqlcmd >/dev/null 2>&1; then
  # Fallback: static binary release (works on musl/Alpine too).
  curl -sSL -o /tmp/sqlcmd.tar.bz2 https://github.com/microsoft/go-sqlcmd/releases/download/v1.8.0/sqlcmd-linux-amd64.tar.bz2
  mkdir -p /tmp/sqlcmd && tar -xjf /tmp/sqlcmd.tar.bz2 -C /tmp/sqlcmd
  export PATH="/tmp/sqlcmd:$PATH"
fi

cat > /tmp/ddl.sql <<'SQL'
IF OBJECT_ID('dbo.copy_watermark','U') IS NULL
CREATE TABLE dbo.copy_watermark (
  source       nvarchar(256)  NOT NULL,
  table_name   nvarchar(256)  NOT NULL,
  last_value   nvarchar(256)  NULL,
  updated_utc  datetimeoffset NOT NULL CONSTRAINT DF_copy_watermark_updated DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT PK_copy_watermark PRIMARY KEY (source, table_name)
);
GO
CREATE OR ALTER PROCEDURE dbo.usp_write_watermark
  @source nvarchar(256), @table_name nvarchar(256), @last_value nvarchar(256)
AS
BEGIN
  SET NOCOUNT ON;
  MERGE dbo.copy_watermark AS tgt
  USING (SELECT @source AS source, @table_name AS table_name) AS src
    ON tgt.source = src.source AND tgt.table_name = src.table_name
  WHEN MATCHED THEN UPDATE SET last_value = @last_value, updated_utc = SYSDATETIMEOFFSET()
  WHEN NOT MATCHED THEN INSERT (source, table_name, last_value) VALUES (@source, @table_name, @last_value);
END;
GO
SQL

# Optional grants — create contained DB users for the console UAMI + ADF MI.
if [ -n "${CONSOLE_UAMI}" ]; then
cat >> /tmp/ddl.sql <<SQL
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${CONSOLE_UAMI}')
  CREATE USER [${CONSOLE_UAMI}] FROM EXTERNAL PROVIDER;
ALTER ROLE db_owner ADD MEMBER [${CONSOLE_UAMI}];
GO
SQL
fi
if [ -n "${ADF_FACTORY}" ]; then
cat >> /tmp/ddl.sql <<SQL
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${ADF_FACTORY}')
  CREATE USER [${ADF_FACTORY}] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datareader ADD MEMBER [${ADF_FACTORY}];
ALTER ROLE db_datawriter ADD MEMBER [${ADF_FACTORY}];
GRANT EXECUTE ON dbo.usp_write_watermark TO [${ADF_FACTORY}];
GO
SQL
fi

echo "Applying control-table DDL to ${SQL_SERVER}/${SQL_DB}…"
sqlcmd -S "${SQL_SERVER}" -d "${SQL_DB}" \
  --authentication-method ActiveDirectoryManagedIdentity -U "${UAMI_CLIENT_ID}" \
  -i /tmp/ddl.sql

echo '{"status":"applied","table":"dbo.copy_watermark","proc":"dbo.usp_write_watermark"}' > "$AZ_SCRIPTS_OUTPUT_PATH"
'''
  }
}

output controlTableName string = 'dbo.copy_watermark'
output writeProcedureName string = 'dbo.usp_write_watermark'
