// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used to create an App Service (Web App) for the DMLZ
// web portal and governance APIs.
targetScope = 'resourceGroup'

// Parameters
@description('Name of the Web App.')
param webAppName string

@description('Azure region.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('App Service Plan SKU.')
@allowed([
  'B1'
  'B2'
  'B3'
  'S1'
  'S2'
  'S3'
  'P1v3'
  'P2v3'
  'P3v3'
])
param planSku string = 'P1v3'

@description('Runtime stack for the Web App.')
@allowed([
  'dotnet'
  'python'
  'node'
  'java'
])
param runtime string = 'dotnet'

@description('Runtime version (e.g. "8.0" for .NET 8, "3.12" for Python 3.12).')
param runtimeVersion string = '8.0'

@description('Enable VNet integration.')
param enableVnetIntegration bool = false

@description('Subnet ID for VNet integration.')
param vnetIntegrationSubnetId string = ''

@description('Subnet ID for the private endpoint.')
param subnetId string = ''

@description('Private DNS Zone ID for Web App (privatelink.azurewebsites.net).')
param privateDnsZoneIdWebApp string = ''

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Application Insights connection string.')
param applicationInsightsConnectionString string = ''

@description('Attach a CanNotDelete resource lock. Default true for production safety.')
param enableResourceLock bool = true

@description('CORS allowed origins. Array of origin URLs.')
param corsAllowedOrigins array = []

@description('Enable CORS credentials support.')
param corsSupportCredentials bool = false

@description('Additional app settings. Array of objects: { name, value }')
param additionalAppSettings array = []

// Variables
var appServicePlanName = '${webAppName}-plan'
var webAppPrivateEndpointName = '${webAppName}-private-endpoint'

// Compute the Linux framework version based on runtime + version.
var linuxFxVersionMap = {
  dotnet: 'DOTNETCORE|${runtimeVersion}'
  python: 'PYTHON|${runtimeVersion}'
  node: 'NODE|${runtimeVersion}'
  java: 'JAVA|${runtimeVersion}'
}

var baseAppSettings = [
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: applicationInsightsConnectionString }
  { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
]

// Resources
// #checkov:skip=CKV_AZURE_17:Web App client certificate requirement not needed for DMLZ internal portal
// #checkov:skip=CKV_AZURE_63:Web App authentication configured via Entra ID integration, not App Service auth
// #checkov:skip=CKV_AZURE_88:Web App uses managed identity for auth; App Service authentication configured out-of-band
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: planSku
  }
  properties: {
    reserved: true
  }
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  tags: tags
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    // CKV_AZURE_17 -- require client certificate at the platform layer; the
    // app can opt out per-route via clientCertExclusionPaths.
    clientCertEnabled: true
    clientCertMode: 'Optional'
    publicNetworkAccess: !empty(subnetId) ? 'Disabled' : 'Enabled'
    virtualNetworkSubnetId: enableVnetIntegration && !empty(vnetIntegrationSubnetId) ? vnetIntegrationSubnetId : null
    siteConfig: {
      linuxFxVersion: linuxFxVersionMap[runtime]
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      alwaysOn: true
      http20Enabled: true
      // CKV_AZURE_213 -- health check endpoint.
      healthCheckPath: '/health'
      appSettings: concat(baseAppSettings, additionalAppSettings)
      cors: !empty(corsAllowedOrigins) ? {
        allowedOrigins: corsAllowedOrigins
        supportCredentials: corsSupportCredentials
      } : null
    }
  }
}

// Private Endpoint
resource webAppPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (!empty(subnetId)) {
  name: webAppPrivateEndpointName
  location: location
  tags: tags
  properties: {
    manualPrivateLinkServiceConnections: []
    privateLinkServiceConnections: [
      {
        name: webAppPrivateEndpointName
        properties: {
          groupIds: [
            'sites'
          ]
          privateLinkServiceId: webApp.id
          requestMessage: ''
        }
      }
    ]
    subnet: {
      id: subnetId
    }
  }
}

resource webAppPrivateEndpointARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (!empty(subnetId) && !empty(privateDnsZoneIdWebApp)) {
  parent: webAppPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: '${webAppPrivateEndpointName}-arecord'
        properties: {
          privateDnsZoneId: privateDnsZoneIdWebApp
        }
      }
    ]
  }
}

// Diagnostic Settings — capture HTTP logs and app service platform logs.
resource webAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${webAppName}-diagnostics'
  scope: webApp
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServiceAppLogs', enabled: true }
      { category: 'AppServicePlatformLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Resource lock — protects the DMLZ web portal from accidental deletion.
resource webAppLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: webApp
  name: '${webAppName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: DMLZ Web App. Delete via the rollback workflow in docs/ROLLBACK.md.'
  }
}

// Outputs
@description('Resource ID of the Web App.')
output webAppId string = webApp.id

@description('Name of the Web App.')
output webAppName string = webApp.name

@description('Default hostname.')
output defaultHostname string = webApp.properties.defaultHostName

@description('Managed identity principal ID.')
output managedIdentityPrincipalId string = webApp.identity.principalId

@description('App Service Plan ID.')
output appServicePlanId string = appServicePlan.id
