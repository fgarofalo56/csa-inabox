// CSA Loom Health Data Services (LHDS) - one locked-down Blob storage account.
//
// Reusable: the stamp deploys it for the audit and export-staging accounts, and
// tenant.bicep (W1-2) deploys it per tenant for pixel data. Posture comes from
// the W0 DICOM run (W0-RECEIPT.md s3.3) and tenant policy:
//   - shared-key access OFF (the tenant policy forces it off anyway), Entra only,
//   - public network access OFF; the only path is a private endpoint with a
//     privatelink.blob zone group (without the zone group the account resolves
//     to its public address and every call fails with UnknownHostException),
//   - CMK through a user-assigned identity assigned AT CREATION (a key cannot be
//     attached afterwards with an identity the account does not already hold),
//   - infrastructure (double) encryption, per ADR-012,
//   - containers are created through ARM, not the data plane, because the data
//     plane is unreachable once public access is off.

targetScope = 'resourceGroup'

@description('Region of the account.')
param location string

@description('Globally unique storage account name (3-24 lowercase letters and digits).')
@minLength(3)
@maxLength(24)
param accountName string

@description('Replication. ZRS for class S/M/L; LRS is acceptable for the dev profile and for regions without availability zones.')
@allowed(['Standard_LRS', 'Standard_ZRS', 'Standard_GRS', 'Standard_GZRS', 'Standard_RAGRS', 'Standard_RAGZRS'])
param skuName string = 'Standard_ZRS'

@description('Blob containers to create.')
param containers array = []

@description('Keep every version of every blob and enable version-level immutability so a retention policy can be applied to the audit trail. Must be chosen at creation for the immutability setting.')
param immutableVersioning bool = false

@description('Time-based retention in days applied to new blob versions when immutableVersioning is true. 0 = immutability enabled but no default policy. The policy is created Unlocked; locking it is irreversible and is an operator decision.')
@minValue(0)
@maxValue(146000)
param immutabilityRetentionDays int = 0

@description('Soft-delete retention in days for blobs and containers.')
@minValue(1)
@maxValue(365)
param softDeleteDays int = 30

@description('Subnet that hosts the private endpoint.')
param peSubnetId string

@description('Resource id of the privatelink.blob private DNS zone.')
param blobZoneId string

@description('Resource id of the CMK user-assigned identity (needs Key Vault Crypto Service Encryption User on the vault).')
param cmkIdentityId string

@description('Key Vault URI that holds the CMK (https://<vault>.<suffix>/).')
param keyVaultUri string

@description('Name of the CMK in the vault. Version-less: the account follows key rotation.')
param keyName string

@description('Log Analytics workspace id for diagnostics. Empty skips the diagnostic setting.')
param workspaceId string = ''

@description('Tags applied to every resource.')
param tags object = {}

resource account 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: accountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: skuName }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${cmkIdentityId}': {}
    }
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Deny'
    }
    isHnsEnabled: false
    immutableStorageWithVersioning: immutableVersioning ? {
      enabled: true
      immutabilityPolicy: immutabilityRetentionDays > 0 ? {
        immutabilityPeriodSinceCreationInDays: max(1, immutabilityRetentionDays)
        state: 'Unlocked'
      } : null
    } : null
    encryption: {
      keySource: 'Microsoft.Keyvault'
      requireInfrastructureEncryption: true
      identity: { userAssignedIdentity: cmkIdentityId }
      keyvaultproperties: {
        keyvaulturi: keyVaultUri
        keyname: keyName
      }
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
      }
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2024-01-01' = {
  parent: account
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: softDeleteDays }
    containerDeleteRetentionPolicy: { enabled: true, days: softDeleteDays }
  }
}

resource blobContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = [for c in containers: {
  parent: blobService
  name: c
  properties: {
    publicAccess: 'None'
  }
}]

resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${accountName}-blob'
  location: location
  tags: tags
  properties: {
    subnet: { id: peSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'blob-link'
        properties: {
          privateLinkServiceId: account.id
          groupIds: ['blob']
        }
      }
    ]
  }
}

resource peDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: { privateDnsZoneId: blobZoneId }
      }
    ]
  }
}

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: blobService
  name: 'diag-lhds-blob'
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

output accountId string = account.id
output accountName string = account.name
output blobEndpoint string = account.properties.primaryEndpoints.blob
output keyName string = keyName
