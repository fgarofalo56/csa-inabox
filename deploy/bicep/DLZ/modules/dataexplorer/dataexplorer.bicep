// Azure Data Explorer (Kusto) Module
// Deploys ADX cluster with databases, private endpoints, and diagnostic settings
targetScope = 'resourceGroup'

// Parameters
@description('Name of the Data Explorer cluster.')
param clusterName string

@description('Azure region for the cluster.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('SKU name for the cluster.')
@allowed([
  'Dev(No SLA)_Standard_E2a_v4'
  'Standard_E2ads_v5'
  'Standard_E4ads_v5'
  'Standard_E8ads_v5'
  'Standard_E16ads_v5'
  'Standard_D11_v2'
  'Standard_D12_v2'
  'Standard_D13_v2'
  'Standard_D14_v2'
  'Standard_L4s'
  'Standard_L8s'
  'Standard_L16s'
])
param skuName string = 'Dev(No SLA)_Standard_E2a_v4'

@description('Number of instances in the cluster.')
@minValue(1)
@maxValue(100)
param skuCapacity int = 1

@description('SKU tier.')
@allowed([
  'Basic'
  'Standard'
])
param skuTier string = 'Basic'

@description('Databases to create. Array of objects: { name, softDeletePeriod, hotCachePeriod }')
param databases array = []

@description('Enable streaming ingestion.')
param enableStreamingIngest bool = true

@description('Enable auto-stop for dev/test clusters.')
param enableAutoStop bool = true

@description('Public network access.')
@allowed([
  'Enabled'
  'Disabled'
])
param publicNetworkAccess string = 'Disabled'

@description('Private endpoint subnet configurations.')
param privateEndpointSubnets array = []

@description('Private DNS Zone ID for Data Explorer (privatelink.{region}.kusto.windows.net).')
param privateDnsZoneId string = ''

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Attach a CanNotDelete resource lock to the Data Explorer cluster. Default true for production safety.')
param enableResourceLock bool = true

@description('Enable Customer-Managed Key (CMK) encryption.  Default false for dev; set true for prod/compliance.')
param parEnableCmk bool = false

@description('Key Vault URI (e.g. https://myvault.vault.azure.net) when CMK is enabled.')
param parCmkKeyVaultUri string = ''

@description('Key name in the Key Vault for CMK encryption.')
param parCmkKeyName string = ''

@description('Key version.  Leave empty for automatic key rotation (recommended).')
param parCmkKeyVersion string = ''

@description('Resource ID of the user-assigned managed identity for CMK.  Created by cmkIdentity.bicep.')
param parCmkIdentityId string = ''

// Resources
resource kustoCluster 'Microsoft.Kusto/clusters@2023-08-15' = {
  name: clusterName
  location: location
  tags: tags
  sku: {
    name: skuName
    capacity: skuCapacity
    tier: skuTier
  }
  identity: {
    type: parEnableCmk ? 'SystemAssigned,UserAssigned' : 'SystemAssigned'
    userAssignedIdentities: parEnableCmk ? {
      '${parCmkIdentityId}': {}
    } : null
  }
  properties: {
    enableStreamingIngest: enableStreamingIngest
    enableAutoStop: enableAutoStop
    publicNetworkAccess: publicNetworkAccess
    enablePurge: false
    enableDoubleEncryption: true
    engineType: 'V3'
    restrictOutboundNetworkAccess: 'Enabled'
    keyVaultProperties: parEnableCmk ? {
      keyVaultUri: parCmkKeyVaultUri
      keyName: parCmkKeyName
      keyVersion: !empty(parCmkKeyVersion) ? parCmkKeyVersion : null
      userIdentity: parCmkIdentityId
    } : null
  }
}

// Databases
resource kustoDatabase 'Microsoft.Kusto/clusters/databases@2023-08-15' = [
  for db in databases: {
    parent: kustoCluster
    name: db.name
    location: location
    kind: 'ReadWrite'
    properties: {
      softDeletePeriod: contains(db, 'softDeletePeriod') ? db.softDeletePeriod : 'P365D'
      hotCachePeriod: contains(db, 'hotCachePeriod') ? db.hotCachePeriod : 'P31D'
    }
  }
]

// Private Endpoints
resource kustoPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = [
  for (peSubnet, index) in privateEndpointSubnets: {
    name: '${clusterName}-pe-${peSubnet.vNetName}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      privateLinkServiceConnections: [
        {
          name: '${clusterName}-cluster'
          properties: {
            privateLinkServiceId: kustoCluster.id
            groupIds: [
              'cluster'
            ]
          }
        }
      ]
      subnet: {
        id: resourceId(
          peSubnet.subscriptionId,
          peSubnet.vNetResourceGroup,
          'Microsoft.Network/virtualNetworks/subnets',
          peSubnet.vNetName,
          peSubnet.subnetName
        )
      }
    }
  }
]

resource kustoPeDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = [
  for (peSubnet, index) in privateEndpointSubnets: if (!empty(privateDnsZoneId)) {
    parent: kustoPrivateEndpoint[index]
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${clusterName}-dns-config'
          properties: {
            privateDnsZoneId: privateDnsZoneId
          }
        }
      ]
    }
  }
]

// Diagnostic Settings
resource kustoDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${clusterName}-diagnostics'
  scope: kustoCluster
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'SucceededIngestion', enabled: true }
      { category: 'FailedIngestion', enabled: true }
      { category: 'IngestionBatching', enabled: true }
      { category: 'Command', enabled: true }
      { category: 'Query', enabled: true }
      { category: 'TableUsageStatistics', enabled: true }
      { category: 'TableDetails', enabled: true }
      { category: 'Journal', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Resource lock — protects the Data Explorer cluster from accidental deletion.
resource kustoLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: kustoCluster
  name: '${clusterName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: Data Explorer cluster. Remove lock before deleting.'
  }
}

// Outputs
output clusterId string = kustoCluster.id

@description('URI of the Data Explorer cluster.')
output clusterUri string = kustoCluster.properties.uri

@description('Data ingestion URI.')
output dataIngestionUri string = kustoCluster.properties.dataIngestionUri

@description('Managed identity principal ID.')
output managedIdentityPrincipalId string = kustoCluster.identity.principalId

@description('Database resource IDs.')
output databaseIds array = [for (db, index) in databases: kustoDatabase[index].id]
