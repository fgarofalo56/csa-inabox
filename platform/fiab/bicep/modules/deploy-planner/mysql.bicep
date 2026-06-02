// CSA Loom deploy-planner — Azure Database for MySQL Flexible Server
//
// Wired by the deploy-planner catalog (key: mysql → mysqlEnabled).
// Self-contained: one flexible server + a starter database. Entra-only auth
// via the administrators child resource so there is no password secret.
//
// Grounded in Microsoft Learn:
//   Microsoft.DBforMySQL/flexibleServers  (Bicep resource definition)
//   https://learn.microsoft.com/azure/templates/microsoft.dbformysql/flexibleservers

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Flexible-server SKU name (Burstable B1ms is the cheapest functional size).')
param skuName string = 'Standard_B1ms'

@description('Compute tier for the SKU.')
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param tier string = 'Burstable'

@description('MySQL major version.')
@allowed(['5.7', '8.0.21'])
param mysqlVersion string = '8.0.21'

@description('Storage size in GB.')
@minValue(20)
@maxValue(16384)
param storageSizeGB int = 20

@description('Entra admin object ID (Loom Console UAMI principal ID). When set, an Entra administrator is created for token-only connections.')
param entraAdminObjectId string = ''

@description('Entra admin display name (UAMI name).')
param entraAdminName string = 'loom-console'

@description('Tenant ID for the Entra administrator.')
param tenantId string = tenant().tenantId

@description('Compliance tags applied to every resource.')
param complianceTags object

var serverName = take('mysql-loom-${uniqueString(resourceGroup().id)}', 63)

resource mysql 'Microsoft.DBforMySQL/flexibleServers@2023-12-30' = {
  name: serverName
  location: location
  tags: complianceTags
  sku: {
    name: skuName
    tier: tier
  }
  properties: {
    version: mysqlVersion
    storage: {
      storageSizeGB: storageSizeGB
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

// Entra administrator — Loom Console UAMI. Requires an identity assigned to the
// server, so attach the same UAMI as a user-assigned identity below.
resource mysqlAdmin 'Microsoft.DBforMySQL/flexibleServers/administrators@2023-12-30' = if (!empty(entraAdminObjectId)) {
  parent: mysql
  name: 'ActiveDirectory'
  properties: {
    administratorType: 'ActiveDirectory'
    login: entraAdminName
    sid: entraAdminObjectId
    tenantId: tenantId
  }
}

// Starter database so the relational editors have something to list.
resource mysqlDb 'Microsoft.DBforMySQL/flexibleServers/databases@2023-12-30' = {
  parent: mysql
  name: 'loom'
  properties: {
    charset: 'utf8mb4'
    collation: 'utf8mb4_unicode_ci'
  }
}

output serverId string = mysql.id
output serverName string = mysql.name
output serverFqdn string = mysql.properties.fullyQualifiedDomainName
output databaseName string = mysqlDb.name
