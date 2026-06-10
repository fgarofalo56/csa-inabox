// CSA Loom — DoD IL5 parameters (Azure Government, IL5-accredited services only)
//
// Per the per-boundary dispatch matrix + v3 audit (2026-05). Differences vs
// GCC-High:
//
// - storageRequireCmk: true (IL5 mandates CMK)
// - keyVaultHsmIsolated: true (Premium HSM, isolated key pool)
// - frontDoorEnabled: false (Front Door not IL5-certified — use AGW only)
// - aiFoundryEnabled: false (Foundry Hub not certified IL5 yet — MAF + AOAI direct)
// - atlasOnAksEnabled: true (Atlas on AKS replaces Purview at IL5)
// - aiSearchEnabled: false (limited IL5 region surface)
//
// Storage CMK key URI: set via env `LOOM_STORAGE_CMK_KEY_URI` once provisioned
// in the IL5 Key Vault (out-of-band — wrapped by an HSM-isolated key).
// main.bicep will receive it through a future param; today storageRequireCmk
// triggers the CMK code path against a key resolved by the storage module.

using '../main.bicep'

param environment = 'AzureUSGovernment'
param location = 'usgovvirginia'
param boundary = 'IL5'
param loomAzureCloud = 'AzureUSGovernment'   // Console AZURE_CLOUD discriminator (IL5 runs on AzureUSGovernment endpoints)
param deploymentMode = 'multi-sub'

// Compute (IL5 differences)
param containerPlatform = 'aks'
param functionsHostSku = 'EP1'
param apimSku = 'Premium'

// Catalog (IL5)
param catalogPrimary = 'atlas-aks'        // Atlas on AKS — Purview Data Map not IL5-accredited

// AI orchestration (IL5)
param agentOrchestrator = 'maf'           // Foundry Agent Service NOT IL5
param foundryPortalEnabled = false

// Capacity sizing
param capacitySku = 'F8'

// Databricks (IL5: same Gov constraints as IL4)
param databricksUnityCatalogEnabled = false
param databricksSqlWarehouseEnabled = false

// Security (IL5 hardening)
param defenderForAIEnabled = false        // Sentinel pipeline
param purviewEnabled = false              // Atlas on AKS instead
param atlasOnAksEnabled = true
param storageRequireCmk = true            // IL5 mandated
param keyVaultHsmIsolated = true          // IL5 mandated

// OpenAI (Gov endpoints + region constraints)
param openaiLocation = 'usgovvirginia'
param openaiEmbeddingsLocation = 'usgovarizona'
param openaiChatModel = 'gpt-4o'
param openaiEmbeddingsModel = 'text-embedding-3-large'

// Power BI
param powerBiSku = 'F64'

// Network
param hubVnetCidr = '10.0.0.0/16'

// Identity (Gov tenant)
param adminEntraGroupId = '<replace-with-IL5-tenant-FiaB-Admins-group-guid>'

// Loom version + image tags
param loomVersion = readEnvironmentVariable('LOOM_VERSION', 'v3.0')
param appImageTags = {
  console: readEnvironmentVariable('LOOM_CONSOLE_TAG', 'v3.0')
  mcp: readEnvironmentVariable('LOOM_MCP_TAG', 'v0.7')
  orchestrator: readEnvironmentVariable('LOOM_ORCHESTRATOR_TAG', 'v0.7')
  activator: readEnvironmentVariable('LOOM_ACTIVATOR_TAG', 'v0.7')
  mirroring: readEnvironmentVariable('LOOM_MIRRORING_TAG', 'v0.7')
  directLake: readEnvironmentVariable('LOOM_DIRECTLAKE_TAG', 'v0.7')
}

// MSAL — IL5 tenant client id+secret via env (don't commit)
param loomMsalClientId = readEnvironmentVariable('LOOM_MSAL_CLIENT_ID', '')
param loomMsalClientSecret = readEnvironmentVariable('LOOM_MSAL_CLIENT_SECRET', '')

// Multi-sub
param dlzSubscriptionIds = []
param dlzDomainNames = []

// Feature flags — IL5 has TIGHTER edge surface
//   - Front Door: NOT IL5-certified → false. Use AGW WAF only.
//   - AI Foundry: not IL5 yet → false.
//   - AI Search: limited IL5 region surface → false.
param deployAppsEnabled = true
param aiFoundryEnabled = false
// Azure AI Content Safety is NOT offered in the DoD regions (US DoD Central /
// US DoD East) per the Microsoft Learn region matrix. Leave off — the Console
// honest-gates the copilot moderation pipeline with a warning MessageBar
// (prompts pass unfiltered, never a silent claim of filtering).
param contentSafetyEnabled = false
param apimEnabled = true
param aiSearchEnabled = false
param adxEnabled = true
param vpnGatewayEnabled = true
param appGatewayEnabled = true
param frontDoorEnabled = false

// Tags
param complianceTags = {
  Environment: 'IL5'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  DISA_IL: 'IL5'
  Data_Classification: 'CUI-SP'
  M365_Boundary: 'IL5'
}
