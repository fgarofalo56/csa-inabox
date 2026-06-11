// CSA Loom — GCC-High / IL4 parameters (Azure Government)
// v3 audit (2026-05): aligned with commercial-full deployment surface so
// every flag main.bicep accepts is set explicitly. Cloud-specific values
// (regions, SKUs, orchestrator) flip per the per-boundary dispatch matrix.
//
// Per AMENDMENTS A1 + per-boundary dispatch matrix:
// - Container Apps NOT at IL4 → AKS
// - Databricks UC + SQL Warehouse NOT in Gov → Hive metastore + Synapse Serverless
// - Foundry portal NOT at IL4 → classic Azure ML Hub
// - Foundry Agent Service Gov-GA unconfirmed → MAF + AOAI direct
// - Defender for Cloud AI Threat Protection Commercial-only → Sentinel pipeline
// - APIM Premium v2 not confirmed in Gov → classic Premium
// - Functions Flex Consumption not in Gov → EP1
// - OpenAI Content Safety NOT at IL4 → self-hosted Presidio
// - OpenAI Batch API NOT in Gov
// - AI Search GA-region surface limited in Gov — default off; opt in once
//   region capacity confirmed.
// - Purview: prefer tenant-level Enterprise Purview (Gov tenants already
//   typically have one). Set false here; reuse the existing account.

using '../main.bicep'

param environment = 'AzureUSGovernment'
param location = 'usgovvirginia'
param boundary = 'GCC-High'
param loomAzureCloud = 'AzureUSGovernment'   // Console AZURE_CLOUD discriminator (GCC-High runs on AzureUSGovernment endpoints)
param deploymentMode = 'multi-sub'   // most federal customers use multi-sub

// Compute (Gov differences)
param containerPlatform = 'aks'           // Container Apps not at IL4+
param functionsHostSku = 'EP1'            // Flex not in Gov
param apimSku = 'Premium'                 // v2 not confirmed in Gov

// Catalog (Gov-IL4)
param catalogPrimary = 'purview'          // UC managed not yet in Gov

// AI orchestration (Gov)
param agentOrchestrator = 'maf'           // Microsoft Agent Framework + AOAI direct
param foundryPortalEnabled = false        // Foundry portal NOT at IL4
// MAF orchestration tier (loom-copilot-maf) — the Gov AOAI-direct copilot
// backend. It deploys as an Azure Container App. Per the Microsoft Learn Azure
// Government services-by-audit-scope table (last updated Feb 2026), Azure
// Container Apps is authorized only at FedRAMP High / DoD IL2 — NOT at DoD IL4.
// GCC-High maps to IL4, so it runs on the AKS compute path (containerPlatform
// below), where the MAF Container App cannot deploy. This flag is set FALSE
// accordingly: the Console copilot-orchestrator uses Gov AOAI-direct, which is
// the real, working backend. Setting it true here would advertise a tier that
// can never activate on this compute platform (a silent no-op), so it is
// honestly false. The flag is still threaded through main.bicep
// (test_main_bicep_threads_copilot_maf_enabled) so the tier activates
// automatically once an AKS-workload deployment for the apps exists.
// See docs/fiab/runbooks/il5-gcch-fullstack-verification.md (gap #2/#3).
param copilotMafEnabled = false

// Capacity sizing
param capacitySku = 'F8'

// Databricks (Gov constraints)
param databricksUnityCatalogEnabled = false  // NOT in usgovaz/usgovva
param databricksSqlWarehouseEnabled = false  // NOT in Gov

// Security
param defenderForAIEnabled = false        // Commercial-only → Sentinel workaround
param purviewEnabled = false              // Reuse tenant Enterprise Purview
param atlasOnAksEnabled = false           // IL5-only
param storageRequireCmk = false           // recommended at IL4; required at IL5
param keyVaultHsmIsolated = false         // IL5 only

// OpenAI (Gov endpoints + region constraints)
param openaiLocation = 'usgovvirginia'              // chat models
param openaiEmbeddingsLocation = 'usgovarizona'     // embeddings Standard mode only here
param openaiChatModel = 'gpt-4o'
param openaiEmbeddingsModel = 'text-embedding-3-large'

// Power BI
param powerBiSku = 'F64'                  // F-SKU available in GCC-H

// Azure Maps — NOT available in GCC-High. azure-maps.bicep already gates on
// boundary == Commercial || GCC, so this is documentary; the geo-map / map
// editors render their honest-gate MessageBars here.
param azureMapsEnabled = false

// Network
param hubVnetCidr = '10.0.0.0/16'

// Identity (Gov tenant)
param adminEntraGroupId = '<replace-with-GCC-High-tenant-FiaB-Admins-group-guid>'

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

// MSAL — Gov tenant client id+secret via env (don't commit)
param loomMsalClientId = readEnvironmentVariable('LOOM_MSAL_CLIENT_ID', '')
param loomMsalClientSecret = readEnvironmentVariable('LOOM_MSAL_CLIENT_SECRET', '')

// Multi-sub (one sub per DLZ for production federal)
param dlzSubscriptionIds = [
  // '<dlz-1-sub-id>'
  // '<dlz-2-sub-id>'
]
param dlzDomainNames = [
  // 'mission-ops'
  // 'finance'
]

// Feature flags — Gov defaults. AI Search OFF (region capacity TBD).
// Front Door NOT certified for IL5 but is for GCC-H — enabled here.
param deployAppsEnabled = true
param aiFoundryEnabled = true
// Azure AI Content Safety IS available in GCC-High (USGovArizona / USGovVirginia)
// — Text, Prompt Shield, and Protected Material Text are all supported per the
// Microsoft Learn region matrix. Wires LOOM_CONTENT_SAFETY_ENDPOINT.
param contentSafetyEnabled = true
param apimEnabled = true
param aiSearchEnabled = false
param adxEnabled = true
param vpnGatewayEnabled = true
param appGatewayEnabled = true
param frontDoorEnabled = true

// Tags
param complianceTags = {
  Environment: 'GCC-High'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  DISA_IL: 'IL4'
  Data_Classification: 'CUI'
  M365_Boundary: 'GCC-High'
}
