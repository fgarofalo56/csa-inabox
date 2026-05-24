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
// Reuse existing tenant-level Enterprise Purview (dmlz-dev-purview-eastus).
// Provisioning a 2nd would fail with 'EnterpriseTenantAlreadyExists'.
param purviewEnabled = false
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

// Multi-sub mode (empty for single-sub)
param dlzSubscriptionIds = []
param dlzDomainNames = []

// Feature flags — ALL ON for full push-button deploy
param deployAppsEnabled = true
param aiFoundryEnabled = true
param apimEnabled = true
param aiSearchEnabled = true
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
