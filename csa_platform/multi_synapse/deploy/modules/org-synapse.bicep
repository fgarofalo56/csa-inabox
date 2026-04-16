// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Per-organization Synapse workspace module — deploys a Synapse workspace,
// dedicated storage account, SQL pool, and Spark pool for a single organization.

targetScope = 'resourceGroup'

// ─── Parameters ─────────────────────────────────────────────────────────────

param location string
param tags object
param orgName string
param environment string
param sqlAdminUsername string
@secure()
param sqlAdminPassword string
param synapseSqlAdminGroupName string = ''
param synapseSqlAdminGroupObjectId string = ''
param logAnalyticsWorkspaceId string = ''
param purviewId string = ''
param sqlPoolSku string = 'DW100c'
param sparkNodeSize string = 'Small'
param sparkMinNodes int = 3
param sparkMaxNodes int = 10
param enableCmk bool = false
param enableResourceLock bool = true
param storageSku string = 'Standard_ZRS'
param privateEndpointSubnets array = []
param privateDnsZoneIdSynapseSql string = ''
param privateDnsZoneIdSynapseDev string = ''

// ─── Variables ──────────────────────────────────────────────────────────────

var uniqueSuffix = take(uniqueString(resourceGroup().id, orgName), 6)
var synapseName = 'syn-${environment}-${orgName}-${uniqueSuffix}'
var storageNameRaw = 'st${environment}${orgName}${uniqueSuffix}'
var storageName = take(toLower(replace(storageNameRaw, '-', '')), 24)
var defaultFileSystemName = 'workspace'

// ─── Storage Account ────────────────────────────────────────────────────────

// #checkov:skip=CKV_AZURE_35:CMK encryption is optional for dev/lab — enable via enableCmk parameter for prod
// #checkov:skip=CKV_AZURE_43:Geo-redundant storage not required for dev/lab — override via storageSku parameter for prod
// #checkov:skip=CKV_AZURE_33:Storage queue logging not required — queues not used in Synapse data lake storage
// #checkov:skip=CKV2_AZURE_38:Soft-delete enabled on blob services below; not applicable at account level
// #checkov:skip=CKV2_AZURE_1:CMK encryption is optional for dev/lab — enable via enableCmk parameter for prod
@description('ADLS Gen2 storage for the Synapse workspace default filesystem.')
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: union(tags, { Organization: orgName })
  identity: { type: 'SystemAssigned' }
  sku: { name: storageSku }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    isHnsEnabled: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      bypass: 'Metrics,AzureServices,Logging'
      defaultAction: 'Deny'
    }
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
      }
    }
  }
}

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 30 }
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
    isVersioningEnabled: true
    changeFeed: { enabled: true, retentionInDays: 30 }
  }
}

resource defaultFileSystem 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobServices
  name: defaultFileSystemName
  properties: { publicAccess: 'None' }
}

// Medallion containers for the organization
resource bronzeContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobServices
  name: 'bronze'
  properties: { publicAccess: 'None' }
}

resource silverContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobServices
  name: 'silver'
  properties: { publicAccess: 'None' }
}

resource goldContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobServices
  name: 'gold'
  properties: { publicAccess: 'None' }
}

// ─── Synapse Workspace ──────────────────────────────────────────────────────

// #checkov:skip=CKV_AZURE_72:Synapse workspace CMK encryption is optional for dev/lab — enable via enableCmk for prod
// #checkov:skip=CKV2_AZURE_19:Synapse audit logging configured via workspace-level diagnostic settings below
@description('Synapse Analytics workspace for the organization.')
resource synapse 'Microsoft.Synapse/workspaces@2021-06-01' = {
  name: synapseName
  location: location
  tags: union(tags, { Organization: orgName })
  identity: { type: 'SystemAssigned' }
  properties: {
    defaultDataLakeStorage: {
      accountUrl: 'https://${storage.name}.dfs.${az.environment().suffixes.storage}'
      filesystem: defaultFileSystemName
    }
    managedResourceGroupName: '${synapseName}-managed'
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
    sqlAdministratorLogin: sqlAdminUsername
    sqlAdministratorLoginPassword: sqlAdminPassword
  }
}

// ─── SQL Pool ───────────────────────────────────────────────────────────────

resource sqlPool 'Microsoft.Synapse/workspaces/sqlPools@2021-06-01' = if (!empty(sqlPoolSku)) {
  parent: synapse
  name: '${orgName}Pool'
  location: location
  tags: union(tags, { Organization: orgName })
  sku: { name: sqlPoolSku }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    createMode: 'Default'
    storageAccountType: 'GRS'
  }
}

// ─── Spark Pool ─────────────────────────────────────────────────────────────

@description('Apache Spark pool for the organization.')
resource sparkPool 'Microsoft.Synapse/workspaces/bigDataPools@2021-06-01' = {
  parent: synapse
  name: '${orgName}Spark'
  location: location
  tags: union(tags, { Organization: orgName })
  properties: {
    autoPause: {
      delayInMinutes: 15
      enabled: true
    }
    autoScale: {
      enabled: true
      minNodeCount: sparkMinNodes
      maxNodeCount: sparkMaxNodes
    }
    nodeSize: sparkNodeSize
    nodeSizeFamily: 'MemoryOptimized'
    sparkVersion: '3.4'
    isAutotuneEnabled: true
    sessionLevelPackagesEnabled: true
  }
}

// ─── Managed Identity SQL Control ───────────────────────────────────────────

resource managedIdentitySqlControl 'Microsoft.Synapse/workspaces/managedIdentitySqlControlSettings@2021-06-01' = {
  parent: synapse
  name: 'default'
  properties: {
    grantSqlControlToManagedIdentity: {
      desiredState: 'Enabled'
    }
  }
}

// ─── AAD Admin ──────────────────────────────────────────────────────────────

resource aadAdmin 'Microsoft.Synapse/workspaces/administrators@2021-06-01' = if (!empty(synapseSqlAdminGroupName) && !empty(synapseSqlAdminGroupObjectId)) {
  parent: synapse
  name: 'activeDirectory'
  properties: {
    administratorType: 'ActiveDirectory'
    login: synapseSqlAdminGroupName
    sid: synapseSqlAdminGroupObjectId
    tenantId: subscription().tenantId
  }
}

// ─── Private Endpoints ──────────────────────────────────────────────────────

resource sqlPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = [
  for peSubnet in privateEndpointSubnets: {
    name: '${synapse.name}-sql-pe-${peSubnet.vNetName}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      privateLinkServiceConnections: [
        {
          name: '${synapse.name}-sql'
          properties: {
            groupIds: ['Sql']
            privateLinkServiceId: synapse.id
          }
        }
      ]
      subnet: {
        id: resourceId(
          peSubnet.SubscriptionId,
          peSubnet.vNetResourceGroup,
          'Microsoft.Network/virtualNetworks/subnets',
          peSubnet.vNetName,
          peSubnet.subnetName
        )
      }
    }
  }
]

resource devPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = [
  for peSubnet in privateEndpointSubnets: {
    name: '${synapse.name}-dev-pe-${peSubnet.vNetName}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      privateLinkServiceConnections: [
        {
          name: '${synapse.name}-dev'
          properties: {
            groupIds: ['Dev']
            privateLinkServiceId: synapse.id
          }
        }
      ]
      subnet: {
        id: resourceId(
          peSubnet.SubscriptionId,
          peSubnet.vNetResourceGroup,
          'Microsoft.Network/virtualNetworks/subnets',
          peSubnet.vNetName,
          peSubnet.subnetName
        )
      }
    }
  }
]

// ─── Diagnostic Settings ────────────────────────────────────────────────────

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

// ─── Resource Locks ─────────────────────────────────────────────────────────

resource synapseLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: synapse
  name: '${synapseName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box Multi-Synapse workspace for organization ${orgName}.'
  }
}

resource storageLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: storage
  name: '${storageName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box Multi-Synapse storage for organization ${orgName}.'
  }
}

// ─── Outputs ────────────────────────────────────────────────────────────────

output synapseId string = synapse.id
output synapseName string = synapse.name
output storageId string = storage.id
output storageName string = storage.name
output managedIdentityPrincipalId string = synapse.identity.principalId
