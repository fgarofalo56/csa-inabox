// CSA Loom — Direct-Lake-Shim infrastructure
//
// Wires the Azure-native parity for Fabric Direct Lake (which needs a Fabric
// F-SKU, unavailable in Gov). The shim keeps a warm AAS / Power BI Premium XMLA
// cache fresh from an ADLS Gen2 Delta source, driven by `_delta_log` change
// notifications:
//
//   1. Service Bus QUEUE — the shim's BackgroundService consumes BlobCreated
//      events from here (PeekLock + dead-letter for failed refreshes).
//   2. Event Grid SYSTEM TOPIC on the DLZ ADLS Gen2 account.
//   3. Event Grid SUBSCRIPTION → the Service Bus queue (delivers BlobCreated).
//   4. Storage Blob Data Reader grant for the shim UAMI (reads `_delta_log`
//      commits to derive the partition to refresh) and, optionally, for the
//      AAS / Power BI Premium service identity (reads Delta Parquet).
//
// Sovereign note (verified against Microsoft Learn):
//   - Event Grid system topics are GA in Commercial, GCC, GCC-High, IL5/DoD.
//   - Service Bus as an Event Grid destination is GA across all four boundaries.
//   - Storage Blob Data Reader guid is cloud-invariant (global built-in role).
//
// No Fabric dependency: the shim drives Power BI Premium *enhanced refresh*
// over XMLA on the sovereign Power BI host — never a Fabric F-SKU.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('ADLS Gen2 storage account name (DLZ lakehouse backing store) that holds the Delta source(s).')
param storageAccountName string

@description('Service Bus namespace name to host the shim queue. Created in this RG if it does not exist (referenced via existing when reused).')
param serviceBusNamespaceName string

@description('Service Bus queue name receiving Delta _delta_log BlobCreated events.')
param serviceBusQueueName string = 'loom-dl-shim-events'

@description('Direct-Lake Shim UAMI principal id — granted Storage Blob Data Reader on the Delta source account.')
param shimMiPrincipalId string

@description('AAS / Power BI Premium service-principal object id — granted Storage Blob Data Reader on the Delta source account. Empty skips that grant.')
param aasMiPrincipalId string = ''

@description('Skip role grants on re-deploy (RBAC writes need Owner/User Access Administrator).')
param skipRoleGrants bool = false

@description('Compliance tags')
param complianceTags object = {}

var blobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1' // Storage Blob Data Reader (global built-in)

resource sa 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

// Service Bus namespace + queue the shim consumes.
resource sbNamespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: serviceBusNamespaceName
  location: location
  sku: { name: 'Standard', tier: 'Standard' }
  tags: complianceTags
  properties: {
    minimumTlsVersion: '1.2'
    disableLocalAuth: true
  }
}

resource sbQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: sbNamespace
  name: serviceBusQueueName
  properties: {
    lockDuration: 'PT1M'
    maxDeliveryCount: 10
    deadLetteringOnMessageExpiration: true
    defaultMessageTimeToLive: 'PT1H'
  }
}

// Event Grid system topic for the ADLS Gen2 account.
resource egSystemTopic 'Microsoft.EventGrid/systemTopics@2023-12-15-preview' = {
  name: 'loom-dl-shim-${storageAccountName}'
  location: location
  tags: complianceTags
  properties: {
    source: sa.id
    topicType: 'Microsoft.Storage.StorageAccounts'
  }
}

// Event Grid subscription → Service Bus queue. The shim's regex
// (`_delta_log/<n>.json`) does the precise match; we pre-filter to
// BlobCreated + ".json" to cut noise.
resource egSubscription 'Microsoft.EventGrid/systemTopics/eventSubscriptions@2023-12-15-preview' = {
  parent: egSystemTopic
  name: 'loom-dl-shim-delta-log'
  properties: {
    eventDeliverySchema: 'EventGridSchema'
    destination: {
      endpointType: 'ServiceBusQueue'
      properties: {
        resourceId: sbQueue.id
      }
    }
    filter: {
      includedEventTypes: ['Microsoft.Storage.BlobCreated']
      subjectEndsWith: '.json'
      isSubjectCaseSensitive: false
    }
    retryPolicy: {
      maxDeliveryAttempts: 10
      eventTimeToLiveInMinutes: 60
    }
  }
}

// Storage Blob Data Reader for the Shim UAMI (reads Delta _delta_log commits).
resource shimReaderGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(shimMiPrincipalId) && !skipRoleGrants) {
  name: guid(sa.id, shimMiPrincipalId, blobDataReaderRoleId, 'shim-uami-reader-v1')
  scope: sa
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataReaderRoleId)
    principalId: shimMiPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Loom Direct-Lake-Shim UAMI: reads Delta _delta_log commits from ADLS for refresh dispatch.'
  }
}

// Storage Blob Data Reader for AAS/PBI Premium MI (reads Delta Parquet).
resource aasReaderGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(aasMiPrincipalId) && !skipRoleGrants) {
  name: guid(sa.id, aasMiPrincipalId, blobDataReaderRoleId, 'aas-dl-shim-reader-v1')
  scope: sa
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataReaderRoleId)
    principalId: aasMiPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Loom Direct-Lake-Shim: AAS/PBI Premium MI reads Delta Parquet from ADLS (Storage Blob Data Reader).'
  }
}

@description('Service Bus namespace FQDN — set as SERVICEBUS_NAMESPACE on the shim app.')
output serviceBusFqdn string = '${sbNamespace.name}.servicebus.${environment().suffixes.storage == 'core.usgovcloudapi.net' ? 'usgovcloudapi.net' : 'windows.net'}'

@description('Service Bus queue ARM resource id — set as LOOM_DIRECT_LAKE_SHIM_QUEUE_ID on the Console for runtime Event Grid wiring.')
output serviceBusQueueId string = sbQueue.id

@description('Event Grid system topic name.')
output systemTopicName string = egSystemTopic.name
