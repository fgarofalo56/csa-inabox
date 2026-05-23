// CSA Loom — Azure Commercial parameters
// Per AMENDMENTS A4 + per-boundary dispatch matrix (architecture.md §4.3)
//
// Status: PARAMETER SCAFFOLDED — values aligned with PRD §7.3.1

using '../main.bicep'

param environment = 'AzureCloud'
param location = 'eastus2'
param boundary = 'Commercial'
param deploymentMode = 'single-sub'   // or 'multi-sub'

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
// Purview defaults OFF — many Microsoft tenants already have an
// Enterprise-tier tenant-level Purview account (only one allowed per
// tenant). Operator opts in once they've decided whether to reuse the
// existing account (preferred) or scope a new one.
param purviewEnabled = false
param storageRequireCmk = false
param keyVaultHsmIsolated = false

// OpenAI
param openaiLocation = 'eastus2'
param openaiEmbeddingsLocation = 'eastus2'
param openaiChatModel = 'gpt-4o'
param openaiEmbeddingsModel = 'text-embedding-3-large'

// Power BI
param powerBiSku = 'F64'

// Network
param hubVnetCidr = '10.0.0.0/16'

// Identity
param adminEntraGroupId = '<replace-with-FiaB-Admins-group-guid>'

// Multi-sub mode (empty for single-sub)
param dlzSubscriptionIds = []
param dlzDomainNames = []

// Tags
param complianceTags = {
  Environment: 'Commercial'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  Data_Classification: 'Standard'
}
