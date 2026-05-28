// CSA Loom — Commercial full push-button deploy (everything enabled)
// Generated for the iterate-until-green session. Uses real Loom Admins
// group + flips every service flag on.

using '../main.bicep'

param environment = 'AzureCloud'
param location = 'eastus2'
param boundary = 'Commercial'
param deploymentMode = 'single-sub'

// Compute
param containerPlatform = 'containerApps'
param functionsHostSku = 'FlexConsumption'
param apimSku = 'PremiumV2'

// Catalog
param catalogPrimary = 'unity-catalog-managed'

// AI orchestration
param agentOrchestrator = 'foundry-agent-service'
param foundryPortalEnabled = true

// Capacity sizing
param capacitySku = 'F8'

// Databricks feature flags
param databricksUnityCatalogEnabled = true
param databricksSqlWarehouseEnabled = true

// Security
param defenderForAIEnabled = true
// Unified Catalog defaults to ON for this full parameter set.
// If your tenant already has an Enterprise Purview account, set this to false
// and provide LOOM_PURVIEW_ACCOUNT via loomPurviewAccount below.
param purviewEnabled = true
// Wire the existing tenant Purview into Loom so /admin/security Purview
// tab calls REAL endpoints instead of rendering the NotConfigured gate.
// Override via env: LOOM_PURVIEW_ACCOUNT=<short-account-name>
param loomPurviewAccount = readEnvironmentVariable('LOOM_PURVIEW_ACCOUNT', 'dmlz-dev-purview-eastus')
// Information Protection + DLP — opt in after the post-deploy bootstrap
// workflow grants the Graph AppRoles AND admin consent is issued.
// Set LOOM_MIP_ENABLED / LOOM_DLP_ENABLED env vars to flip these on.
param loomMipEnabled = bool(readEnvironmentVariable('LOOM_MIP_ENABLED', 'false'))
param loomDlpEnabled = bool(readEnvironmentVariable('LOOM_DLP_ENABLED', 'false'))
param storageRequireCmk = false
param keyVaultHsmIsolated = false
param atlasOnAksEnabled = false

// OpenAI
param openaiLocation = 'eastus2'
param openaiEmbeddingsLocation = 'eastus2'
param openaiChatModel = 'gpt-4o'
param openaiEmbeddingsModel = 'text-embedding-3-large'

// Power BI
param powerBiSku = 'F64'

// Network
param hubVnetCidr = '10.0.0.0/16'

// Identity — real Loom Admins group
param adminEntraGroupId = '716f5ec5-20d0-4713-9e42-57ef931cd665'

// Loom version + image tags — preserves currently deployed images
param loomVersion = readEnvironmentVariable('LOOM_VERSION', 'v2.1')
param appImageTags = {
  console: readEnvironmentVariable('LOOM_CONSOLE_TAG', 'v2.1')
  mcp: readEnvironmentVariable('LOOM_MCP_TAG', 'v0.7')
  orchestrator: readEnvironmentVariable('LOOM_ORCHESTRATOR_TAG', 'v0.7')
  activator: readEnvironmentVariable('LOOM_ACTIVATOR_TAG', 'v0.7')
  mirroring: readEnvironmentVariable('LOOM_MIRRORING_TAG', 'v0.7')
  directLake: readEnvironmentVariable('LOOM_DIRECTLAKE_TAG', 'v0.7')
}

// MSAL — passed from env vars (don't commit secrets to disk)
param loomMsalClientId = readEnvironmentVariable('LOOM_MSAL_CLIENT_ID', '9844c28c-3b3a-4949-8d63-9eefa3b50a9d')
param loomMsalClientSecret = readEnvironmentVariable('LOOM_MSAL_CLIENT_SECRET', '')
// Stable session secret — pass via env to preserve sign-ins across deploys
param loomSessionSecret = readEnvironmentVariable('LOOM_SESSION_SECRET', newGuid())

// Multi-sub mode (empty for single-sub)
param dlzSubscriptionIds = []
param dlzDomainNames = []

// Feature flags — ALL ON for full push-button deploy
// AI Search currently OFF — eastus2 capacity exhausted (InsufficientResourcesAvailable).
// Re-enable in next iteration when capacity refreshes OR switch region.
param deployAppsEnabled = true
param aiFoundryEnabled = true
param apimEnabled = true
param aiSearchEnabled = false
param adxEnabled = true
param vpnGatewayEnabled = true
param appGatewayEnabled = true
param frontDoorEnabled = true

// Tags
param complianceTags = {
  Environment: 'Commercial'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  Data_Classification: 'Standard'
}
