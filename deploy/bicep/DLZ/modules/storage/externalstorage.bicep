// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used to create a storage account where the access key needs to be shared.
targetScope = 'resourceGroup'

// Parameters
param location string
param tags object
param privateEndpointSubnets array

param storageName string
param privateDNSZones object
param fileSystemNames array = [
  'data'
]

// Variables
var storageNameCleaned = length(storageName) > 24
  ? concat(substring(toLower(replace(storageName, '-', '')), 0, 20), uniqueString(resourceGroup().id))
  : toLower(replace(storageName, '-', ''))

var storageExternalPrivateEndpointNameBlob = '${storageNameCleaned}-blob-pe'

// Resources

resource storageExternal 'Microsoft.Storage/storageAccounts@2021-02-01' = {
  name: storageNameCleaned
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'Standard_ZRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: false
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
        queue: { enabled: true, keyType: 'Service' }
        table: { enabled: true, keyType: 'Service' }
      }
    }
    isHnsEnabled: false
    isNfsV3Enabled: false
    largeFileSharesState: 'Disabled'
    minimumTlsVersion: 'TLS1_2'
    networkAcls: {
      bypass: 'Metrics'
      defaultAction: 'Deny'
      ipRules: []
      virtualNetworkRules: []
    }
    supportsHttpsTrafficOnly: true
  }
}

// Storage Lifecycle Management Policy
resource storageExternalManagementPolicies 'Microsoft.Storage/storageAccounts/managementPolicies@2021-02-01' = {
  parent: storageExternal
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

// Blob Services
resource storageExternalBlobServices 'Microsoft.Storage/storageAccounts/blobServices@2021-02-01' = {
  parent: storageExternal
  name: 'default'
  properties: {
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
    cors: { corsRules: [] }
  }
}

// File Systems
resource storageExternalFileSystems 'Microsoft.Storage/storageAccounts/blobServices/containers@2021-02-01' = [
  for fileSystemName in fileSystemNames: {
    parent: storageExternalBlobServices
    name: fileSystemName
    properties: {
      publicAccess: 'None'
      metadata: {}
    }
  }
]

// Blob Private Endpoint
module privateEndpointModuleBlob '../network/privatelink.bicep' = [
  for peSubnet in privateEndpointSubnets: {
    name: 'peDeployment${peSubnet.vNetName}-${storageNameCleaned}-Blob'
    scope: resourceGroup(peSubnet.SubscriptionId, peSubnet.vNetResourceGroup)
    params: {
      serviceId: storageExternal.id
      serviceSubResource: 'blob'
      tags: tags
      privateEndpointSubnets: privateEndpointSubnets
      privateDNSZones: privateDNSZones
      serviceName: storageNameCleaned
    }
    dependsOn: [
      storageExternalBlobServices
      storageExternalFileSystems
    ]
  }
]

// // Private Endpoints for Blob
// resource storageExternalPrivateEndpointBlob 'Microsoft.Network/privateEndpoints@2022-07-01' = [
//   for peSubnet in privateEndpointSubnets: {
//     name: '${storageExternalPrivateEndpointNameBlob}-${peSubnet.vNetName}'
//     location: peSubnet.vNetLocation
//     tags: tags
//     properties: {
//       manualPrivateLinkServiceConnections: []
//       privateLinkServiceConnections: [
//         {
//           name: '${storageExternalPrivateEndpointNameBlob}-${peSubnet.vNetName}'
//           properties: {
//             groupIds: ['blob']
//             privateLinkServiceId: resourceId(subscription().id, storageExternal.id)
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
//       storageExternal
//       storageExternalBlobServices
//     ]
//   }
// ]

// // Private DNS Zone Group for Blob
// resource storageExternalPrivateEndpointBlobARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroup@2024-05-01' = [
//   for (peSubnet, i) in privateEndpointSubnets: if (!empty(privateDNSZones.subscriptionId)) {
//     parent: storageExternalPrivateEndpointBlob[i]
//     name: 'default'
//     properties: {
//       privateDnsZoneConfigs: [
//         {
//           name: '${storageExternalPrivateEndpointNameBlob}-${peSubnet.vNetName}-arecord'
//           properties: {
//             privateDnsZoneId: contains(['usgovvirginia', 'usgovarizona', 'usgovtexas'], toLower(location))
//               ? '/subscriptions/${privateDNSZones.subscriptionId}/resourceGroups/${privateDNSZones.resourceGroupName}/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.usgovcloudapi.net'
//               : '/subscriptions/${privateDNSZones.subscriptionId}/resourceGroups/${privateDNSZones.resourceGroupName}/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net'
//           }
//         }
//       ]
//     }
//     dependsOn: [storageExternalPrivateEndpointBlob[i]]
//   }
// ]

// Outputs
output storageId string = storageExternal.id
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
