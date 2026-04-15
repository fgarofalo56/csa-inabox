// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Data Marketplace infrastructure — App Service + Cosmos DB + APIM for the
// self-service data product marketplace.

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
param baseName string = 'csa-marketplace'

@description('Log Analytics workspace resource ID for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('App Service Plan SKU. Use B1 for dev, S1+ for prod.')
@allowed(['B1', 'B2', 'S1', 'S2', 'P1v3', 'P2v3'])
param appServicePlanSku string = 'B1'

@description('Cosmos DB consistency level.')
@allowed(['Session', 'BoundedStaleness', 'Strong', 'ConsistentPrefix', 'Eventual'])
param cosmosConsistencyLevel string = 'Session'

@description('Enable Cosmos DB free tier (only one per subscription).')
param cosmosFreeTier bool = false

@description('APIM publisher email address.')
param apimPublisherEmail string = 'admin@contoso.com'

@description('APIM publisher organization name.')
param apimPublisherName string = 'CSA-in-a-Box'

@description('APIM SKU. Use Developer for non-prod, Standard for prod.')
@allowed(['Developer', 'Standard', 'Premium'])
param apimSku string = 'Developer'

@description('Private endpoint subnet configurations.')
param privateEndpointSubnets array = []

@description('Attach a CanNotDelete resource lock. Default true for production.')
param enableResourceLock bool = true

// ─── Variables ──────────────────────────────────────────────────────────────

var uniqueSuffix = take(uniqueString(resourceGroup().id), 6)
var appServicePlanName = '${baseName}-plan-${environment}'
var webAppName = '${baseName}-app-${environment}-${uniqueSuffix}'
var cosmosAccountName = take(toLower('${baseName}-cosmos-${environment}-${uniqueSuffix}'), 44)
var apimName = '${baseName}-apim-${environment}'
var appInsightsName = '${baseName}-insights-${environment}'
var cosmosDatabaseName = 'marketplace'

// ─── Application Insights ───────────────────────────────────────────────────

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: !empty(logAnalyticsWorkspaceId) ? logAnalyticsWorkspaceId : null
  }
}

// ─── Cosmos DB Account ──────────────────────────────────────────────────────

@description('Cosmos DB account for marketplace data (products, access requests, quality metrics).')
resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-02-15-preview' = {
  name: cosmosAccountName
  location: location
  tags: union(tags, { Pattern: 'DataMarketplace' })
  kind: 'GlobalDocumentDB'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    databaseAccountOfferType: 'Standard'
    enableFreeTier: cosmosFreeTier
    consistencyPolicy: {
      defaultConsistencyLevel: cosmosConsistencyLevel
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: environment == 'prod'
      }
    ]
    publicNetworkAccess: 'Disabled'
    networkAclBypass: 'AzureServices'
    disableLocalAuth: true // Force Azure AD auth
    capabilities: [
      { name: 'EnableServerless' }
    ]
    minimalTlsVersion: 'Tls12'
  }
}

@description('Marketplace database.')
resource cosmosDatabase 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-02-15-preview' = {
  parent: cosmosAccount
  name: cosmosDatabaseName
  properties: {
    resource: {
      id: cosmosDatabaseName
    }
  }
}

@description('Data products container.')
resource productsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-02-15-preview' = {
  parent: cosmosDatabase
  name: 'products'
  properties: {
    resource: {
      id: 'products'
      partitionKey: {
        paths: ['/domain']
        kind: 'Hash'
        version: 2
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        includedPaths: [{ path: '/*' }]
        excludedPaths: [{ path: '/"_etag"/?' }]
        compositeIndexes: [
          [
            { path: '/domain', order: 'ascending' }
            { path: '/qualityScore', order: 'descending' }
          ]
        ]
      }
      defaultTtl: -1
    }
  }
}

@description('Access requests container.')
resource accessRequestsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-02-15-preview' = {
  parent: cosmosDatabase
  name: 'access_requests'
  properties: {
    resource: {
      id: 'access_requests'
      partitionKey: {
        paths: ['/productId']
        kind: 'Hash'
        version: 2
      }
      defaultTtl: -1
    }
  }
}

@description('Quality metrics container with TTL for historical data.')
resource qualityContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-02-15-preview' = {
  parent: cosmosDatabase
  name: 'quality_metrics'
  properties: {
    resource: {
      id: 'quality_metrics'
      partitionKey: {
        paths: ['/productId']
        kind: 'Hash'
        version: 2
      }
      defaultTtl: 7776000 // 90 days
    }
  }
}

// ─── App Service Plan ───────────────────────────────────────────────────────

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: appServicePlanSku
  }
  properties: {
    reserved: true
  }
}

// ─── Web App (FastAPI) ──────────────────────────────────────────────────────

@description('App Service running the FastAPI marketplace application.')
resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  tags: union(tags, { Pattern: 'DataMarketplace' })
  kind: 'app,linux'
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
      alwaysOn: appServicePlanSku != 'B1'
      appSettings: [
        { name: 'COSMOS_ENDPOINT', value: cosmosAccount.properties.documentEndpoint }
        { name: 'COSMOS_DATABASE', value: cosmosDatabaseName }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        { name: 'ENVIRONMENT', value: environment }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
      ]
    }
  }
}

// ─── APIM ───────────────────────────────────────────────────────────────────

@description('API Management instance for the marketplace API.')
resource apim 'Microsoft.ApiManagement/service@2023-09-01-preview' = {
  name: apimName
  location: location
  tags: union(tags, { Pattern: 'DataMarketplace' })
  sku: {
    name: apimSku
    capacity: apimSku == 'Developer' ? 1 : 1
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publisherEmail: apimPublisherEmail
    publisherName: apimPublisherName
    publicNetworkAccess: 'Enabled' // Set to Disabled for prod with private endpoints
  }
}

@description('Marketplace API definition in APIM.')
resource marketplaceApi 'Microsoft.ApiManagement/service/apis@2023-09-01-preview' = {
  parent: apim
  name: 'marketplace-api'
  properties: {
    displayName: 'Data Marketplace API'
    description: 'CSA-in-a-Box Data Marketplace — product discovery, access requests, and quality monitoring'
    path: 'marketplace'
    protocols: ['https']
    serviceUrl: 'https://${webApp.properties.defaultHostName}'
    subscriptionRequired: true
    apiVersion: 'v1'
  }
}

// ─── RBAC: Web App → Cosmos DB ──────────────────────────────────────────────

// Cosmos DB Built-in Data Contributor role
var cosmosDataContributorRoleId = '00000000-0000-0000-0000-000000000002'

@description('Grant the web app managed identity Cosmos DB data contributor access.')
resource cosmosRbac 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-02-15-preview' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, webApp.id, cosmosDataContributorRoleId)
  properties: {
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    principalId: webApp.identity.principalId
    scope: cosmosAccount.id
  }
}

// ─── Diagnostic Settings ────────────────────────────────────────────────────

resource webAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${webAppName}-diagnostics'
  scope: webApp
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

resource cosmosDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${cosmosAccountName}-diagnostics'
  scope: cosmosAccount
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'Requests', enabled: true }
    ]
  }
}

// ─── Resource Locks ─────────────────────────────────────────────────────────

resource cosmosLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: cosmosAccount
  name: '${cosmosAccountName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box Data Marketplace Cosmos DB account.'
  }
}

resource webAppLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: webApp
  name: '${webAppName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box Data Marketplace web application.'
  }
}

// ─── Outputs ────────────────────────────────────────────────────────────────

@description('Web App resource ID.')
output webAppId string = webApp.id

@description('Web App default hostname.')
output webAppHostname string = webApp.properties.defaultHostName

@description('Cosmos DB account endpoint.')
output cosmosEndpoint string = cosmosAccount.properties.documentEndpoint

@description('APIM gateway URL.')
output apimGatewayUrl string = apim.properties.gatewayUrl

@description('Web App managed identity principal ID.')
output webAppPrincipalId string = webApp.identity.principalId
