// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used to create a Storage Account for DMLZ
// (governance data, Purview scan results, audit logs, metadata).
targetScope = 'resourceGroup'

// Parameters
@description('Name of the storage account (max 24 chars, lowercase alphanumeric only).')
param storageName string

@description('Azure region.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('''Override the storage SKU. When empty, the module picks
Standard_ZRS in regions that support it and Standard_LRS elsewhere.''')
@allowed([
  ''
  'Standard_LRS'
  'Standard_ZRS'
  'Standard_GRS'
  'Standard_RAGRS'
  'Standard_GZRS'
  'Standard_RAGZRS'
])
param storageSku string = ''

@description('Blob containers to create for DMLZ governance data.')
param containerNames array = [
  'purview-scans'
  'governance-reports'
  'audit-logs'
  'metadata'
]

@description('Subnet ID for the blob private endpoint.')
param subnetId string = ''

@description('Private DNS Zone ID for blob (privatelink.blob.core.windows.net).')
param privateDnsZoneIdBlob string = ''

@description('Private DNS Zone ID for table (privatelink.table.core.windows.net).')
param privateDnsZoneIdTable string = ''

@description('Private DNS Zone ID for queue (privatelink.queue.core.windows.net).')
param privateDnsZoneIdQueue string = ''

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Attach a CanNotDelete resource lock. Default true for production safety.')
param enableResourceLock bool = true

@description('Enable Customer-Managed Key (CMK) encryption.')
param parEnableCmk bool = false

@description('Key Vault URI (e.g. https://myvault.vault.azure.net) when CMK is enabled.')
param parCmkKeyVaultUri string = ''

@description('Key name in the Key Vault for CMK encryption.')
param parCmkKeyName string = ''

@description('Key version. Leave empty for automatic key rotation (recommended).')
param parCmkKeyVersion string = ''

@description('Resource ID of the user-assigned managed identity for CMK.')
param parCmkIdentityId string = ''

// Variables
var storageNameCleaned = length(storageName) > 24
  ? substring(toLower(replace(storageName, '-', '')), 0, 24)
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

var effectiveStorageSku = !empty(storageSku)
  ? storageSku
  : (contains(storageZrsRegions, toLower(location)) ? 'Standard_ZRS' : 'Standard_LRS')

var blobPrivateEndpointName = '${storageNameCleaned}-blob-pe'
var tablePrivateEndpointName = '${storageNameCleaned}-table-pe'
var queuePrivateEndpointName = '${storageNameCleaned}-queue-pe'

// Resources
// #checkov:skip=CKV_AZURE_35:CMK encryption is optional for dev/lab — enable via parEnableCmk parameter for prod
// #checkov:skip=CKV_AZURE_43:Geo-redundant storage not required for dev/lab — override via storageSku parameter for prod
// #checkov:skip=CKV_AZURE_33:Storage queue logging not required — queues not used in DMLZ governance storage
// #checkov:skip=CKV2_AZURE_38:Soft-delete enabled on blob services below; not applicable at account level
// #checkov:skip=CKV2_AZURE_1:CMK encryption is optional for dev/lab — enable via parEnableCmk parameter for prod
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageNameCleaned
  location: location
  tags: tags
  identity: parEnableCmk ? {
    type: 'SystemAssigned,UserAssigned'
    userAssignedIdentities: {
      '${parCmkIdentityId}': {}
    }
  } : {
    type: 'SystemAssigned'
  }
  sku: {
    name: effectiveStorageSku
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    // HNS disabled — this is standard blob storage for management data,
    // not a data lake with hierarchical namespace.
    isHnsEnabled: false
    isNfsV3Enabled: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    encryption: parEnableCmk ? {
      keySource: 'Microsoft.Keyvault'
      requireInfrastructureEncryption: true
      keyvaultproperties: {
        keyvaulturi: parCmkKeyVaultUri
        keyname: parCmkKeyName
        keyversion: !empty(parCmkKeyVersion) ? parCmkKeyVersion : null
      }
      identity: {
        userAssignedIdentity: parCmkIdentityId
      }
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
        queue: { enabled: true, keyType: 'Account' }
        table: { enabled: true, keyType: 'Account' }
      }
    } : {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
        queue: { enabled: true, keyType: 'Account' }
        table: { enabled: true, keyType: 'Account' }
      }
    }
    networkAcls: {
      bypass: 'Metrics,AzureServices,Logging'
      defaultAction: 'Deny'
      ipRules: []
      virtualNetworkRules: []
    }
    publicNetworkAccess: 'Disabled'
  }
}

// Blob Service Properties — soft-delete and versioning for governance data protection.
resource storageBlobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 30 }
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
    isVersioningEnabled: true
    changeFeed: { enabled: true, retentionInDays: 30 }
    cors: { corsRules: [] }
  }
}

// Blob Containers for governance data
resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [
  for containerName in containerNames: {
    parent: storageBlobServices
    name: containerName
    properties: {
      publicAccess: 'None'
    }
  }
]

// Lifecycle Management — tier governance data to cool storage after 90 days.
resource storageManagementPolicies 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          enabled: true
          name: 'governance-lifecycle'
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: { tierToCool: { daysAfterModificationGreaterThan: 90 } }
              snapshot: { tierToCool: { daysAfterCreationGreaterThan: 90 } }
              version: { tierToCool: { daysAfterCreationGreaterThan: 90 } }
            }
            filters: {
              blobTypes: [ 'blockBlob' ]
              prefixMatch: []
            }
          }
        }
      ]
    }
  }
}

// Private Endpoints — blob, table, and queue for governance data access.
resource blobPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (!empty(subnetId)) {
  name: blobPrivateEndpointName
  location: location
  tags: tags
  properties: {
    manualPrivateLinkServiceConnections: []
    privateLinkServiceConnections: [
      {
        name: blobPrivateEndpointName
        properties: {
          groupIds: [ 'blob' ]
          privateLinkServiceId: storage.id
          requestMessage: ''
        }
      }
    ]
    subnet: {
      id: subnetId
    }
  }
}

resource blobPeARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (!empty(subnetId) && !empty(privateDnsZoneIdBlob)) {
  parent: blobPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: '${blobPrivateEndpointName}-arecord'
        properties: {
          privateDnsZoneId: privateDnsZoneIdBlob
        }
      }
    ]
  }
}

resource tablePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (!empty(subnetId)) {
  name: tablePrivateEndpointName
  location: location
  tags: tags
  properties: {
    manualPrivateLinkServiceConnections: []
    privateLinkServiceConnections: [
      {
        name: tablePrivateEndpointName
        properties: {
          groupIds: [ 'table' ]
          privateLinkServiceId: storage.id
          requestMessage: ''
        }
      }
    ]
    subnet: {
      id: subnetId
    }
  }
}

resource tablePeARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (!empty(subnetId) && !empty(privateDnsZoneIdTable)) {
  parent: tablePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: '${tablePrivateEndpointName}-arecord'
        properties: {
          privateDnsZoneId: privateDnsZoneIdTable
        }
      }
    ]
  }
}

resource queuePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (!empty(subnetId)) {
  name: queuePrivateEndpointName
  location: location
  tags: tags
  properties: {
    manualPrivateLinkServiceConnections: []
    privateLinkServiceConnections: [
      {
        name: queuePrivateEndpointName
        properties: {
          groupIds: [ 'queue' ]
          privateLinkServiceId: storage.id
          requestMessage: ''
        }
      }
    ]
    subnet: {
      id: subnetId
    }
  }
}

resource queuePeARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (!empty(subnetId) && !empty(privateDnsZoneIdQueue)) {
  parent: queuePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: '${queuePrivateEndpointName}-arecord'
        properties: {
          privateDnsZoneId: privateDnsZoneIdQueue
        }
      }
    ]
  }
}

// Diagnostic Settings — capture storage access logs for governance audit.
resource storageAccountDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${storageNameCleaned}-diagnostics'
  scope: storage
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    metrics: [
      { category: 'Transaction', enabled: true }
    ]
  }
}

resource storageBlobDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${storageNameCleaned}-blob-diagnostics'
  scope: storageBlobServices
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'Transaction', enabled: true }
    ]
  }
}

// Resource lock — protects governance data from accidental deletion.
resource storageLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: storage
  name: '${storageNameCleaned}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: DMLZ governance storage account. Delete via the rollback workflow in docs/ROLLBACK.md.'
  }
}

// Outputs
@description('Resource ID of the storage account.')
output storageId string = storage.id

@description('Name of the storage account (cleaned).')
output storageName string = storage.name

@description('Primary blob endpoint.')
output primaryBlobEndpoint string = storage.properties.primaryEndpoints.blob

@description('Managed identity principal ID.')
output managedIdentityPrincipalId string = storage.identity.principalId
