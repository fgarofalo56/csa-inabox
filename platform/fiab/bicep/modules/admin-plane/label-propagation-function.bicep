// CSA Loom — label-propagation timer Function (F15). Azure Functions on a Linux
// Consumption (Y1/Dynamic) plan with a system-assigned identity. Polls the Loom
// Cosmos lineage graph every LABEL_PROPAGATION_CRON interval and writes
// sensitivity-label propagation state to the `label-propagation` container.
//
// Code: apps/fiab-label-propagation (Node v4 model). No Microsoft Fabric
// dependency — operates purely on the Loom Cosmos store.
//
// The Function identity needs Cosmos DB Built-in Data Contributor at the Loom
// Cosmos account. That account lives in the DLZ resource group (cross-RG, and a
// Cosmos *data-plane* role is a sqlRoleAssignment, not Azure RBAC), so the grant
// is performed in post-deploy bootstrap (scripts/csa-loom/grant-navigator-rbac.sh)
// using the principalId output below.
//
// Grounded in Microsoft Learn:
//   Functions infra-as-code (serverfarms Y1/Dynamic) + Microsoft.Web/sites
//   https://learn.microsoft.com/azure/azure-functions/functions-infrastructure-as-code
//   Timer trigger (NCRONTAB)
//   https://learn.microsoft.com/azure/azure-functions/functions-bindings-timer

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Loom Cosmos account endpoint (https://<acct>.documents.<suffix>:443/). Empty disables the engine cleanly.')
param loomCosmosEndpoint string = ''

@description('Loom Cosmos database id.')
param loomCosmosDatabase string = 'loom'

@description('NCRONTAB schedule (6-field) for the propagation timer. Default every 15 minutes.')
param labelPropagationCron string = '0 */15 * * * *'

@description('Application Insights connection string for telemetry. Empty skips wiring.')
param appInsightsConnectionString string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object

var saName = take('salblprop${uniqueString(resourceGroup().id)}', 24)
var planName = take('plan-lblprop-${uniqueString(resourceGroup().id)}', 40)
var siteName = take('func-lblprop-${uniqueString(resourceGroup().id)}', 60)

resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: saName
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  tags: complianceTags
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  kind: 'functionapp,linux'
  properties: {
    reserved: true
  }
}

var baseAppSettings = [
  {
    name: 'AzureWebJobsStorage'
    value: 'DefaultEndpointsProtocol=https;AccountName=${sa.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${sa.listKeys().keys[0].value}'
  }
  { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
  { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
  { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
  { name: 'LOOM_COSMOS_ENDPOINT', value: loomCosmosEndpoint }
  { name: 'LOOM_COSMOS_DATABASE', value: loomCosmosDatabase }
  { name: 'LABEL_PROPAGATION_CRON', value: labelPropagationCron }
]

resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: siteName
  location: location
  tags: complianceTags
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Node|20'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: empty(appInsightsConnectionString) ? baseAppSettings : concat(baseAppSettings, [
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
      ])
    }
  }
}

output siteId string = site.id
output siteName string = site.name
output defaultHostName string = site.properties.defaultHostName
@description('System-assigned identity principalId — grant it Cosmos DB Built-in Data Contributor in post-deploy bootstrap.')
output principalId string = site.identity.principalId
