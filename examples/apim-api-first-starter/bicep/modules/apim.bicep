// APIM instance + AOAI backend wiring + sample echo API

param location string
param apimName string
param sku string
param capacity int
param publisherEmail string
param publisherName string
param appInsightsId string
@secure()
param appInsightsInstrumentationKey string
param miId string
@description('When set, an AOAI backend is provisioned in APIM wired via APIM system-assigned identity (no shared key). Empty means the backend is not auto-wired and you can register it manually after deployment.')
param aoaiEndpoint string = ''
@description('AOAI account name used to scope the role assignment that lets APIM call AOAI via managed identity. Required when aoaiEndpoint is set.')
param aoaiAccountName string = ''
param deploySampleBackend bool

resource apim 'Microsoft.ApiManagement/service@2023-09-01-preview' = {
  name: apimName
  location: location
  sku: {
    name: sku
    capacity: sku == 'Developer' ? 1 : capacity
  }
  identity: {
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: {
      '${miId}': {}
    }
  }
  properties: {
    publisherEmail: publisherEmail
    publisherName: publisherName
    virtualNetworkType: 'None'  // production should be 'Internal' with VNet integration
    apiVersionConstraint: {
      minApiVersion: '2021-08-01'
    }
  }
}

// App Insights logger
resource appiLogger 'Microsoft.ApiManagement/service/loggers@2023-09-01-preview' = {
  parent: apim
  name: 'appinsights-logger'
  properties: {
    loggerType: 'applicationInsights'
    resourceId: appInsightsId
    credentials: {
      instrumentationKey: appInsightsInstrumentationKey
    }
    description: 'Application Insights logger for the API-First starter'
  }
}

// Diagnostics on the gateway tied to the logger
resource gatewayDiag 'Microsoft.ApiManagement/service/diagnostics@2023-09-01-preview' = {
  parent: apim
  name: 'applicationinsights'
  properties: {
    alwaysLog: 'allErrors'
    loggerId: appiLogger.id
    sampling: {
      samplingType: 'fixed'
      percentage: 100
    }
    frontend: {
      request: { headers: ['*'], body: { bytes: 512 } }
      response: { headers: ['*'], body: { bytes: 512 } }
    }
    backend: {
      request: { headers: ['*'], body: { bytes: 512 } }
      response: { headers: ['*'], body: { bytes: 512 } }
    }
  }
}

// AOAI backend (provisioned when aoaiEndpoint is set).
// Auth uses APIM's system-assigned managed identity — no shared key on disk.
// The role assignment below grants the identity 'Cognitive Services OpenAI User'.
resource aoaiBackend 'Microsoft.ApiManagement/service/backends@2023-09-01-preview' = if (!empty(aoaiEndpoint)) {
  parent: apim
  name: 'aoai-backend'
  properties: {
    protocol: 'http'
    url: aoaiEndpoint
  }
}

// Resolve the AOAI account in this RG so we can target the role assignment.
resource aoaiAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = if (!empty(aoaiAccountName)) {
  name: aoaiAccountName
}

// 'Cognitive Services OpenAI User' built-in role id.
var aoaiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource aoaiRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(aoaiEndpoint) && !empty(aoaiAccountName)) {
  scope: aoaiAccount
  name: guid(apim.id, aoaiUserRoleId, aoaiAccountName)
  properties: {
    principalId: apim.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', aoaiUserRoleId)
  }
}

// AOAI Chat Completions API — minimal stub; replace with full OpenAPI in production
resource aoaiApi 'Microsoft.ApiManagement/service/apis@2023-09-01-preview' = if (!empty(aoaiEndpoint)) {
  parent: apim
  name: 'aoai-chat'
  properties: {
    displayName: 'Azure OpenAI Chat'
    path: 'aoai'
    protocols: ['https']
    serviceUrl: aoaiEndpoint
    subscriptionRequired: true
  }
}

resource aoaiChatOp 'Microsoft.ApiManagement/service/apis/operations@2023-09-01-preview' = if (!empty(aoaiEndpoint)) {
  parent: aoaiApi
  name: 'chat-completions'
  properties: {
    displayName: 'Chat completions'
    method: 'POST'
    urlTemplate: '/openai/deployments/{deployment-id}/chat/completions'
    templateParameters: [
      { name: 'deployment-id', type: 'string', required: true }
    ]
  }
}

// LLM policy bundle on the AOAI chat API — the differentiator
resource aoaiPolicy 'Microsoft.ApiManagement/service/apis/policies@2023-09-01-preview' = if (!empty(aoaiEndpoint)) {
  parent: aoaiApi
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: loadTextContent('../../policies/aoai-chat.xml')
  }
}

// Sample echo API for smoke-testing the platform
resource echoApi 'Microsoft.ApiManagement/service/apis@2023-09-01-preview' = if (deploySampleBackend) {
  parent: apim
  name: 'echo'
  properties: {
    displayName: 'Echo'
    path: 'echo'
    protocols: ['https']
    serviceUrl: 'https://echo.free.beeceptor.com'
    subscriptionRequired: true
  }
}

resource echoOp 'Microsoft.ApiManagement/service/apis/operations@2023-09-01-preview' = if (deploySampleBackend) {
  parent: echoApi
  name: 'ping'
  properties: {
    displayName: 'Ping'
    method: 'GET'
    urlTemplate: '/ping'
  }
}

// Global policy (CORS + default rate limit)
resource globalPolicy 'Microsoft.ApiManagement/service/policies@2023-09-01-preview' = {
  parent: apim
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: loadTextContent('../../policies/global.xml')
  }
}

output apimName string = apim.name
output gatewayUrl string = apim.properties.gatewayUrl
output managementUrl string = apim.properties.managementApiUrl
output developerPortalUrl string = apim.properties.developerPortalUrl
