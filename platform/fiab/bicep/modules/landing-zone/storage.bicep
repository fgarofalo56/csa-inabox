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

@description('Private endpoints subnet ID')
param privateEndpointSubnetId string

@description('Private DNS zone ID for blob')
param privateDnsZoneBlobId string

@description('Private DNS zone ID for dfs')
param privateDnsZoneDfsId string

@description('Compliance tags')
param complianceTags object

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
      } : null
      services: {
        blob: { enabled: true }
        file: { enabled: true }
      }
    }
  }
}

// Containers: bronze (raw), silver (cleansed), gold (curated), landing-zone
// (Open Mirroring publisher drops), checkpoints (Spark checkpoint dirs)
resource bs 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' = {
  parent: sa
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 30
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 30
    }
    isVersioningEnabled: true
    changeFeed: { enabled: true }
  }
}

var containers = ['bronze', 'silver', 'gold', 'landing-zone', 'checkpoints']

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

resource peBlobDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
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

resource peDfsDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: peDfs
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'dfs-zone', properties: { privateDnsZoneId: privateDnsZoneDfsId } }
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
output landingZoneContainerUrl string = '${sa.properties.primaryEndpoints.dfs}landing-zone'
