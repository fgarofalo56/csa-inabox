// -------------------------------------------------------------
// {{ cookiecutter.vertical_name }} - starter Bicep template
//
// Wires in shared modules under deploy/bicep/shared/modules/
// for resource group, private endpoint, RBAC, and security
// (customer-managed key identity). Extend as needed.
//
// FedRAMP target: {{ cookiecutter.fedramp_level }}
// Owner:          {{ cookiecutter.domain_owner }}
// -------------------------------------------------------------

targetScope = 'resourceGroup'

@description('Base name prefix for all resources (lowercase, no hyphens)')
@minLength(3)
@maxLength(20)
param baseName string = '{{ cookiecutter.vertical_slug | replace("-", "") }}'

@description('Azure region')
param location string = resourceGroup().location

@description('FedRAMP target level')
@allowed([ 'moderate', 'high', 'il4', 'il5' ])
param fedRampLevel string = '{{ cookiecutter.fedramp_level }}'

@description('Log Analytics workspace resource ID for diagnostic settings')
param logAnalyticsWorkspaceId string = ''

@description('Tags applied to every resource')
param tags object = {
  vertical: '{{ cookiecutter.vertical_slug }}'
  owner: '{{ cookiecutter.domain_owner }}'
  fedramp: fedRampLevel
  source: 'csa-inabox/templates/example-vertical'
}

// -------------------------------------------------------------
// ADLS Gen2 storage account (bronze/silver/gold containers)
// -------------------------------------------------------------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: '${baseName}adls${uniqueString(resourceGroup().id)}'
  location: location
  tags: tags
  sku: {
    name: 'Standard_ZRS'
  }
  kind: 'StorageV2'
  properties: {
    isHnsEnabled: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false   // FedRAMP High / IL5: identity-only.
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
    encryption: {
      services: {
        blob: { enabled: true }
        file: { enabled: true }
      }
      keySource: 'Microsoft.Storage'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
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
  }
}

resource bronzeContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'bronze'
  properties: { publicAccess: 'None' }
}
resource silverContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'silver'
  properties: { publicAccess: 'None' }
}
resource goldContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'gold'
  properties: { publicAccess: 'None' }
}

// -------------------------------------------------------------
// Outputs - consumed by downstream pipelines, dbt profiles, etc.
// -------------------------------------------------------------

output storageAccountName string = storage.name
output storageAccountId string = storage.id
output bronzeContainer string = 'bronze'
output silverContainer string = 'silver'
output goldContainer string = 'gold'

// TODO: wire in additional shared modules as needed:
//   module rbac '../../../../deploy/bicep/shared/modules/roleAssignment.bicep' = { ... }
//   module pe   '../../../../deploy/bicep/shared/modules/privateEndpoint.bicep' = { ... }
//   module cmk  '../../../../deploy/bicep/shared/modules/security/cmkIdentity.bicep' = { ... }
