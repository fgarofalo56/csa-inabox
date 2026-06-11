// CSA Loom — GCC parameters
// GCC = M365 GCC tenant + Azure Commercial subscriptions
// Critical GCC gate: F-SKU not supported → no Direct Lake parity in GCC
//
// Status: PARAMETER SCAFFOLDED

using '../main.bicep'

param environment = 'AzureCloud'
param location = 'eastus'
param boundary = 'GCC'
param deploymentMode = 'single-sub'

// Compute (same as Commercial — GCC runs on Azure public)
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

// Databricks (same as Commercial)
param databricksUnityCatalogEnabled = true
param databricksSqlWarehouseEnabled = true

// Security
param defenderForAIEnabled = true
// Azure AI Content Safety — copilot persona moderation. GCC runs on Commercial
// Azure endpoints, so Content Safety is available; wires LOOM_CONTENT_SAFETY_ENDPOINT.
param contentSafetyEnabled = true
param purviewEnabled = true
param storageRequireCmk = false
param keyVaultHsmIsolated = false

// OpenAI (Azure public endpoints; M365 GCC identity isolation)
param openaiLocation = 'eastus'
param openaiEmbeddingsLocation = 'eastus'
param openaiChatModel = 'gpt-4o'
param openaiEmbeddingsModel = 'text-embedding-3-large'

// Power BI — GCC limitation
param powerBiSku = 'P1'   // P-SKU only; F-SKU NOT in GCC

// Azure Maps — Gen2 account deploys by default in GCC (azure-maps.bicep gates
// on boundary == Commercial || GCC). Set EXISTING_AZURE_MAPS_ACCOUNT to bring
// your own; leave unset to provision a fresh account + bind the env automatically.
param loomAzureMapsAccount = readEnvironmentVariable('EXISTING_AZURE_MAPS_ACCOUNT', '')

// Network
param hubVnetCidr = '10.0.0.0/16'

// Identity
param adminEntraGroupId = '<replace-with-GCC-tenant-FiaB-Admins-group-guid>'

// Multi-sub
param dlzSubscriptionIds = []
param dlzDomainNames = []

// Tags
param complianceTags = {
  Environment: 'GCC'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  Data_Classification: 'CUI-low'
  M365_Boundary: 'GCC'
}
