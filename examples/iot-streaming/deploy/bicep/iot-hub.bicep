// ─────────────────────────────────────────────────────────────
// IoT Hub + Device Provisioning Service + Event Hub for Telemetry
// CSA-in-a-Box IoT Streaming Example
// ─────────────────────────────────────────────────────────────

@description('Base name for all resources (will be suffixed)')
param baseName string = 'csaiot'

@description('Azure region for deployment')
param location string = resourceGroup().location

@description('IoT Hub SKU')
@allowed(['F1', 'S1', 'S2', 'S3'])
param iotHubSku string = 'S1'

@description('IoT Hub SKU capacity (number of units)')
param iotHubCapacity int = 1

@description('Event Hub namespace SKU')
@allowed(['Basic', 'Standard', 'Premium'])
param eventHubSku string = 'Standard'

@description('Event Hub partition count')
param partitionCount int = 4

@description('Event Hub message retention in days')
param messageRetentionDays int = 7

@description('ADLS Gen2 storage account name for Event Hub Capture')
param captureStorageAccountName string

@description('ADLS Gen2 container name for capture output')
param captureContainerName string = 'bronze'

@description('Log Analytics workspace resource ID for diagnostics')
// NOTE: For production deployments, logAnalyticsWorkspaceId should be required
// (remove the default empty value) to ensure all resources emit diagnostics.
param logAnalyticsWorkspaceId string

@description('Enable public network access. Set to false for production deployments.')
param publicNetworkAccessEnabled bool = false

@description('Key Vault name for storing connection strings and secrets.')
param keyVaultName string = '${baseName}-kv'

@description('Tags to apply to all resources')
param tags object = {
  Project: 'CSA-in-a-Box'
  Component: 'IoT-Streaming'
  Environment: 'dev'
}

// ─── Variables ────────────────────────────────────────────────
var iotHubName = '${baseName}-iothub'
var dpsName = '${baseName}-dps'
var eventHubNamespaceName = '${baseName}-ehns'
var telemetryHubName = 'telemetry'
var alertsHubName = 'alerts'
var processedHubName = 'processed'

// Consumer groups
var adxConsumerGroup = 'adx-consumer'
var asaConsumerGroup = 'asa-consumer'
var captureConsumerGroup = 'capture-consumer'

// Authorization rules
var sendRuleName = 'SendRule'
var listenRuleName = 'ListenRule'
var manageRuleName = 'ManageRule'

// ─── Event Hub Namespace ─────────────────────────────────────
resource eventHubNamespace 'Microsoft.EventHub/namespaces@2024-01-01' = {
  name: eventHubNamespaceName
  location: location
  tags: tags
  sku: {
    name: eventHubSku
    tier: eventHubSku
    capacity: 1
  }
  properties: {
    isAutoInflateEnabled: eventHubSku == 'Standard'
    maximumThroughputUnits: eventHubSku == 'Standard' ? 10 : 0
    kafkaEnabled: eventHubSku != 'Basic'
    minimumTlsVersion: '1.2'
    publicNetworkAccess: publicNetworkAccessEnabled ? 'Enabled' : 'Disabled'
    disableLocalAuth: false
    zoneRedundant: true
  }
}

// ─── Telemetry Event Hub ─────────────────────────────────────
resource telemetryHub 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  parent: eventHubNamespace
  name: telemetryHubName
  properties: {
    partitionCount: partitionCount
    messageRetentionInDays: messageRetentionDays
    captureDescription: {
      enabled: true
      encoding: 'Avro'
      intervalInSeconds: 300
      sizeLimitInBytes: 314572800
      destination: {
        name: 'EventHubArchive.AzureBlockBlob'
        properties: {
          storageAccountResourceId: resourceId('Microsoft.Storage/storageAccounts', captureStorageAccountName)
          blobContainer: captureContainerName
          archiveNameFormat: '{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}'
        }
      }
      skipEmptyArchives: true
    }
  }
}

// ─── Alerts Event Hub ────────────────────────────────────────
resource alertsHub 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  parent: eventHubNamespace
  name: alertsHubName
  properties: {
    partitionCount: 2
    messageRetentionInDays: 3
  }
}

// ─── Processed Event Hub ─────────────────────────────────────
resource processedHub 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  parent: eventHubNamespace
  name: processedHubName
  properties: {
    partitionCount: partitionCount
    messageRetentionInDays: messageRetentionDays
  }
}

// ─── Consumer Groups ─────────────────────────────────────────
resource adxConsumer 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-01-01' = {
  parent: telemetryHub
  name: adxConsumerGroup
  properties: {
    userMetadata: 'Consumer group for Azure Data Explorer real-time ingestion'
  }
}

resource asaConsumer 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-01-01' = {
  parent: telemetryHub
  name: asaConsumerGroup
  properties: {
    userMetadata: 'Consumer group for Stream Analytics windowed aggregation'
  }
}

resource captureConsumer 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-01-01' = {
  parent: telemetryHub
  name: captureConsumerGroup
  properties: {
    userMetadata: 'Consumer group for ADLS Gen2 Capture cold path'
  }
}

// ─── Event Hub Authorization Rules ───────────────────────────
resource sendRule 'Microsoft.EventHub/namespaces/eventhubs/authorizationRules@2024-01-01' = {
  parent: telemetryHub
  name: sendRuleName
  properties: {
    rights: ['Send']
  }
}

resource listenRule 'Microsoft.EventHub/namespaces/eventhubs/authorizationRules@2024-01-01' = {
  parent: telemetryHub
  name: listenRuleName
  properties: {
    rights: ['Listen']
  }
}

resource manageRule 'Microsoft.EventHub/namespaces/authorizationRules@2024-01-01' = {
  parent: eventHubNamespace
  name: manageRuleName
  properties: {
    rights: ['Manage', 'Send', 'Listen']
  }
}

// ─── Key Vault (for storing connection strings securely) ─────
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
  }
}

resource ehSendConnectionStringSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'eh-telemetry-send-connection-string'
  properties: {
    value: sendRule.listKeys().primaryConnectionString
  }
}

resource ehListenConnectionStringSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'eh-telemetry-listen-connection-string'
  properties: {
    value: listenRule.listKeys().primaryConnectionString
  }
}

resource iotHubOwnerKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'iothub-owner-primary-key'
  properties: {
    value: iotHub.listKeys().value[0].primaryKey
  }
}

// ─── IoT Hub ─────────────────────────────────────────────────
resource iotHub 'Microsoft.Devices/IotHubs@2023-06-30' = {
  name: iotHubName
  location: location
  tags: tags
  sku: {
    name: iotHubSku
    capacity: iotHubCapacity
  }
  properties: {
    eventHubEndpoints: {
      events: {
        retentionTimeInDays: 1
        partitionCount: partitionCount
      }
    }
    routing: {
      endpoints: {
        eventHubs: [
          {
            name: 'telemetry-route'
            connectionString: sendRule.listKeys().primaryConnectionString
            resourceGroup: resourceGroup().name
            subscriptionId: subscription().subscriptionId
          }
        ]
      }
      routes: [
        {
          name: 'telemetry-to-eventhub'
          source: 'DeviceMessages'
          condition: 'true'
          endpointNames: ['telemetry-route']
          isEnabled: true
        }
        {
          name: 'twin-changes-to-builtin'
          source: 'TwinChangeEvents'
          condition: 'true'
          endpointNames: ['events']
          isEnabled: true
        }
      ]
      fallbackRoute: {
        name: '$fallback'
        source: 'DeviceMessages'
        condition: 'true'
        endpointNames: ['events']
        isEnabled: true
      }
    }
    cloudToDevice: {
      maxDeliveryCount: 10
      defaultTtlAsIso8601: 'PT1H'
      feedback: {
        lockDurationAsIso8601: 'PT60S'
        ttlAsIso8601: 'PT1H'
        maxDeliveryCount: 10
      }
    }
    features: 'None'
    minTlsVersion: '1.2'
    disableLocalAuth: false
  }
}

// ─── Device Provisioning Service ─────────────────────────────
resource dps 'Microsoft.Devices/provisioningServices@2022-12-12' = {
  name: dpsName
  location: location
  tags: tags
  sku: {
    name: 'S1'
    capacity: 1
  }
  properties: {
    iotHubs: [
      {
        connectionString: 'HostName=${iotHub.properties.hostName};SharedAccessKeyName=iothubowner;SharedAccessKey=${iotHub.listKeys().value[0].primaryKey}'
        location: location
        // NOTE: DPS requires inline connection string at deploy time.
        // The key is also stored in Key Vault (secret: iothub-owner-primary-key)
        // for runtime access by applications.
      }
    ]
    allocationPolicy: 'Hashed'
  }
}

// ─── Diagnostic Settings ─────────────────────────────────────
resource iotHubDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: '${iotHubName}-diag'
  scope: iotHub
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

resource ehDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: '${eventHubNamespaceName}-diag'
  scope: eventHubNamespace
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

// ─── Outputs ─────────────────────────────────────────────────
output iotHubName string = iotHub.name
output iotHubHostName string = iotHub.properties.hostName
output dpsName string = dps.name
output dpsIdScope string = dps.properties.idScope
output eventHubNamespaceName string = eventHubNamespace.name
output telemetryHubName string = telemetryHub.name
output alertsHubName string = alertsHub.name
output processedHubName string = processedHub.name
output eventHubNamespaceId string = eventHubNamespace.id
// Connection strings are stored in Key Vault — never expose as Bicep outputs.
// Use Key Vault secret references: 'eh-telemetry-send-connection-string'
// and 'eh-telemetry-listen-connection-string' at runtime.
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
