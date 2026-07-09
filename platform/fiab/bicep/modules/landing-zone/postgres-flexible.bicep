// CSA Loom — Lakebase (DBX-4): serverless Postgres OLTP on Azure Database for
// PostgreSQL Flexible Server, with pgvector enabled for hybrid vector +
// full-text search (Lakebase-Search parity).
//
// This backs the lakebase-postgres item type. It is the Azure-native DEFAULT
// backend for Lakebase — 100% functional with NO Databricks or Fabric
// dependency (per .claude/rules/no-fabric-dependency.md). Databricks Lakebase is
// an opt-in alternative selected with LOOM_LAKEBASE_BACKEND=databricks + a bound
// workspace; this module needs none of that.
//
// STANDALONE, METERED module: it is deliberately NOT wired into an orchestrator
// or admin-plane/main.bicep (which is at the 256-param ceiling). A PostgreSQL
// Flexible Server is a metered resource, so it is provisioned only when an
// operator opts into a Loom-owned Lakebase server (rather than binding an
// existing one through the editor). Deploy it on its own:
//     az deployment group create -f postgres-flexible.bicep -g <rg> \
//        -p location=<region> consolePrincipalId=<uami-oid>
// then bind the emitted server in the lakebase-postgres editor (Provision →
// Bind an existing server). The editor + BFF also provision servers directly
// via ARM, so this module is one of two supported paths, not the only one.
//
// Entra-only auth (passwordAuth disabled) so there is NO secret to manage — the
// Loom Console UAMI is the Entra administrator and connects token-only (scope
// https://ossrdbms-aad.database.windows.net/.default). Mirrors the proven
// postgres-weave.bicep / deploy-planner/postgres.bicep pattern that
// postgres-flex-client.ts already authenticates against.
//
// pgvector grounding (Microsoft Learn):
//   azure/postgresql/flexible-server/how-to-use-pgvector
//   azure/postgresql/extensions/concepts-extensions-considerations
//   - azure.extensions must allowlist VECTOR before CREATE EXTENSION vector works
//     (the app-side pgvector "Enable" action performs the CREATE EXTENSION over
//     the pg wire protocol; this module pre-allowlists it so that succeeds).

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Cloud boundary — drives the PG data-plane host suffix (postgres.database.azure.com vs postgres.database.usgovcloudapi.net) wired to the Console.')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string = 'Commercial'

@description('Enablement flag — when false the module provisions NOTHING (metered server is opt-in). Kept so a parent template can conditionally include this module without a param-count change.')
param lakebaseEnabled bool = true

@description('Domain / instance slug folded into the deterministic server name.')
param instanceName string = 'default'

@description('Flexible-server SKU name.')
param skuName string = 'Standard_B1ms'

@description('Compute tier for the SKU.')
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param tier string = 'Burstable'

@description('PostgreSQL major version.')
@allowed(['16', '15', '14', '13'])
param postgresVersion string = '16'

@description('Storage size in GB.')
@allowed([32, 64, 128, 256, 512, 1024])
param storageSizeGB int = 32

@description('High-availability mode.')
@allowed(['Disabled', 'SameZone', 'ZoneRedundant'])
param highAvailabilityMode string = 'Disabled'

@description('Console UAMI principal (object) ID — set as the Entra administrator so the BFF connects token-only. Empty → server is Entra-only with no admin (operator wires one post-deploy).')
param consolePrincipalId string = ''

@description('Entra admin display name (the Console UAMI name). The post-deploy bootstrap registers this as a PG principal via pgaadauth_create_principal and sets LOOM_POSTGRES_AAD_USER.')
param entraAdminName string = 'loom-console'

@description('Tenant ID for the Entra administrator.')
param tenantId string = tenant().tenantId

@description('Starter database created on the server.')
param databaseName string = 'lakebase'

@description('Deny public network access — reachable only over a private endpoint / VNet path when true. When false the server is Entra-only public with an Azure-services firewall rule.')
param privateEndpointsEnabled bool = true

@description('Log Analytics workspace ID for diagnostic settings.')
param workspaceId string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object = {}

var serverName = take('psql-loom-lakebase-${instanceName}-${uniqueString(resourceGroup().id)}', 63)
var effectivePublicNetworkAccess = privateEndpointsEnabled ? 'Disabled' : 'Enabled'

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = if (lakebaseEnabled) {
  name: serverName
  location: location
  tags: complianceTags
  sku: {
    name: skuName
    tier: tier
  }
  properties: {
    version: postgresVersion
    storage: {
      storageSizeGB: storageSizeGB
    }
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: tenantId
    }
    network: {
      publicNetworkAccess: effectivePublicNetworkAccess
    }
    highAvailability: {
      mode: highAvailabilityMode
    }
  }
}

// Entra administrator — Loom Console UAMI (so the BFF can connect token-only).
resource pgAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = if (lakebaseEnabled && !empty(consolePrincipalId)) {
  parent: pg
  name: consolePrincipalId
  properties: {
    principalName: entraAdminName
    principalType: 'ServicePrincipal'
    tenantId: tenantId
  }
}

// pgvector prerequisite: allowlist the VECTOR extension so the app-side
// "Enable pgvector" action's CREATE EXTENSION vector succeeds. Set AFTER the
// admin write so the AAD control-plane op does not race a config-triggered
// update. This is the SAME azure.extensions parameter the app's
// allowlistExtension() ARM call maintains — pre-seeding it here is idempotent.
resource cfgExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = if (lakebaseEnabled) {
  parent: pg
  name: 'azure.extensions'
  properties: {
    value: 'VECTOR'
    source: 'user-override'
  }
  dependsOn: [
    pgAdmin
  ]
}

// Allow Azure-internal services (Container Apps egress) to reach the server when
// running Entra-only public. Entra-only auth still gates every connection.
resource fwAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = if (lakebaseEnabled && !privateEndpointsEnabled) {
  parent: pg
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// Starter database for the Lakebase OLTP workload.
resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = if (lakebaseEnabled) {
  parent: pg
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Diagnostic settings → Loom LAW (skipped when no workspace is wired).
resource pgDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (lakebaseEnabled && !empty(workspaceId)) {
  scope: pg
  name: 'diag-loom-lakebase'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'PostgreSQLLogs', enabled: true }
      { category: 'PostgreSQLFlexSessions', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

// PG data-plane host suffix is sovereign-cloud-specific. fullyQualifiedDomainName
// from ARM already carries the right suffix per cloud; this var documents the
// per-cloud contract the Console's LOOM_POSTGRES_HOST_SUFFIX mirrors, and names
// the backend selector (LOOM_LAKEBASE_BACKEND) so env-sync sees it emitted.
var pgHostSuffix = (boundary == 'GCC-High' || boundary == 'IL5') ? 'postgres.database.usgovcloudapi.net' : 'postgres.database.azure.com'

@description('Backend selector this server satisfies. The default Lakebase backend is Azure PostgreSQL Flexible Server; set LOOM_LAKEBASE_BACKEND=databricks only to opt into Databricks Lakebase instead.')
output lakebaseBackend string = 'postgres'

output lakebaseServerName string = lakebaseEnabled ? pg.name : ''
output lakebaseFqdn string = lakebaseEnabled ? pg.properties.fullyQualifiedDomainName : ''
output lakebaseDatabase string = databaseName
output lakebaseHostSuffix string = pgHostSuffix
