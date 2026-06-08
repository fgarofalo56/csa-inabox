// CSA Loom — posture-refresh Azure Function (Govern posture pre-compute).
//
// Provisions a standalone Python Consumption Function App that serves BOTH
// Govern posture paths in one app:
//   - F2 Admin view  — TimerTrigger (every 5 min) + /api/posture-refresh-admin
//     recompute per tenant → Cosmos ``posture-aggregates-admin``.
//   - F3 data-owner  — POST /api/posture-refresh recomputes a signed-in owner's
//     posture on tab-open → Cosmos ``posture-aggregates`` + ``recommended-actions``.
// AAD-only to Cosmos via system-assigned managed identity (no account keys).
//
// What this Bicep creates:
//   - Storage account (Functions runtime backing store), TLS1.2, no public blob.
//   - Consumption (Y1 Dynamic) Linux plan.
//   - Function App (Python 3.12), HTTPS-only, system-assigned MI.
//   - A cross-RG module that grants the Function MI "Cosmos DB Built-in Data
//     Contributor" on the existing Loom Cosmos account.
//
// What it does NOT do (post-deploy, see DEPLOYMENT.md):
//   - Push the function code (func azure functionapp publish). The bootstrap
//     workflow auto-publishes any app named ``func-loom-posture*``.
//   - Read the generated host key and store it in Key Vault as
//     ``loom-posture-function-key``.
//   - Set ``LOOM_POSTURE_FUNCTION_URL`` (= output ``functionUrl``) on the
//     Console (admin-plane param ``loomPostureFunctionUrl``).
//
// Apply:
//   az deployment group create \
//     -g <function-rg> \
//     -f azure-functions/posture-refresh/deploy/main.bicep \
//     -p loomCosmosEndpoint=https://<acct>.documents.azure.com:443/ \
//        loomCosmosAccountName=<acct> \
//        loomCosmosAccountResourceGroup=<cosmos-rg>

targetScope = 'resourceGroup'

@description('Region for the Function App + storage. Defaults to the RG location.')
param location string = resourceGroup().location

@description('Loom Cosmos DB endpoint (https://<acct>.documents.azure.<com|us>:443/).')
param loomCosmosEndpoint string

@description('Loom Cosmos database name.')
param loomCosmosDatabase string = 'loom'

@description('Loom Cosmos account name (for the data-plane RBAC grant).')
param loomCosmosAccountName string

@description('Resource group of the Loom Cosmos account (may differ from this RG).')
param loomCosmosAccountResourceGroup string = resourceGroup().name

@description('Compliance/cost tags applied to all resources.')
param tags object = {}

var saName = take('saposture${uniqueString(resourceGroup().id)}', 24)
var planName = 'plan-posture-refresh-${uniqueString(resourceGroup().id)}'
var siteName = 'func-loom-posture-refresh-${uniqueString(resourceGroup().id)}'

resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: saName
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
  name: planName
  location: location
  tags: tags
  sku: { name: 'Y1', tier: 'Dynamic' }
  kind: 'functionapp,linux'
  properties: { reserved: true }
}

resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: siteName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Python|3.12'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        { name: 'AzureWebJobsStorage', value: 'DefaultEndpointsProtocol=https;AccountName=${sa.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${sa.listKeys().keys[0].value}' }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'python' }
        { name: 'LOOM_COSMOS_ENDPOINT', value: loomCosmosEndpoint }
        { name: 'LOOM_COSMOS_DATABASE', value: loomCosmosDatabase }
      ]
    }
  }
}

// Cross-RG data-plane grant to the existing Loom Cosmos account.
module cosmosRbac 'cosmos-rbac.bicep' = {
  name: 'posture-cosmos-rbac'
  scope: resourceGroup(loomCosmosAccountResourceGroup)
  params: {
    loomCosmosAccountName: loomCosmosAccountName
    functionPrincipalId: site.identity.principalId
  }
}

@description('Function base URL — set this as the Console LOOM_POSTURE_FUNCTION_URL.')
output functionUrl string = 'https://${site.properties.defaultHostName}'

@description('Function App name (for func azure functionapp publish).')
output functionName string = site.name
