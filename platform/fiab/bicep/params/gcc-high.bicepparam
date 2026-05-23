// CSA Loom — GCC-High / IL4 parameters (Azure Government)
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
//
// Status: PARAMETER SCAFFOLDED

using '../main.bicep'

param environment = 'AzureUSGovernment'
param location = 'usgovvirginia'
param boundary = 'GCC-High'
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

// Capacity sizing
param capacitySku = 'F8'

// Databricks (Gov constraints)
param databricksUnityCatalogEnabled = false  // NOT in usgovaz/usgovva
param databricksSqlWarehouseEnabled = false  // NOT in Gov

// Security
param defenderForAIEnabled = false        // Commercial-only → Sentinel workaround
param purviewEnabled = true               // IL4 audit OK
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

// Network
param hubVnetCidr = '10.0.0.0/16'

// Identity (Gov tenant)
param adminEntraGroupId = '<replace-with-GCC-High-tenant-FiaB-Admins-group-guid>'

// Multi-sub (one sub per DLZ for production federal)
param dlzSubscriptionIds = [
  // '<dlz-1-sub-id>'
  // '<dlz-2-sub-id>'
]
param dlzDomainNames = [
  // 'mission-ops'
  // 'finance'
]

// Tags
param complianceTags = {
  Environment: 'GCC-High'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  DISA_IL: 'IL4'
  Data_Classification: 'CUI'
  M365_Boundary: 'GCC-High'
}
