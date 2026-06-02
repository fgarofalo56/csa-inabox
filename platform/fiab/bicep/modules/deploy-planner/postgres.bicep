// CSA Loom deploy-planner — Azure Database for PostgreSQL Flexible Server
//
// Wired by the deploy-planner catalog (key: postgres → postgresEnabled).
// Self-contained: provisions one flexible server + a starter database so the
// Loom relational-store editors have a real ARM object to bind to. Entra-only
// auth (passwordAuth disabled) so there is no secret to manage — the Loom
// Console UAMI is set as the Entra administrator.
//
// Grounded in Microsoft Learn:
//   Microsoft.DBforPostgreSQL/flexibleServers  (Bicep resource definition)
//   https://learn.microsoft.com/azure/templates/microsoft.dbforpostgresql/flexibleservers

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Flexible-server SKU name (Burstable B1ms is the cheapest functional size).')
param skuName string = 'Standard_B1ms'

@description('Compute tier for the SKU.')
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param tier string = 'Burstable'

@description('PostgreSQL major version.')
@allowed(['13', '14', '15', '16'])
param postgresVersion string = '16'

@description('Storage size in GB.')
@allowed([32, 64, 128, 256, 512])
param storageSizeGB int = 32

@description('Entra admin object ID (Loom Console UAMI principal ID). When set, the server is created with Entra-only auth and this principal as admin. Empty → public/password auth fallback is NOT used; instead an Entra-only server with no admin is created (operator wires one in the editor).')
param entraAdminObjectId string = ''

@description('Entra admin display name (UAMI name). Required when entraAdminObjectId is set.')
param entraAdminName string = 'loom-console'

@description('Tenant ID for the Entra administrator.')
param tenantId string = tenant().tenantId

@description('Compliance tags applied to every resource.')
param complianceTags object

var serverName = take('psql-loom-${uniqueString(resourceGroup().id)}', 63)

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
resource pgAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = if (!empty(entraAdminObjectId)) {
  parent: pg
  name: entraAdminObjectId
  properties: {
    principalName: entraAdminName
    principalType: 'ServicePrincipal'
    tenantId: tenantId
  }
}

// Starter database so the relational editors have something to list.
resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'loom'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

output serverId string = pg.id
output serverName string = pg.name
output serverFqdn string = pg.properties.fullyQualifiedDomainName
output databaseName string = pgDb.name
