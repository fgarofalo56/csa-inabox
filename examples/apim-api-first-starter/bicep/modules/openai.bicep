// Optional Azure OpenAI account for the LLM policy demo

param location string
param aoaiName string

resource aoai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: aoaiName
  location: location
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: {
    publicNetworkAccess: 'Enabled'  // production should set to Disabled with private endpoint
    customSubDomainName: aoaiName
    disableLocalAuth: false  // production should set to true and use managed identity
  }
}

// Sample chat model deployment — provision a small footprint by default
resource gpt 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aoai
  name: 'gpt-4o-mini'
  sku: {
    name: 'GlobalStandard'
    capacity: 20
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-4o-mini'
      version: '2024-07-18'
    }
  }
}

// Embeddings model — required for semantic cache policy
resource emb 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aoai
  name: 'text-embedding-3-small'
  sku: {
    name: 'Standard'
    capacity: 20
  }
  dependsOn: [
    gpt
  ]
  properties: {
    model: {
      format: 'OpenAI'
      name: 'text-embedding-3-small'
      version: '1'
    }
  }
}

// AOAI keys are intentionally NOT exposed as outputs.
// APIM authenticates to AOAI via managed identity (see modules/apim.bicep
// role assignment for 'Cognitive Services OpenAI User'). For local testing,
// fetch a key with `az cognitiveservices account keys list` instead.
output endpoint string = aoai.properties.endpoint
output chatDeploymentName string = gpt.name
output embeddingsDeploymentName string = emb.name
