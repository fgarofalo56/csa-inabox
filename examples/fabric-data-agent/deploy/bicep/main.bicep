// -------------------------------------------------------------
// CSA-0113 fabric-data-agent — reference pattern
//
// IMPORTANT: Microsoft Fabric is pre-GA in Azure Government as of
// 2026-04.  See GOV_NOTE.md for the Commercial-vs-Gov positioning and
// the streaming-spine alternative available today.
//
// This Bicep deploys the bookkeeping resources an operator needs
// alongside a Fabric workspace (Key Vault for OpenAI / Fabric
// credentials, Application Insights for agent telemetry).  The Fabric
// workspace itself is NOT provisioned via Bicep — use the Fabric admin
// portal / Power BI admin tenant settings / Terraform Fabric provider
// until ARM support is GA.
// -------------------------------------------------------------

targetScope = 'resourceGroup'

// ------------------------ Parameters ------------------------

@description('Base name prefix for resources (lowercase, 3-20 chars).')
@minLength(3)
@maxLength(20)
param baseName string = 'csafabagent'

@description('Azure region.')
param location string = resourceGroup().location

@description('Environment name (dev / test / prod).')
@allowed([ 'dev', 'test', 'prod' ])
param environment string = 'dev'

@description('Object ID of the service principal that runs the agent. Granted KV Secrets User.')
param agentPrincipalId string = ''

@description('Log Analytics workspace ID for Application Insights.')
param logAnalyticsWorkspaceId string = ''

@description('Tags applied to every resource.')
param tags object = {
  vertical: 'fabric-data-agent'
  environment: environment
  source: 'csa-inabox/examples/fabric-data-agent'
  gov_awaiting_ga: 'true'     // surface-level callout for Gov reviewers
}

// ------------------------ Names -----------------------------

var kvName   = '${baseName}kv${uniqueString(resourceGroup().id)}'
var appiName = '${baseName}-appi-${environment}'

// ------------------------ Key Vault -------------------------

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

// Secrets placeholders — populate via az keyvault secret set after deploy.
//   - fabric-workspace-id
//   - fabric-lakehouse-id
//   - openai-endpoint
//   - openai-api-key
//
// Secrets are intentionally NOT materialised in Bicep to avoid
// leaking them into deployment logs.

// RBAC — grant the agent's service principal Key Vault Secrets User.
resource agentKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(agentPrincipalId)) {
  name: guid(resourceGroup().id, agentPrincipalId, 'kv-secrets-user')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6',   // Key Vault Secrets User
    )
    principalId: agentPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ------------------------ App Insights ----------------------

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: appiName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: empty(logAnalyticsWorkspaceId) ? null : logAnalyticsWorkspaceId
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// ------------------------ Outputs ---------------------------

output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output appInsightsName string = appi.name
output appInsightsInstrumentationKey string = appi.properties.InstrumentationKey
output govAwaitingGaNotice string = 'Fabric is pre-GA in Azure Government. See GOV_NOTE.md.'
