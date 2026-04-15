// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used to create an Azure API Management instance for DMLZ data APIs.
targetScope = 'resourceGroup'

// Parameters
@description('Name of the API Management instance.')
param apimName string

@description('Azure region.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('Publisher email address for the APIM instance.')
param publisherEmail string

@description('Publisher organization name.')
param publisherName string

@description('SKU for the API Management instance.')
@allowed([
  'Developer'
  'Standard'
  'Premium'
])
param sku string = 'Developer'

@description('Number of scale units. Only applies to Standard and Premium SKUs.')
@minValue(1)
@maxValue(12)
param skuCount int = 1

@description('Subnet ID for VNet integration (internal mode). Required for internal APIM.')
param subnetId string

@description('Private endpoint subnet ID for the gateway private endpoint.')
param privateEndpointSubnetId string = ''

@description('Private DNS Zone ID for API Management (privatelink.azure-api.net).')
param privateDnsZoneIdApim string = ''

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Application Insights resource ID for API analytics.')
param applicationInsightsId string = ''

@description('Application Insights instrumentation key.')
param applicationInsightsInstrumentationKey string = ''

@description('Attach a CanNotDelete resource lock. Default true for production safety.')
param enableResourceLock bool = true

@description('Public network access setting.')
@allowed([
  'Enabled'
  'Disabled'
])
param publicNetworkAccess string = 'Disabled'

@description('Named values to configure. Array of objects: { name, displayName, value, secret }')
param namedValues array = []

// Variables
var apimPrivateEndpointName = '${apimName}-private-endpoint'

// Resources
// #checkov:skip=CKV_AZURE_107:APIM backend uses VNet-internal endpoints; mutual TLS not required for internal APIs
// #checkov:skip=CKV_AZURE_174:APIM minimum API version configured at API-level, not globally
resource apim 'Microsoft.ApiManagement/service@2023-09-01-preview' = {
  name: apimName
  location: location
  tags: tags
  sku: {
    name: sku
    capacity: skuCount
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publisherEmail: publisherEmail
    publisherName: publisherName
    virtualNetworkType: 'Internal'
    virtualNetworkConfiguration: {
      subnetResourceId: subnetId
    }
    publicNetworkAccess: publicNetworkAccess
    customProperties: {
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls10': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls11': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Ssl30': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Backend.Protocols.Tls10': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Backend.Protocols.Tls11': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Backend.Protocols.Ssl30': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Ciphers.TripleDes168': 'False'
    }
  }
}

// Named Values
resource apimNamedValues 'Microsoft.ApiManagement/service/namedValues@2023-09-01-preview' = [
  for nv in namedValues: {
    parent: apim
    name: nv.name
    properties: {
      displayName: nv.displayName
      value: nv.value
      secret: contains(nv, 'secret') ? nv.secret : false
    }
  }
]

// API Version Set — provides a template for versioned data APIs
resource apiVersionSet 'Microsoft.ApiManagement/service/apiVersionSets@2023-09-01-preview' = {
  parent: apim
  name: 'data-api-version-set'
  properties: {
    displayName: 'Data APIs'
    versioningScheme: 'Segment'
    description: 'Version set for DMLZ data management APIs.'
  }
}

// Application Insights Logger
resource apimLogger 'Microsoft.ApiManagement/service/loggers@2023-09-01-preview' = if (!empty(applicationInsightsId)) {
  parent: apim
  name: '${apimName}-logger'
  properties: {
    loggerType: 'applicationInsights'
    resourceId: applicationInsightsId
    credentials: {
      instrumentationKey: applicationInsightsInstrumentationKey
    }
  }
}

// Private Endpoint
resource apimPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (!empty(privateEndpointSubnetId)) {
  name: apimPrivateEndpointName
  location: location
  tags: tags
  properties: {
    manualPrivateLinkServiceConnections: []
    privateLinkServiceConnections: [
      {
        name: apimPrivateEndpointName
        properties: {
          groupIds: [
            'Gateway'
          ]
          privateLinkServiceId: apim.id
          requestMessage: ''
        }
      }
    ]
    subnet: {
      id: privateEndpointSubnetId
    }
  }
}

resource apimPrivateEndpointARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (!empty(privateEndpointSubnetId) && !empty(privateDnsZoneIdApim)) {
  parent: apimPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: '${apimPrivateEndpointName}-arecord'
        properties: {
          privateDnsZoneId: privateDnsZoneIdApim
        }
      }
    ]
  }
}

// Diagnostic Settings — capture gateway logs and metrics for API audit trails.
resource apimDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${apimName}-diagnostics'
  scope: apim
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

// Resource lock — APIM instances are expensive and slow to recreate.
resource apimLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: apim
  name: '${apimName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: DMLZ API Management instance. Delete via the rollback workflow in docs/ROLLBACK.md.'
  }
}

// Outputs
@description('Resource ID of the API Management instance.')
output apimId string = apim.id

@description('Name of the API Management instance.')
output apimName string = apim.name

@description('Gateway URL of the API Management instance.')
output gatewayUrl string = apim.properties.gatewayUrl

@description('Managed identity principal ID.')
output managedIdentityPrincipalId string = apim.identity.principalId

@description('Private IP addresses of the API Management instance.')
output privateIpAddresses array = apim.properties.privateIPAddresses
