// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Unified APIM Gateway for CSA-in-a-Box Data Mesh — single entry point for
// DAB, AI Services, Marketplace, and Portal APIs.
targetScope = 'resourceGroup'

// ─── Parameters ─────────────────────────────────────────────────────────────

@description('Prefix used to generate resource names.')
param namePrefix string = 'csa-datamesh'

@description('Environment identifier.')
@allowed(['dev', 'stg', 'prod'])
param environment string

@description('Azure region for resource deployment.')
param location string = resourceGroup().location

@description('Resource tags applied to all deployed resources.')
param tags object = {}

@description('Publisher email address for the APIM instance.')
param publisherEmail string

@description('Publisher organization name.')
param publisherName string = 'CSA-in-a-Box'

@description('SKU for the API Management instance.')
@allowed([
  'Developer'
  'Standard'
  'Premium'
])
param apimSku string = 'Developer'

@description('Number of scale units. Only applies to Standard and Premium SKUs.')
@minValue(1)
@maxValue(12)
param skuCount int = 1

@description('Enable Application Insights integration.')
param enableAppInsights bool = true

@description('Application Insights resource ID.')
param applicationInsightsId string = ''

@description('Application Insights instrumentation key.')
param applicationInsightsInstrumentationKey string = ''

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Backend URL for Data API Builder (Container App or App Service).')
param dabBackendUrl string

@description('Backend URL for AI services (FastAPI).')
param aiBackendUrl string

@description('Backend URL for Data Marketplace (FastAPI).')
param marketplaceBackendUrl string

@description('Backend URL for Portal core API (FastAPI).')
param portalBackendUrl string

@description('Azure AD JWT issuer URL for token validation.')
param jwtIssuer string = ''

@description('Azure AD JWT audience for token validation.')
param jwtAudience string = ''

@description('Allowed CORS origins (comma-separated).')
param allowedOrigins string = '*'

@description('Rate limit: max calls per period for internal products.')
param rateLimitCalls int = 100

@description('Rate limit: period in seconds.')
param rateLimitPeriod int = 60

@description('Attach a CanNotDelete resource lock. Default true for production.')
param enableResourceLock bool = false

@description('Enable public network access.')
param publicNetworkAccessEnabled bool = true

// ─── Variables ──────────────────────────────────────────────────────────────

var apimName = '${namePrefix}-apim-gw-${environment}'
var uniqueSuffix = take(uniqueString(resourceGroup().id), 6)
var apimDisplayName = 'CSA-in-a-Box Data Mesh Gateway (${toUpper(environment)})'

// ─── APIM Service ───────────────────────────────────────────────────────────

resource apim 'Microsoft.ApiManagement/service@2023-09-01-preview' = {
  name: '${apimName}-${uniqueSuffix}'
  location: location
  tags: union(tags, { Pattern: 'DataMeshGateway', Environment: environment })
  sku: {
    name: apimSku
    capacity: skuCount
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publisherEmail: publisherEmail
    publisherName: publisherName
    publicNetworkAccess: publicNetworkAccessEnabled ? 'Enabled' : 'Disabled'
    customProperties: {
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls10': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls11': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Ssl30': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Backend.Protocols.Tls10': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Backend.Protocols.Tls11': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Backend.Protocols.Ssl30': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Ciphers.TripleDes168': 'False'
    }
  }
}

// ─── Named Values ───────────────────────────────────────────────────────────

resource nvJwtIssuer 'Microsoft.ApiManagement/service/namedValues@2023-09-01-preview' = {
  parent: apim
  name: 'jwt-issuer'
  properties: {
    displayName: 'jwt-issuer'
    value: jwtIssuer
    secret: false
  }
}

resource nvJwtAudience 'Microsoft.ApiManagement/service/namedValues@2023-09-01-preview' = {
  parent: apim
  name: 'jwt-audience'
  properties: {
    displayName: 'jwt-audience'
    value: jwtAudience
    secret: false
  }
}

resource nvAllowedOrigins 'Microsoft.ApiManagement/service/namedValues@2023-09-01-preview' = {
  parent: apim
  name: 'allowed-origins'
  properties: {
    displayName: 'allowed-origins'
    value: allowedOrigins
    secret: false
  }
}

resource nvRateLimitCalls 'Microsoft.ApiManagement/service/namedValues@2023-09-01-preview' = {
  parent: apim
  name: 'rate-limit-calls'
  properties: {
    displayName: 'rate-limit-calls'
    value: string(rateLimitCalls)
    secret: false
  }
}

resource nvRateLimitPeriod 'Microsoft.ApiManagement/service/namedValues@2023-09-01-preview' = {
  parent: apim
  name: 'rate-limit-period'
  properties: {
    displayName: 'rate-limit-period'
    value: string(rateLimitPeriod)
    secret: false
  }
}

// ─── Application Insights Logger ────────────────────────────────────────────

resource apimLogger 'Microsoft.ApiManagement/service/loggers@2023-09-01-preview' = if (enableAppInsights && !empty(applicationInsightsId)) {
  parent: apim
  name: '${apimName}-logger'
  properties: {
    loggerType: 'applicationInsights'
    resourceId: applicationInsightsId
    credentials: {
      instrumentationKey: applicationInsightsInstrumentationKey
    }
  }
}

// ─── Backends ───────────────────────────────────────────────────────────────

resource dabBackend 'Microsoft.ApiManagement/service/backends@2023-09-01-preview' = {
  parent: apim
  name: 'dab-backend'
  properties: {
    title: 'Data API Builder'
    description: 'DAB Container App providing REST and GraphQL over Azure SQL'
    url: dabBackendUrl
    protocol: 'http'
    tls: {
      validateCertificateChain: true
      validateCertificateName: true
    }
  }
}

resource aiBackend 'Microsoft.ApiManagement/service/backends@2023-09-01-preview' = {
  parent: apim
  name: 'ai-backend'
  properties: {
    title: 'AI Services'
    description: 'AI endpoints — chat, embeddings, document intelligence'
    url: aiBackendUrl
    protocol: 'http'
    tls: {
      validateCertificateChain: true
      validateCertificateName: true
    }
  }
}

resource marketplaceBackend 'Microsoft.ApiManagement/service/backends@2023-09-01-preview' = {
  parent: apim
  name: 'marketplace-backend'
  properties: {
    title: 'Data Marketplace'
    description: 'Self-service data product marketplace'
    url: marketplaceBackendUrl
    protocol: 'http'
    tls: {
      validateCertificateChain: true
      validateCertificateName: true
    }
  }
}

resource portalBackend 'Microsoft.ApiManagement/service/backends@2023-09-01-preview' = {
  parent: apim
  name: 'portal-backend'
  properties: {
    title: 'Portal Core API'
    description: 'CSA Portal — governance, domains, users, configuration'
    url: portalBackendUrl
    protocol: 'http'
    tls: {
      validateCertificateChain: true
      validateCertificateName: true
    }
  }
}

// ─── API Definitions ────────────────────────────────────────────────────────

resource dabApi 'Microsoft.ApiManagement/service/apis@2023-09-01-preview' = {
  parent: apim
  name: 'data-api-builder'
  properties: {
    displayName: 'Data API Builder'
    description: 'REST and GraphQL access to data products via DAB'
    path: 'dab'
    protocols: ['https']
    serviceUrl: dabBackendUrl
    subscriptionRequired: true
    subscriptionKeyParameterNames: {
      header: 'Ocp-Apim-Subscription-Key'
      query: 'subscription-key'
    }
  }
  dependsOn: [dabBackend]
}

resource aiApi 'Microsoft.ApiManagement/service/apis@2023-09-01-preview' = {
  parent: apim
  name: 'ai-services'
  properties: {
    displayName: 'AI Services'
    description: 'AI chat, embeddings, and document intelligence endpoints'
    path: 'ai'
    protocols: ['https']
    serviceUrl: aiBackendUrl
    subscriptionRequired: true
    subscriptionKeyParameterNames: {
      header: 'Ocp-Apim-Subscription-Key'
      query: 'subscription-key'
    }
  }
  dependsOn: [aiBackend]
}

resource marketplaceApi 'Microsoft.ApiManagement/service/apis@2023-09-01-preview' = {
  parent: apim
  name: 'marketplace'
  properties: {
    displayName: 'Data Marketplace'
    description: 'Data product discovery, access requests, and quality monitoring'
    path: 'marketplace'
    protocols: ['https']
    serviceUrl: marketplaceBackendUrl
    subscriptionRequired: true
    subscriptionKeyParameterNames: {
      header: 'Ocp-Apim-Subscription-Key'
      query: 'subscription-key'
    }
  }
  dependsOn: [marketplaceBackend]
}

resource portalApi 'Microsoft.ApiManagement/service/apis@2023-09-01-preview' = {
  parent: apim
  name: 'portal-api'
  properties: {
    displayName: 'Portal Core API'
    description: 'Governance, domain management, user management, configuration'
    path: 'portal'
    protocols: ['https']
    serviceUrl: portalBackendUrl
    subscriptionRequired: true
    subscriptionKeyParameterNames: {
      header: 'Ocp-Apim-Subscription-Key'
      query: 'subscription-key'
    }
  }
  dependsOn: [portalBackend]
}

// ─── Products ───────────────────────────────────────────────────────────────

resource internalProduct 'Microsoft.ApiManagement/service/products@2023-09-01-preview' = {
  parent: apim
  name: 'data-mesh-internal'
  properties: {
    displayName: 'Data Mesh Internal'
    description: 'Internal consumers — full access to all APIs with higher rate limits'
    subscriptionRequired: true
    approvalRequired: false
    state: 'published'
  }
}

resource externalProduct 'Microsoft.ApiManagement/service/products@2023-09-01-preview' = {
  parent: apim
  name: 'data-mesh-external'
  properties: {
    displayName: 'Data Mesh External'
    description: 'External consumers — read-only access with standard rate limits'
    subscriptionRequired: true
    approvalRequired: true
    state: 'published'
  }
}

resource aiProduct 'Microsoft.ApiManagement/service/products@2023-09-01-preview' = {
  parent: apim
  name: 'ai-platform'
  properties: {
    displayName: 'AI Platform'
    description: 'AI-specific consumers — access to AI and Marketplace APIs'
    subscriptionRequired: true
    approvalRequired: true
    state: 'published'
  }
}

// ─── Product-API Associations ───────────────────────────────────────────────

// Internal product gets ALL APIs
resource internalDab 'Microsoft.ApiManagement/service/products/apis@2023-09-01-preview' = {
  parent: internalProduct
  name: 'data-api-builder'
  dependsOn: [dabApi]
}

resource internalAi 'Microsoft.ApiManagement/service/products/apis@2023-09-01-preview' = {
  parent: internalProduct
  name: 'ai-services'
  dependsOn: [aiApi]
}

resource internalMarketplace 'Microsoft.ApiManagement/service/products/apis@2023-09-01-preview' = {
  parent: internalProduct
  name: 'marketplace'
  dependsOn: [marketplaceApi]
}

resource internalPortal 'Microsoft.ApiManagement/service/products/apis@2023-09-01-preview' = {
  parent: internalProduct
  name: 'portal-api'
  dependsOn: [portalApi]
}

// External product gets read-only APIs (DAB + Marketplace)
resource externalDab 'Microsoft.ApiManagement/service/products/apis@2023-09-01-preview' = {
  parent: externalProduct
  name: 'data-api-builder'
  dependsOn: [dabApi]
}

resource externalMarketplace 'Microsoft.ApiManagement/service/products/apis@2023-09-01-preview' = {
  parent: externalProduct
  name: 'marketplace'
  dependsOn: [marketplaceApi]
}

// AI product gets AI + Marketplace APIs
resource aiProductAi 'Microsoft.ApiManagement/service/products/apis@2023-09-01-preview' = {
  parent: aiProduct
  name: 'ai-services'
  dependsOn: [aiApi]
}

resource aiProductMarketplace 'Microsoft.ApiManagement/service/products/apis@2023-09-01-preview' = {
  parent: aiProduct
  name: 'marketplace'
  dependsOn: [marketplaceApi]
}

// ─── Subscriptions ──────────────────────────────────────────────────────────

resource internalSubscription 'Microsoft.ApiManagement/service/subscriptions@2023-09-01-preview' = {
  parent: apim
  name: 'internal-default'
  properties: {
    displayName: 'Internal Default Subscription'
    scope: internalProduct.id
    state: 'active'
  }
}

resource externalSubscription 'Microsoft.ApiManagement/service/subscriptions@2023-09-01-preview' = {
  parent: apim
  name: 'external-default'
  properties: {
    displayName: 'External Default Subscription'
    scope: externalProduct.id
    state: 'active'
  }
}

resource aiSubscription 'Microsoft.ApiManagement/service/subscriptions@2023-09-01-preview' = {
  parent: apim
  name: 'ai-platform-default'
  properties: {
    displayName: 'AI Platform Default Subscription'
    scope: aiProduct.id
    state: 'active'
  }
}

// ─── Diagnostic Settings ────────────────────────────────────────────────────

resource apimDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${apimName}-diagnostics'
  scope: apim
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

// APIM-level diagnostic to Application Insights (for per-API analytics)
resource apimApiDiagnostic 'Microsoft.ApiManagement/service/diagnostics@2023-09-01-preview' = if (enableAppInsights && !empty(applicationInsightsId)) {
  parent: apim
  name: 'applicationinsights'
  properties: {
    loggerId: apimLogger.id
    alwaysLog: 'allErrors'
    sampling: {
      percentage: 100
      samplingType: 'fixed'
    }
    logClientIp: true
  }
}

// ─── Resource Locks ─────────────────────────────────────────────────────────

resource apimLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: apim
  name: '${apimName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: Data Mesh unified APIM gateway. Delete via rollback workflow in docs/ROLLBACK.md.'
  }
}

// ─── Outputs ────────────────────────────────────────────────────────────────

@description('Gateway URL of the unified APIM instance.')
output apimGatewayUrl string = apim.properties.gatewayUrl

@description('Management API URL.')
output apimManagementUrl string = apim.properties.managementApiUrl

@description('Developer portal URL.')
output developerPortalUrl string = apim.properties.developerPortalUrl

@description('Resource ID of the APIM instance.')
output apimId string = apim.id

@description('Managed identity principal ID.')
output managedIdentityPrincipalId string = apim.identity.principalId

@description('APIM instance name.')
output apimName string = apim.name
