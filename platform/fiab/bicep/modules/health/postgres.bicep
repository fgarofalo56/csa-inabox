// CSA Loom Health Data Services (LHDS) - stamp PostgreSQL Flexible Server.
//
// One server per stamp, one database per tenant (ADR-003; databases are created
// by tenant.bicep, W1-2). Posture:
//   - private access: the server lives in a delegated subnet and resolves
//     through a private DNS zone THIS module creates. Passing a zone that does
//     not exist fails the deployment, so the zone is created and linked here.
//   - Entra-only authentication (no password to manage),
//   - CMK through a user-assigned identity assigned at creation (ADR-012),
//   - azure.extensions allow-lists the extensions the engines create
//     (W0-RECEIPT.md s1.3 obs 3),
//   - Premium SSD storage ('Premium_LRS'): SSD v2 was not offered in any Gov
//     region the W0 probe read (W0-RECEIPT.md s4.1b).
// Gov SKUs: Gov offers E-series v3/v4 only, so the stamp maps classes onto
// Standard_E*ds_v4 there; the caller passes the resolved SKU.

targetScope = 'resourceGroup'

@description('Region of the server. Gov default is usgovarizona (zone-redundant HA, W0-RECEIPT.md s4.1b); usgovvirginia is offer-restricted for the measured subscription.')
param location string

@description('Stamp short name; folded into resource names.')
param stampName string

@description('Server SKU name, for example Standard_D2ds_v5 (dev), Standard_E8ds_v5 (class S), Standard_E8ds_v4 (class S in Gov).')
param skuName string

@description('Compute tier matching the SKU family.')
@allowed(['GeneralPurpose', 'MemoryOptimized'])
param tier string

@description('PostgreSQL major version.')
@allowed(['17', '16', '15', '14'])
param postgresVersion string = '16'

@description('Storage in GB. Premium SSD ceiling is 32767 (32 TiB).')
@allowed([32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32767])
param storageSizeGB int

@description('High availability. ZoneRedundant needs a region that offers it (usgovarizona does; usgovtexas does not).')
@allowed(['Disabled', 'SameZone', 'ZoneRedundant'])
param highAvailabilityMode string = 'Disabled'

@description('Read replicas to create from the primary (class S 1, M and L 2). They share the delegated subnet and the CMK.')
@minValue(0)
@maxValue(5)
param replicaCount int = 0

@description('Backup retention in days.')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 35

@description('Delegated subnet for the server.')
param delegatedSubnetId string

@description('Resource id of the stamp VNet; linked to the private DNS zone this module creates.')
param vnetId string

@description('Name of the private DNS zone to create. Must end in postgres.database.<cloud suffix>; network.bicep computes it per cloud.')
param privateDnsZoneName string

@description('Additional VNets (for example the hub) linked to the private DNS zone so they resolve the server.')
param extraDnsLinkVnetIds array = []

@description('Resource id of the CMK user-assigned identity.')
param cmkIdentityId string

@description('Versionless key URI of the PostgreSQL CMK.')
param cmkKeyUri string

@description('Entra tenant id for authentication.')
param tenantId string = subscription().tenantId

@description('Object id of the Entra group set as server administrator. Empty = no administrator is created and the operator adds one.')
param adminEntraGroupId string = ''

@description('Display name of the administrator group.')
param adminEntraGroupName string = 'lhds-pg-admins'

@description('Extensions allow-listed through azure.extensions. These are what the FHIR/DICOM engines create (BTREE_GIN and PG_TRGM for search, BTREE_GIST for ranges, UNACCENT for name search).')
param extensions array = [
  'BTREE_GIN'
  'PG_TRGM'
  'BTREE_GIST'
  'UNACCENT'
]

@description('Log Analytics workspace id for diagnostics. Empty skips the diagnostic setting.')
param workspaceId string = ''

@description('Tags applied to every resource.')
param tags object = {}

var serverName = take('psql-lhds-${stampName}-${uniqueString(resourceGroup().id)}', 63)

resource dnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: privateDnsZoneName
  location: 'global'
  tags: tags
}

resource dnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: dnsZone
  name: 'link-stamp'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnetId }
  }
}

// @batchSize(1): concurrent link PUTs against one zone race in ARM.
@batchSize(1)
resource extraLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for v in extraDnsLinkVnetIds: {
  parent: dnsZone
  name: 'link-${uniqueString(v)}'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: v }
  }
  dependsOn: [
    dnsLink
  ]
}]

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: tier
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${cmkIdentityId}': {}
    }
  }
  properties: {
    version: postgresVersion
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
      type: 'Premium_LRS'
    }
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: tenantId
    }
    network: {
      delegatedSubnetResourceId: delegatedSubnetId
      privateDnsZoneArmResourceId: dnsZone.id
      publicNetworkAccess: 'Disabled'
    }
    highAvailability: {
      mode: highAvailabilityMode
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    dataEncryption: {
      type: 'AzureKeyVault'
      primaryKeyURI: cmkKeyUri
      primaryUserAssignedIdentityId: cmkIdentityId
    }
  }
  dependsOn: [
    dnsLink
  ]
}

resource admin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = if (!empty(adminEntraGroupId)) {
  parent: server
  name: adminEntraGroupId
  properties: {
    principalName: adminEntraGroupName
    principalType: 'Group'
    tenantId: tenantId
  }
}

// Server configuration writes must be sequential and follow the administrator
// write, or the Entra control-plane operation races a config-triggered update.
resource cfgExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'azure.extensions'
  properties: {
    value: join(extensions, ',')
    source: 'user-override'
  }
  dependsOn: [
    admin
  ]
}

// Replicas are created one at a time: a replica create locks the source.
@batchSize(1)
resource replicas 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = [for i in range(0, replicaCount): {
  name: take('${serverName}-r${i + 1}', 63)
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: tier
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${cmkIdentityId}': {}
    }
  }
  properties: {
    createMode: 'Replica'
    sourceServerResourceId: server.id
    network: {
      delegatedSubnetResourceId: delegatedSubnetId
      privateDnsZoneArmResourceId: dnsZone.id
      publicNetworkAccess: 'Disabled'
    }
    dataEncryption: {
      type: 'AzureKeyVault'
      primaryKeyURI: cmkKeyUri
      primaryUserAssignedIdentityId: cmkIdentityId
    }
  }
  dependsOn: [
    cfgExtensions
  ]
}]

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: server
  name: 'diag-lhds-postgres'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'PostgreSQLLogs', enabled: true }
      { category: 'PostgreSQLFlexSessions', enabled: true }
      { category: 'PostgreSQLFlexQueryStoreRuntime', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output serverId string = server.id
output serverName string = server.name
output fqdn string = server.properties.fullyQualifiedDomainName
output replicaNames array = [for i in range(0, replicaCount): replicas[i].name]
output privateDnsZoneId string = dnsZone.id
output extensionsAllowList string = cfgExtensions.properties.value
