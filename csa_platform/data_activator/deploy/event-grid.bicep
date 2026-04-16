// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Data Activator — Event Grid infrastructure for event-driven alerting.
// Deploys an Event Grid system topic, event subscriptions, and the
// Function App that hosts the rule evaluation engine.

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

@description('Teams webhook URL for alert notifications.')
@secure()
param teamsWebhookUrl string = ''

@description('PagerDuty integration key for critical alerts.')
@secure()
param pagerDutyIntegrationKey string = ''

@description('Storage account resource ID for the Event Grid system topic source.')
param sourceStorageAccountId string = ''

@description('Log Analytics workspace resource ID for diagnostics.')
// NOTE: For production deployments, logAnalyticsWorkspaceId should be required
// (remove the default empty value) to ensure all resources emit diagnostics.
param logAnalyticsWorkspaceId string = ''

@description('Application Insights connection string.')
param appInsightsConnectionString string = ''

@description('Enable public network access. Set to false for production deployments.')
param publicNetworkAccessEnabled bool = false

// ─── Variables ──────────────────────────────────────────────────────────────

var uniqueSuffix = take(uniqueString(resourceGroup().id), 6)
var functionAppName = '${baseName}-rules-${environment}-${uniqueSuffix}'
var appServicePlanName = '${baseName}-rules-plan-${environment}'
var eventGridTopicName = '${baseName}-events-${environment}'
var funcStorageName = take(toLower(replace('strulesng${environment}${uniqueSuffix}', '-', '')), 24)

// ─── Storage Account (Function App) ─────────────────────────────────────────

resource funcStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: funcStorageName
  location: location
  tags: union(tags, { Purpose: 'Rule Engine Function App storage' })
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

// ─── App Service Plan (Consumption) ─────────────────────────────────────────

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
    reserved: true
  }
}

// ─── Function App (Rule Engine) ─────────────────────────────────────────────

@description('Azure Function App hosting the Data Activator rule evaluation engine.')
resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: union(tags, { Pattern: 'DataActivator', Component: 'RuleEngine' })
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
        { name: 'AzureWebJobsStorage__accountName', value: funcStorage.name }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'python' }
        { name: 'TEAMS_WEBHOOK_URL', value: teamsWebhookUrl }
        { name: 'PAGERDUTY_INTEGRATION_KEY', value: pagerDutyIntegrationKey }
        { name: 'ENVIRONMENT', value: environment }
      ]
    }
  }
}

// ─── RBAC: Function App → Storage (identity-based connection) ──────────────

@description('Grant the Function App managed identity Storage Blob Data Owner on its storage account.')
resource storageBlobDataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(funcStorage.id, functionApp.id, 'StorageBlobDataOwner')
  scope: funcStorage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ─── Event Grid Custom Topic ────────────────────────────────────────────────

@description('Custom Event Grid topic for data platform events.')
resource eventGridTopic 'Microsoft.EventGrid/topics@2024-06-01-preview' = {
  name: eventGridTopicName
  location: location
  tags: union(tags, { Pattern: 'DataActivator', Component: 'EventIngestion' })
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    inputSchema: 'CloudEventSchemaV1_0'
    publicNetworkAccess: publicNetworkAccessEnabled ? 'Enabled' : 'Disabled'
  }
}

// ─── Event Grid Subscriptions ───────────────────────────────────────────────

@description('Subscription for data quality events routed to the rule engine.')
resource qualitySubscription 'Microsoft.EventGrid/topics/eventSubscriptions@2024-06-01-preview' = {
  parent: eventGridTopic
  name: 'quality-events'
  properties: {
    destination: {
      endpointType: 'AzureFunction'
      properties: {
        resourceId: '${functionApp.id}/functions/evaluate_rules'
        maxEventsPerBatch: 10
        preferredBatchSizeInKilobytes: 64
      }
    }
    filter: {
      includedEventTypes: [
        'csa.data.quality.check'
        'csa.data.anomaly.detected'
      ]
    }
    eventDeliverySchema: 'CloudEventSchemaV1_0'
    retryPolicy: {
      maxDeliveryAttempts: 5
      eventTimeToLiveInMinutes: 1440
    }
  }
}

@description('Subscription for freshness check events.')
resource freshnessSubscription 'Microsoft.EventGrid/topics/eventSubscriptions@2024-06-01-preview' = {
  parent: eventGridTopic
  name: 'freshness-events'
  properties: {
    destination: {
      endpointType: 'AzureFunction'
      properties: {
        resourceId: '${functionApp.id}/functions/evaluate_rules'
        maxEventsPerBatch: 1
        preferredBatchSizeInKilobytes: 64
      }
    }
    filter: {
      includedEventTypes: [
        'csa.data.freshness.check'
      ]
    }
    eventDeliverySchema: 'CloudEventSchemaV1_0'
    retryPolicy: {
      maxDeliveryAttempts: 10
      eventTimeToLiveInMinutes: 1440
    }
  }
}

@description('Subscription for pipeline lifecycle events.')
resource pipelineSubscription 'Microsoft.EventGrid/topics/eventSubscriptions@2024-06-01-preview' = {
  parent: eventGridTopic
  name: 'pipeline-events'
  properties: {
    destination: {
      endpointType: 'AzureFunction'
      properties: {
        resourceId: '${functionApp.id}/functions/evaluate_rules'
        maxEventsPerBatch: 1
        preferredBatchSizeInKilobytes: 64
      }
    }
    filter: {
      includedEventTypes: [
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

@description('Subscription for domain-specific telemetry events.')
resource telemetrySubscription 'Microsoft.EventGrid/topics/eventSubscriptions@2024-06-01-preview' = {
  parent: eventGridTopic
  name: 'telemetry-events'
  properties: {
    destination: {
      endpointType: 'AzureFunction'
      properties: {
        resourceId: '${functionApp.id}/functions/evaluate_rules'
        maxEventsPerBatch: 10
        preferredBatchSizeInKilobytes: 128
      }
    }
    filter: {
      includedEventTypes: [
        'csa.domain.seismic.event'
        'csa.domain.aqi.reading'
        'csa.domain.park.telemetry'
        'csa.domain.gaming.telemetry'
      ]
    }
    eventDeliverySchema: 'CloudEventSchemaV1_0'
    retryPolicy: {
      maxDeliveryAttempts: 3
      eventTimeToLiveInMinutes: 720
    }
  }
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

resource topicDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${eventGridTopicName}-diagnostics'
  scope: eventGridTopic
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

// ─── Outputs ────────────────────────────────────────────────────────────────

@description('Event Grid topic endpoint for publishing events.')
output eventGridTopicEndpoint string = eventGridTopic.properties.endpoint

@description('Event Grid topic resource ID.')
output eventGridTopicId string = eventGridTopic.id

@description('Function App resource ID.')
output functionAppId string = functionApp.id

@description('Function App default hostname.')
output functionAppHostname string = functionApp.properties.defaultHostName

@description('Function App managed identity principal ID.')
output functionAppPrincipalId string = functionApp.identity.principalId
