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

@description('Enable Customer-Managed Key (CMK) encryption for the workspace.  Default false for dev.')
param parEnableCmk bool = false

@description('Key name in Key Vault for CMK encryption.  Required when parEnableCmk is true.')
param parCmkKeyName string = ''

@description('Key Vault resource URI for CMK (e.g. https://myvault.vault.azure.net).  Required when parEnableCmk is true.')
param parCmkKeyVaultUrl string = ''

@description('Attach a CanNotDelete resource lock to the Synapse workspace. Default true for production safety.')
param enableResourceLock bool = true

@description('Deploy a dedicated SQL pool (formerly SQL DW). Set to false to skip and save cost in dev/test.')
param enableSqlPool bool = false

@description('SKU name for the dedicated SQL pool (e.g. DW100c, DW200c). Only used when enableSqlPool is true.')
param sqlPoolSkuName string = 'DW100c'

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
// #checkov:skip=CKV_AZURE_72:Synapse workspace CMK encryption is optional for dev/lab — enable via parEnableCmk for prod
// #checkov:skip=CKV2_AZURE_19:Synapse audit logging configured via workspace-level diagnostic settings below
resource synapse 'Microsoft.Synapse/workspaces@2021-06-01-preview' = {
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
    encryption: parEnableCmk ? {
      cmk: {
        key: {
          name: parCmkKeyName
          keyVaultUrl: parCmkKeyVaultUrl
        }
      }
    } : null
    virtualNetworkProfile: {
      computeSubnetId: synapseComputeSubnetId
    }
  }
}

resource synapseSqlPool001 'Microsoft.Synapse/workspaces/sqlPools@2021-06-01-preview' = if (enableSqlPool) {
  parent: synapse
  name: 'sqlPool001'
  location: location
  tags: tags
  sku: {
    name: sqlPoolSkuName
  }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    createMode: 'Default'
    storageAccountType: 'GRS'
  }
}

resource synapseManagedIdentitySqlControlSettings 'Microsoft.Synapse/workspaces/managedIdentitySqlControlSettings@2021-06-01-preview' = {
  parent: synapse
  name: 'default'
  properties: {
    grantSqlControlToManagedIdentity: {
      desiredState: 'Enabled'
    }
  }
}

resource synapseAadAdministrators 'Microsoft.Synapse/workspaces/administrators@2021-06-01-preview' = if (!empty(synapseSqlAdminGroupName) && !empty(synapseSqlAdminGroupObjectID)) {
  parent: synapse
  name: 'activeDirectory'
  properties: {
    administratorType: 'ActiveDirectory'
    login: synapseSqlAdminGroupName
    sid: synapseSqlAdminGroupObjectID
    tenantId: subscription().tenantId
  }
}

resource synapsePrivateEndpointSql 'Microsoft.Network/privateEndpoints@2023-11-01' = [
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

resource synapsePrivateEndpointSqlARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = [
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

resource synapsePrivateEndpointSqlOnDemand 'Microsoft.Network/privateEndpoints@2023-11-01' = [
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

resource synapsePrivateEndpointSqlOnDemandARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = [
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

resource synapsePrivateEndpointDev 'Microsoft.Network/privateEndpoints@2023-11-01' = [
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

resource synapsePrivateEndpointDevARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = [
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

// Resource lock — protects the Synapse workspace from accidental deletion.
resource synapseLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: synapse
  name: '${synapseName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: data-lake Synapse workspace. Delete via the rollback workflow in docs/ROLLBACK.md.'
  }
}

// Outputs
output synapseId string = synapse.id
output synapseName string = synapse.name
output managedIdentityPrincipalId string = synapse.identity.principalId
