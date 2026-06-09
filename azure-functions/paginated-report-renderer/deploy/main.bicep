// CSA Loom — paginated-report-renderer Azure Function.
//
// Provisions a standalone Python Consumption Function App that renders a
// Loom-native RDL report definition to PDF / Excel / Word (ReportLab /
// openpyxl / python-docx). This is the Azure-native DEFAULT export path for the
// `paginated-report` item type — NO Microsoft Fabric / Power BI capacity is
// involved (see .claude/rules/no-fabric-dependency.md).
//
// What this Bicep creates:
//   - Storage account (Functions runtime backing store), TLS1.2, no public blob.
//   - Consumption (Y1 Dynamic) Linux plan.
//   - Function App (Python 3.12), HTTPS-only, system-assigned MI.
//   - An optional cross-RG module that grants the Function MI "Cosmos DB
//     Built-in Data Contributor" on the Loom Cosmos account — only needed for
//     the future live-query render path; rendering from request-body sampleRows
//     needs no Cosmos access. Pass loomCosmosAccountName='' to skip the grant.
//
// What it does NOT do (post-deploy, see DEPLOYMENT.md):
//   - Push the function code (func azure functionapp publish). The bootstrap
//     workflow auto-publishes any app named ``func-loom-prpt-renderer*``.
//   - Read the generated host key and store it in Key Vault as
//     ``loom-paginated-render-key``.
//   - Set ``LOOM_PAGINATED_RENDER_URL`` (= output ``functionUrl``) on the
//     Console (admin-plane param ``loomPaginatedRenderUrl``).
//
// Apply:
//   az deployment group create \
//     -g <function-rg> \
//     -f azure-functions/paginated-report-renderer/deploy/main.bicep \
//     -p loomCosmosEndpoint=https://<acct>.documents.azure.com:443/ \
//        loomCosmosAccountName=<acct> \
//        loomCosmosAccountResourceGroup=<cosmos-rg>

targetScope = 'resourceGroup'

@description('Region for the Function App + storage. Defaults to the RG location.')
param location string = resourceGroup().location

@description('Loom Cosmos DB endpoint (only used by the future live-query path).')
param loomCosmosEndpoint string = ''

@description('Loom Cosmos database name.')
param loomCosmosDatabase string = 'loom'

@description('Loom Cosmos account name for the optional data-plane RBAC grant. Empty skips the grant.')
param loomCosmosAccountName string = ''

@description('Resource group of the Loom Cosmos account (may differ from this RG).')
param loomCosmosAccountResourceGroup string = resourceGroup().name

@description('Compliance/cost tags applied to all resources.')
param tags object = {}

var saName = take('saprpt${uniqueString(resourceGroup().id)}', 24)
var planName = 'plan-prpt-renderer-${uniqueString(resourceGroup().id)}'
var siteName = 'func-loom-prpt-renderer-${uniqueString(resourceGroup().id)}'

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

// Optional cross-RG data-plane grant (future live-query render path).
module cosmosRbac 'cosmos-rbac.bicep' = if (!empty(loomCosmosAccountName)) {
  name: 'prpt-cosmos-rbac'
  scope: resourceGroup(loomCosmosAccountResourceGroup)
  params: {
    loomCosmosAccountName: loomCosmosAccountName
    functionPrincipalId: site.identity.principalId
  }
}

@description('Function base URL — set this as the Console LOOM_PAGINATED_RENDER_URL.')
output functionUrl string = 'https://${site.properties.defaultHostName}'

@description('Function App name (for func azure functionapp publish).')
output functionName string = site.name

@description('System-assigned managed identity principal id.')
output principalId string = site.identity.principalId
