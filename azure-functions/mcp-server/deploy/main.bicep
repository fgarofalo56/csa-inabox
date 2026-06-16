// CSA Loom MCP tool server — Azure Functions IaC (deploy-from-scratch)
//
// Provisions the Function App that hosts the Loom MCP server
// (azure-functions/mcp-server/function_app.py) plus its supporting resources,
// and wires the app settings the server reads. Deploys at RESOURCE GROUP scope.
//
// What this Bicep creates:
//   - Storage account (Functions runtime backing store)
//   - Application Insights (telemetry)
//   - Linux Consumption plan (Y1) + Python 3.12 Function App with a
//     system-assigned managed identity
//   - App settings, incl. a Key Vault reference for LOOM_MCP_API_KEY
//   - RBAC: Reader on this resource group + Key Vault Secrets User on the
//     existing Key Vault, both for the Function App's managed identity
//
// What it does NOT do (honest gates — the tools surface a precise message):
//   - Grant Reader on OTHER Loom resource groups (cross-RG ARM tools): grant
//     the output principalId Reader on each RG in loomResourceGroups.
//   - Grant 'Search Index Data Reader' on the AI Search service (catalog tool):
//     grant the output principalId that role, or set LOOM_AI_SEARCH_KEY.
//   - Grant 'Data Factory Contributor' on the Loom Data Factory (data-movement
//     author/run tools — loom_upsert_pipeline / loom_run_pipeline): grant the
//     output principalId that role on the factory (Reader suffices for the
//     read/diagnose tools). Set adfName + dlzResourceGroup to enable them.
//
// Apply:
//   az deployment group create -g <rg> \
//     -f azure-functions/mcp-server/deploy/main.bicep \
//     -p keyVaultName=<kv> apiKeySecretName=loom-mcp-api-key \
//        loomSubscriptionId=<sub> loomResourceGroups="['rg-a','rg-b']" \
//        aiSearchService=<search>
//   # then: func azure functionapp publish <functionAppName> --python

@description('Location for all resources.')
param location string = resourceGroup().location

@description('Function App name (globally unique). 2-60 chars.')
param functionAppName string = 'func-csa-loom-mcp'

@description('Storage account name (globally unique, 3-24 lowercase alphanumerics).')
@minLength(3)
@maxLength(24)
param storageAccountName string = toLower('stloommcp${uniqueString(resourceGroup().id)}')

@description('Application Insights name.')
param appInsightsName string = 'appi-csa-loom-mcp'

@description('Consumption plan name.')
param planName string = 'plan-csa-loom-mcp'

@description('Existing Key Vault holding the MCP API key secret.')
param keyVaultName string

@description('Key Vault secret name holding the shared MCP API key (LOOM_MCP_API_KEY).')
param apiKeySecretName string = 'loom-mcp-api-key'

@description('LITERAL shared MCP API key value. When non-empty it is set directly as the LOOM_MCP_API_KEY app setting, bypassing the Key Vault reference. REQUIRED on estates where the Loom Key Vault is private-link only — a Consumption Function App has no VNet integration and cannot resolve a @Microsoft.KeyVault(...) reference (it returns the literal reference string → the server 401s). Empty keeps the Key Vault reference (works only when the Function can reach the vault).')
@secure()
param apiKeyValue string = ''

@description('Subscription that hosts the Loom deployment (for the ARM tools).')
param loomSubscriptionId string = subscription().subscriptionId

@description('Loom resource groups the ARM tools inspect (comma-joined into an app setting).')
param loomResourceGroups array = [ resourceGroup().name ]

@description('AI Search service name (or full https URL) backing loom_search_catalog. Empty = catalog tool honest-gates.')
param aiSearchService string = ''

@description('AI Search index for the catalog tool.')
param aiSearchIndex string = 'loom-items'

@description('Resource group of the Loom default Data Factory (for the data-movement tools). Empty = those tools honest-gate.')
param dlzResourceGroup string = ''

@description('Loom default Data Factory name backing the data-movement (pipeline/copy-job/dataflow) tools. Empty = those tools honest-gate.')
param adfName string = ''

@description('Azure SQL server FQDN hosting the copy-job watermark / CDC LSN checkpoint control DB (dbo.copy_watermark). Empty = loom_run_copy_job Incremental/CDC modes honest-gate; Full mode still works. Deploy platform/fiab/bicep/modules/admin-plane/copy-job-control.bicep to create the control table + dbo.usp_write_watermark.')
param copyJobControlSqlServer string = ''

@description('Database name of the copy-job control DB (default loom-control).')
param copyJobControlSqlDatabase string = 'loom-control'

@description('ARM endpoint (Gov: https://management.usgovcloudapi.net).')
param armEndpoint string = environment().resourceManager

// ── Storage ──────────────────────────────────────────────────────────────

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    // Identity-based AzureWebJobsStorage (below) — shared key disabled to match
    // AAD-only Loom estates (Azure Policy enforces allowSharedKeyAccess=false;
    // a key-based connection string is rejected: KeyBasedAuthenticationNotPermitted).
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
  }
}

// ── App Insights ───────────────────────────────────────────────────────────

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
  }
}

// ── Consumption plan (Linux) ─────────────────────────────────────────────────

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  sku: { name: 'Y1', tier: 'Dynamic' }
  kind: 'functionapp'
  properties: { reserved: true } // Linux
}

// ── Existing Key Vault ───────────────────────────────────────────────────────

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

var apiKeySecretUri = '${keyVault.properties.vaultUri}secrets/${apiKeySecretName}'

// ── Function App ─────────────────────────────────────────────────────────────

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
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
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'AzureWebJobsStorage__blobServiceUri', value: 'https://${storage.name}.blob.${environment().suffixes.storage}' }
        { name: 'AzureWebJobsStorage__queueServiceUri', value: 'https://${storage.name}.queue.${environment().suffixes.storage}' }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'python' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        // Literal value when supplied (private-KV estates), else the KV reference.
        { name: 'LOOM_MCP_API_KEY', value: empty(apiKeyValue) ? '@Microsoft.KeyVault(SecretUri=${apiKeySecretUri})' : apiKeyValue }
        { name: 'LOOM_SUBSCRIPTION_ID', value: loomSubscriptionId }
        { name: 'LOOM_RESOURCE_GROUPS', value: join(loomResourceGroups, ',') }
        { name: 'LOOM_AI_SEARCH_SERVICE', value: aiSearchService }
        { name: 'LOOM_AI_SEARCH_INDEX', value: aiSearchIndex }
        { name: 'LOOM_DLZ_RG', value: dlzResourceGroup }
        { name: 'LOOM_ADF_NAME', value: adfName }
        { name: 'LOOM_COPYJOB_CONTROL_SQL_SERVER', value: copyJobControlSqlServer }
        { name: 'LOOM_COPYJOB_CONTROL_SQL_DB', value: copyJobControlSqlDatabase }
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

// Key Vault Secrets User on the existing KV (read the API key secret).
var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionApp.id, kvSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Identity-based AzureWebJobsStorage needs the Function MI to hold data roles on
// its runtime storage account (the AAD-only estate disallows the account key).
// Storage Blob Data Owner — host package/lease blobs.
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

// Storage Queue Data Contributor — host trigger/lease queues.
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
output principalId string = functionApp.identity.principalId
