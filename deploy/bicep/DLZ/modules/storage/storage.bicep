// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used to create a Data Lake.
targetScope = 'resourceGroup'

// Parameters
param location string
param tags object
param privateEndpointSubnets array

param storageName string
@description('Private DNS zone Location Information')
param privateDNSZones object
param fileSystemNames array

// Variables
var storageNameCleaned = length(storageName) > 24
  ? concat(substring(toLower(replace(storageName, '-', '')), 0, 20), uniqueString(resourceGroup().id))
  : toLower(replace(storageName, '-', ''))

var storageZrsRegions = [
  'usgovvirginia'
  'usgoviowa'
  'usgovarizona'
  'usgovtexas'
  'centralus'
  'eastus'
  'eastus2'
  'southcentralus'
  'westus2'
  'westus3'
]

// Storage Account
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageNameCleaned
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: contains(storageZrsRegions, toLower(location)) ? 'Standard_ZRS' : 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
        queue: { enabled: true, keyType: 'Account' }
        table: { enabled: true, keyType: 'Account' }
      }
    }
    isHnsEnabled: true
    isNfsV3Enabled: false
    largeFileSharesState: 'Disabled'
    minimumTlsVersion: 'TLS1_2'
    networkAcls: {
      bypass: 'Metrics,AzureServices,Logging'
      defaultAction: 'Deny'
      ipRules: []
      virtualNetworkRules: []
    }
    supportsHttpsTrafficOnly: true
  }
}

// Lifecycle Management Policy
resource storageManagementPolicies 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          enabled: true
          name: 'default'
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: { tierToCool: { daysAfterModificationGreaterThan: 90 } }
              snapshot: { tierToCool: { daysAfterCreationGreaterThan: 90 } }
              version: { tierToCool: { daysAfterCreationGreaterThan: 90 } }
            }
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: []
            }
          }
        }
      ]
    }
  }
}

// Blob Service Properties — enables the point-in-time restore feature
// set used by the rollback procedure in docs/ROLLBACK.md.  Versioning +
// change feed are prerequisites for restorePolicy, and blob/container
// soft-delete give a second line of recovery.
resource storageBlobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    // Keep deleted blobs for 7 days so accidental deletes are recoverable.
    deleteRetentionPolicy: { enabled: true, days: 7 }
    // Keep deleted containers for 7 days for the same reason.
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
    // Blob versioning + change feed are required to enable restorePolicy.
    isVersioningEnabled: true
    changeFeed: { enabled: true, retentionInDays: 7 }
    // 6-day point-in-time restore window (must be strictly less than
    // deleteRetentionPolicy.days and changeFeed.retentionInDays).
    restorePolicy: { enabled: true, days: 6 }
    cors: { corsRules: [] }
  }
}

// Blob Private Endpoint
module privateEndpointModuleBlob '../network/privatelink.bicep' = [
  for peSubnet in privateEndpointSubnets: {
    name: 'peDeployment${peSubnet.vNetName}-${storageNameCleaned}-Blob'
    scope: resourceGroup(peSubnet.SubscriptionId, peSubnet.vNetResourceGroup)
    params: {
      serviceId: storage.id
      serviceSubResource: 'blob'
      tags: tags
      privateEndpointSubnets: privateEndpointSubnets
      privateDNSZones: privateDNSZones
      serviceName: storageNameCleaned
    }
    dependsOn: [
      storageBlobServices
    ]
  }
]

// DFS Private Endpoint
module privateEndpointModuleDfs '../network/privatelink.bicep' = [
  for peSubnet in privateEndpointSubnets: {
    name: 'peDeployment${peSubnet.vNetName}-${storageNameCleaned}-DFS'
    scope: resourceGroup(peSubnet.SubscriptionId, peSubnet.vNetResourceGroup)
    params: {
      serviceId: storage.id
      serviceSubResource: 'dfs'
      tags: tags
      privateEndpointSubnets: privateEndpointSubnets
      privateDNSZones: privateDNSZones
      serviceName: storageNameCleaned
    }
    dependsOn: [
      storageBlobServices
      privateEndpointModuleBlob
    ]
  }
]

// Private Endpoints for Blob
// resource storagePrivateEndpointsBlob 'Microsoft.Network/privateEndpoints@2024-05-01' = [
//   for peSubnet in privateEndpointSubnets: {
//     name: '${storagePrivateEndpointNameBlob}-${peSubnet.vNetName}'
//     location: peSubnet.vNetLocation
//     tags: tags
//     properties: {
//       manualPrivateLinkServiceConnections: []
//       privateLinkServiceConnections: [
//         {
//           name: '${storagePrivateEndpointNameBlob}-${peSubnet.vNetName}'
//           properties: {
//             groupIds: ['blob']
//             privateLinkServiceId: resourceId(subscription().id, storage.id)
//             requestMessage: ''
//           }
//         }
//       ]
//       subnet: {
//         id: resourceId(
//           peSubnet.subscriptionId,
//           peSubnet.vNetResourceGroup,
//           'Microsoft.Network/virtualNetworks/subnets',
//           peSubnet.vNetName,
//           peSubnet.subnetName
//         )
//       }
//     }
//     dependsOn: [
//       storage // Ensure storage account is created first
//       storageBlobServices
//     ]
//   }
// ]

// // Private DNS Zone Group for Blob
// resource storagePrivateEndpointBlobARecords 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [
//   for (peSubnet, i) in privateEndpointSubnets: if (!empty(privateDNSZones.subscriptionId)) {
//     parent: storagePrivateEndpointsBlob[i]
//     name: 'default'
//     properties: {
//       privateDnsZoneConfigs: [
//         {
//           name: '${storagePrivateEndpointNameBlob}-${peSubnet.vNetName}-arecord'
//           properties: {
//             privateDnsZoneId: contains(['usgovvirginia', 'usgovarizona', 'usgovtexas'], toLower(location))
//               ? '/subscriptions/${privateDNSZones.subscriptionId}/resourceGroups/${privateDNSZones.resourceGroupName}/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.usgovcloudapi.net'
//               : '/subscriptions/${privateDNSZones.subscriptionId}/resourceGroups/${privateDNSZones.resourceGroupName}/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net'
//           }
//         }
//       ]
//     }
//     dependsOn: [storagePrivateEndpointsBlob[i]]
//   }
// ]

// Outputs
output storageId string = storage.id
output storageFileSystemIds array = [
  for fileSystemName in fileSystemNames: {
    storageFileSystemId: resourceId(
      'Microsoft.Storage/storageAccounts/blobServices/containers',
      storageNameCleaned,
      'default',
      fileSystemName
    )
  }
]
