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
param miClientId string
param aoaiEndpoint string
@secure()
param aoaiKey string
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

// AOAI backend (provisioned when deployOpenAi is true)
resource aoaiBackend 'Microsoft.ApiManagement/service/backends@2023-09-01-preview' = if (!empty(aoaiEndpoint)) {
  parent: apim
  name: 'aoai-backend'
  properties: {
    protocol: 'http'
    url: aoaiEndpoint
    credentials: {
      header: {
        'api-key': [aoaiKey]
      }
    }
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
