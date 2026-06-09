// CSA Loom — report-subscriptions timer Function. Azure Functions on a Linux
// Consumption (Y1/Dynamic) plan with a system-assigned identity. On the
// REPORT_SUBSCRIPTIONS_CRON schedule it reads enabled report subscriptions from
// the Loom Cosmos store, renders each report via the real Power BI ExportTo
// REST job (PDF/PPTX/PNG), archives the file to ADLS, emails it via the
// report-subscription delivery Logic App, and writes a delivery-log row.
//
// Code: apps/fiab-report-subscriptions (Node v4 model). Azure-native parity
// with Fabric/Power BI report subscriptions — NO Microsoft Fabric dependency.
//
// The Function identity needs (granted in post-deploy bootstrap where the role
// is cross-RG / data-plane, and inline here where possible):
//   - Cosmos DB Built-in Data Contributor on the Loom Cosmos account
//     (data-plane sqlRoleAssignment — grant-navigator-rbac.sh),
//   - Storage Blob Data Contributor on LOOM_ADLS_ACCOUNT,
//   - Logic App Contributor on the delivery workflow (granted by
//     integration/report-subscription-logicapp.bicep via subscriptionPrincipalId),
//   - membership (Member+) in each Power BI workspace it exports from.
//
// Grounded in Microsoft Learn:
//   Functions infra-as-code (serverfarms Y1/Dynamic) + Microsoft.Web/sites
//   https://learn.microsoft.com/azure/azure-functions/functions-infrastructure-as-code
//   Timer trigger (NCRONTAB)
//   https://learn.microsoft.com/azure/azure-functions/functions-bindings-timer
//   Power BI ExportToFile
//   https://learn.microsoft.com/power-bi/developer/embedded/export-to

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Loom Cosmos account endpoint (https://<acct>.documents.<suffix>:443/). Empty disables the engine cleanly.')
param loomCosmosEndpoint string = ''

@description('Loom Cosmos database id.')
param loomCosmosDatabase string = 'loom'

@description('NCRONTAB schedule (6-field) for the subscription timer tick. Default weekdays at 08:00 UTC; use a finer cadence to fire per-subscription schedules close to their intended time.')
param reportSubscriptionsCron string = '0 0 8 * * 1-5'

@description('ADLS Gen2 account name the rendered exports are archived to (report-exports container).')
param adlsAccount string = ''

@description('Subscription id used for ARM listCallbackUrl on the delivery Logic App.')
param loomSubscriptionId string = ''

@description('Delivery Logic App workflow name (integration/report-subscription-logicapp.bicep).')
param subscriptionLogicAppName string = ''

@description('Resource group of the delivery Logic App. Empty defaults at runtime to LOOM_DLZ_RG.')
param subscriptionLogicAppRg string = ''

@description('LOOM_DLZ_RG fallback wired into app settings so the Function can resolve the Logic App RG.')
param loomDlzRg string = ''

@description('Application Insights connection string for telemetry. Empty skips wiring.')
param appInsightsConnectionString string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object

var saName = take('sarptsub${uniqueString(resourceGroup().id)}', 24)
var planName = take('plan-rptsub-${uniqueString(resourceGroup().id)}', 40)
var siteName = take('func-rptsub-${uniqueString(resourceGroup().id)}', 60)

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
  { name: 'REPORT_SUBSCRIPTIONS_CRON', value: reportSubscriptionsCron }
  { name: 'LOOM_ADLS_ACCOUNT', value: adlsAccount }
  { name: 'LOOM_STORAGE_SUFFIX', value: environment().suffixes.storage }
  { name: 'LOOM_SUBSCRIPTION_ID', value: loomSubscriptionId }
  { name: 'LOOM_SUBSCRIPTION_LOGIC_APP_NAME', value: subscriptionLogicAppName }
  { name: 'LOOM_SUBSCRIPTION_LOGIC_APP_RG', value: subscriptionLogicAppRg }
  { name: 'LOOM_DLZ_RG', value: loomDlzRg }
  // Sovereign-cloud endpoints derived from the deployment environment so the
  // Function reaches the correct Power BI / ARM hosts in Gov clouds.
  { name: 'LOOM_ARM_ENDPOINT', value: environment().resourceManager }
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
@description('System-assigned identity principalId — grant it Cosmos DB Built-in Data Contributor + Storage Blob Data Contributor + Logic App Contributor in post-deploy bootstrap / the delivery Logic App module.')
output principalId string = site.identity.principalId
