// CSA Loom built-in MCP tool server — admin-plane module (DEFAULT-ON).
//
// Provisions the Azure Function App that hosts the in-repo Loom MCP server
// (azure-functions/mcp-server/function_app.py), wired into the admin-plane
// orchestrator behind `loomBuiltinMcpEnabled` (default true). The Python code is
// published separately (zip / `func azure functionapp publish`) — same as the
// loom-* container images must be pushed before deployAppsEnabled, so this module
// is gated the same way by the orchestrator.
//
// ESTATE-CORRECT (validated live, sub e093f4fd…/centralus, 2026-06):
//  - AzureWebJobsStorage is IDENTITY-based (AzureWebJobsStorage__accountName +
//    blob/queueServiceUri). The Loom estate enforces AAD-only storage
//    (allowSharedKeyAccess=false via Azure Policy), so a key-based connection
//    string is rejected (`KeyBasedAuthenticationNotPermitted`). The Function MI
//    is granted Storage Blob Data Owner + Storage Queue Data Contributor on its
//    own runtime storage account.
//  - LOOM_MCP_API_KEY is a LITERAL @secure() value (not a Key Vault reference).
//    The Loom Key Vault is private-link only; a Consumption Function App has no
//    VNet integration and cannot resolve a `@Microsoft.KeyVault(...)` reference
//    (it returns the literal reference string → 401). The orchestrator writes
//    the SAME value to the admin Key Vault as `loom-builtin-mcp-api-key` so the
//    Console (which CAN reach the private vault over the CAE VNet) loads it for
//    one-click registration.
//
// no-fabric-dependency: tools call AI Search + ARM + ADF — all Azure-native.

@description('Location for all resources.')
param location string = resourceGroup().location

@description('Function App name (globally unique).')
param functionAppName string = 'func-csa-loom-mcp'

@description('Storage account name (globally unique, 3-24 lowercase alphanumerics).')
@minLength(3)
@maxLength(24)
param storageAccountName string = toLower('stloommcp${uniqueString(resourceGroup().id)}')

@description('Application Insights name.')
param appInsightsName string = 'appi-csa-loom-mcp'

@description('Consumption plan name.')
param planName string = 'plan-csa-loom-mcp'

@description('Shared MCP API key (deterministic GUID from the orchestrator). Set as a LITERAL app setting — the private Loom Key Vault is unreachable by a Consumption Function App.')
@secure()
param apiKey string

@description('Subscription that hosts the Loom deployment (for the ARM tools).')
param loomSubscriptionId string = subscription().subscriptionId

@description('Loom resource groups the ARM tools inspect (comma-joined into an app setting).')
param loomResourceGroups array = [ resourceGroup().name ]

@description('AI Search service name backing loom_search_catalog. Empty = the catalog tool honest-gates.')
param aiSearchService string = ''

@description('AI Search index for the catalog tool.')
param aiSearchIndex string = 'loom-items'

@description('Resource group of the Loom default Data Factory. Empty = the data-movement tools honest-gate.')
param dlzResourceGroup string = ''

@description('Loom default Data Factory name backing the data-movement tools. Empty = those tools honest-gate.')
param adfName string = ''

@description('ARM endpoint (Gov: https://management.usgovcloudapi.net).')
param armEndpoint string = environment().resourceManager

@description('Resource tags.')
param complianceTags object = {}

// ── Storage (identity-based; AAD-only estate) ────────────────────────────────
resource storage 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: storageAccountName
  location: location
  tags: complianceTags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: complianceTags
  kind: 'web'
  properties: { Application_Type: 'web' }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  tags: complianceTags
  sku: { name: 'Y1', tier: 'Dynamic' }
  kind: 'functionapp'
  properties: { reserved: true } // Linux
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  tags: complianceTags
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Python|3.12'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        // Identity-based runtime storage (no account key — AAD-only estate).
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'AzureWebJobsStorage__blobServiceUri', value: 'https://${storage.name}.blob.${environment().suffixes.storage}' }
        { name: 'AzureWebJobsStorage__queueServiceUri', value: 'https://${storage.name}.queue.${environment().suffixes.storage}' }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'python' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        // Literal API key — the private Loom KV is unreachable by Consumption.
        { name: 'LOOM_MCP_API_KEY', value: apiKey }
        { name: 'LOOM_SUBSCRIPTION_ID', value: loomSubscriptionId }
        { name: 'LOOM_RESOURCE_GROUPS', value: join(loomResourceGroups, ',') }
        { name: 'LOOM_AI_SEARCH_SERVICE', value: aiSearchService }
        { name: 'LOOM_AI_SEARCH_INDEX', value: aiSearchIndex }
        { name: 'LOOM_DLZ_RG', value: dlzResourceGroup }
        { name: 'LOOM_ADF_NAME', value: adfName }
        { name: 'LOOM_ARM_ENDPOINT', value: armEndpoint }
      ]
    }
  }
}

// ── RBAC ─────────────────────────────────────────────────────────────────────
// Reader on this resource group (ARM list tools, current RG).
var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
resource readerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, functionApp.id, readerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRoleId)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Storage Blob Data Owner on the runtime storage (identity-based AzureWebJobsStorage).
var blobOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
resource blobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, blobOwnerRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobOwnerRoleId)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Storage Queue Data Contributor (Functions host uses queues for triggers/leases).
var queueContribRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
resource queueContrib 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, queueContribRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueContribRoleId)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Outputs ──────────────────────────────────────────────────────────────────
output functionAppName string = functionApp.name
output mcpEndpoint string = 'https://${functionApp.properties.defaultHostName}/api/mcp'
output healthEndpoint string = 'https://${functionApp.properties.defaultHostName}/api/health'
// Post-provision honest gates (the tools surface a precise message until granted):
//  - Search Index Data Reader on the AI Search service (loom_search_catalog)
//  - Data Factory Contributor on the Loom Data Factory (data-movement author/run)
//  - Reader on any cross-RG Loom resource groups (loom_list_resources)
output principalId string = functionApp.identity.principalId
