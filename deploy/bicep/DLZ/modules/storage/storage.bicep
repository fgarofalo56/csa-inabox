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

@description('''Override the storage SKU.  When empty, the module picks
Standard_ZRS in regions that support it and Standard_LRS elsewhere.  Set
this to ``Standard_RAGRS`` (or ``Standard_RAGZRS``) on critical data
workloads to enable read-access geo-redundant storage — this is the
tier the DR runbook (docs/DR.md) expects for RPO < 1h workloads.''')
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

@description('Attach a CanNotDelete resource lock to the storage account.  Default true for production safety.')
param enableResourceLock bool = true

@description('Log Analytics workspace resource ID for diagnostic settings. Leave empty to skip diagnostics.')
param logAnalyticsWorkspaceId string = ''

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

// Variables
var storageNameCleaned = length(toLower(replace(storageName, '-', ''))) > 24
  ? '${substring(toLower(replace(storageName, '-', '')), 0, min(11, length(toLower(replace(storageName, '-', '')))))}${uniqueString(resourceGroup().id)}'
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

// Storage Account
// #checkov:skip=CKV_AZURE_35:CMK encryption is optional for dev/lab — enable via parEnableCmk parameter for prod
// #checkov:skip=CKV_AZURE_43:Geo-redundant storage not required for dev/lab — override via storageSku parameter for prod
// #checkov:skip=CKV_AZURE_33:Storage queue logging not required — queues not used in data lake storage
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
    // Keep deleted blobs for 30 days — matches the audit recommendation
    // for data-platform soft-delete retention.
    deleteRetentionPolicy: { enabled: true, days: 30 }
    // Keep deleted containers for 30 days for the same reason.
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
    // Blob versioning + change feed are required to enable restorePolicy.
    isVersioningEnabled: true
    changeFeed: { enabled: true, retentionInDays: 30 }
    // 29-day point-in-time restore window (must be strictly less than
    // deleteRetentionPolicy.days and changeFeed.retentionInDays).
    restorePolicy: { enabled: true, days: 29 }
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

// Diagnostic settings — storage account diagnostics flow at the
// blobServices / fileServices sub-resource level, not the account
// itself.  The account still gets a metric-only diagnostic setting so
// transaction / availability metrics land in Log Analytics.
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

// Resource lock — protects the storage account from accidental `az group delete`.
resource storageLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: storage
  name: '${storageNameCleaned}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: data-lake storage account. Delete via the rollback workflow in docs/ROLLBACK.md.'
  }
}

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
