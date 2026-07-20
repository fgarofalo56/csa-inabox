// CSA Loom — access-governance expiry sweeper (W3).
//
// Provisions a standalone Python Consumption Function App that drives the
// Console's expiry-sweep endpoint on a timer. It calls
// ``POST {LOOM_CONSOLE_URL}/api/access-governance/sweep`` with the shared
// ``x-loom-system-token`` (LOOM_SWEEPER_TOKEN) every 15 minutes; the Console does
// the real ledger scan + grant revoke + 'expired' marking. This app therefore
// needs NO Cosmos/ARM data-plane access of its own — only the Console URL + token.
//
// What this Bicep creates:
//   - Storage account (Functions runtime backing store), TLS1.2, no public blob.
//   - Consumption (Y1 Dynamic) Linux plan.
//   - Function App (Python 3.12), HTTPS-only, system-assigned MI.
//
// Post-deploy (see the access-governance PRP / DEPLOYMENT):
//   - Push the function code (func azure functionapp publish).
//   - Set LOOM_SWEEPER_TOKEN to the SAME value on the Console app (so the route
//     accepts this Function) — store it as a Key Vault secretRef on both.
//
// Apply:
//   az deployment group create \
//     -g <function-rg> \
//     -f azure-functions/access-governance-sweeper/deploy/main.bicep \
//     -p loomConsoleUrl=https://<console-host> loomSweeperToken=<secret>

targetScope = 'resourceGroup'

@description('Region for the Function App + storage. Defaults to the RG location.')
param location string = resourceGroup().location

@description('Base URL of the Console the sweeper drives (no trailing slash).')
param loomConsoleUrl string

@description('Shared system token; MUST match LOOM_SWEEPER_TOKEN on the Console.')
@secure()
param loomSweeperToken string

@description('Compliance/cost tags applied to all resources.')
param tags object = {}

var saName = take('saagsweep${uniqueString(resourceGroup().id)}', 24)
var planName = 'plan-ag-sweeper-${uniqueString(resourceGroup().id)}'
var siteName = 'func-loom-ag-sweeper-${uniqueString(resourceGroup().id)}'

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
        { name: 'LOOM_CONSOLE_URL', value: loomConsoleUrl }
        { name: 'LOOM_SWEEPER_TOKEN', value: loomSweeperToken }
      ]
    }
  }
}

@description('Function base URL.')
output functionUrl string = 'https://${site.properties.defaultHostName}'

@description('Function App name (for func azure functionapp publish).')
output functionName string = site.name
