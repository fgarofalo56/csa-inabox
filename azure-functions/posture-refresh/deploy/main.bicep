// CSA Loom Govern posture-refresh — Function App IaC.
//
// Provisions the Consumption (Linux, Python v2) Function App that runs the
// posture-refresh timer (every 5 min) + on-demand HTTP refresh, writing the
// Govern -> Admin view (F2) posture aggregates to the existing Loom Cosmos
// `posture-aggregates` container.
//
// Identity: REUSES the existing Console UAMI (which already holds the Cosmos DB
// Built-in Data Contributor role at account scope) so NO new Cosmos RBAC grant
// is required. Pass its resource id + client id.
//
// Apply (after the admin-plane Cosmos + UAMI exist):
//
//   az deployment group create -g <admin-rg> \
//     -f azure-functions/posture-refresh/deploy/main.bicep \
//     -p cosmosEndpoint=<https://...documents.azure.com:443/> \
//        consoleUamiResourceId=<uami-id> consoleUamiClientId=<uami-client-id>
//
// Then publish the code:  func azure functionapp publish <functionAppName>

@description('Location for all resources.')
param location string = resourceGroup().location

@description('Function App name (globally unique).')
param functionAppName string = 'func-loom-posture-${uniqueString(resourceGroup().id)}'

@description('Storage account name for the Function runtime (3-24 lowercase alnum).')
@minLength(3)
@maxLength(24)
param storageAccountName string = take('stloompost${uniqueString(resourceGroup().id)}', 24)

@description('Loom Cosmos account document endpoint (https://<acct>.documents.azure.com:443/).')
param cosmosEndpoint string

@description('Loom Cosmos database name.')
param cosmosDatabase string = 'loom'

@description('Resource id of the existing Console UAMI (already a Cosmos Data Contributor).')
param consoleUamiResourceId string

@description('Client id of the existing Console UAMI.')
param consoleUamiClientId string

@description('Tags applied to every resource.')
param tags object = {}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${functionAppName}-plan'
  location: location
  tags: tags
  // Consumption (Dynamic) — no always-on cost.
  sku: { name: 'Y1', tier: 'Dynamic' }
  kind: 'functionapp'
  properties: {
    reserved: true // Linux required for Python v2
  }
}

var storageConnString = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storage.listKeys().keys[0].value}'

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${consoleUamiResourceId}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Python|3.11'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'AzureWebJobsStorage', value: storageConnString }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'python' }
        { name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING', value: storageConnString }
        { name: 'WEBSITE_CONTENTSHARE', value: toLower(functionAppName) }
        { name: 'LOOM_COSMOS_ENDPOINT', value: cosmosEndpoint }
        { name: 'LOOM_COSMOS_DATABASE', value: cosmosDatabase }
        { name: 'LOOM_UAMI_CLIENT_ID', value: consoleUamiClientId }
      ]
    }
  }
}

output functionAppName string = functionApp.name
output functionAppPrincipalId string = ''
