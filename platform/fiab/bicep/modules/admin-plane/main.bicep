// CSA Loom — Admin Plane orchestrator
// Deployment scope: resource group (rg-csa-loom-admin-<region>)
//
// Status: SCAFFOLDED — module stubs in this folder; real Bicep
// implementations land via PRP-02.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Cloud boundary (Commercial / GCC / GCC-High / IL5)')
param boundary string

@description('Container platform — containerApps or aks')
param containerPlatform string

@description('Functions host SKU')
param functionsHostSku string

@description('APIM SKU')
param apimSku string

@description('Catalog primary')
param catalogPrimary string

@description('Agent orchestrator')
param agentOrchestrator string

@description('Capacity SKU')
param capacitySku string

@description('Foundry portal enabled')
param foundryPortalEnabled bool

@description('Defender for Cloud AI Threat Protection enabled')
param defenderForAIEnabled bool

@description('Purview Data Map enabled')
param purviewEnabled bool

@description('Atlas on AKS enabled (IL5 only)')
param atlasOnAksEnabled bool

@description('OpenAI region for chat')
param openaiLocation string

@description('OpenAI region for embeddings')
param openaiEmbeddingsLocation string

@description('OpenAI chat model')
param openaiChatModel string

@description('OpenAI embeddings model')
param openaiEmbeddingsModel string

@description('Key Vault Premium HSM isolated (IL5)')
param keyVaultHsmIsolated bool

@description('Admin Entra group object ID')
param adminEntraGroupId string

@description('Hub VNet CIDR')
param hubVnetCidr string

@description('Compliance tags')
param complianceTags object

// =====================================================================
// Module stubs — each placeholder; real implementations land via PRP-02
// =====================================================================

// 1. Network (hub VNet + Azure Firewall + DNS zones)
//    Reuse from Azure/data-management-zone/modules/network.bicep

// 2. Private DNS zones (extend with Fabric / OneLake / Container Apps zones)

// 3. ACR (reuse 1:1 from Azure/data-management-zone/modules/container.bicep)

// 4. Container platform (Container App Env or AKS, per containerPlatform)

// 5. Console app (Next.js Loom Console)

// 6. MCP server app (self-hosted Azure MCP)

// 7. Setup orchestrator app (Foundry Agent Service or MAF — per agentOrchestrator)

// 8. Copilot app (extended apps/copilot)

// 9. Catalog (Purview / UC managed / Atlas — per catalogPrimary)

// 10. AI Foundry Hub (or Azure ML Classic Hub if foundryPortalEnabled=false)

// 11. AI Search (S1+ with vector + integrated vectorization)

// 12. APIM (Premium v2 or classic Premium per apimSku)

// 13. Identity (UAMI for Orchestrator + UAMI for MCP server)

// 14. Monitoring (App Insights + LAW + Sentinel)

// 15. Key Vault Premium (HSM isolated if keyVaultHsmIsolated=true)

// 16. Sentinel AI rules (Defender AI workaround in Gov; optional in Commercial)

// 17. Presidio sidecar (Gov only, where Content Safety unavailable)

// 18. Policy initiative (extends from Azure/data-management-zone)

// =====================================================================
// Outputs
// =====================================================================

output hubVnetId string = 'PLACEHOLDER-hub-vnet-resource-id'
output consoleUrl string = 'https://loom-console-${uniqueString(resourceGroup().id)}.example.com'
output mcpServerUrl string = 'https://loom-mcp-${uniqueString(resourceGroup().id)}.example.com'
output catalogEndpoint string = 'PLACEHOLDER-catalog-endpoint'
