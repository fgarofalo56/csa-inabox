// Azure Key Vault - Government Deployment Module
// FedRAMP High compliant with FIPS 140-2 Level 2+ HSM

@description('Key Vault name.')
param name string

@description('Azure Government region.')
param location string

@description('Resource tags including compliance metadata.')
param tags object = {}

@description('Enable purge protection (required for FedRAMP High).')
param enablePurgeProtection bool = true

@description('Enable soft delete.')
param enableSoftDelete bool = true

@description('Soft delete retention in days.')
param softDeleteRetentionInDays int = 90

@description('Enable RBAC authorization (recommended over access policies).')
param enableRbacAuthorization bool = true

@description('Network ACL configuration.')
param networkAcls object = {
  defaultAction: 'Deny'
  bypass: 'AzureServices'
}

// #checkov:skip=CKV_AZURE_110:Key Vault secret expiration managed via operational process, not resource policy
// #checkov:skip=CKV_AZURE_112:Key Vault key expiration managed via operational process, not resource policy
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'premium'  // Premium SKU for HSM-backed keys (FedRAMP)
    }
    enabledForDeployment: false
    enabledForDiskEncryption: true
    enabledForTemplateDeployment: true
    enableSoftDelete: enableSoftDelete
    softDeleteRetentionInDays: softDeleteRetentionInDays
    enablePurgeProtection: enablePurgeProtection
    enableRbacAuthorization: enableRbacAuthorization
    publicNetworkAccess: 'Disabled'
    networkAcls: networkAcls
  }
}

// Diagnostic settings for audit logging (required by FedRAMP)
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: '${name}-diag'
  scope: keyVault
  properties: {
    logs: [
      {
        category: 'AuditEvent'
        enabled: true
        retentionPolicy: {
          days: 365
          enabled: true
        }
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
