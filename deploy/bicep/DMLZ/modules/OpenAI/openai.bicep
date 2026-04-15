// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used to create an Azure OpenAI Service instance for DMLZ.
targetScope = 'resourceGroup'

// Parameters
@description('Name of the Azure OpenAI account.')
param openAiName string

@description('Azure region.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('SKU for the Cognitive Services account.')
param sku string = 'S0'

@description('Model deployments. Array of objects: { name, model: { format, name, version }, sku: { name, capacity } }')
param deployments array = []

@description('Public network access setting.')
@allowed([
  'Enabled'
  'Disabled'
])
param publicNetworkAccess string = 'Disabled'

@description('Custom subdomain name for the OpenAI account.')
param customSubDomainName string = ''

@description('Subnet ID for private endpoint.')
param subnetId string = ''

@description('Private DNS Zone ID for OpenAI (privatelink.openai.azure.com).')
param privateDnsZoneIdOpenAi string = ''

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Attach a CanNotDelete resource lock. Default true for production safety.')
param enableResourceLock bool = true

@description('Enable Customer-Managed Key (CMK) encryption.')
param parEnableCmk bool = false

@description('Key Vault URI (e.g. https://myvault.vault.azure.net) when CMK is enabled.')
param parCmkKeyVaultUri string = ''

@description('Key name in the Key Vault for CMK encryption.')
param parCmkKeyName string = ''

@description('Key version. Leave empty for automatic key rotation (recommended).')
param parCmkKeyVersion string = ''

@description('Resource ID of the user-assigned managed identity for CMK.')
param parCmkIdentityId string = ''

// Variables
var openAiPrivateEndpointName = '${openAiName}-private-endpoint'
var effectiveSubDomainName = !empty(customSubDomainName) ? customSubDomainName : openAiName

// Resources
// #checkov:skip=CKV_AZURE_236:OpenAI CMK encryption is optional for dev/lab — enable via parEnableCmk for prod
resource openAi 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: openAiName
  location: location
  tags: tags
  kind: 'OpenAI'
  identity: {
    type: parEnableCmk ? 'SystemAssigned,UserAssigned' : 'SystemAssigned'
    userAssignedIdentities: parEnableCmk ? {
      '${parCmkIdentityId}': {}
    } : null
  }
  sku: {
    name: sku
  }
  properties: {
    customSubDomainName: effectiveSubDomainName
    publicNetworkAccess: publicNetworkAccess
    networkAcls: {
      defaultAction: 'Deny'
      ipRules: []
      virtualNetworkRules: []
    }
    disableLocalAuth: true
    encryption: parEnableCmk ? {
      keySource: 'Microsoft.KeyVault'
      keyVaultProperties: {
        keyName: parCmkKeyName
        keyVaultUri: parCmkKeyVaultUri
        keyVersion: !empty(parCmkKeyVersion) ? parCmkKeyVersion : null
        identityClientId: parCmkIdentityId
      }
    } : null
  }
}

// Model Deployments
@batchSize(1)
resource openAiDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = [
  for deployment in deployments: {
    parent: openAi
    name: deployment.name
    sku: contains(deployment, 'sku') ? deployment.sku : {
      name: 'Standard'
      capacity: 10
    }
    properties: {
      model: deployment.model
      raiPolicyName: contains(deployment, 'raiPolicyName') ? deployment.raiPolicyName : 'Microsoft.DefaultV2'
    }
  }
]

// Private Endpoint
resource openAiPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (!empty(subnetId)) {
  name: openAiPrivateEndpointName
  location: location
  tags: tags
  properties: {
    manualPrivateLinkServiceConnections: []
    privateLinkServiceConnections: [
      {
        name: openAiPrivateEndpointName
        properties: {
          groupIds: [
            'account'
          ]
          privateLinkServiceId: openAi.id
          requestMessage: ''
        }
      }
    ]
    subnet: {
      id: subnetId
    }
  }
}

resource openAiPrivateEndpointARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (!empty(subnetId) && !empty(privateDnsZoneIdOpenAi)) {
  parent: openAiPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: '${openAiPrivateEndpointName}-arecord'
        properties: {
          privateDnsZoneId: privateDnsZoneIdOpenAi
        }
      }
    ]
  }
}

// Diagnostic Settings — capture token usage and content filtering events.
resource openAiDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${openAiName}-diagnostics'
  scope: openAi
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

// Resource lock — Azure OpenAI instances have quota allocations and model
// deployments that are slow to recreate.
resource openAiLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: openAi
  name: '${openAiName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: DMLZ Azure OpenAI account. Delete via the rollback workflow in docs/ROLLBACK.md.'
  }
}

// Outputs
@description('Resource ID of the Azure OpenAI account.')
output openAiId string = openAi.id

@description('Name of the Azure OpenAI account.')
output openAiName string = openAi.name

@description('Endpoint URL of the Azure OpenAI account.')
output endpoint string = openAi.properties.endpoint

@description('Managed identity principal ID.')
output managedIdentityPrincipalId string = openAi.identity.principalId
