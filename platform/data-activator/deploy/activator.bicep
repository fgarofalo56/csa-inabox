// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Data Activator equivalent — deploys Logic Apps + Event Grid + Function App
// for real-time alerting on data quality, freshness, and anomaly events.

targetScope = 'resourceGroup'

// ─── Parameters ─────────────────────────────────────────────────────────────

@description('Azure region for resource deployment.')
param location string = resourceGroup().location

@description('Resource tags applied to all deployed resources.')
param tags object = {}

@description('Environment identifier.')
@allowed(['dev', 'stg', 'prod'])
param environment string

@description('Base name prefix for all resources.')
param baseName string = 'csa-activator'

@description('Teams webhook URL for alert notifications. Store in Key Vault for production.')
@secure()
param teamsWebhookUrl string = ''

@description('PagerDuty integration key for critical alerts. Store in Key Vault for production.')
@secure()
param pagerDutyIntegrationKey string = ''

@description('Email recipients for alert notifications (semicolon-separated).')
param alertEmailRecipients string = ''

@description('Log Analytics workspace resource ID for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Application Insights connection string. Leave empty to create a new instance.')
param appInsightsConnectionString string = ''

@description('Storage account for Function App and alert rule storage.')
param functionStorageAccountName string = ''

@description('Attach a CanNotDelete resource lock. Default true for production.')
param enableResourceLock bool = true

// ─── Variables ──────────────────────────────────────────────────────────────

var uniqueSuffix = take(uniqueString(resourceGroup().id), 6)
var functionAppName = '${baseName}-func-${environment}-${uniqueSuffix}'
var appServicePlanName = '${baseName}-plan-${environment}'
var eventGridTopicName = '${baseName}-topic-${environment}'
var logicAppName = '${baseName}-logic-${environment}'
var funcStorageName = take(toLower(replace('stactivator${environment}${uniqueSuffix}', '-', '')), 24)
var appInsightsName = '${baseName}-insights-${environment}'

// ─── Storage Account (Function App) ─────────────────────────────────────────

resource funcStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = if (empty(functionStorageAccountName)) {
  name: funcStorageName
  location: location
  tags: union(tags, { Purpose: 'Data Activator Function App storage' })
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true // Required for Azure Functions runtime
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    encryption: {
      keySource: 'Microsoft.Storage'
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
        queue: { enabled: true, keyType: 'Account' }
        table: { enabled: true, keyType: 'Account' }
      }
    }
  }
}

var effectiveFuncStorageName = !empty(functionStorageAccountName) ? functionStorageAccountName : funcStorage.name

// ─── Application Insights ───────────────────────────────────────────────────

resource appInsights 'Microsoft.Insights/components@2020-02-02' = if (empty(appInsightsConnectionString)) {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: !empty(logAnalyticsWorkspaceId) ? logAnalyticsWorkspaceId : null
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

var effectiveAppInsightsConnStr = !empty(appInsightsConnectionString)
  ? appInsightsConnectionString
  : appInsights.properties.ConnectionString

// ─── App Service Plan (Consumption) ─────────────────────────────────────────

@description('Consumption plan for the alert processor Function App.')
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  kind: 'functionapp'
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true // Linux
  }
}

// ─── Function App ───────────────────────────────────────────────────────────

@description('Azure Function App running the alert processor.')
resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: union(tags, { Pattern: 'DataActivator' })
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Python|3.11'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'AzureWebJobsStorage', value: 'DefaultEndpointsProtocol=https;AccountName=${effectiveFuncStorageName};EndpointSuffix=${az.environment().suffixes.storage};AccountKey=${listKeys(resourceId('Microsoft.Storage/storageAccounts', effectiveFuncStorageName), '2023-05-01').keys[0].value}' }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'python' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: effectiveAppInsightsConnStr }
        { name: 'TEAMS_WEBHOOK_URL', value: teamsWebhookUrl }
        { name: 'PAGERDUTY_INTEGRATION_KEY', value: pagerDutyIntegrationKey }
        { name: 'ALERT_EMAIL_RECIPIENTS', value: alertEmailRecipients }
        { name: 'ENVIRONMENT', value: environment }
      ]
    }
  }
}

// ─── Event Grid Topic ───────────────────────────────────────────────────────

@description('Custom Event Grid topic for data platform events.')
resource eventGridTopic 'Microsoft.EventGrid/topics@2024-06-01-preview' = {
  name: eventGridTopicName
  location: location
  tags: union(tags, { Pattern: 'DataActivator' })
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    inputSchema: 'CloudEventSchemaV1_0'
    publicNetworkAccess: 'Disabled'
  }
}

// ─── Event Grid Subscription ────────────────────────────────────────────────

@description('Event Grid subscription that routes events to the Function App.')
resource eventGridSubscription 'Microsoft.EventGrid/topics/eventSubscriptions@2024-06-01-preview' = {
  parent: eventGridTopic
  name: 'alert-processor-subscription'
  properties: {
    destination: {
      endpointType: 'AzureFunction'
      properties: {
        resourceId: '${functionApp.id}/functions/alert_processor'
        maxEventsPerBatch: 1
        preferredBatchSizeInKilobytes: 64
      }
    }
    filter: {
      includedEventTypes: [
        'csa.data.quality.check'
        'csa.data.freshness.check'
        'csa.data.anomaly.detected'
        'csa.pipeline.completed'
        'csa.pipeline.failed'
      ]
    }
    eventDeliverySchema: 'CloudEventSchemaV1_0'
    retryPolicy: {
      maxDeliveryAttempts: 10
      eventTimeToLiveInMinutes: 1440
    }
  }
}

// ─── Logic App (Notification Orchestrator) ──────────────────────────────────

@description('Logic App for orchestrating multi-channel alert notifications.')
resource logicApp 'Microsoft.Logic/workflows@2019-05-01' = {
  name: logicAppName
  location: location
  tags: union(tags, { Pattern: 'DataActivator' })
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    state: 'Enabled'
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      parameters: {
        '$connections': {
          defaultValue: {}
          type: 'Object'
        }
      }
      triggers: {
        manual: {
          type: 'Request'
          kind: 'Http'
          inputs: {
            schema: {
              type: 'object'
              properties: {
                alertName: { type: 'string' }
                severity: { type: 'string' }
                domain: { type: 'string' }
                dataProduct: { type: 'string' }
                message: { type: 'string' }
                details: { type: 'object' }
                timestamp: { type: 'string' }
              }
            }
          }
        }
      }
      actions: {
        Switch_on_severity: {
          type: 'Switch'
          expression: '@triggerBody()?[\'severity\']'
          cases: {
            Critical: {
              case: 'critical'
              actions: {
                Send_Teams_and_PagerDuty: {
                  type: 'Compose'
                  inputs: {
                    teamsMessage: 'CRITICAL ALERT: @{triggerBody()?[\'alertName\']} in @{triggerBody()?[\'domain\']}/@{triggerBody()?[\'dataProduct\']}'
                    pagerDuty: true
                  }
                }
              }
            }
            Warning: {
              case: 'warning'
              actions: {
                Send_Teams_Only: {
                  type: 'Compose'
                  inputs: {
                    teamsMessage: 'WARNING: @{triggerBody()?[\'alertName\']} in @{triggerBody()?[\'domain\']}/@{triggerBody()?[\'dataProduct\']}'
                    pagerDuty: false
                  }
                }
              }
            }
          }
          default: {
            actions: {
              Log_Info: {
                type: 'Compose'
                inputs: {
                  message: 'INFO: @{triggerBody()?[\'alertName\']}'
                }
              }
            }
          }
        }
      }
    }
  }
}

// ─── Diagnostic Settings ────────────────────────────────────────────────────

resource functionDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${functionAppName}-diagnostics'
  scope: functionApp
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

resource logicAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${logicAppName}-diagnostics'
  scope: logicApp
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

// ─── Resource Locks ─────────────────────────────────────────────────────────

resource functionLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: functionApp
  name: '${functionAppName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box Data Activator function app.'
  }
}

// ─── Outputs ────────────────────────────────────────────────────────────────

@description('Function App resource ID.')
output functionAppId string = functionApp.id

@description('Function App default hostname.')
output functionAppHostname string = functionApp.properties.defaultHostName

@description('Event Grid topic endpoint.')
output eventGridTopicEndpoint string = eventGridTopic.properties.endpoint

@description('Event Grid topic resource ID.')
output eventGridTopicId string = eventGridTopic.id

@description('Logic App trigger URL (retrieve via listCallbackUrl).')
output logicAppName string = logicApp.name

@description('Function App managed identity principal ID.')
output functionAppPrincipalId string = functionApp.identity.principalId
