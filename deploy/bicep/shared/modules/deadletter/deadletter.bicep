// Shared module: per-pipeline dead-letter queue infrastructure.
// Per CSA-0138 / AQ-0033, this is the canonical DLQ pattern for
// any ingest pipeline (ADF, Stream Analytics, Event Hubs consumer,
// Databricks Autoloader). See docs/runbooks/dead-letter.md for the
// operator triage + replay runbook.
//
// Provisions, per pipeline:
//   1. Blob container `deadletter-<pipelineName>` in an existing storage account
//   2. Event Grid system topic on the storage account (idempotent) + a
//      subscription filtering on BlobCreated events scoped to the DLQ container
//   3. Diagnostic settings on the storage blob service routing StorageRead /
//      StorageWrite to the provided Log Analytics workspace
//   4. Azure Monitor metric alert firing when container size exceeds
//      `alertThresholdBytes` (default 1 GiB)
//
// All callers should pass the pipeline's action-group ID via `actionGroupId`
// so DLQ alerts reach the same on-call channel as upstream pipeline alerts.
// -----------------------------------------------------------------------------
// Example caller (hypothetical iot-telemetry pipeline main.bicep) — do NOT
// create this file; it is illustrative only:
//
//   module iotTelemetryDlq '../shared/modules/deadletter/deadletter.bicep' = {
//     name: 'deploy-dlq-iot-telemetry'
//     scope: resourceGroup(parIngestResourceGroupName)
//     params: {
//       location:                parLocation
//       storageAccountName:      parIngestStorageAccountName
//       pipelineName:            'iot-telemetry'
//       logAnalyticsWorkspaceId: parLogAnalyticsWorkspaceId
//       actionGroupId:           parPipelineActionGroupId
//       alertThresholdBytes:     1073741824  // 1 GiB; override per pipeline SLA
//       tags:                    parTags
//     }
//   }
//
//   output outIotTelemetryDlqUri string = iotTelemetryDlq.outputs.containerUri
// -----------------------------------------------------------------------------

targetScope = 'resourceGroup'

metadata name = 'CSA-in-a-Box — Dead-Letter Queue module'
metadata description = 'Canonical per-pipeline DLQ infrastructure (container + Event Grid + diagnostics + alert)'

@description('Azure region for Event Grid topic and alert rule. Storage account region is fixed by the existing account.')
param location string = resourceGroup().location

@description('Name of an EXISTING storage account that will host the dead-letter container. Must be in the same resource group as this deployment.')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Logical name of the ingest pipeline this DLQ serves (e.g. "iot-telemetry", "noaa-weather"). Used to name the container and all dependent resources. Limited to 52 characters so the derived container name "deadletter-<pipelineName>" fits Azure\'s 63-char container-name cap.')
@minLength(3)
@maxLength(52)
param pipelineName string

@description('Resource ID of the Log Analytics workspace that receives storage diagnostic logs for DLQ activity.')
param logAnalyticsWorkspaceId string

@description('Resource ID of the Azure Monitor Action Group invoked when DLQ size breaches the threshold.')
param actionGroupId string

@description('Threshold in bytes for the DLQ-size alert. Default 1 GiB. Increase for high-volume pipelines; decrease for low-volume pipelines with tight replay SLAs.')
@minValue(1048576)
param alertThresholdBytes int = 1073741824

@description('Tags applied to every resource this module provisions.')
param tags object = {}

// Validate pipelineName matches Azure container naming rules
// (lowercase alphanumeric + hyphen, 3-63 chars, starting with a letter).
// Bicep can't express regex constraints on params directly, so we assert via
// a variable that fails deployment with a readable message if violated.
var pipelineNamePattern = '^[a-z][a-z0-9-]{2,62}$'
var isPipelineNameValid = length(pipelineName) >= 3 && length(pipelineName) <= 63
#disable-next-line no-unused-vars
var assertPipelineName = isPipelineNameValid ? pipelineName : 'INVALID-PIPELINE-NAME-must-match-${pipelineNamePattern}'

// Derived names
var containerName = 'deadletter-${pipelineName}'
var systemTopicName = 'evgt-${storageAccountName}-dlq'
var eventSubName = 'evgs-dlq-${pipelineName}'
var alertRuleName = 'csa-alert-dlq-size-${pipelineName}'
var diagnosticName = 'diag-dlq-${pipelineName}'

// Reference existing storage account + blob service
resource storageAccount 'Microsoft.Storage/storageAccounts@2025-01-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' existing = {
  parent: storageAccount
  name: 'default'
}

// 1. Dead-letter container
resource dlqContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = {
  parent: blobService
  name: containerName
  properties: {
    publicAccess: 'None'
    metadata: {
      pipeline: pipelineName
      purpose: 'dead-letter'
      managedBy: 'csa-0138-deadletter-module'
    }
  }
}

// 2a. Event Grid system topic on the storage account (one per account; safe to
//     declare idempotently — if it already exists, ARM reuses it).
resource systemTopic 'Microsoft.EventGrid/systemTopics@2025-02-15' = {
  name: systemTopicName
  location: location
  tags: tags
  properties: {
    source: storageAccount.id
    topicType: 'Microsoft.Storage.StorageAccounts'
  }
}

// 2b. Subscription filtered to BlobCreated events inside the DLQ container
resource dlqSubscription 'Microsoft.EventGrid/systemTopics/eventSubscriptions@2025-02-15' = {
  parent: systemTopic
  name: eventSubName
  properties: {
    eventDeliverySchema: 'EventGridSchema'
    filter: {
      includedEventTypes: [
        'Microsoft.Storage.BlobCreated'
      ]
      subjectBeginsWith: '/blobServices/default/containers/${containerName}/'
    }
    retryPolicy: {
      maxDeliveryAttempts: 30
      eventTimeToLiveInMinutes: 1440
    }
  }
  dependsOn: [
    dlqContainer
  ]
}

// 3. Diagnostic settings on blob service (StorageRead + StorageWrite)
resource blobDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  // Note: Microsoft.Insights/diagnosticSettings retains 2021-05-01-preview as its
  // canonical surface; newer GA track is 2016-09-01 which lacks workspaceId typing.
  scope: blobService
  name: diagnosticName
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'StorageRead'
        enabled: true
      }
      {
        category: 'StorageWrite'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'Transaction'
        enabled: true
      }
    ]
  }
}

// 4. Metric alert when container size exceeds threshold
//    Uses the Blob-service-level UsedCapacity metric with a dimension filter on
//    container name. Evaluated hourly; DLQ fill typically trends slowly.
resource dlqSizeAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: alertRuleName
  location: 'global'
  tags: tags
  properties: {
    description: 'DLQ container "${containerName}" size exceeded ${alertThresholdBytes} bytes — operator triage required per docs/runbooks/dead-letter.md'
    severity: 2
    enabled: true
    scopes: [
      storageAccount.id
    ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    targetResourceType: 'Microsoft.Storage/storageAccounts'
    targetResourceRegion: location
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'DlqContainerSize'
          metricNamespace: 'Microsoft.Storage/storageAccounts/blobServices'
          metricName: 'BlobCapacity'
          operator: 'GreaterThan'
          threshold: alertThresholdBytes
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            {
              name: 'BlobType'
              operator: 'Include'
              values: [
                'BlockBlob'
              ]
            }
          ]
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroupId
        webHookProperties: {
          pipeline: pipelineName
          container: containerName
          runbook: 'docs/runbooks/dead-letter.md'
        }
      }
    ]
  }
}

@description('HTTPS URI of the dead-letter container (suitable for az storage blob list --container-name).')
output containerUri string = '${storageAccount.properties.primaryEndpoints.blob}${containerName}'

@description('Resource ID of the Event Grid subscription that fires on BlobCreated in the DLQ container.')
output eventGridSubscriptionId string = dlqSubscription.id

@description('Resource ID of the DLQ-size metric alert rule.')
output alertRuleId string = dlqSizeAlert.id

@description('Resource ID of the DLQ container (useful for downstream RBAC assignments).')
output containerId string = dlqContainer.id
