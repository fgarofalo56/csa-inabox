// CSA Loom — top-level orchestrator
// Deployment scope: subscription
// Per-boundary parameter set: params/{commercial,gcc,gcc-high,il5}.bicepparam
// Deployment mode: single-sub | multi-sub
//
// Status: SCAFFOLDED — module stubs in modules/admin-plane/ +
//                      modules/landing-zone/ + modules/shared/
//                      Real Bicep implementations land via PRP-02.

targetScope = 'subscription'

@description('Azure cloud environment')
@allowed(['AzureCloud', 'AzureUSGovernment'])
param environment string

@description('Primary region (e.g., eastus2 / usgovvirginia)')
param location string

@description('Cloud boundary')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Deployment mode')
@allowed(['single-sub', 'multi-sub'])
param deploymentMode string

@description('Container platform — Container Apps (Commercial/GCC) or AKS (GCC-H/IL5)')
@allowed(['containerApps', 'aks'])
param containerPlatform string

@description('Functions host SKU — FlexConsumption (Commercial/GCC) or EP1 (Gov)')
@allowed(['FlexConsumption', 'EP1'])
param functionsHostSku string

@description('APIM SKU — PremiumV2 (Commercial/GCC) or Premium (Gov)')
@allowed(['PremiumV2', 'Premium'])
param apimSku string

@description('Catalog primary backend')
@allowed(['unity-catalog-managed', 'purview', 'atlas-aks'])
param catalogPrimary string

@description('Agent orchestrator — Foundry Agent Service (Commercial/GCC) or MAF + AOAI direct (Gov)')
@allowed(['foundry-agent-service', 'maf'])
param agentOrchestrator string

@description('Capacity SKU equivalence (drives Databricks + ADX + Power BI sizing)')
@allowed(['F2', 'F4', 'F8', 'F32', 'F64', 'F128', 'F512'])
param capacitySku string

@description('Databricks Unity Catalog managed availability')
param databricksUnityCatalogEnabled bool

@description('Databricks SQL Warehouse availability')
param databricksSqlWarehouseEnabled bool

@description('Foundry portal availability')
param foundryPortalEnabled bool

@description('Defender for Cloud AI Threat Protection availability')
param defenderForAIEnabled bool

@description('Purview Data Map availability (false at IL5)')
param purviewEnabled bool

@description('Apache Atlas on AKS deployment (IL5 only)')
param atlasOnAksEnabled bool = false

@description('OpenAI region for chat models')
param openaiLocation string

@description('OpenAI region for embeddings (usgovarizona in Gov)')
param openaiEmbeddingsLocation string

@description('OpenAI chat model')
param openaiChatModel string

@description('OpenAI embeddings model')
param openaiEmbeddingsModel string

@description('Power BI SKU (P-SKU for GCC; F-SKU elsewhere)')
param powerBiSku string

@description('Storage requires CMK (true at IL5)')
param storageRequireCmk bool = false

@description('Key Vault Premium HSM isolated (true at IL5)')
param keyVaultHsmIsolated bool = false

@description('Admin Plane subscription ID — defaults to deployment sub')
param adminPlaneSubId string = subscription().subscriptionId

@description('DLZ subscription IDs (multi-sub mode only)')
param dlzSubscriptionIds array = []

@description('DLZ domain names (parallel to dlzSubscriptionIds)')
param dlzDomainNames array = []

@description('Admin Entra group object ID for FiaB Admins')
param adminEntraGroupId string

@description('Hub VNet CIDR')
param hubVnetCidr string = '10.0.0.0/16'

@description('Compliance tags applied to every resource')
param complianceTags object

@description('Deploy Loom apps (Container Apps for Console/MCP/etc.). Requires container images in ACR — set false on initial provision, then true after CI image-build pipeline runs (PRP-16).')
param deployAppsEnabled bool = false

@description('Deploy AI Foundry Hub. Requires storage-account strategy; default off.')
param aiFoundryEnabled bool = false

@description('Deploy APIM. Premium V2 takes 30+ min; default off for fast iteration.')
param apimEnabled bool = false

@description('Deploy AI Search. Default off — capacity in eastus2 is intermittent.')
param aiSearchEnabled bool = false

@description('Deploy ADX database in DLZ. Requires admin-plane ADX cluster to already exist (provisioned out-of-band today). Default off.')
param adxEnabled bool = false

// ---------- User access patterns ----------

@description('Deploy a P2S VPN Gateway (AAD-auth, OpenVPN) in the hub VNet. ~30 min provisioning, ~$30/mo. Default off.')
param vpnGatewayEnabled bool = false

@description('Deploy Application Gateway v2 + WAF in front of the Console. ~15 min provisioning, ~$250/mo. Default off.')
param appGatewayEnabled bool = false

@description('Deploy Front Door Premium with Private Link to the ACA env. ~5 min provisioning + manual PE approval, ~$330/mo. Default off.')
param frontDoorEnabled bool = false

// =====================================================================
// Resource group for Admin Plane
// =====================================================================

var adminPlaneRgName = 'rg-csa-loom-admin-${location}'

resource adminPlaneRg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: adminPlaneRgName
  location: location
  tags: complianceTags
}

// =====================================================================
// Admin Plane deployment (Hub VNet + Console + MCP + Copilot + ...)
// =====================================================================

module adminPlane 'modules/admin-plane/main.bicep' = {
  name: 'admin-plane'
  scope: adminPlaneRg
  params: {
    location: location
    boundary: boundary
    containerPlatform: containerPlatform
    functionsHostSku: functionsHostSku
    apimSku: apimSku
    catalogPrimary: catalogPrimary
    agentOrchestrator: agentOrchestrator
    capacitySku: capacitySku
    foundryPortalEnabled: foundryPortalEnabled
    defenderForAIEnabled: defenderForAIEnabled
    purviewEnabled: purviewEnabled
    atlasOnAksEnabled: atlasOnAksEnabled
    openaiLocation: openaiLocation
    openaiEmbeddingsLocation: openaiEmbeddingsLocation
    openaiChatModel: openaiChatModel
    openaiEmbeddingsModel: openaiEmbeddingsModel
    keyVaultHsmIsolated: keyVaultHsmIsolated
    adminEntraGroupId: adminEntraGroupId
    hubVnetCidr: hubVnetCidr
    complianceTags: complianceTags
    deployAppsEnabled: deployAppsEnabled
    aiFoundryEnabled: aiFoundryEnabled
    apimEnabled: apimEnabled
    aiSearchEnabled: aiSearchEnabled
    vpnGatewayEnabled: vpnGatewayEnabled
    appGatewayEnabled: appGatewayEnabled
    frontDoorEnabled: frontDoorEnabled
  }
}

// =====================================================================
// Data Landing Zone resource groups (created here so DLZ modules can target them)
// =====================================================================

resource singleDlzRg 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deploymentMode == 'single-sub') {
  name: 'rg-csa-loom-dlz-single-${location}'
  location: location
  tags: complianceTags
}

// =====================================================================
// Data Landing Zone(s)
//
// Single-sub mode: 1 DLZ in same sub as Admin Plane
// Multi-sub mode:  per-DLZ subs, one module per element of dlzSubscriptionIds
// =====================================================================

// Single-sub: 1 DLZ in same sub
module singleDlz 'modules/landing-zone/main.bicep' = if (deploymentMode == 'single-sub') {
  name: 'dlz-single'
  scope: singleDlzRg
  params: {
    location: location
    boundary: boundary
    domainName: 'default'
    containerPlatform: containerPlatform
    capacitySku: capacitySku
    adminPlaneHubVnetId: adminPlane.outputs.hubVnetId
    adminPlaneLawId: adminPlane.outputs.lawId
    adminPlaneAppInsightsConnectionString: adminPlane.outputs.appInsightsConnectionString
    adminPlanePrivateDnsZoneIds: adminPlane.outputs.privateDnsZoneIds
    adminPlaneAdxClusterRgName: adminPlaneRgName
    adxEnabled: adxEnabled
    adminEntraGroupId: adminEntraGroupId
    activatorPrincipalId: adminPlane.outputs.uamiActivatorPrincipalId
    catalogEndpoint: adminPlane.outputs.catalogEndpoint
    databricksUnityCatalogEnabled: databricksUnityCatalogEnabled
    databricksSqlWarehouseEnabled: databricksSqlWarehouseEnabled
    storageRequireCmk: storageRequireCmk
    powerBiSku: powerBiSku
    complianceTags: complianceTags
  }
}

// Multi-sub: per-DLZ in separate subs
// NOTE: caller is responsible for creating the per-DLZ RGs in the
// target subs before this deployment runs (typically via a bootstrap
// PowerShell or az CLI script — see scripts/csa-loom/bootstrap-dlz-rgs.sh).
@batchSize(1)
module dlz 'modules/landing-zone/main.bicep' = [for (subId, i) in dlzSubscriptionIds: if (deploymentMode == 'multi-sub') {
  name: 'dlz-${i}'
  scope: resourceGroup(subId, 'rg-csa-loom-dlz-${dlzDomainNames[i]}-${location}')
  params: {
    location: location
    boundary: boundary
    domainName: dlzDomainNames[i]
    containerPlatform: containerPlatform
    capacitySku: capacitySku
    adminPlaneHubVnetId: adminPlane.outputs.hubVnetId
    adminPlaneLawId: adminPlane.outputs.lawId
    adminPlaneAppInsightsConnectionString: adminPlane.outputs.appInsightsConnectionString
    adminPlanePrivateDnsZoneIds: adminPlane.outputs.privateDnsZoneIds
    adminPlaneAdxClusterRgName: adminPlaneRgName
    adxEnabled: adxEnabled
    adminEntraGroupId: adminEntraGroupId
    activatorPrincipalId: adminPlane.outputs.uamiActivatorPrincipalId
    catalogEndpoint: adminPlane.outputs.catalogEndpoint
    databricksUnityCatalogEnabled: databricksUnityCatalogEnabled
    databricksSqlWarehouseEnabled: databricksSqlWarehouseEnabled
    storageRequireCmk: storageRequireCmk
    powerBiSku: powerBiSku
    complianceTags: complianceTags
  }
}]

// =====================================================================
// Outputs
// =====================================================================

output consoleUrl string = adminPlane.outputs.consoleUrl
output mcpServerUrl string = adminPlane.outputs.mcpServerUrl
output adminPlaneHubVnetId string = adminPlane.outputs.hubVnetId
output adminPlaneRgName string = adminPlaneRgName

// Access-pattern outputs (empty unless their flag is on)
output vpnGatewayPublicIp string = adminPlane.outputs.vpnGatewayPublicIp
output appGatewayPublicFqdn string = adminPlane.outputs.appGatewayPublicFqdn
output frontDoorPublicUrl string = adminPlane.outputs.frontDoorPublicUrl
