// CSA Loom DLZ — ADLS Gen2 lakehouse storage account
// Hierarchical namespace; CMK-encrypted in IL5; private endpoints for
// blob + dfs.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name (suffix for storage account)')
param domainName string

@description('Storage requires CMK (IL5)')
param requireCmk bool

@description('Key Vault key URI for CMK (required if requireCmk)')
param cmkKeyUri string = ''

@description('UAMI principal ID with Key Vault Crypto Service Encryption User role')
param cmkIdentityId string = ''

@description('Pin CMK to a specific key version (F14). Empty = auto-rotate to the latest version (recommended). A hex version string pins the account to that exact version.')
param cmkKeyVersion string = ''

@description('Private endpoints subnet ID')
param privateEndpointSubnetId string

@description('Private DNS zone ID for blob. Empty (dlz-attach with no hub DNS coordinates) skips the blob PE private DNS zone group.')
param privateDnsZoneBlobId string = ''

@description('Private DNS zone ID for dfs. Empty (dlz-attach with no hub DNS coordinates) skips the dfs PE private DNS zone group.')
param privateDnsZoneDfsId string = ''

@description('Log Analytics workspace ID for diagnostic settings. Empty (dlz-attach with no hub LAW coordinate) skips the diagnostic settings.')
param workspaceId string = ''

@description('Compliance tags')
param complianceTags object

@description('Soft-delete retention days for blob/directory recovery (Recycle bin restore window). 1–365. Default 30.')
@minValue(1)
@maxValue(365)
param recycleRetentionDays int = 30

var saName = take('saloom${replace(domainName, '-', '')}${uniqueString(resourceGroup().id)}', 24)

resource sa 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: saName
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_ZRS' }
  identity: requireCmk ? {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${cmkIdentityId}': {}
    }
  } : { type: 'None' }
  properties: {
    isHnsEnabled: true
    isSftpEnabled: false
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    allowCrossTenantReplication: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
    }
    encryption: {
      keySource: requireCmk ? 'Microsoft.Keyvault' : 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      identity: requireCmk ? { userAssignedIdentity: cmkIdentityId } : null
      keyvaultproperties: requireCmk ? {
        keyvaulturi: substring(cmkKeyUri, 0, indexOf(cmkKeyUri, '/keys/'))
        keyname: split(split(cmkKeyUri, '/keys/')[1], '/')[0]
        // Empty = auto-rotate to latest; a hex version pins the account (F14).
        keyversion: cmkKeyVersion
      } : null
      services: {
        blob: { enabled: true }
        file: { enabled: true }
      }
    }
  }
}

// Containers: bronze (raw), silver (cleansed), gold (curated), landing
// (Open Mirroring publisher drops — producers push Parquet here, merged into
// managed Delta under bronze/mirrors/**), checkpoints (Spark checkpoint dirs)
resource bs 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' = {
  parent: sa
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: recycleRetentionDays
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: recycleRetentionDays
    }
    // Blob versioning conflicts with HNS (ADLS Gen2) — disable.
    // Delta Lake's _delta_log/ already gives us per-commit time travel,
    // which is the use case versioning would have served.
    isVersioningEnabled: false
    changeFeed: { enabled: true }
  }
}

var containers = ['bronze', 'silver', 'gold', 'landing', 'checkpoints', 'csv-imports', 'org-visuals']

resource sc 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = [for c in containers: {
  parent: bs
  name: c
  properties: {
    publicAccess: 'None'
  }
}]

// Private endpoint — blob
resource peBlob 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${saName}-blob'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'blob-link'
        properties: {
          privateLinkServiceId: sa.id
          groupIds: ['blob']
        }
      }
    ]
  }
}

resource peBlobDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (!empty(privateDnsZoneBlobId)) {
  parent: peBlob
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'blob-zone', properties: { privateDnsZoneId: privateDnsZoneBlobId } }
    ]
  }
}

// Private endpoint — dfs (ADLS Gen2)
resource peDfs 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${saName}-dfs'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'dfs-link'
        properties: {
          privateLinkServiceId: sa.id
          groupIds: ['dfs']
        }
      }
    ]
  }
}

resource peDfsDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (!empty(privateDnsZoneDfsId)) {
  parent: peDfs
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'dfs-zone', properties: { privateDnsZoneId: privateDnsZoneDfsId } }
    ]
  }
}

// =====================================================================
// Diagnostic settings → standardized Loom LAW
// =====================================================================

resource diagAccount 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: sa
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    metrics: [
      { category: 'Transaction', enabled: true }
      { category: 'Capacity', enabled: true }
    ]
  }
}

resource diagBlob 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: bs
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'StorageRead', enabled: true }
      { category: 'StorageWrite', enabled: true }
      { category: 'StorageDelete', enabled: true }
    ]
    metrics: [
      { category: 'Transaction', enabled: true }
    ]
  }
}

// Event Grid system topic for Delta log writes (Direct-Lake Shim picks up)
resource sysTopic 'Microsoft.EventGrid/systemTopics@2025-02-15' = {
  name: 'evt-${saName}'
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    source: sa.id
    topicType: 'Microsoft.Storage.StorageAccounts'
  }
}

output storageAccountId string = sa.id
output storageAccountName string = sa.name
output dfsEndpoint string = sa.properties.primaryEndpoints.dfs
output blobEndpoint string = sa.properties.primaryEndpoints.blob
output eventGridTopicId string = sysTopic.id
output bronzeContainerUrl string = '${sa.properties.primaryEndpoints.dfs}bronze'
output silverContainerUrl string = '${sa.properties.primaryEndpoints.dfs}silver'
output goldContainerUrl string = '${sa.properties.primaryEndpoints.dfs}gold'
output landingContainerUrl string = '${sa.properties.primaryEndpoints.dfs}landing'
