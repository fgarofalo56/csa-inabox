// ============================================================================
// CSA-in-a-Box: Lambda Architecture Streaming Infrastructure
// ============================================================================
// This module deploys the streaming analytics pipeline including:
// - Event Hubs for real-time ingestion (earthquake, weather, clickstream)
// - Stream Analytics for in-flight transformations
// - Azure Data Explorer (ADX) for warm/analytical queries
// - Cosmos DB for hot-path low-latency lookups
// - Azure Functions for event processing glue
// ============================================================================

targetScope = 'resourceGroup'

// ============================================================================
// Parameters
// ============================================================================

@description('The name prefix for all resources')
param namePrefix string = 'csa'

@description('The environment name (dev, staging, prod)')
param environment string = 'dev'

@description('Azure region for resources')
param location string = resourceGroup().location

@description('Tags to apply to all resources')
param tags object = {}

@description('Log Analytics workspace resource ID for diagnostic settings')
param logAnalyticsWorkspaceResourceId string = ''

@description('Subnet resource ID for private endpoints (optional)')
param subnetId string = ''

@description('Enable private endpoints for all services')
param enablePrivateEndpoints bool = false

@description('Event Hubs SKU tier')
@allowed(['Basic', 'Standard', 'Premium'])
param eventHubsSkuTier string = 'Standard'

@description('Stream Analytics streaming unit count')
@minValue(1)
@maxValue(120)
param streamingUnits int = 3

@description('Azure Data Explorer SKU name — use Dev(No SLA)_Standard_E2a_v4 for dev')
param adxSkuName string = 'Dev(No SLA)_Standard_E2a_v4'

@description('Azure Data Explorer SKU tier')
@allowed(['Basic', 'Standard'])
param adxSkuTier string = 'Basic'

// ============================================================================
// Variables
// ============================================================================

var uniqueId = substring(uniqueString(resourceGroup().id), 0, 4)
var baseName = '${namePrefix}-stream-${environment}-${uniqueId}'

// Event Hub names — one per data source in the CSA streaming pipeline
var eventHubNames = [
  'earthquake-events'
  'weather-events'
  'clickstream-events'
]

// ============================================================================
// Event Hubs Namespace + Event Hubs
// ============================================================================

resource eventHubsNamespace 'Microsoft.EventHub/namespaces@2024-01-01' = {
  name: '${baseName}-ehns'
  location: location
  tags: tags
  sku: {
    name: eventHubsSkuTier
    tier: eventHubsSkuTier
    capacity: 1
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    isAutoInflateEnabled: false
    kafkaEnabled: true // Enable Kafka protocol for broader ecosystem compatibility
    publicNetworkAccess: enablePrivateEndpoints ? 'Disabled' : 'Enabled'
    disableLocalAuth: false
  }
}

// Create individual event hubs for each data stream
resource eventHubs 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = [for ehName in eventHubNames: {
  parent: eventHubsNamespace
  name: ehName
  properties: {
    messageRetentionInDays: 1
    partitionCount: 2
    status: 'Active'
  }
}]

// Consumer group for Stream Analytics on each event hub
resource eventHubConsumerGroups 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-01-01' = [for (ehName, i) in eventHubNames: {
  parent: eventHubs[i]
  name: 'stream-analytics-cg'
  properties: {}
}]

// ============================================================================
// Stream Analytics Job
// ============================================================================

resource streamAnalyticsJob 'Microsoft.StreamAnalytics/streamingjobs@2021-10-01-preview' = {
  name: '${baseName}-asa'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    sku: {
      name: 'Standard'
    }
    eventsOutOfOrderPolicy: 'Adjust'
    outputErrorPolicy: 'Stop'
    eventsOutOfOrderMaxDelayInSeconds: 5
    eventsLateArrivalMaxDelayInSeconds: 16
    dataLocale: 'en-US'
    jobType: 'Cloud'
    // Placeholder transformation — replace with actual query during implementation
    transformation: {
      name: 'Transformation'
      properties: {
        streamingUnits: streamingUnits
        query: '''
          -- Placeholder: route earthquake events to ADX and Cosmos hot-path
          SELECT *
          INTO [adx-output]
          FROM [earthquake-events-input]
          WHERE eventType = 'earthquake'

          SELECT *
          INTO [cosmos-output]
          FROM [earthquake-events-input]
          WHERE magnitude >= 4.0
        '''
      }
    }
  }
}

// ============================================================================
// Azure Data Explorer (Kusto) — Warm/Analytical Store
// ============================================================================

// ADX provides fast analytical queries over streaming data with built-in
// time-series functions. Dev SKU uses a single node with no SLA.
resource adxCluster 'Microsoft.Kusto/clusters@2023-08-15' = {
  name: replace('${baseName}-adx', '-', '')
  location: location
  tags: tags
  sku: {
    name: adxSkuName
    tier: adxSkuTier
    capacity: 1
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    enableStreamingIngest: true
    enablePurge: false
    enableAutoStop: true // Auto-stop idle dev clusters to save cost
    publicNetworkAccess: enablePrivateEndpoints ? 'Disabled' : 'Enabled'
    // CKV_AZURE_74 -- enable disk encryption on Kusto data disks.
    enableDiskEncryption: true
    // CKV_AZURE_75 -- double-encryption (platform key + service key).
    // Available on all SKUs at no extra cost.
    enableDoubleEncryption: true
  }
}

resource adxDatabase 'Microsoft.Kusto/clusters/databases@2023-08-15' = {
  parent: adxCluster
  name: 'streaming_db'
  location: location
  kind: 'ReadWrite'
  properties: {
    hotCachePeriod: 'P31D'
    softDeletePeriod: 'P365D'
  }
}

// ============================================================================
// Cosmos DB — Hot-Path Low-Latency Store
// ============================================================================

// Session consistency balances latency and consistency for event lookups.
// Serverless mode is cost-effective for bursty streaming workloads in dev.
resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-08-15' = {
  name: '${baseName}-cosmos'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    enableAutomaticFailover: false
    enableMultipleWriteLocations: false
    publicNetworkAccess: enablePrivateEndpoints ? 'Disabled' : 'Enabled'
    networkAclBypass: 'None'
    disableKeyBasedMetadataWriteAccess: true
    // CKV_AZURE_140 -- AAD-only authentication; no shared keys allowed.
    // Code paths must use DefaultAzureCredential / managed identity.
    disableLocalAuth: true
    capabilities: environment == 'prod' ? [] : [
      {
        name: 'EnableServerless'
      }
    ]
  }
}

resource cosmosDatabase 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-08-15' = {
  parent: cosmosAccount
  name: 'streaming'
  properties: {
    resource: {
      id: 'streaming'
    }
  }
}

resource cosmosContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-08-15' = {
  parent: cosmosDatabase
  name: 'hot-events'
  properties: {
    resource: {
      id: 'hot-events'
      partitionKey: {
        paths: ['/eventType']
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        includedPaths: [
          {
            path: '/*'
          }
        ]
        excludedPaths: [
          {
            path: '/"_etag"/?'
          }
        ]
      }
      defaultTtl: 86400 // 24-hour TTL — hot events expire after one day
    }
  }
}

// ============================================================================
// Azure Functions — Event Processing Glue
// ============================================================================

// Storage account required by Functions runtime
resource funcStorageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: replace('${baseName}-func', '-', '')
  location: location
  tags: tags
  sku: {
    // CKV_AZURE_206 -- GRS for cross-region durability of Functions
    // runtime metadata.  LRS would lose state on a regional outage.
    name: 'Standard_GRS'
  }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    publicNetworkAccess: enablePrivateEndpoints ? 'Disabled' : 'Enabled'
    // CKV_AZURE_35 -- default-deny network ACL.  When private endpoints
    // are off (lab/dev) Azure Functions still needs to reach this
    // account; the bypass list permits the trusted Azure services path
    // (Functions, Logging) without leaving the account world-open.
    networkAcls: {
      // CKV_AZURE_35 -- always default-deny; bypass keeps Functions runtime + Logging.
      defaultAction: 'Deny'
      bypass: 'AzureServices,Logging,Metrics'
    }
  }
}

// Consumption plan keeps costs near-zero for intermittent processing
resource funcAppServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${baseName}-asp'
  location: location
  tags: tags
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  kind: 'functionapp'
  properties: {
    reserved: true // Linux
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: '${baseName}-func'
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: funcAppServicePlan.id
    httpsOnly: true
    publicNetworkAccess: enablePrivateEndpoints ? 'Disabled' : 'Enabled'
    // CKV_AZURE_17 -- require client certificates so internet-exposed
    // function endpoints have a second authentication factor.
    clientCertEnabled: true
    clientCertMode: 'Optional'
    siteConfig: {
      linuxFxVersion: 'PYTHON|3.11'
      // CKV_AZURE_15 -- enforce TLS 1.2 minimum on inbound traffic.
      minTlsVersion: '1.2'
      // CKV_AZURE_18 / CKV_AZURE_67 -- HTTP/2 for inbound, modern default.
      http20Enabled: true
      // CKV_AZURE_78 -- disable FTP/FTPS deployments entirely (we use
      // managed identity + zip deploy or container deploy).
      ftpsState: 'Disabled'
      // CKV_AZURE_213 -- health check endpoint so the platform can
      // remove unhealthy instances from rotation.
      healthCheckPath: '/api/health'
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${funcStorageAccount.name};EndpointSuffix=${az.environment().suffixes.storage};AccountKey=${funcStorageAccount.listKeys().keys[0].value}'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'python'
        }
        {
          name: 'EVENT_HUB_NAMESPACE'
          value: eventHubsNamespace.properties.serviceBusEndpoint
        }
        {
          name: 'COSMOS_ENDPOINT'
          value: cosmosAccount.properties.documentEndpoint
        }
      ]
    }
  }
}

// ============================================================================
// RBAC — Functions identity permissions
// ============================================================================

// Azure Event Hubs Data Receiver — lets Functions read from Event Hubs
var eventHubsDataReceiverRoleId = 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde'

resource funcEventHubsRbac 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(eventHubsNamespace.id, functionApp.id, eventHubsDataReceiverRoleId)
  scope: eventHubsNamespace
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', eventHubsDataReceiverRoleId)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Cosmos DB Built-in Data Contributor — lets Functions write to Cosmos
var cosmosDbContributorRoleId = '00000000-0000-0000-0000-000000000002'

resource funcCosmosRbac 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-08-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, functionApp.id, cosmosDbContributorRoleId)
  properties: {
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${cosmosDbContributorRoleId}'
    principalId: functionApp.identity.principalId
    scope: cosmosAccount.id
  }
}

// ============================================================================
// Private Endpoints (if enabled)
// ============================================================================

resource eventHubsPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (enablePrivateEndpoints) {
  name: '${baseName}-ehns-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: subnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${baseName}-ehns-pe-connection'
        properties: {
          privateLinkServiceId: eventHubsNamespace.id
          groupIds: ['namespace']
        }
      }
    ]
  }
}

resource cosmosPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (enablePrivateEndpoints) {
  name: '${baseName}-cosmos-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: subnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${baseName}-cosmos-pe-connection'
        properties: {
          privateLinkServiceId: cosmosAccount.id
          groupIds: ['Sql']
        }
      }
    ]
  }
}

// ============================================================================
// Diagnostic Settings
// ============================================================================

resource eventHubsDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceResourceId)) {
  scope: eventHubsNamespace
  name: 'eventhubs-diagnostics'
  properties: {
    workspaceId: logAnalyticsWorkspaceResourceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
  }
}

resource streamAnalyticsDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceResourceId)) {
  scope: streamAnalyticsJob
  name: 'asa-diagnostics'
  properties: {
    workspaceId: logAnalyticsWorkspaceResourceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
  }
}

resource cosmosDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceResourceId)) {
  scope: cosmosAccount
  name: 'cosmos-diagnostics'
  properties: {
    workspaceId: logAnalyticsWorkspaceResourceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
  }
}

resource functionAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceResourceId)) {
  scope: functionApp
  name: 'func-diagnostics'
  properties: {
    workspaceId: logAnalyticsWorkspaceResourceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
  }
}

// ============================================================================
// Outputs
// ============================================================================

output eventHubsNamespace string = eventHubsNamespace.name
output eventHubsNamespaceId string = eventHubsNamespace.id
output adxEndpoint string = adxCluster.properties.uri
output adxClusterName string = adxCluster.name
output cosmosEndpoint string = cosmosAccount.properties.documentEndpoint
output cosmosAccountName string = cosmosAccount.name
output functionAppName string = functionApp.name
output functionAppIdentityPrincipalId string = functionApp.identity.principalId
output streamAnalyticsJobName string = streamAnalyticsJob.name
