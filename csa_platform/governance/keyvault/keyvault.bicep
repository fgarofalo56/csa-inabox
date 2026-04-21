// Key Vault Module — Data Platform Secrets Management
// Deploys Azure Key Vault with private endpoints, RBAC authorization, and diagnostic settings.
targetScope = 'resourceGroup'

@description('Name of the Key Vault')
@maxLength(24)
param keyVaultName string

@description('Location for the Key Vault')
param location string = resourceGroup().location

@description('SKU for the Key Vault')
@allowed([
  'standard'
  'premium'
])
param skuName string = 'standard'

@description('Enable RBAC authorization (recommended over access policies)')
param enableRbacAuthorization bool = true

@description('Enable purge protection')
param enablePurgeProtection bool = true

@description('Soft delete retention in days')
@minValue(7)
@maxValue(90)
param softDeleteRetentionInDays int = 90

@description('Enable public network access')
@allowed([
  'Enabled'
  'Disabled'
])
param publicNetworkAccess string = 'Disabled'

@description('VNet and Subnet info for Private Endpoints')
param privateEndpointSubnets array = []

@description('Private DNS Zone resource ID for Key Vault')
param privateDnsZoneId string = ''

@description('Resource ID of the Log Analytics workspace for diagnostics')
param logAnalyticsWorkspaceId string = ''

@description('Tags for Key Vault resources')
param tags object = {}

// Resources

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: skuName
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: enableRbacAuthorization
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    enablePurgeProtection: enablePurgeProtection
    publicNetworkAccess: publicNetworkAccess
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: publicNetworkAccess == 'Disabled' ? 'Deny' : 'Allow'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

// Private Endpoints
resource keyVaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-04-01' = [
  for peSubnet in privateEndpointSubnets: {
    name: '${keyVaultName}-pe-vault-${peSubnet.vNetLocation}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      subnet: {
        id: resourceId(peSubnet.subscriptionId, peSubnet.vNetResourceGroup, 'Microsoft.Network/virtualNetworks/subnets', peSubnet.vNetName, peSubnet.subnetName)
      }
      privateLinkServiceConnections: [
        {
          name: '${keyVaultName}-vault'
          properties: {
            privateLinkServiceId: keyVault.id
            groupIds: [
              'vault'
            ]
          }
        }
      ]
    }
  }
]

// DNS Zone Groups
resource keyVaultDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-04-01' = [
  for (peSubnet, i) in privateEndpointSubnets: if (!empty(privateDnsZoneId)) {
    name: 'default'
    parent: keyVaultPrivateEndpoint[i]
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${keyVaultName}-vault-dns'
          properties: {
            privateDnsZoneId: privateDnsZoneId
          }
        }
      ]
    }
  }
]

// Diagnostic Settings
resource keyVaultDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${keyVaultName}-diag'
  scope: keyVault
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
      {
        categoryGroup: 'audit'
        enabled: true
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

// Outputs
output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
