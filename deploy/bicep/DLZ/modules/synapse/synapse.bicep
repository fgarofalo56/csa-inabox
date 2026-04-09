// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used to create a Synapse workspace.
targetScope = 'resourceGroup'

// Parameters
param location string
param tags object
param synapseName string
param administratorUsername string = 'SqlServerMainUser'
@secure()
param administratorPassword string
param synapseSqlAdminGroupName string = ''
param synapseSqlAdminGroupObjectID string = ''
param synapseDefaultStorageAccountFileSystemId string
param synapseComputeSubnetId string = ''
param privateDnsZoneIdSynapseSql string = ''
param privateDnsZoneIdSynapseDev string = ''
param privateEndpointSubnets array
@description('Purview resource ID for lineage integration (optional)')
param purviewId string = ''
@description('Log Analytics workspace resource ID for diagnostic settings')
param logAnalyticsWorkspaceId string = ''

// Variables
var synapseDefaultStorageAccountFileSystemName = length(split(synapseDefaultStorageAccountFileSystemId, '/')) >= 13
  ? last(split(synapseDefaultStorageAccountFileSystemId, '/'))
  : 'incorrectSegmentLength'
var synapseDefaultStorageAccountName = length(split(synapseDefaultStorageAccountFileSystemId, '/')) >= 13
  ? split(synapseDefaultStorageAccountFileSystemId, '/')[8]
  : 'incorrectSegmentLength'
var synapsePrivateEndpointNameSql = '${synapse.name}-sql-private-endpoint'
var synapsePrivateEndpointNameSqlOnDemand = '${synapse.name}-sqlondemand-private-endpoint'
var synapsePrivateEndpointNameDev = '${synapse.name}-dev-private-endpoint'

// Resources
resource synapse 'Microsoft.Synapse/workspaces@2021-03-01' = {
  name: synapseName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    defaultDataLakeStorage: {
      accountUrl: 'https://${synapseDefaultStorageAccountName}.dfs.${environment().suffixes.storage}'
      filesystem: synapseDefaultStorageAccountFileSystemName
    }
    managedResourceGroupName: synapseName
    managedVirtualNetwork: 'default'
    managedVirtualNetworkSettings: {
      allowedAadTenantIdsForLinking: []
      linkedAccessCheckOnTargetResource: true
      preventDataExfiltration: true
    }
    publicNetworkAccess: 'Disabled'
    purviewConfiguration: !empty(purviewId) ? {
      purviewResourceId: purviewId
    } : null
    sqlAdministratorLogin: administratorUsername
    sqlAdministratorLoginPassword: administratorPassword
    virtualNetworkProfile: {
      computeSubnetId: synapseComputeSubnetId
    }
  }
}

resource synapseSqlPool001 'Microsoft.Synapse/workspaces/sqlPools@2021-03-01' = {
  // Uncomment if you want to deploy a Synapse Spark Pool as part of your Data Landing Zone inside the shared product resource group
  parent: synapse
  name: 'sqlPool001'
  location: location
  tags: tags
  sku: {
    name: 'DW100c'
  }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    createMode: 'Default'
    storageAccountType: 'GRS'
  }
}

// resource synapseBigDataPool001 'Microsoft.Synapse/workspaces/bigDataPools@2021-03-01' = {  // Uncomment if you want to deploy a Synapse SQL Pool as part of your Data Landing Zone inside the shared product resource group
//   parent: synapse
//   name: 'bigDataPool001'
//   location: location
//   tags: tags
//   properties: {
//     autoPause: {
//       enabled: true
//       delayInMinutes: 15
//     }
//     autoScale: {
//       enabled: true
//       minNodeCount: 3
//       maxNodeCount: 10
//     }
//     // cacheSize: 100  // Uncomment to set a specific cache size
//     customLibraries: []
//     defaultSparkLogFolder: 'logs/'
//     dynamicExecutorAllocation: {
//       enabled: true
//       minExecutors: 1
//       maxExecutors: 9
//     }
//     // isComputeIsolationEnabled: true  // Uncomment to enable compute isolation (only available in selective regions)
//     // libraryRequirements: {  // Uncomment to install pip dependencies on the Spark cluster
//     //   content: ''
//     //   filename: 'requirements.txt'
//     // }
//     nodeSize: 'Small'
//     nodeSizeFamily: 'MemoryOptimized'
//     sessionLevelPackagesEnabled: true
//     // sparkConfigProperties: {  // Uncomment to set spark conf on the Spark cluster
//     //   content: ''
//     //   filename: 'spark.conf'
//     // }
//     sparkEventsFolder: 'events/'
//     sparkVersion: '3.1'
//   }
// }

resource synapseManagedIdentitySqlControlSettings 'Microsoft.Synapse/workspaces/managedIdentitySqlControlSettings@2021-03-01' = {
  parent: synapse
  name: 'default'
  properties: {
    grantSqlControlToManagedIdentity: {
      desiredState: 'Enabled'
    }
  }
}

resource synapseAadAdministrators 'Microsoft.Synapse/workspaces/administrators@2021-03-01' = if (!empty(synapseSqlAdminGroupName) && !empty(synapseSqlAdminGroupObjectID)) {
  parent: synapse
  name: 'activeDirectory'
  properties: {
    administratorType: 'ActiveDirectory'
    login: synapseSqlAdminGroupName
    sid: synapseSqlAdminGroupObjectID
    tenantId: subscription().tenantId
  }
}

resource synapsePrivateEndpointSql 'Microsoft.Network/privateEndpoints@2020-11-01' = [
  for peSubnet in privateEndpointSubnets: {
    name: '${synapsePrivateEndpointNameSql}-${peSubnet.vNetName}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      manualPrivateLinkServiceConnections: []
      privateLinkServiceConnections: [
        {
          name: synapsePrivateEndpointNameSql
          properties: {
            groupIds: [
              'Sql'
            ]
            privateLinkServiceId: synapse.id
            requestMessage: ''
          }
        }
      ]
      subnet: {
        id: resourceId(
          subscription().subscriptionId,
          peSubnet.vNetResourceGroup,
          'Microsoft.Network/virtualNetworks/subnets',
          peSubnet.vNetName,
          peSubnet.subnetName
        )
      }
    }
  }
]

resource synapsePrivateEndpointSqlARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2020-11-01' = [
  for (peSubnet, i) in privateEndpointSubnets: if (!empty(privateDnsZoneIdSynapseSql)) {
    name: 'default'
    parent: synapsePrivateEndpointSql[i]
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${synapsePrivateEndpointNameSql}-${peSubnet.vNetName}-arecord'
          properties: {
            privateDnsZoneId: privateDnsZoneIdSynapseSql
          }
        }
      ]
    }
  }
]

resource synapsePrivateEndpointSqlOnDemand 'Microsoft.Network/privateEndpoints@2020-11-01' = [
  for peSubnet in privateEndpointSubnets: {
    name: '${synapsePrivateEndpointNameSqlOnDemand}-${peSubnet.vNetName}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      manualPrivateLinkServiceConnections: []
      privateLinkServiceConnections: [
        {
          name: synapsePrivateEndpointNameSqlOnDemand
          properties: {
            groupIds: [
              'SqlOnDemand'
            ]
            privateLinkServiceId: synapse.id
            requestMessage: ''
          }
        }
      ]
      subnet: {
        id: resourceId(
          subscription().subscriptionId,
          peSubnet.vNetResourceGroup,
          'Microsoft.Network/virtualNetworks/subnets',
          peSubnet.vNetName,
          peSubnet.subnetName
        )
      }
    }
  }
]

resource synapsePrivateEndpointSqlOnDemandARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2020-11-01' = [
  for (peSubnet, i) in privateEndpointSubnets: if (!empty(privateDnsZoneIdSynapseSql)) {
    name: 'default'
    parent: synapsePrivateEndpointSqlOnDemand[i]
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${synapsePrivateEndpointNameSqlOnDemand}-${peSubnet.vNetName}-arecord'
          properties: {
            privateDnsZoneId: privateDnsZoneIdSynapseSql
          }
        }
      ]
    }
  }
]

resource synapsePrivateEndpointDev 'Microsoft.Network/privateEndpoints@2020-11-01' = [
  for peSubnet in privateEndpointSubnets: {
    name: '${synapsePrivateEndpointNameDev}-${peSubnet.vNetName}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      manualPrivateLinkServiceConnections: []
      privateLinkServiceConnections: [
        {
          name: synapsePrivateEndpointNameDev
          properties: {
            groupIds: [
              'Dev'
            ]
            privateLinkServiceId: synapse.id
            requestMessage: ''
          }
        }
      ]
      subnet: {
        id: resourceId(
          subscription().subscriptionId,
          peSubnet.vNetResourceGroup,
          'Microsoft.Network/virtualNetworks/subnets',
          peSubnet.vNetName,
          peSubnet.subnetName
        )
      }
    }
  }
]

resource synapsePrivateEndpointDevARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2020-11-01' = [
  for (peSubnet, i) in privateEndpointSubnets: if (!empty(privateDnsZoneIdSynapseDev)) {
    name: 'default'
    parent: synapsePrivateEndpointDev[i]
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${synapsePrivateEndpointNameDev}-${peSubnet.vNetName}-arecord'
          properties: {
            privateDnsZoneId: privateDnsZoneIdSynapseDev
          }
        }
      ]
    }
  }
]

// Diagnostic Settings
resource synapseDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${synapse.name}-diagnostics'
  scope: synapse
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Outputs
output synapseId string = synapse.id
output synapseName string = synapse.name
output managedIdentityPrincipalId string = synapse.identity.principalId
