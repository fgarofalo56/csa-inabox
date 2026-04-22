targetScope = 'resourceGroup'

@description('The name prefix for all resources')
param namePrefix string = 'csa'

@description('The environment name (dev, staging, prod)')
param environment string = 'dev'

@description('Azure region for resources')
param location string = resourceGroup().location

@description('Tags to apply to all resources')
param tags object = {}

@description('Azure OpenAI deployments configuration')
param openAIDeployments array = [
  {
    name: 'gpt-5-4'
    model: {
      format: 'OpenAI'
      name: 'gpt-5.4'
      version: '2024-11-20'
    }
    sku: {
      name: 'Standard'
      capacity: 30
    }
  }
  {
    name: 'text-embedding-3-large'
    model: {
      format: 'OpenAI'
      name: 'text-embedding-3-large'
      version: '1'
    }
    sku: {
      name: 'Standard'
      capacity: 120
    }
  }
]

@description('Enable private endpoints for all services')
param enablePrivateEndpoints bool = true

@description('Virtual network resource ID for private endpoints')
param vnetResourceId string = ''

@description('Subnet resource ID for private endpoints')
param privateEndpointSubnetId string = ''

@description('Log Analytics workspace resource ID for diagnostic settings')
param logAnalyticsWorkspaceResourceId string = ''

// Variables
var uniqueId = substring(uniqueString(resourceGroup().id), 0, 4)
var baseName = '${namePrefix}-ai-${environment}-${uniqueId}'

// Azure Government variant: Phase 2 — Coming Soon
// This module will be extended to support Azure Government cloud requirements

// Azure OpenAI Service
resource openAI 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: '${baseName}-openai'
  location: location
  tags: tags
  kind: 'OpenAI'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: toLower('${baseName}-openai')
    networkAcls: enablePrivateEndpoints ? {
      defaultAction: 'Deny'
      virtualNetworkRules: []
      ipRules: []
    } : {
      defaultAction: 'Allow'
    }
    publicNetworkAccess: enablePrivateEndpoints ? 'Disabled' : 'Enabled'
  }
  sku: {
    name: 'S0'
  }
}

// Azure OpenAI Deployments
resource openAIDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = [for deployment in openAIDeployments: {
  parent: openAI
  name: deployment.name
  properties: {
    model: deployment.model
  }
  sku: deployment.sku
}]

// Azure AI Search
resource searchService 'Microsoft.Search/searchServices@2024-06-01-preview' = {
  name: '${baseName}-search'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'standard'
  }
  properties: {
    replicaCount: 1
    partitionCount: 1
    hostingMode: 'default'
    semanticSearch: 'standard'
    networkRuleSet: enablePrivateEndpoints ? {
      ipRules: []
      bypass: 'None'
    } : null
    publicNetworkAccess: enablePrivateEndpoints ? 'disabled' : 'enabled'
    disableLocalAuth: false
    authOptions: {
      aadOrApiKey: {
        aadAuthFailureMode: 'http401WithBearerChallenge'
      }
    }
    encryptionWithCmk: {
      enforcement: 'Unspecified'
    }
  }
}

// Azure AI Foundry Hub (ML Workspace)
resource aiHub 'Microsoft.MachineLearningServices/workspaces@2024-10-01' = {
  name: '${baseName}-aihub'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  kind: 'Hub'
  properties: {
    friendlyName: '${baseName} AI Hub'
    description: 'Azure AI Foundry Hub for CSA Analytics Platform'
    publicNetworkAccess: enablePrivateEndpoints ? 'Disabled' : 'Enabled'
    managedNetwork: enablePrivateEndpoints ? {
      isolationMode: 'AllowInternetOutbound'
      outboundRules: {
        'required-openai-outbound': {
          type: 'FQDN'
          destination: 'api.openai.com'
          category: 'UserDefined'
        }
      }
    } : null
  }
}

// Azure AI Foundry Project
resource aiProject 'Microsoft.MachineLearningServices/workspaces@2024-10-01' = {
  name: '${baseName}-aiproject'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  kind: 'Project'
  properties: {
    friendlyName: '${baseName} AI Project'
    description: 'Azure AI Foundry Project for CSA Analytics'
    hubResourceId: aiHub.id
  }
}

// Cosmos DB Account for Gremlin (Knowledge Graph)
resource cosmosGremlin 'Microsoft.DocumentDB/databaseAccounts@2024-08-15' = {
  name: '${baseName}-gremlin'
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
    capabilities: [
      {
        name: 'EnableGremlin'
      }
    ]
    enableAutomaticFailover: false
    enableMultipleWriteLocations: false
    publicNetworkAccess: enablePrivateEndpoints ? 'Disabled' : 'Enabled'
    networkAclBypass: 'None'
    disableKeyBasedMetadataWriteAccess: true
  }
}

// Cosmos DB Gremlin Database
resource gremlinDatabase 'Microsoft.DocumentDB/databaseAccounts/gremlinDatabases@2024-08-15' = {
  parent: cosmosGremlin
  name: 'knowledge'
  properties: {
    resource: {
      id: 'knowledge'
    }
    options: {
      throughput: 400
    }
  }
}

// Cosmos DB Gremlin Graph Container
resource gremlinGraph 'Microsoft.DocumentDB/databaseAccounts/gremlinDatabases/graphs@2024-08-15' = {
  parent: gremlinDatabase
  name: 'entities'
  properties: {
    resource: {
      id: 'entities'
      partitionKey: {
        paths: ['/partitionKey']
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
    }
    options: {}
  }
}

// Cosmos DB Account for SQL API (Agent Memory/Chat History)
resource cosmosSQL 'Microsoft.DocumentDB/databaseAccounts@2024-08-15' = {
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
    capabilities: [
      {
        name: 'EnableServerless'
      }
    ]
  }
}

// Cosmos DB SQL Database
resource sqlDatabase 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-08-15' = {
  parent: cosmosSQL
  name: 'agents'
  properties: {
    resource: {
      id: 'agents'
    }
  }
}

// Chat History Container
resource chatHistoryContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-08-15' = {
  parent: sqlDatabase
  name: 'chat_history'
  properties: {
    resource: {
      id: 'chat_history'
      partitionKey: {
        paths: ['/session_id']
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
      defaultTtl: 2592000 // 30 days
    }
  }
}

// Agent Memory Container
resource agentMemoryContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-08-15' = {
  parent: sqlDatabase
  name: 'agent_memory'
  properties: {
    resource: {
      id: 'agent_memory'
      partitionKey: {
        paths: ['/agent_id']
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
    }
  }
}

// PostgreSQL Flexible Server with pgvector
resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: '${baseName}-postgres'
  location: location
  tags: tags
  sku: {
    name: environment == 'prod' ? 'Standard_D2ads_v5' : 'Standard_B1ms'
    tier: environment == 'prod' ? 'GeneralPurpose' : 'Burstable'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    administratorLogin: 'csaadmin'
    administratorLoginPassword: 'P@ssw0rd123!' // In production, use Key Vault
    version: '15'
    storage: {
      storageSizeGB: environment == 'prod' ? 512 : 32
      tier: 'P4'
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: environment == 'prod' ? 35 : 7
      geoRedundantBackup: environment == 'prod' ? 'Enabled' : 'Disabled'
    }
    network: enablePrivateEndpoints ? {
      publicNetworkAccess: 'Disabled'
      delegatedSubnetResourceId: privateEndpointSubnetId
    } : {
      publicNetworkAccess: 'Enabled'
    }
    highAvailability: environment == 'prod' ? {
      mode: 'ZoneRedundant'
    } : {
      mode: 'Disabled'
    }
    maintenanceWindow: {
      customWindow: 'Enabled'
      dayOfWeek: 0
      startHour: 1
      startMinute: 0
    }
  }
}

// PostgreSQL Database
resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgresServer
  name: 'vectorstore'
  properties: {
    charset: 'utf8'
    collation: 'en_US.utf8'
  }
}

// PostgreSQL Configuration for pgvector extension
resource postgresConfig 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = {
  parent: postgresServer
  name: 'shared_preload_libraries'
  properties: {
    value: 'vector'
    source: 'user-override'
  }
}

// Container Apps Environment
resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${baseName}-env'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    workloadProfiles: [
      {
        name: 'consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    vnetConfiguration: enablePrivateEndpoints ? {
      infrastructureSubnetId: privateEndpointSubnetId
      internal: true
    } : null
  }
}

// Container Registry
resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: replace('${baseName}-acr', '-', '')
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'Standard'
  }
  properties: {
    adminUserEnabled: false
    networkRuleSet: enablePrivateEndpoints ? {
      defaultAction: 'Deny'
      virtualNetworkRules: []
      ipRules: []
    } : {
      defaultAction: 'Allow'
    }
    publicNetworkAccess: enablePrivateEndpoints ? 'Disabled' : 'Enabled'
    dataEndpointEnabled: false
  }
}

// Key Vault
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${baseName}-kv'
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: tenant().tenantId
    accessPolicies: []
    enabledForDeployment: false
    enabledForDiskEncryption: false
    enabledForTemplateDeployment: false
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    enableRbacAuthorization: true
    networkAcls: enablePrivateEndpoints ? {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
      virtualNetworkRules: []
      ipRules: []
    } : {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
    publicNetworkAccess: enablePrivateEndpoints ? 'Disabled' : 'Enabled'
  }
}

// Private Endpoints (if enabled)
resource openAIPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (enablePrivateEndpoints) {
  name: '${baseName}-openai-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${baseName}-openai-pe-connection'
        properties: {
          privateLinkServiceId: openAI.id
          groupIds: ['account']
        }
      }
    ]
  }
}

resource searchPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (enablePrivateEndpoints) {
  name: '${baseName}-search-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${baseName}-search-pe-connection'
        properties: {
          privateLinkServiceId: searchService.id
          groupIds: ['searchService']
        }
      }
    ]
  }
}

resource cosmosGremlinPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (enablePrivateEndpoints) {
  name: '${baseName}-gremlin-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${baseName}-gremlin-pe-connection'
        properties: {
          privateLinkServiceId: cosmosGremlin.id
          groupIds: ['Gremlin']
        }
      }
    ]
  }
}

resource cosmosSQLPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (enablePrivateEndpoints) {
  name: '${baseName}-cosmos-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${baseName}-cosmos-pe-connection'
        properties: {
          privateLinkServiceId: cosmosSQL.id
          groupIds: ['Sql']
        }
      }
    ]
  }
}

resource keyVaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (enablePrivateEndpoints) {
  name: '${baseName}-kv-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${baseName}-kv-pe-connection'
        properties: {
          privateLinkServiceId: keyVault.id
          groupIds: ['vault']
        }
      }
    ]
  }
}

resource containerRegistryPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (enablePrivateEndpoints) {
  name: '${baseName}-acr-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${baseName}-acr-pe-connection'
        properties: {
          privateLinkServiceId: containerRegistry.id
          groupIds: ['registry']
        }
      }
    ]
  }
}

// Diagnostic Settings (if Log Analytics is provided)
resource openAIDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceResourceId)) {
  scope: openAI
  name: 'openai-diagnostics'
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

resource searchDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceResourceId)) {
  scope: searchService
  name: 'search-diagnostics'
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

resource cosmosGremlinDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceResourceId)) {
  scope: cosmosGremlin
  name: 'cosmos-gremlin-diagnostics'
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

resource cosmosSQLDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceResourceId)) {
  scope: cosmosSQL
  name: 'cosmos-sql-diagnostics'
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

resource keyVaultDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceResourceId)) {
  scope: keyVault
  name: 'keyvault-diagnostics'
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

// Outputs
output openAIEndpoint string = openAI.properties.endpoint
output openAIResourceId string = openAI.id
output openAIIdentityPrincipalId string = openAI.identity.principalId

output searchEndpoint string = 'https://${searchService.name}.search.windows.net'
output searchResourceId string = searchService.id
output searchIdentityPrincipalId string = searchService.identity.principalId

output aiFoundryHubEndpoint string = aiHub.properties.discoveryUrl
output aiFoundryHubResourceId string = aiHub.id
output aiFoundryProjectResourceId string = aiProject.id

output cosmosGremlinEndpoint string = cosmosGremlin.properties.documentEndpoint
output cosmosGremlinResourceId string = cosmosGremlin.id
output cosmosGremlinIdentityPrincipalId string = cosmosGremlin.identity.principalId

output cosmosSQLEndpoint string = cosmosSQL.properties.documentEndpoint
output cosmosSQLResourceId string = cosmosSQL.id
output cosmosSQLIdentityPrincipalId string = cosmosSQL.identity.principalId

output postgresServerName string = postgresServer.name
output postgresServerFQDN string = postgresServer.properties.fullyQualifiedDomainName
output postgresServerResourceId string = postgresServer.id
output postgresIdentityPrincipalId string = postgresServer.identity.principalId

output containerAppsEnvironmentId string = containerAppsEnvironment.id
output containerRegistryName string = containerRegistry.name
output containerRegistryLoginServer string = containerRegistry.properties.loginServer
output containerRegistryResourceId string = containerRegistry.id
output containerRegistryIdentityPrincipalId string = containerRegistry.identity.principalId

output keyVaultUri string = keyVault.properties.vaultUri
output keyVaultResourceId string = keyVault.id

output resourceIds object = {
  openAI: openAI.id
  search: searchService.id
  aiFoundryHub: aiHub.id
  aiFoundryProject: aiProject.id
  cosmosGremlin: cosmosGremlin.id
  cosmosSQL: cosmosSQL.id
  postgresServer: postgresServer.id
  containerAppsEnvironment: containerAppsEnvironment.id
  containerRegistry: containerRegistry.id
  keyVault: keyVault.id
}