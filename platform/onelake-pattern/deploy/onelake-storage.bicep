// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// OneLake-equivalent storage deployment — ADLS Gen2 with hierarchical namespace,
// Bronze/Silver/Gold containers, cross-domain access policies, private endpoints,
// and lifecycle management. Mirrors the OneLake workspace/lakehouse model.

targetScope = 'resourceGroup'

// ─── Parameters ─────────────────────────────────────────────────────────────

@description('Azure region for resource deployment.')
param location string = resourceGroup().location

@description('Resource tags applied to all deployed resources.')
param tags object = {}

@description('Domain name for the OneLake-equivalent workspace (e.g. "sales", "finance").')
@minLength(2)
@maxLength(12)
param domainName string

@description('Environment identifier used in naming.')
@allowed(['dev', 'stg', 'prod'])
param environment string

@description('Additional storage containers beyond the default medallion layers.')
param additionalContainers array = []

@description('Private endpoint subnet configurations. Each entry must include vNetName, subnetName, vNetResourceGroup, SubscriptionId, vNetLocation.')
param privateEndpointSubnets array = []

@description('Private DNS zone resource IDs for blob and DFS endpoints.')
param privateDNSZones object = {
  blob: ''
  dfs: ''
}

@description('Log Analytics workspace resource ID for diagnostic settings. Leave empty to skip.')
param logAnalyticsWorkspaceId string = ''

@description('Override the storage SKU. When empty, Standard_ZRS is used for supported regions, Standard_LRS otherwise.')
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

@description('Attach a CanNotDelete resource lock. Default true for production safety.')
param enableResourceLock bool = true

@description('Enable Customer-Managed Key (CMK) encryption.')
param enableCmk bool = false

@description('Key Vault URI for CMK encryption (e.g. https://myvault.vault.azure.net).')
param cmkKeyVaultUri string = ''

@description('Key name in Key Vault for CMK encryption.')
param cmkKeyName string = ''

@description('Key version for CMK. Leave empty for automatic rotation.')
param cmkKeyVersion string = ''

@description('Resource ID of the user-assigned managed identity for CMK.')
param cmkIdentityId string = ''

@description('Managed identity name for the domain. Creates a user-assigned identity for cross-domain access.')
param managedIdentityName string = 'mi-${environment}-${domainName}'

@description('Enable soft delete for blobs and containers.')
param softDeleteRetentionDays int = 30

@description('Number of days after modification to tier bronze blobs to cool storage.')
param bronzeTierToCoolDays int = 90

@description('Number of days after modification to tier bronze blobs to archive storage.')
param bronzeTierToArchiveDays int = 365

@description('Number of days to retain quarantine data before deletion.')
param quarantineRetentionDays int = 90

@description('Cross-domain reader principal IDs — managed identities from other domains that need read access to the gold container.')
param crossDomainReaderPrincipalIds array = []

// ─── Variables ──────────────────────────────────────────────────────────────

// Storage account names must be <= 24 chars, lowercase, no hyphens.
var storageNameRaw = 'st${environment}${domainName}${take(uniqueString(resourceGroup().id), 6)}'
var storageName = take(toLower(replace(storageNameRaw, '-', '')), 24)

// Default medallion containers — OneLake lakehouse equivalent.
var defaultContainers = [
  {
    name: 'bronze'
    publicAccess: 'None'
    metadata: { layer: 'raw', description: 'Raw ingestion layer — immutable landing zone' }
  }
  {
    name: 'silver'
    publicAccess: 'None'
    metadata: { layer: 'conformed', description: 'Cleansed and conformed data' }
  }
  {
    name: 'gold'
    publicAccess: 'None'
    metadata: { layer: 'curated', description: 'Business-ready aggregates and data products' }
  }
  {
    name: 'quarantine'
    publicAccess: 'None'
    metadata: { layer: 'quarantine', description: 'Rows and files that failed quality validation' }
  }
]

var allContainers = concat(defaultContainers, additionalContainers)

// ZRS-capable regions (Azure Government + select commercial).
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

// Built-in role definition IDs.
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

// ─── User-Assigned Managed Identity ─────────────────────────────────────────

@description('Domain managed identity for cross-domain RBAC and service authentication.')
resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: managedIdentityName
  location: location
  tags: union(tags, {
    Domain: domainName
    Purpose: 'OneLake-pattern domain identity'
  })
}

// ─── Storage Account ────────────────────────────────────────────────────────

// #checkov:skip=CKV_AZURE_35:CMK encryption is optional for dev/lab — enable via enableCmk parameter for prod
// #checkov:skip=CKV_AZURE_43:Geo-redundant storage not required for dev/lab — override via storageSku parameter for prod
// #checkov:skip=CKV_AZURE_33:Storage queue logging not required — queues not used in OneLake-pattern storage
// #checkov:skip=CKV2_AZURE_38:Soft-delete enabled on blob services below; not applicable at account level
// #checkov:skip=CKV2_AZURE_1:CMK encryption is optional for dev/lab — enable via enableCmk parameter for prod
@description('ADLS Gen2 storage account with hierarchical namespace — OneLake equivalent.')
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: union(tags, {
    Domain: domainName
    Environment: environment
    Pattern: 'OneLake'
  })
  identity: enableCmk ? {
    type: 'SystemAssigned,UserAssigned'
    userAssignedIdentities: {
      '${cmkIdentityId}': {}
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
    encryption: enableCmk ? {
      keySource: 'Microsoft.Keyvault'
      requireInfrastructureEncryption: true
      keyvaultproperties: {
        keyvaulturi: cmkKeyVaultUri
        keyname: cmkKeyName
        keyversion: !empty(cmkKeyVersion) ? cmkKeyVersion : null
      }
      identity: {
        userAssignedIdentity: cmkIdentityId
      }
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
      }
    } : {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
      }
    }
    isHnsEnabled: true
    isNfsV3Enabled: false
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

// ─── Blob Service Properties ────────────────────────────────────────────────

@description('Blob service configuration with versioning, soft delete, and point-in-time restore.')
resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: softDeleteRetentionDays }
    containerDeleteRetentionPolicy: { enabled: true, days: softDeleteRetentionDays }
    isVersioningEnabled: true
    changeFeed: { enabled: true, retentionInDays: softDeleteRetentionDays }
    restorePolicy: { enabled: true, days: softDeleteRetentionDays - 1 }
    cors: { corsRules: [] }
  }
}

// ─── Containers (Lakehouses) ────────────────────────────────────────────────

@description('Storage containers representing OneLake lakehouses (bronze/silver/gold/quarantine).')
resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [
  for container in allContainers: {
    parent: blobServices
    name: container.name
    properties: {
      publicAccess: 'None'
      metadata: contains(container, 'metadata') ? container.metadata : {}
    }
  }
]

// ─── Lifecycle Management ───────────────────────────────────────────────────

@description('Lifecycle policies for cost optimization — tier bronze to cool/archive, clean quarantine.')
resource lifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          enabled: true
          name: 'bronze-tier-to-cool'
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                tierToCool: { daysAfterModificationGreaterThan: bronzeTierToCoolDays }
                tierToArchive: { daysAfterModificationGreaterThan: bronzeTierToArchiveDays }
              }
              snapshot: { tierToCool: { daysAfterCreationGreaterThan: bronzeTierToCoolDays } }
              version: { tierToCool: { daysAfterCreationGreaterThan: bronzeTierToCoolDays } }
            }
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['bronze/']
            }
          }
        }
        {
          enabled: true
          name: 'quarantine-cleanup'
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: { daysAfterModificationGreaterThan: quarantineRetentionDays }
              }
            }
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['quarantine/']
            }
          }
        }
        {
          enabled: true
          name: 'silver-tier-to-cool'
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                tierToCool: { daysAfterModificationGreaterThan: 180 }
              }
            }
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['silver/']
            }
          }
        }
      ]
    }
  }
}

// ─── Cross-Domain RBAC ──────────────────────────────────────────────────────

@description('Grant cross-domain read access to the gold container for consuming domains.')
resource crossDomainReaderAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (principalId, i) in crossDomainReaderPrincipalIds: {
    name: guid(storage.id, 'gold-reader', principalId)
    scope: containers[2]  // gold container
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
      principalId: principalId
      principalType: 'ServicePrincipal'
    }
  }
]

// ─── Private Endpoints ──────────────────────────────────────────────────────

@description('Blob private endpoint for secure access.')
resource blobPrivateEndpoints 'Microsoft.Network/privateEndpoints@2023-11-01' = [
  for peSubnet in privateEndpointSubnets: {
    name: '${storageName}-blob-pe-${peSubnet.vNetName}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      privateLinkServiceConnections: [
        {
          name: '${storageName}-blob'
          properties: {
            groupIds: ['blob']
            privateLinkServiceId: storage.id
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

@description('DFS private endpoint for ADLS Gen2 access.')
resource dfsPrivateEndpoints 'Microsoft.Network/privateEndpoints@2023-11-01' = [
  for peSubnet in privateEndpointSubnets: {
    name: '${storageName}-dfs-pe-${peSubnet.vNetName}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      privateLinkServiceConnections: [
        {
          name: '${storageName}-dfs'
          properties: {
            groupIds: ['dfs']
            privateLinkServiceId: storage.id
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
    dependsOn: [blobPrivateEndpoints]
  }
]

// ─── DNS Zone Groups ────────────────────────────────────────────────────────

resource blobDnsZoneGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = [
  for (peSubnet, i) in privateEndpointSubnets: if (!empty(privateDNSZones.blob)) {
    name: 'default'
    parent: blobPrivateEndpoints[i]
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${storageName}-blob-dns'
          properties: {
            privateDnsZoneId: privateDNSZones.blob
          }
        }
      ]
    }
  }
]

resource dfsDnsZoneGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = [
  for (peSubnet, i) in privateEndpointSubnets: if (!empty(privateDNSZones.dfs)) {
    name: 'default'
    parent: dfsPrivateEndpoints[i]
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${storageName}-dfs-dns'
          properties: {
            privateDnsZoneId: privateDNSZones.dfs
          }
        }
      ]
    }
  }
]

// ─── Diagnostic Settings ────────────────────────────────────────────────────

@description('Storage account metric diagnostics.')
resource storageDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${storageName}-diagnostics'
  scope: storage
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    metrics: [
      { category: 'Transaction', enabled: true }
    ]
  }
}

@description('Blob service log diagnostics.')
resource blobDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${storageName}-blob-diagnostics'
  scope: blobServices
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

// ─── Resource Lock ──────────────────────────────────────────────────────────

@description('Prevents accidental deletion of the storage account.')
resource storageLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: storage
  name: '${storageName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box OneLake-pattern storage. Delete via rollback workflow in docs/ROLLBACK.md.'
  }
}

// ─── Outputs ────────────────────────────────────────────────────────────────

@description('Storage account resource ID.')
output storageId string = storage.id

@description('Storage account name (cleaned).')
output storageName string = storage.name

@description('Storage account DFS endpoint URL.')
output dfsEndpoint string = storage.properties.primaryEndpoints.dfs

@description('Storage account blob endpoint URL.')
output blobEndpoint string = storage.properties.primaryEndpoints.blob

@description('Managed identity principal ID for RBAC assignments.')
output managedIdentityPrincipalId string = managedIdentity.properties.principalId

@description('Managed identity resource ID.')
output managedIdentityId string = managedIdentity.id

@description('Container names deployed.')
output containerNames array = [for container in allContainers: container.name]
