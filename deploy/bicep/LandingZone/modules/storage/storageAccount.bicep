// Template to deploy Azure Storage Accounts

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
param defaultAction string = 'Allow'

@description('Enable Hierarchical Namespace for the storage account. Azure Datalake Gen2')
param isHnsEnabled bool = false


// Variables
var name = substring(toLower('lasa${prefix}${environment}${uniqueString(resourceGroup)}'), 0, 23)

// Resource

resource resStorageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: name
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
    publicNetworkAccess: 'enabled'

  }
}

output storageAccountName string = resStorageAccount.name
output storageAccountId string = resStorageAccount.id

