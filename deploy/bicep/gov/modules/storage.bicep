// ADLS Gen2 Storage Account - Government Deployment Module
// Serves as the OneLake-equivalent storage layer with medallion architecture

@description('Storage account name (lowercase, no hyphens).')
param name string

@description('Azure Government region.')
param location string

@description('Resource tags.')
param tags object = {}

@allowed(['Standard_LRS', 'Standard_GRS', 'Standard_RAGRS', 'Standard_ZRS'])
@description('Storage SKU.')
param sku string = 'Standard_LRS'

@description('Storage account kind.')
param kind string = 'StorageV2'

@description('Enable hierarchical namespace (ADLS Gen2).')
param isHnsEnabled bool = true

@description('Minimum TLS version.')
param minimumTlsVersion string = 'TLS1_2'

@description('Allow blob public access.')
param allowBlobPublicAccess bool = false

@description('Container names to create (medallion layers).')
param containers array = [
  'bronze'
  'silver'
  'gold'
]

@description('Enable customer-managed key encryption.')
param enableCustomerManagedKey bool = false

@description('Key Vault resource ID for CMK (used when enableCustomerManagedKey=true).')
#disable-next-line no-unused-params  // Reserved for CMK configuration — requires user-assigned identity setup
param keyVaultId string = ''

@description('Log Analytics workspace ID for diagnostics.')
param logAnalyticsId string = ''

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  kind: kind
  sku: {
    name: sku
  }
  properties: {
    accessTier: 'Hot'
    isHnsEnabled: isHnsEnabled
    minimumTlsVersion: minimumTlsVersion
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: allowBlobPublicAccess
    allowSharedKeyAccess: false  // Force Entra ID auth (FedRAMP best practice)
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
    encryption: {
      keySource: enableCustomerManagedKey ? 'Microsoft.Keyvault' : 'Microsoft.Storage'
      requireInfrastructureEncryption: true  // Double encryption for FedRAMP
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
        table: { enabled: true, keyType: 'Account' }
        queue: { enabled: true, keyType: 'Account' }
      }
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
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
    changeFeed: {
      enabled: true
      retentionInDays: 90
    }
  }
}

resource storageContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [
  for container in containers: {
    parent: blobService
    name: container
    properties: {
      publicAccess: 'None'
    }
  }
]

// Diagnostic settings
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: '${name}-diag'
  scope: storageAccount
  properties: {
    workspaceId: logAnalyticsId
    metrics: [
      {
        category: 'Transaction'
        enabled: true
      }
      {
        category: 'Capacity'
        enabled: true
      }
    ]
  }
}

output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
output primaryBlobEndpoint string = storageAccount.properties.primaryEndpoints.blob
output primaryDfsEndpoint string = storageAccount.properties.primaryEndpoints.dfs
