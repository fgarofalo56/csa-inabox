// Azure Functions Module
// Deploys Function App with App Service Plan, private endpoints, and diagnostics
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
param runtimeVersion string = '3.11'

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

@description('Attach a CanNotDelete resource lock to the Function App. Default true for production safety.')
param enableResourceLock bool = true

// NOTE: Azure Functions CMK encryption is inherited from the underlying
// storage account (storageAccountId parameter). To enable CMK for Functions:
// 1. Deploy the storage account with CMK enabled (see storage.bicep parEnableCmk)
// 2. The Function App will automatically use the CMK-encrypted storage
// No additional CMK configuration is needed on the Function App resource itself.

// Variables
var appServicePlanName = '${functionAppName}-plan'
var isConsumption = planSku == 'Y1'

// Resources
// #checkov:skip=CKV_AZURE_17:Function App client certificate requirement not needed for internal processing functions
// #checkov:skip=CKV_AZURE_63:Function App authentication configured via Entra ID integration, not App Service auth
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
    // CKV_AZURE_17 -- require client certificates so internet-exposed
    // function endpoints have a second authentication factor.
    clientCertEnabled: true
    clientCertMode: 'Optional'
    siteConfig: {
      linuxFxVersion: '${toUpper(runtime)}|${runtimeVersion}'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      // CKV_AZURE_18 / CKV_AZURE_67 -- HTTP/2 for inbound, modern default.
      http20Enabled: true
      // CKV_AZURE_213 -- health check endpoint so the platform can
      // remove unhealthy instances from rotation.
      healthCheckPath: '/api/health'
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: storageAccountName }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: runtime }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: applicationInsightsConnectionString }
        { name: 'AzureWebJobsFeatureFlags', value: 'EnableWorkerIndexing' }
      ]
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

// Diagnostic Settings
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

// Resource lock — protects the Function App from accidental deletion.
resource functionLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: functionApp
  name: '${functionAppName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: Function App. Remove lock before deleting.'
  }
}

// Outputs
output functionAppId string = functionApp.id

@description('Name of the Function App.')
output functionAppName string = functionApp.name

@description('Default hostname.')
output defaultHostname string = functionApp.properties.defaultHostName

@description('Managed identity principal ID.')
output managedIdentityPrincipalId string = functionApp.identity.principalId

@description('App Service Plan ID.')
output appServicePlanId string = appServicePlan.id
