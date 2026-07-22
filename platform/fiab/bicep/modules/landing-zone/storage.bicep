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

@description('DR0 — declarative blob versioning + point-in-time restore (restorePolicy) posture. Default ON, but see hnsSupportsVersioning below: BOTH features are "Not yet supported" on HNS-enabled (ADLS Gen2) accounts per the Learn feature matrix, and this lake is HNS by design, so the guard keeps them off (ARM rejects the combination). Rides drConfig.enableBlobPitr from the top-level orchestrator; becomes live the day the platform lifts the HNS restriction or this module is pointed at a flat-namespace account.')
param enableBlobPitr bool = true

@description('Storage account SKU (replication). Default Standard_ZRS = zone-redundant, single region (the shipped default DR posture). Opt into a geo-redundant tier (Standard_GZRS / Standard_GRS / Standard_RAGZRS) for cross-region survivability — an operator DR decision with added cost; see docs/fiab/operations/disaster-recovery.md.')
@allowed([
  'Standard_ZRS'
  'Standard_GZRS'
  'Standard_GRS'
  'Standard_RAGZRS'
])
param storageSkuName string = 'Standard_ZRS'

var saName = take('saloom${replace(domainName, '-', '')}${uniqueString(resourceGroup().id)}', 24)

resource sa 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: saName
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: storageSkuName }
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
// DR0 — restore posture (Learn-grounded, verified 2026-07-22).
// Blob versioning AND point-in-time restore (restorePolicy) are BOTH
// "⬤ Not yet supported" on HNS-enabled accounts per the authoritative feature
// matrix (learn.microsoft.com/azure/storage/blobs/storage-feature-support-in-
// storage-accounts) and versioning-overview ("Storage accounts with a
// hierarchical namespace enabled ... aren't currently supported"). This account
// is HNS by design (isHnsEnabled: true — ABFS + POSIX ACLs + Delta), so the
// guard below keeps both OFF: ARM rejects the combination at deploy time.
// The effective, supported lake restore baseline is therefore:
//   - blob + container soft delete (recycleRetentionDays window, below),
//   - change feed (below),
//   - Delta Lake _delta_log per-commit time travel for table data.
// Flip hnsSupportsVersioning to true the day Azure lifts the HNS restriction —
// enableBlobPitr (drConfig, default true) then turns versioning + a
// restorePolicy of recycleRetentionDays-1 days (must be < delete retention) on
// with no other edits.
var hnsSupportsVersioning = false
var blobPitrOn = enableBlobPitr && hnsSupportsVersioning

resource bs 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' = {
  parent: sa
  name: 'default'
  properties: union({
    deleteRetentionPolicy: {
      enabled: true
      days: recycleRetentionDays
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: recycleRetentionDays
    }
    isVersioningEnabled: blobPitrOn
    changeFeed: { enabled: true }
  }, blobPitrOn ? {
    restorePolicy: {
      enabled: true
      // PITR window must be strictly less than the soft-delete retention.
      days: max(recycleRetentionDays - 1, 1)
    }
  } : {})
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
  // Serialize after the blob PE: both land in the same PE subnet and each PE
  // create mutates the subnet (→ VNet 'Updating'). PUT'ing them in parallel
  // makes the second bail with "Virtual network ... is not in the succeeded
  // provisioning state". Ordering-only; both PEs still deploy.
  dependsOn: [ peBlob ]
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
