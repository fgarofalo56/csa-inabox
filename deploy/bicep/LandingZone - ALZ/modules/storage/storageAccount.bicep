targetScope = 'resourceGroup'

// Metadata
metadata name = 'ALZ Bicep - Storage Account'
metadata description = 'Module used to deploy Azure Storage Accounts'

// Parameters
param location string
param prefix string
param environment string
param tags object
param resourceGroup string

param ipRules array = []

@sys.description('Storage Account Name')
param parmStorageAccountName string

@sys.description('Enable Defender for Storage')
param defenderForStorageEnabled bool = false

@sys.description('The maximum amount of data that can be scanned by Defender for Storage in a month. The value should be between 1 and 1000 GB.')
param parDefenderStorageCapGBPerMonth int = 100

@allowed([
  'Standard_LRS'
  'Standard_GRS'
  'Standard_RAGRS'
  'Standard_ZRS'
  'Premium_LRS'
  ])
@description('The SKU name of the storage account.')
param skuName string = 'Standard_LRS'

@allowed([
  'StorageV2'
  'Storage'
  'BlobStorage'
  'FileStorage'
  'BlockBlobStorage'
])
@description('The kind of the storage account.')
param kind string = 'StorageV2'

@allowed([
  'Hot'
  'Cool'
  'Premium'
  ])
@description('The access tier of the storage account.')
param accessTier string = 'Hot'

@allowed([
  'AzureServices'
  'Logging'
  'Metrics'
  'None'
  ])
@description('The bypass property allows requests to pass through the firewall if they are made against the Azure Storage service.')
param bypassServies string = 'AzureServices'

@allowed([
  'Allow'
  'Deny'
  ])
@description('The default action of the storage account.')
param defaultAction string = 'Deny'

@description('Enable Hierarchical Namespace for the storage account. Azure Datalake Gen2')
param isHnsEnabled bool = false

// Variables
@sys.description('Takes the value from storageAccountName and formats name to make it unique')
var varStorageAccountname = substring(replace(replace(replace(toLower(concat(parmStorageAccountName, uniqueString(subscription().subscriptionId, resourceGroup, parmStorageAccountName))),'-',''),' ', ''),'_', ''), 0, 24) 

// Resource Definition for Storage Account
resource resStorageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: varStorageAccountname
  location: location
  tags: tags
  kind: kind
  sku: {
    name: skuName
  }
  properties: {
    accessTier: accessTier
    allowBlobPublicAccess: false
    isHnsEnabled: isHnsEnabled
    minimumTlsVersion: 'TLS1_2'
    networkAcls: {
      bypass:  bypassServies
      defaultAction: defaultAction
      ipRules: ipRules
      virtualNetworkRules: []
    }
    defaultToOAuthAuthentication: true
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Disabled'

  }
}

resource defenderForStorageConfig 'Microsoft.Security/defenderForStorageSettings@2022-12-01-preview' = if(defenderForStorageEnabled) {
  name: 'current'
  scope: resStorageAccount
  properties: {
    isEnabled: true
    malwareScanning: {
      onUpload: {
        capGBPerMonth: parDefenderStorageCapGBPerMonth
        isEnabled: true
      }
    scanResultsEventGridTopicResourceId: null
    }
    overrideSubscriptionLevelSettings: false
    sensitiveDataDiscovery: {
      isEnabled: true
    }
  }
}




output storageAccountName string = resStorageAccount.name
output storageAccountId string = resStorageAccount.id

