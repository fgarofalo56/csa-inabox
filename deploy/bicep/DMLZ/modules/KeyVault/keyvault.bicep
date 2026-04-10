// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used to create a KeyVault.
targetScope = 'resourceGroup'

// Parameters
param location string
param tags object
param subnetId string
param keyvaultName string
param privateDnsZoneIdKeyVault string = ''

@description('Attach a CanNotDelete resource lock to the Key Vault. Default true for production safety.')
param enableResourceLock bool = true

@description('Log Analytics workspace resource ID for diagnostic settings. Leave empty to skip diagnostics.')
param logAnalyticsWorkspaceId string = ''

// Variables
var keyVaultPrivateEndpointName = '${keyVault.name}-private-endpoint'

// Resources
resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: keyvaultName
  location: location
  tags: tags
  properties: {
    accessPolicies: []
    createMode: 'default'
    enabledForDeployment: false
    enabledForDiskEncryption: false
    enabledForTemplateDeployment: false
    enablePurgeProtection: true
    enableRbacAuthorization: true
    enableSoftDelete: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
      ipRules: []
      virtualNetworkRules: []
    }
    // With the networkAcls above we already deny public traffic; setting
    // publicNetworkAccess 'Disabled' makes the intent explicit and matches
    // the rest of the DMLZ data-plane posture.
    publicNetworkAccess: 'Disabled'
    sku: {
      family: 'A'
      name: 'standard'
    }
    softDeleteRetentionInDays: 90
    tenantId: subscription().tenantId
  }
}

resource keyVaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: keyVaultPrivateEndpointName
  location: location
  tags: tags
  properties: {
    manualPrivateLinkServiceConnections: []
    privateLinkServiceConnections: [
      {
        name: keyVaultPrivateEndpointName
        properties: {
          groupIds: [
            'vault'
          ]
          privateLinkServiceId: keyVault.id
          requestMessage: ''
        }
      }
    ]
    subnet: {
      id: subnetId
    }
  }
}

resource keyVaultPrivateEndpointARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if(!empty(privateDnsZoneIdKeyVault)) {
  parent: keyVaultPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: '${keyVaultPrivateEndpoint.name}-arecord'
        properties: {
          privateDnsZoneId: privateDnsZoneIdKeyVault
        }
      }
    ]
  }
}

// Resource lock — Key Vault has its own soft-delete + purge protection,
// but a resource lock prevents accidental `az group delete` from hitting
// it in the first place.
resource keyVaultLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: keyVault
  name: '${keyvaultName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: DMLZ Key Vault. Delete via the rollback workflow in docs/ROLLBACK.md.'
  }
}

// Diagnostic settings — audit every Key Vault operation to Log Analytics
// so AuditEvent queries from docs/LOG_SCHEMA.md work across the platform.
resource keyVaultDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${keyvaultName}-diagnostics'
  scope: keyVault
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Outputs
output keyvaultId string = keyVault.id
