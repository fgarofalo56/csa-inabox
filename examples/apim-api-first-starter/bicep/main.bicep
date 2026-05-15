// APIM API-First Starter — main.bicep
// See: docs/solution-store/index.md and docs/guides/apim-universal-gateway.md
// This is a STARTER. See README.md for what it does and does not include.

targetScope = 'resourceGroup'

@description('Email used as the APIM publisher contact')
param apimPublisherEmail string

@description('Display name used as the APIM publisher')
param apimPublisherName string

@description('Azure region — default to the resource group location')
param location string = resourceGroup().location

@description('Suffix appended to resource names to keep them unique within the tenant')
param namePrefix string = 'apifirst'

@description('Deploy an Azure OpenAI account as a sample backend for the LLM policy demo')
param deployOpenAi bool = false

@description('Deploy a sample container backend for the echo API')
param deploySampleBackend bool = false

@description('APIM SKU — Premium v2 recommended for production; Developer for non-prod')
@allowed([
  'Developer'
  'Standard'
  'Premium'
  'PremiumV2'
])
param apimSku string = 'Developer'

@description('APIM capacity units (Premium v2 only; ignored otherwise)')
@minValue(1)
@maxValue(10)
param apimCapacity int = 1

var rgSuffix = uniqueString(resourceGroup().id)
var apimName = '${namePrefix}-apim-${rgSuffix}'
var logName = '${namePrefix}-log-${rgSuffix}'
var appiName = '${namePrefix}-appi-${rgSuffix}'
var kvName = take('${namePrefix}kv${rgSuffix}', 24)
var miName = '${namePrefix}-mi-${rgSuffix}'
var aoaiName = '${namePrefix}-aoai-${rgSuffix}'

// ---- User-assigned managed identity ---------------------------------------
resource mi 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: miName
  location: location
}

// ---- Observability (Log Analytics + App Insights) -------------------------
module obs 'modules/observability.bicep' = {
  name: 'obs'
  params: {
    location: location
    logName: logName
    appiName: appiName
  }
}

// ---- Key Vault (with managed identity access) ------------------------------
module kv 'modules/keyvault.bicep' = {
  name: 'kv'
  params: {
    location: location
    kvName: kvName
    miPrincipalId: mi.properties.principalId
  }
}

// ---- Optional: Azure OpenAI sample backend --------------------------------
module aoai 'modules/openai.bicep' = if (deployOpenAi) {
  name: 'aoai'
  params: {
    location: location
    aoaiName: aoaiName
  }
}

// ---- APIM Premium v2 (or chosen SKU) --------------------------------------
module apim 'modules/apim.bicep' = {
  name: 'apim'
  params: {
    location: location
    apimName: apimName
    sku: apimSku
    capacity: apimCapacity
    publisherEmail: apimPublisherEmail
    publisherName: apimPublisherName
    appInsightsId: obs.outputs.appiId
    appInsightsInstrumentationKey: obs.outputs.appiInstrumentationKey
    miId: mi.id
    miClientId: mi.properties.clientId
    aoaiEndpoint: deployOpenAi ? aoai!.outputs.endpoint : ''
    aoaiKey: deployOpenAi ? aoai!.outputs.apiKey : ''
    deploySampleBackend: deploySampleBackend
  }
}

// ---- Outputs --------------------------------------------------------------
output apimName string = apim.outputs.apimName
output apimGatewayUrl string = apim.outputs.gatewayUrl
output apimManagementUrl string = apim.outputs.managementUrl
output apimDeveloperPortalUrl string = apim.outputs.developerPortalUrl
output keyVaultName string = kv.outputs.kvName
output logAnalyticsName string = logName
output appInsightsName string = appiName
output managedIdentityClientId string = mi.properties.clientId
output aoaiEndpoint string = deployOpenAi ? aoai!.outputs.endpoint : ''
