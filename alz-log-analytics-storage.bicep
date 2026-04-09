// ============================================================================
// Log Analytics Storage Account
// Template for the storage account used by Log Analytics workspace
// ============================================================================

@description('Storage account name (must be globally unique, 3-24 lowercase alphanumeric)')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Azure region for the storage account')
param location string = 'eastus'

@description('Tags to apply to the storage account')
param tags object = {}

@description('IP addresses to allow through the firewall (CIDR notation)')
param allowedIpRules array = []

@description('The storage account SKU')
@allowed([
  'Standard_LRS'
  'Standard_GRS'
  'Standard_ZRS'
  'Standard_RAGRS'
])
param skuName string = 'Standard_LRS'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  sku: {
    name: skuName
    tier: 'Standard'
  }
  kind: 'StorageV2'
  name: storageAccountName
  location: location
  tags: tags
  properties: {
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
    allowCrossTenantReplication: false
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    isHnsEnabled: false
    networkAcls: {
      bypass: 'AzureServices'
      virtualNetworkRules: []
      ipRules: [for ip in allowedIpRules: {
        value: ip
        action: 'Allow'
      }]
      defaultAction: 'Deny'
    }
    supportsHttpsTrafficOnly: true
    encryption: {
      services: {
        file: {
          keyType: 'Account'
          enabled: true
        }
        blob: {
          keyType: 'Account'
          enabled: true
        }
      }
      keySource: 'Microsoft.Storage'
    }
    accessTier: 'Hot'
  }
}

output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
output primaryEndpoints object = storageAccount.properties.primaryEndpoints
