// ─────────────────────────────────────────────────────────────
// IoT Hub + Device Provisioning Service + Event Hub for Telemetry
// CSA-in-a-Box IoT Streaming Example
//
// BREAKING CHANGE — CSA-0025 / AQ-0014 (FedRAMP High / IL5 posture)
// ─────────────────────────────────────────────────────────────
// IoT Hub and DPS are Entra-only. Shared Access Signature (SAS) key
// authentication is DISABLED (`disableLocalAuth: true`) on both
// resources per CSA-0025 (approved via ballot AQ-0014).
//
// • No `listKeys()` on IoT Hub — the `iotHubOwnerKeySecret` that
//   previously materialized the primary key into Key Vault has
//   been removed. Device clients authenticate via workload
//   identity (managed identity + OAuth token) or X.509 +
//   DPS Entra enrollment.
// • DPS no longer accepts a SAS connection string for linking to
//   IoT Hub. DPS uses its system-assigned managed identity to
//   enroll devices (`authenticationType: 'identityBased'`).
// • Legacy SAS device clients MUST migrate before deploying this
//   template. See docs/migrations/iot-hub-entra.md.
// • Rollback: flipping `disableLocalAuth` back to `false` takes
//   the deployment off the FedRAMP High / IL5 path. Do not do
//   this in gov or regulated environments.
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

// REMOVED per CSA-0025 — IoT Hub SAS key is no longer materialized
// into Key Vault. With `disableLocalAuth: true` there is no SAS
// connection string to store. Consumers use Entra workload identity
// and the `Azure IoT Hub Data Contributor` / `Azure IoT Hub Data
// Reader` RBAC roles on the hub resource ID below.
//   output iotHubResourceId string = iotHub.id
// resource iotHubOwnerKeySecret ... REMOVED (CSA-0025)

// ─── IoT Hub (Entra-only per CSA-0025 / AQ-0014) ─────────────
// SAS authentication is disabled. Device clients authenticate via
// workload identity (MSI + OAuth) or X.509 + DPS Entra enrollment.
// Legacy SAS clients must migrate — see docs/migrations/iot-hub-entra.md.
resource iotHub 'Microsoft.Devices/IotHubs@2023-06-30' = {
  name: iotHubName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
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
            // Identity-based routing (CSA-0025) — IoT Hub uses its
            // system-assigned managed identity to authenticate to
            // Event Hubs. The hub's MI must be granted
            // "Azure Event Hubs Data Sender" on the namespace.
            authenticationType: 'identityBased'
            endpointUri: 'sb://${eventHubNamespace.name}.servicebus.windows.net'
            entityPath: telemetryHubName
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
    // CSA-0025: SAS auth disabled. Use Entra workload identity.
    disableLocalAuth: true
    // No SAS authorization policies — Entra only.
    authorizationPolicies: []
  }
}

// ─── Device Provisioning Service (Entra-only per CSA-0025) ──
// DPS is deployed UNLINKED from IoT Hub. The Bicep/ARM DPS schema
// currently requires a SAS connection string for inline IoT-Hub
// linking (`IotHubDefinitionDescription.connectionString` is
// marked required through API 2025-02-01-preview). Since IoT Hub
// has `disableLocalAuth: true`, no valid SAS string exists — so
// we leave `iotHubs: []` and establish the identity-based link
// post-deploy. The DPS system-assigned identity below is granted
// "IoT Hub Data Contributor" so that the post-deploy link can be
// configured with `authenticationType: identityBased` via:
//
//   az iot dps linked-hub create \
//     --dps-name <dps>  --resource-group <rg> \
//     --hub-resource-id <iotHub.id> \
//     --allocation-weight 1 \
//     --authentication-type identityBased
//
// See docs/migrations/iot-hub-entra.md for the full playbook.
resource dps 'Microsoft.Devices/provisioningServices@2023-03-01-preview' = {
  name: dpsName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'S1'
    capacity: 1
  }
  properties: {
    // CSA-0025: no SAS link. Link established post-deploy via CLI
    // using the DPS system-assigned identity (see comment above).
    iotHubs: []
    allocationPolicy: 'Hashed'
  }
}

// ─── Role Assignment: DPS MI → IoT Hub Data Contributor ─────
// Required for identity-based DPS→IoT Hub linking (CSA-0025).
// Role GUID: 4fc6c259-987e-4a07-842e-c321cc9d413f (IoT Hub Data Contributor)
resource dpsIotHubContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: iotHub
  name: guid(iotHub.id, dps.id, 'IoTHubDataContributor')
  properties: {
    principalId: dps.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4fc6c259-987e-4a07-842e-c321cc9d413f'
    )
  }
}

// ─── Role Assignment: IoT Hub MI → Event Hubs Data Sender ───
// Required for identity-based IoT Hub routing to Event Hubs (CSA-0025).
// Role GUID: 2b629674-e913-4c01-ae53-ef4638d8f975 (Azure Event Hubs Data Sender)
resource iotHubEhSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: eventHubNamespace
  name: guid(eventHubNamespace.id, iotHub.id, 'EventHubsDataSender')
  properties: {
    principalId: iotHub.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '2b629674-e913-4c01-ae53-ef4638d8f975'
    )
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
output iotHubResourceId string = iotHub.id
output iotHubHostName string = iotHub.properties.hostName
output iotHubPrincipalId string = iotHub.identity.principalId
output dpsName string = dps.name
output dpsResourceId string = dps.id
output dpsIdScope string = dps.properties.idScope
output dpsEndpoint string = dps.properties.deviceProvisioningHostName
output dpsPrincipalId string = dps.identity.principalId
output eventHubNamespaceName string = eventHubNamespace.name
output telemetryHubName string = telemetryHub.name
output alertsHubName string = alertsHub.name
output processedHubName string = processedHub.name
output eventHubNamespaceId string = eventHubNamespace.id
// CSA-0025: IoT Hub SAS output REMOVED. No `iothub-owner-primary-key`
// Key Vault secret and no `iotHubConnectionString` output. Consumers
// authenticate to IoT Hub via Entra (workload identity + OAuth token).
// See docs/migrations/iot-hub-entra.md for the migration playbook.
// Event Hub SAS connection strings are still available in Key Vault
// ('eh-telemetry-send-connection-string' / 'eh-telemetry-listen-connection-string')
// for Stream Analytics compatibility — see CSA-0026 for the Event Hub
// identity migration (tracked separately).
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
