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

// #checkov:skip=CKV_AZURE_35:CMK encryption not required for external staging storage in dev/lab
// #checkov:skip=CKV_AZURE_43:Geo-redundant storage not required for dev/lab — ZRS already configured
// #checkov:skip=CKV_AZURE_33:Storage queue logging not required — queues not used in external storage
// #checkov:skip=CKV2_AZURE_38:Soft-delete enabled on blob services below; not applicable at account level
// #checkov:skip=CKV2_AZURE_1:CMK encryption not required for external staging storage in dev/lab
resource storageExternal 'Microsoft.Storage/storageAccounts@2023-05-01' = {
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
      requireInfrastructureEncryption: true
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
        queue: { enabled: true, keyType: 'Account' }
        table: { enabled: true, keyType: 'Account' }
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
resource storageExternalManagementPolicies 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
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
resource storageExternalBlobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageExternal
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 30 }
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
    isVersioningEnabled: true
    changeFeed: { enabled: true, retentionInDays: 30 }
    cors: { corsRules: [] }
  }
}

// File Systems
resource storageExternalFileSystems 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [
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
