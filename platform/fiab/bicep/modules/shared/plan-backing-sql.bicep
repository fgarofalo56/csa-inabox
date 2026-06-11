// CSA Loom — Plan (preview) backing SQL database (audit-T64)
//
// Azure-native parity of Microsoft Fabric Plan's auto-provisioned **Fabric SQL
// database**. Fabric creates a SQL database when you create a Plan item, to hold
// plan metadata and to receive planning-sheet writeback
// (/fabric/iq/plan/planning-writeback/planning-how-to-persist-data). Loom does
// the same with an **Azure SQL Database** — NO Microsoft Fabric dependency
// (.claude/rules/no-fabric-dependency.md). Planning cells always persist to
// Cosmos first; this database is the governed, queryable writeback target
// (dbo.loom_plan_cells, created idempotently by the writeback BFF on first POST).
//
// Provisions a database on an EXISTING Azure SQL logical server (the platform
// already deploys one for the unified SQL editor — see main.bicep). No new
// server / admin credential is created here, so the module is credential-free
// and safe to (re)deploy. The Console UAMI authenticates with its AAD token; a
// db_ddladmin + db_datawriter grant is applied at the database data-plane via
// the post-deploy bootstrap (the UAMI is already the server's Entra admin on the
// platform server, so the writeback MERGE works out of the box there).
//
// Wire-up: set LOOM_PLAN_BACKING_SQL_SERVER + LOOM_PLAN_BACKING_SQL_DATABASE on
// the Console app (admin-plane/main.bicep already emits both env vars).
//
// Refs:
//   Microsoft.Sql/servers/databases — https://learn.microsoft.com/azure/templates/microsoft.sql/servers/databases
//   Serverless General Purpose tier — https://learn.microsoft.com/azure/azure-sql/database/serverless-tier-overview

targetScope = 'resourceGroup'

@description('Name of the EXISTING Azure SQL logical server (in this resource group) that will host the Plan backing database.')
param sqlServerName string

@description('Name of the Plan backing database to create.')
param databaseName string = 'loom-plan'

@description('Azure region for the database. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Max data size in bytes (default 2 GB — plan metadata is tiny).')
param maxSizeBytes int = 2147483648

@description('Auto-pause delay in minutes for the serverless database (-1 disables auto-pause). 60 = pause after an hour idle to minimise cost.')
param autoPauseDelayMinutes int = 60

// Reference the already-deployed logical server.
resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' existing = {
  name: sqlServerName
}

// Serverless General Purpose database — scales to near-zero cost when idle,
// which suits the bursty, low-volume Plan writeback workload.
resource planDb 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: databaseName
  location: location
  sku: {
    name: 'GP_S_Gen5_1'
    tier: 'GeneralPurpose'
    family: 'Gen5'
    capacity: 1
  }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    maxSizeBytes: maxSizeBytes
    autoPauseDelay: autoPauseDelayMinutes
    minCapacity: json('0.5')
    zoneRedundant: false
    readScale: 'Disabled'
  }
}

@description('Server name to set as LOOM_PLAN_BACKING_SQL_SERVER.')
output backingSqlServer string = sqlServerName

@description('Database name to set as LOOM_PLAN_BACKING_SQL_DATABASE.')
output backingSqlDatabase string = planDb.name
