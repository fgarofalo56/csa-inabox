// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used to create an Azure Function App for DMLZ automation
// (governance workflows, policy enforcement, metadata processing).
targetScope = 'resourceGroup'

// Parameters
@description('Name of the Function App.')
param functionAppName string

@description('Azure region.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('Runtime stack for the Function App.')
@allowed([
  'python'
  'dotnet-isolated'
  'node'
  'java'
])
param runtime string = 'python'

@description('Runtime version.')
param runtimeVersion string = '3.12'

@description('App Service Plan SKU.')
@allowed([
  'Y1'
  'EP1'
  'EP2'
  'EP3'
  'P1v3'
  'P2v3'
])
param planSku string = 'EP1'

@description('Resource ID of the Storage Account for the Function App.')
param storageAccountId string

@description('Name of the Storage Account.')
param storageAccountName string

@description('Resource ID of the Application Insights instance.')
param applicationInsightsId string = ''

@description('Application Insights connection string.')
param applicationInsightsConnectionString string = ''

@description('Enable VNet integration.')
param enableVnetIntegration bool = false

@description('Subnet ID for VNet integration.')
param vnetIntegrationSubnetId string = ''

@description('Private endpoint subnet configurations.')
param privateEndpointSubnets array = []

@description('Private DNS Zone ID for Function App (privatelink.azurewebsites.net).')
param privateDnsZoneId string = ''

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Attach a CanNotDelete resource lock. Default true for production safety.')
param enableResourceLock bool = true

@description('Additional app settings for governance configuration. Array of objects: { name, value }')
param additionalAppSettings array = []

// NOTE: Azure Functions CMK encryption is inherited from the underlying
// storage account (storageAccountId parameter). To enable CMK for Functions:
// 1. Deploy the storage account with CMK enabled (see storage.bicep parEnableCmk)
// 2. The Function App will automatically use the CMK-encrypted storage
// No additional CMK configuration is needed on the Function App resource itself.

// Variables
var appServicePlanName = '${functionAppName}-plan'
var isConsumption = planSku == 'Y1'

var baseAppSettings = [
  { name: 'AzureWebJobsStorage__accountName', value: storageAccountName }
  { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
  { name: 'FUNCTIONS_WORKER_RUNTIME', value: runtime }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: applicationInsightsConnectionString }
  { name: 'AzureWebJobsFeatureFlags', value: 'EnableWorkerIndexing' }
  { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
]

// Resources
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: planSku
    tier: isConsumption ? 'Dynamic' : 'ElasticPremium'
  }
  properties: {
    reserved: true
    maximumElasticWorkerCount: isConsumption ? null : 20
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: union(tags, { 'azd-service-name': functionAppName })
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    publicNetworkAccess: empty(privateEndpointSubnets) ? 'Enabled' : 'Disabled'
    virtualNetworkSubnetId: enableVnetIntegration && !empty(vnetIntegrationSubnetId) ? vnetIntegrationSubnetId : null
    siteConfig: {
      linuxFxVersion: '${toUpper(runtime)}|${runtimeVersion}'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: concat(baseAppSettings, additionalAppSettings)
    }
  }
}

// Private Endpoints
resource functionPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = [
  for (peSubnet, index) in privateEndpointSubnets: {
    name: '${functionAppName}-pe-${peSubnet.vNetName}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      privateLinkServiceConnections: [
        {
          name: '${functionAppName}-sites'
          properties: {
            privateLinkServiceId: functionApp.id
            groupIds: [
              'sites'
            ]
          }
        }
      ]
      subnet: {
        id: resourceId(
          peSubnet.subscriptionId,
          peSubnet.vNetResourceGroup,
          'Microsoft.Network/virtualNetworks/subnets',
          peSubnet.vNetName,
          peSubnet.subnetName
        )
      }
    }
  }
]

resource functionPeDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = [
  for (peSubnet, index) in privateEndpointSubnets: if (!empty(privateDnsZoneId)) {
    parent: functionPrivateEndpoint[index]
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${functionAppName}-dns-config'
          properties: {
            privateDnsZoneId: privateDnsZoneId
          }
        }
      ]
    }
  }
]

// Diagnostic Settings — capture function execution logs for governance audit trails.
resource functionDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${functionAppName}-diagnostics'
  scope: functionApp
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'FunctionAppLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Resource lock — protects the DMLZ automation Function App from accidental deletion.
resource functionLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: functionApp
  name: '${functionAppName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: DMLZ Function App for governance automation. Delete via the rollback workflow in docs/ROLLBACK.md.'
  }
}

// Outputs
@description('Resource ID of the Function App.')
output functionAppId string = functionApp.id

@description('Name of the Function App.')
output functionAppName string = functionApp.name

@description('Default hostname.')
output defaultHostname string = functionApp.properties.defaultHostName

@description('Managed identity principal ID.')
output managedIdentityPrincipalId string = functionApp.identity.principalId

@description('App Service Plan ID.')
output appServicePlanId string = appServicePlan.id
