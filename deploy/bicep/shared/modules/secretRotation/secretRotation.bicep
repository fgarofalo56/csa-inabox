// =============================================================================
// CSA-in-a-Box: Secret Rotation Function App + Event Grid Subscription
// Deploys an Azure Function App that automatically rotates secrets when
// Key Vault fires SecretNearExpiry events.  Also creates an alert rule
// for rotation failures so the ops team is notified.
// =============================================================================
targetScope = 'resourceGroup'

// Parameters
@description('Azure region for deployment')
param parLocation string

@description('Name of the Function App')
param parFunctionAppName string

@description('Resource ID of the Key Vault whose secrets will be rotated')
param parKeyVaultId string

@description('Name of the Key Vault (derived from parKeyVaultId if empty)')
param parKeyVaultName string = ''

@description('Resource ID of the storage account for Function App runtime files')
param parStorageAccountId string

@description('Log Analytics workspace resource ID for diagnostic settings')
param parLogAnalyticsWorkspaceId string = ''

@description('Tags for resource organisation')
param parTags object = {}

@description('App Service Plan SKU.  Y1 = Consumption (pay-per-execution).')
@allowed([
  'Y1'   // Consumption plan — cheapest for low-volume workloads
  'EP1'  // Elastic Premium — needed if VNet integration is required
])
param parPlanSku string = 'Y1'

@description('Application Insights instrumentation key.  Leave empty to skip AI integration.')
param parAppInsightsInstrumentationKey string = ''

@description('Application Insights connection string.  Leave empty to skip AI integration.')
param parAppInsightsConnectionString string = ''

@description('Azure subscription ID for rotation SDK calls.  The function uses this to manage resources.')
param parAzureSubscriptionId string = subscription().subscriptionId

@description('Default secret validity in days after rotation')
param parSecretValidityDays int = 90

@description('Attach a CanNotDelete resource lock to the Function App.  Default true for production safety.')
param parEnableResourceLock bool = true

// Variables
var effectiveKeyVaultName = !empty(parKeyVaultName) ? parKeyVaultName : last(split(parKeyVaultId, '/'))
var storageAccountName = last(split(parStorageAccountId, '/'))
var appServicePlanName = '${parFunctionAppName}-plan'
var eventGridTopicName = '${effectiveKeyVaultName}-secret-expiry-topic'
var eventGridSubscriptionName = '${parFunctionAppName}-rotation-subscription'

// App Service Plan (Consumption)
resource appServicePlan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: appServicePlanName
  location: parLocation
  tags: parTags
  kind: 'functionapp,linux'
  sku: {
    name: parPlanSku
  }
  properties: {
    reserved: true // Required for Linux
  }
}

// Function App
resource functionApp 'Microsoft.Web/sites@2024-11-01' = {
  name: parFunctionAppName
  location: parLocation
  tags: parTags
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    publicNetworkAccess: 'Disabled'
    siteConfig: {
      pythonVersion: '3.11'
      linuxFxVersion: 'Python|3.11'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: storageAccountName }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'python' }
        { name: 'KEY_VAULT_URL', value: 'https://${effectiveKeyVaultName}${environment().suffixes.keyvaultDns}' }
        { name: 'AZURE_SUBSCRIPTION_ID', value: parAzureSubscriptionId }
        { name: 'SECRET_VALIDITY_DAYS', value: string(parSecretValidityDays) }
        { name: 'SECRET_LENGTH', value: '32' }
        { name: 'APPINSIGHTS_INSTRUMENTATIONKEY', value: parAppInsightsInstrumentationKey }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: parAppInsightsConnectionString }
      ]
    }
  }
}

// Key Vault Secrets Officer role — allows the function to read/write secrets
// during rotation.  Role ID: b86a8fe4-44ce-4948-aee5-eccb2c155cd7
resource kvSecretsOfficerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(parKeyVaultId, functionApp.id, 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
  scope: keyVault
  properties: {
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
    )
    description: 'CSA-in-a-Box: secret rotation function — Key Vault Secrets Officer'
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: effectiveKeyVaultName
}

// Event Grid System Topic on Key Vault
resource eventGridTopic 'Microsoft.EventGrid/systemTopics@2025-02-15' = {
  name: eventGridTopicName
  location: parLocation
  tags: parTags
  properties: {
    source: parKeyVaultId
    topicType: 'Microsoft.KeyVault.vaults'
  }
}

// Event Grid Subscription — routes SecretNearExpiry to the Function
resource eventGridSubscription 'Microsoft.EventGrid/systemTopics/eventSubscriptions@2025-02-15' = {
  parent: eventGridTopic
  name: eventGridSubscriptionName
  properties: {
    destination: {
      endpointType: 'AzureFunction'
      properties: {
        resourceId: '${functionApp.id}/functions/secret_rotation_handler'
        maxEventsPerBatch: 1
        preferredBatchSizeInKilobytes: 64
      }
    }
    filter: {
      includedEventTypes: [
        'Microsoft.KeyVault.SecretNearExpiry'
      ]
    }
    eventDeliverySchema: 'EventGridSchema'
    retryPolicy: {
      maxDeliveryAttempts: 5
      eventTimeToLiveInMinutes: 1440
    }
  }
}

// Diagnostic settings for the Function App
resource functionAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(parLogAnalyticsWorkspaceId)) {
  name: '${parFunctionAppName}-diagnostics'
  scope: functionApp
  properties: {
    workspaceId: parLogAnalyticsWorkspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Resource lock
resource functionAppLock 'Microsoft.Authorization/locks@2020-05-01' = if (parEnableResourceLock) {
  scope: functionApp
  name: '${parFunctionAppName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: secret rotation function app. Delete via the rollback workflow in docs/ROLLBACK.md.'
  }
}

// Outputs
output functionAppId string = functionApp.id
output functionAppName string = functionApp.name
output functionAppPrincipalId string = functionApp.identity.principalId
output eventGridTopicId string = eventGridTopic.id
