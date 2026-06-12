// CSA Loom — Weave (Semantic Ontology) graph store: Azure Database for
// PostgreSQL Flexible Server with the Apache AGE extension.
//
// Backs the Weave object/link/action *instance* write-back (lib/azure/
// weave-ontology-store.ts → ag_catalog cypher over the real PG wire protocol).
// Object instances are AGE vertices, link instances are AGE edges, action types
// run create/update/delete cypher in a PostgreSQL transaction (AGE is ACID).
//
// Default-on (weaveOntologyEnabled=true in the orchestrator) — Palantir-class
// ontology write-back REQUIRES a graph store, so this is provisioned by default
// (mirrors the cosmosGraphVectorEnabled default-on rationale). Set false to skip
// the ~1 Burstable PG flexible server / DLZ.
//
// Entra-only auth (passwordAuth disabled) so there is NO secret to manage — the
// Loom Console UAMI is the Entra administrator and connects token-only (scope
// https://ossrdbms-aad.database.azure.com/.default). This mirrors the proven
// deploy-planner/postgres.bicep pattern (public network + Entra-only + firewall),
// which the postgres-flex-client.ts query path already authenticates against.
//
// Apache AGE grounding (Microsoft Learn):
//   azure/postgresql/azure-ai/generative-ai-age-overview
//   azure/postgresql/extensions/concepts-extensions-considerations
//   - shared_preload_libraries MUST include AGE (else the cypher() call errors
//     with "unhandled cypher(cstring) function call"). Setting it triggers an
//     automatic server restart — the post-deploy bootstrap waits for Ready.
//   - azure.extensions must allowlist AGE before CREATE EXTENSION AGE works.
//   - age is Preview; PG16 → AGE 1.6.0 (pin postgresVersion '16').

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Cloud boundary — drives the PG data-plane host suffix (postgres.database.azure.com vs postgres.database.usgovcloudapi.net) wired to the Console.')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string = 'Commercial'

@description('Domain name (DLZ slug) — folded into the deterministic server name.')
param domainName string = 'default'

@description('Flexible-server SKU name (Burstable B1ms is the cheapest functional size).')
param skuName string = 'Standard_B1ms'

@description('Compute tier for the SKU.')
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param tier string = 'Burstable'

@description('PostgreSQL major version. AGE on PG16 is version 1.6.0 (Preview).')
@allowed(['16'])
param postgresVersion string = '16'

@description('Storage size in GB.')
@allowed([32, 64, 128, 256, 512])
param storageSizeGB int = 32

@description('Console UAMI principal (object) ID — set as the Entra administrator so the BFF connects token-only. Empty → server is created Entra-only with no admin (operator wires one post-deploy).')
param consolePrincipalId string = ''

@description('Entra admin display name (the Console UAMI name). The post-deploy bootstrap registers this as a PG principal via pgaadauth_create_principal and sets LOOM_POSTGRES_AAD_USER.')
param entraAdminName string = 'loom-console'

@description('Tenant ID for the Entra administrator.')
param tenantId string = tenant().tenantId

@description('Log Analytics workspace ID for diagnostic settings.')
param workspaceId string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object

var serverName = take('psql-loom-weave-${domainName}-${uniqueString(resourceGroup().id)}', 63)
var weaveDatabaseName = 'loom-weave'

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
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
      publicNetworkAccess: 'Enabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

// Entra administrator — Loom Console UAMI (so the BFF can connect token-only).
resource pgAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = if (!empty(consolePrincipalId)) {
  parent: pg
  name: consolePrincipalId
  properties: {
    principalName: entraAdminName
    principalType: 'ServicePrincipal'
    tenantId: tenantId
  }
}

// AGE prerequisite #1: load the AGE library at server start. Setting
// shared_preload_libraries triggers an automatic restart — the post-deploy
// bootstrap polls getServer until state == 'Ready' before CREATE EXTENSION.
resource cfgPreload 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: pg
  name: 'shared_preload_libraries'
  properties: {
    value: 'AGE'
    source: 'user-override'
  }
}

// AGE prerequisite #2: allowlist the AGE extension so CREATE EXTENSION succeeds.
// Sequenced after the preload config so the two configuration writes don't race
// (PG flexible-server serialises configuration changes; an explicit dependsOn
// makes the order deterministic in the ARM graph).
resource cfgExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: pg
  name: 'azure.extensions'
  properties: {
    value: 'AGE'
    source: 'user-override'
  }
  dependsOn: [
    cfgPreload
  ]
}

// Allow Azure-internal services (Container Apps egress) to reach the server.
// The Console runs in-VNet; this 0.0.0.0 rule is the Azure-services special
// case (start==end==0.0.0.0) — Entra-only auth still gates every connection,
// so there is no anonymous access. Mirrors the deploy-planner firewall pattern.
resource fwAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// Starter database for the Weave graph (the bootstrap creates the AGE graph here).
resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: weaveDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Diagnostic settings → Loom LAW (skipped when no workspace is wired).
resource pgDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: pg
  name: 'diag-loom-weave'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'PostgreSQLLogs', enabled: true }
      { category: 'PostgreSQLFlexSessions', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

// PG data-plane host suffix is sovereign-cloud-specific: Commercial / GCC use
// postgres.database.azure.com; GCC-High / IL5 use postgres.database.usgovcloudapi.net.
// fullyQualifiedDomainName from ARM already carries the right suffix per cloud,
// so we emit it directly — this var is documentation of the per-cloud contract
// the Console's LOOM_POSTGRES_HOST_SUFFIX / LOOM_POSTGRES_AAD_SCOPE mirror.
var pgHostSuffix = (boundary == 'GCC-High' || boundary == 'IL5') ? 'postgres.database.usgovcloudapi.net' : 'postgres.database.azure.com'

output weavePgServerName string = pg.name
output weavePgFqdn string = pg.properties.fullyQualifiedDomainName
output weavePgDatabase string = pgDb.name
output weavePgHostSuffix string = pgHostSuffix
