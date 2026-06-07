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

@description('Purview account name (short, NOT full URL) to wire into the Loom Console. When empty, /admin/security Purview tab returns 503 with a structured remediation hint. Set this to an EXISTING Purview account name in the tenant — only one Enterprise-tier Purview is allowed per tenant, so most deployments REUSE the tenant-level account rather than provisioning a second one (which fails with `EnterpriseTenantAlreadyExists`).')
param loomPurviewAccount string = ''

@description('Enable Microsoft Information Protection reads via Microsoft Graph for the Console (sensitivity labels + label policies + apply-label evaluation). Requires the Console UAMI to be admin-consented for InformationProtectionPolicy.Read.All + SensitivityLabel.Evaluate. Defaults off — the bootstrap workflow flips the AppRoles, then operators re-deploy with this true.')
param loomMipEnabled bool = false

@description('Enable Purview DLP reads via Microsoft Graph for the Console (DLP policies + rules + alerts + simulate). Requires Console UAMI Policy.Read.All + SecurityAlert.Read.All admin-consented. Note: the DLP /beta endpoints are tenant-preview-gated — the Loom panel surfaces a precise 404→501 hint when the tenant has not opted into the Graph DLP preview.')
param loomDlpEnabled bool = false

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

@description('Entra group object ID whose members bootstrap the Loom Feature-Permissions admin (bypass the gate before any grants exist). Passed to the admin plane → LOOM_TENANT_ADMIN_GROUP_ID.')
param loomTenantAdminGroupId string = ''

@description('Entra user object ID that bootstraps the Loom Feature-Permissions admin (single-user bootstrap). Passed to the admin plane → LOOM_TENANT_ADMIN_OID.')
param loomTenantAdminOid string = ''

@description('Hub VNet CIDR')
param hubVnetCidr string = '10.0.0.0/16'

@description('Compliance tags applied to every resource')
param complianceTags object

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Deploy Loom apps (Container Apps for Console/MCP/etc.). Requires container images in ACR — set false on initial provision, then true after CI image-build pipeline runs (PRP-16).')
param deployAppsEnabled bool = false

@description('Deploy AI Foundry Hub. Requires storage-account strategy; default off.')
param aiFoundryEnabled bool = false

@description('Deploy the dedicated AI Foundry Agent Service account (aifndry-loom-<location>) with the loom-agents project + chat/embedding model deployments. Backs LOOM_FOUNDRY_PROJECT_ENDPOINT + LOOM_AOAI_* so AI Functions, Copilot, and data-agent test-chat work out of the box. Independent of aiFoundryEnabled.')
param agentFoundryEnabled bool = false

@description('Resource group of the AML workspace for MLflow experiment tracking (ml-experiment "Runs & metrics" tab). Empty → falls back to LOOM_FOUNDRY_RG.')
param loomAmlRg string = ''

@description('Deploy APIM. Premium V2 takes 30+ min; default off for fast iteration.')
param apimEnabled bool = false

@description('Deploy AI Search. Default off — capacity in eastus2 is intermittent.')
param aiSearchEnabled bool = false

@description('Deploy ADX shared cluster (admin-plane) + per-DLZ ADX databases. Backs the RTI editor family — Eventhouse, KQL Database, KQL Queryset, KQL Dashboard, Eventstream. Default on as of 2026-05-27 (sweep-rti). Set false to skip ~$140/mo Dev SKU cluster.')
param adxEnabled bool = true

// ---------- Bring-your-own existing services (reuse instead of provision-new) ----------
// Set any of these (via params/<boundary>.bicepparam readEnvironmentVariable('EXISTING_*',''))
// to reuse an EXISTING resource in any RG/sub instead of provisioning a new one.
// Empty → provision new per the matching *Enabled flag. See docs/fiab/bring-your-own-services.md.
@description('Reuse an existing AI Search service (name) instead of provisioning one.')
param existingAiSearchService string = ''
@description('Resource group of the existing AI Search service.')
param existingAiSearchRg string = ''
@description('Reuse an existing APIM service (name) instead of provisioning one.')
param existingApimName string = ''
@description('Resource group of the existing APIM service.')
param existingApimRg string = ''
@description('Reuse an existing ADX/Kusto cluster (name) instead of provisioning one.')
param existingAdxClusterName string = ''
@description('Resource group of the existing ADX cluster.')
param existingAdxClusterRg string = ''
@description('Reuse an existing AI Foundry / AOAI (AIServices) account (name) instead of provisioning the Foundry hub.')
param existingFoundryAccountName string = ''
@description('Resource group of the existing Foundry/AOAI account.')
param existingFoundryRg string = ''

// ---------- Deploy-planner service toggles ----------
// Each flag wires a self-contained module under modules/deploy-planner/** that
// provisions a REAL Azure resource (secure-by-default: Entra-only auth where
// supported, public blob disabled, TLS 1.2). The deploy-planner catalog
// (apps/fiab-console/lib/components/deploy-planner/service-catalog.ts) maps its
// tiles to these flags so the visual plan and `az deployment sub create` stay
// in sync. All default false — opt-in per plan. Modules deploy into the DLZ RG
// (single-sub) so they sit alongside the lake + Cosmos data plane.

@description('Deploy an Azure Database for PostgreSQL Flexible Server (Entra-only auth) + starter DB.')
param postgresEnabled bool = false

@description('Deploy an Azure Database for MySQL Flexible Server + starter DB.')
param mysqlEnabled bool = false

@description('Deploy an Azure Cache for Redis (Basic C0, Entra auth enabled).')
param redisEnabled bool = false

@description('Deploy an Azure Event Grid custom topic (local-auth disabled).')
param eventGridEnabled bool = false

@description('Deploy an Azure Service Bus namespace (Standard, SAS disabled) + starter queue/topic.')
param serviceBusEnabled bool = false

@description('Deploy an Azure SignalR Service (Standard_S1, AAD-only).')
param signalrEnabled bool = false

@description('Deploy a Storage Queues account (StorageV2, shared-key disabled) + starter queue.')
param storageQueuesEnabled bool = false

@description('Deploy a multi-service Azure AI Services (Cognitive Services) account (Entra-only).')
param aiServicesEnabled bool = false

@description('Deploy a Document Intelligence (FormRecognizer) account (Entra-only).')
param documentIntelligenceEnabled bool = false

@description('Deploy a Content Safety account (Entra-only).')
param contentSafetyEnabled bool = false

@description('Deploy an Azure App Service (Linux B1 plan + web app, HTTPS-only).')
param appServiceEnabled bool = false

@description('Deploy an Azure Functions app (Consumption Linux plan + backing storage).')
param functionsEnabled bool = false

@description('Deploy an Azure Container Instances group (sample image, start/stop-able).')
param containerInstancesEnabled bool = false

@description('Deploy an Azure Stream Analytics job (Standard, created Stopped).')
param streamAnalyticsEnabled bool = false

@description('Deploy an Azure Data Factory (v2) for the ADF editors.')
param dataFactoryEnabled bool = false

@description('Deploy a Linux Virtual Machine (isolated VNet/subnet + NIC, NO public IP, SSH-key auth).')
param vmEnabled bool = false

@description('SSH public key (OpenSSH) for the deploy-planner VM admin user. Required to actually boot the VM; password auth is disabled.')
@secure()
param vmAdminSshPublicKey string = ''

@description('Deploy an Azure Batch account (BatchService mode) + backing auto-storage (managed-identity auth).')
param batchEnabled bool = false

@description('Deploy a Consumption Logic App (empty editable workflow).')
param logicAppsEnabled bool = false

@description('Deploy an Azure Static Web App (standalone, no repo link).')
param staticWebAppsEnabled bool = false

@description('Deploy an Azure CDN profile (Standard Microsoft).')
param cdnEnabled bool = false

@description('Deploy an internal Standard Load Balancer (isolated VNet/subnet + frontend/pool/probe/rule).')
param loadBalancerEnabled bool = false

@description('Deploy an Azure Firewall (Standard AZFW_VNet) in its own VNet with AzureFirewallSubnet + static public IP.')
param firewallEnabled bool = false

@description('Deploy a single-kind Computer Vision (CognitiveServices ComputerVision) account, Entra-only.')
param visionServicesEnabled bool = false

@description('Deploy a single-kind Speech Services (CognitiveServices SpeechServices) account, Entra-only.')
param speechServicesEnabled bool = false

@description('Deploy a single-kind Language (CognitiveServices TextAnalytics) account, Entra-only.')
param languageServicesEnabled bool = false

@description('Deploy an Azure Machine Learning workspace + its KV/Storage/AppInsights dependencies.')
param mlWorkspaceEnabled bool = false

@description('Enable Microsoft Defender for Cloud Standard pricing tiers on the subscription.')
param defenderCloudEnabled bool = false

@description('Assign a sample built-in audit policy at the subscription scope (Azure Policy navigator).')
param policyEnabled bool = false

// ---------- User access patterns ----------

@description('Deploy a P2S VPN Gateway (AAD-auth, OpenVPN) in the hub VNet. ~30 min provisioning, ~$30/mo. Default off.')
param vpnGatewayEnabled bool = false

@description('Deploy Application Gateway v2 + WAF in front of the Console. ~15 min provisioning, ~$250/mo. Default off.')
param appGatewayEnabled bool = false

@description('Deploy Front Door Premium with Private Link to the ACA env. ~5 min provisioning + manual PE approval, ~$330/mo. Default off.')
param frontDoorEnabled bool = false

@description('Optional vanity URL for the console (e.g. csa-loom.contoso.ai) — set in the Setup Wizard. Creates a Front Door managed-cert custom domain; the deploy outputs the CNAME + _dnsauth TXT to add at your DNS provider. Empty = use the generated Front Door host.')
param loomVanityDomain string = ''

// Standalone Azure ML workspace coordinates for the AML control-plane
// navigator (aml-client.ts / resolveAmlTarget). All optional — empty values
// fall back to the AI Foundry hub env (LOOM_FOUNDRY_*) + the deployment
// subscription in the resolver, so existing deployments are unaffected.
@description('AML workspace name for the standalone AML client (LOOM_AML_WORKSPACE). Empty falls back to the AI Foundry hub name.')
param loomAmlWorkspace string = ''

@description('Resource group of the AML workspace (LOOM_AML_RESOURCE_GROUP). Empty falls back to LOOM_FOUNDRY_RG.')
param loomAmlResourceGroup string = ''

@description('Subscription id of the AML workspace (LOOM_AML_SUBSCRIPTION). Empty falls back to the deployment subscription.')
param loomAmlSubscription string = ''

@description('Primary region of the AML workspace (LOOM_AML_REGION). Empty falls back to the deployment location.')
param loomAmlRegion string = ''

@description('Entra app client ID for Loom Console MSAL. When empty, Console runs unauth.')
param loomMsalClientId string = ''

@description('Entra app client secret for Loom Console MSAL. Stored in Container App secret store.')
@secure()
param loomMsalClientSecret string = ''

@description('Session cookie secret (HKDF input). Empty → admin-plane derives a stable per-RG GUID so sign-ins survive redeploys; set LOOM_SESSION_SECRET for a tenant-managed secret.')
@secure()
param loomSessionSecret string = ''

@description('Local admin password for the scaled self-hosted IR (SHIR) VMSS nodes in each DLZ. Empty → the SHIR is NOT deployed (honest gate); supply a Key-Vault-backed secret to enable the 4-node scale-to-0 self-hosted IR. No password is ever embedded/generated in the template.')
@secure()
param shirAdminPassword string = ''

@description('Loom version label shown in the UI + on /api/version.')
param loomVersion string = 'v0.1'

@description('Container image tag per app (overridable per release).')
param appImageTags object = {
  console: 'v0.1'
  mcp: 'v0.1'
  orchestrator: 'v0.1'
  activator: 'v0.1'
  mirroring: 'v0.1'
  directLake: 'v0.1'
}

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
    databricksUnityCatalogEnabled: databricksUnityCatalogEnabled
    openaiLocation: openaiLocation
    openaiEmbeddingsLocation: openaiEmbeddingsLocation
    openaiChatModel: openaiChatModel
    openaiEmbeddingsModel: openaiEmbeddingsModel
    keyVaultHsmIsolated: keyVaultHsmIsolated
    adminEntraGroupId: adminEntraGroupId
    loomTenantAdminGroupId: loomTenantAdminGroupId
    loomTenantAdminOid: loomTenantAdminOid
    hubVnetCidr: hubVnetCidr
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    deployAppsEnabled: deployAppsEnabled
    aiFoundryEnabled: aiFoundryEnabled
    agentFoundryEnabled: agentFoundryEnabled
    loomAmlRg: loomAmlRg
    apimEnabled: apimEnabled
    aiSearchEnabled: aiSearchEnabled
    adxEnabled: adxEnabled
    existingAiSearchService: existingAiSearchService
    existingAiSearchRg: existingAiSearchRg
    existingApimName: existingApimName
    existingApimRg: existingApimRg
    existingAdxClusterName: existingAdxClusterName
    existingAdxClusterRg: existingAdxClusterRg
    existingFoundryAccountName: existingFoundryAccountName
    existingFoundryRg: existingFoundryRg
    vpnGatewayEnabled: vpnGatewayEnabled
    appGatewayEnabled: appGatewayEnabled
    frontDoorEnabled: frontDoorEnabled
    loomVanityDomain: loomVanityDomain
    loomStorageAccount: take('saloomdefault${uniqueString(singleDlzRg.id)}', 24)
    loomCosmosAccount: take('cosmos-loom-default-${uniqueString(singleDlzRg.id)}', 44)
    // Forward the Cosmos data-plane endpoints to the console so the vector-store
    // and graph editors bind to the deployed account by default (no manual
    // config). Vector search runs on the NoSQL document endpoint; the Gremlin
    // editor honest-gates because the default account is NoSQL-only (set this
    // when a Gremlin-capable Cosmos account is deployed — see full-deployment-and-byo).
    loomCosmosVectorEndpoint: 'https://${take('cosmos-loom-default-${uniqueString(singleDlzRg.id)}', 44)}.documents.azure.com:443/'
    loomCosmosGremlinEndpoint: ''
    loomPurviewAccount: loomPurviewAccount
    loomMipEnabled: loomMipEnabled
    loomDlpEnabled: loomDlpEnabled
    loomMsalClientId: loomMsalClientId
    loomMsalClientSecret: loomMsalClientSecret
    loomSessionSecret: loomSessionSecret
    loomVersion: loomVersion
    appImageTags: appImageTags
    // Standalone AML workspace coords for the AML control-plane navigator.
    loomAmlWorkspace: loomAmlWorkspace
    loomAmlResourceGroup: loomAmlResourceGroup
    loomAmlSubscription: loomAmlSubscription
    loomAmlRegion: loomAmlRegion
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
    adxClusterPrincipalId: adminPlane.outputs.adxClusterPrincipalId
    adminEntraGroupId: adminEntraGroupId
    activatorPrincipalId: adminPlane.outputs.uamiActivatorPrincipalId
    consolePrincipalId: adminPlane.outputs.uamiConsolePrincipalId
    consoleUamiName: adminPlane.outputs.uamiConsoleName
    synapseSqlPrivateDnsZoneId: adminPlane.outputs.privateDnsZoneIds.synapseSql
    adfPrivateDnsZoneId: adminPlane.outputs.privateDnsZoneIds.adf
    catalogEndpoint: adminPlane.outputs.catalogEndpoint
    databricksUnityCatalogEnabled: databricksUnityCatalogEnabled
    databricksSqlWarehouseEnabled: databricksSqlWarehouseEnabled
    storageRequireCmk: storageRequireCmk
    powerBiSku: powerBiSku
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    shirAdminPassword: shirAdminPassword
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
    adxClusterPrincipalId: adminPlane.outputs.adxClusterPrincipalId
    adminEntraGroupId: adminEntraGroupId
    activatorPrincipalId: adminPlane.outputs.uamiActivatorPrincipalId
    consolePrincipalId: adminPlane.outputs.uamiConsolePrincipalId
    consoleUamiName: adminPlane.outputs.uamiConsoleName
    synapseSqlPrivateDnsZoneId: adminPlane.outputs.privateDnsZoneIds.synapseSql
    adfPrivateDnsZoneId: adminPlane.outputs.privateDnsZoneIds.adf
    catalogEndpoint: adminPlane.outputs.catalogEndpoint
    databricksUnityCatalogEnabled: databricksUnityCatalogEnabled
    databricksSqlWarehouseEnabled: databricksSqlWarehouseEnabled
    storageRequireCmk: storageRequireCmk
    powerBiSku: powerBiSku
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    shirAdminPassword: shirAdminPassword
  }
}]

// =====================================================================
// Deploy-planner service toggles (single-sub mode) — each provisions a
// real, self-contained Azure resource into the DLZ RG when its flag is on.
// consolePrincipalId wires the Loom Console UAMI so the matching navigator
// /editor can drive the resource over Entra-only data/control planes.
// =====================================================================

var dpConsolePrincipalId = adminPlane.outputs.uamiConsolePrincipalId

module dpPostgres 'modules/deploy-planner/postgres.bicep' = if (deploymentMode == 'single-sub' && postgresEnabled) {
  name: 'dp-postgres'
  scope: singleDlzRg
  params: {
    location: location
    entraAdminObjectId: dpConsolePrincipalId
    entraAdminName: adminPlane.outputs.uamiConsoleName
    complianceTags: complianceTags
  }
}

module dpMysql 'modules/deploy-planner/mysql.bicep' = if (deploymentMode == 'single-sub' && mysqlEnabled) {
  name: 'dp-mysql'
  scope: singleDlzRg
  params: {
    location: location
    entraAdminObjectId: dpConsolePrincipalId
    entraAdminName: adminPlane.outputs.uamiConsoleName
    complianceTags: complianceTags
  }
}

module dpRedis 'modules/deploy-planner/redis.bicep' = if (deploymentMode == 'single-sub' && redisEnabled) {
  name: 'dp-redis'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    complianceTags: complianceTags
  }
}

module dpEventGrid 'modules/deploy-planner/event-grid.bicep' = if (deploymentMode == 'single-sub' && eventGridEnabled) {
  name: 'dp-eventgrid'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpServiceBus 'modules/deploy-planner/service-bus.bicep' = if (deploymentMode == 'single-sub' && serviceBusEnabled) {
  name: 'dp-servicebus'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpSignalr 'modules/deploy-planner/signalr.bicep' = if (deploymentMode == 'single-sub' && signalrEnabled) {
  name: 'dp-signalr'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpStorageQueues 'modules/deploy-planner/storage-queues.bicep' = if (deploymentMode == 'single-sub' && storageQueuesEnabled) {
  name: 'dp-storagequeues'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpAiServices 'modules/deploy-planner/cognitive-account.bicep' = if (deploymentMode == 'single-sub' && aiServicesEnabled) {
  name: 'dp-aiservices'
  scope: singleDlzRg
  params: {
    location: location
    kind: 'CognitiveServices'
    nameFragment: 'aiservices'
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpDocIntel 'modules/deploy-planner/cognitive-account.bicep' = if (deploymentMode == 'single-sub' && documentIntelligenceEnabled) {
  name: 'dp-docintel'
  scope: singleDlzRg
  params: {
    location: location
    kind: 'FormRecognizer'
    nameFragment: 'docintel'
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpContentSafety 'modules/deploy-planner/cognitive-account.bicep' = if (deploymentMode == 'single-sub' && contentSafetyEnabled) {
  name: 'dp-contentsafety'
  scope: singleDlzRg
  params: {
    location: location
    kind: 'ContentSafety'
    nameFragment: 'contentsafety'
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpAppService 'modules/deploy-planner/app-service.bicep' = if (deploymentMode == 'single-sub' && appServiceEnabled) {
  name: 'dp-appservice'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpFunctions 'modules/deploy-planner/functions.bicep' = if (deploymentMode == 'single-sub' && functionsEnabled) {
  name: 'dp-functions'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpContainerInstances 'modules/deploy-planner/container-instances.bicep' = if (deploymentMode == 'single-sub' && containerInstancesEnabled) {
  name: 'dp-aci'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpStreamAnalytics 'modules/deploy-planner/stream-analytics.bicep' = if (deploymentMode == 'single-sub' && streamAnalyticsEnabled) {
  name: 'dp-streamanalytics'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpDataFactory 'modules/deploy-planner/data-factory.bicep' = if (deploymentMode == 'single-sub' && dataFactoryEnabled) {
  name: 'dp-datafactory'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpVm 'modules/deploy-planner/virtual-machine.bicep' = if (deploymentMode == 'single-sub' && vmEnabled) {
  name: 'dp-vm'
  scope: singleDlzRg
  params: {
    location: location
    adminSshPublicKey: vmAdminSshPublicKey
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpBatch 'modules/deploy-planner/batch.bicep' = if (deploymentMode == 'single-sub' && batchEnabled) {
  name: 'dp-batch'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpLogicApps 'modules/deploy-planner/logic-app.bicep' = if (deploymentMode == 'single-sub' && logicAppsEnabled) {
  name: 'dp-logicapps'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpStaticWebApps 'modules/deploy-planner/static-web-app.bicep' = if (deploymentMode == 'single-sub' && staticWebAppsEnabled) {
  name: 'dp-staticwebapps'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpCdn 'modules/deploy-planner/cdn.bicep' = if (deploymentMode == 'single-sub' && cdnEnabled) {
  name: 'dp-cdn'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpLoadBalancer 'modules/deploy-planner/load-balancer.bicep' = if (deploymentMode == 'single-sub' && loadBalancerEnabled) {
  name: 'dp-loadbalancer'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpFirewall 'modules/deploy-planner/firewall.bicep' = if (deploymentMode == 'single-sub' && firewallEnabled) {
  name: 'dp-firewall'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpVision 'modules/deploy-planner/cognitive-account.bicep' = if (deploymentMode == 'single-sub' && visionServicesEnabled) {
  name: 'dp-vision'
  scope: singleDlzRg
  params: {
    location: location
    kind: 'ComputerVision'
    nameFragment: 'vision'
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpSpeech 'modules/deploy-planner/cognitive-account.bicep' = if (deploymentMode == 'single-sub' && speechServicesEnabled) {
  name: 'dp-speech'
  scope: singleDlzRg
  params: {
    location: location
    kind: 'SpeechServices'
    nameFragment: 'speech'
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpLanguage 'modules/deploy-planner/cognitive-account.bicep' = if (deploymentMode == 'single-sub' && languageServicesEnabled) {
  name: 'dp-language'
  scope: singleDlzRg
  params: {
    location: location
    kind: 'TextAnalytics'
    nameFragment: 'language'
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpMlWorkspace 'modules/deploy-planner/ml-workspace.bicep' = if (deploymentMode == 'single-sub' && mlWorkspaceEnabled) {
  name: 'dp-mlworkspace'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

// Subscription-scoped deploy-planner toggles. Defender pricings + Azure Policy
// assignments are subscription resources, so these modules deploy at sub scope.
module dpDefenderCloud 'modules/deploy-planner/defender-cloud.bicep' = if (deploymentMode == 'single-sub' && defenderCloudEnabled) {
  name: 'dp-defendercloud'
  scope: subscription()
}

module dpPolicy 'modules/deploy-planner/policy-assignment.bicep' = if (deploymentMode == 'single-sub' && policyEnabled) {
  name: 'dp-policy'
  scope: subscription()
}

// Console UAMI → Monitoring Reader at subscription scope, so the /monitor tabs
// (metrics / activity / health / alerts) and the Activator run-history grid
// (Microsoft.AlertsManagement/alerts) read live control-plane observability.
module consoleMonitoringReaderRbac 'modules/admin-plane/monitoring-reader-rbac.bicep' = {
  name: 'console-monitoring-reader'
  scope: subscription()
  params: {
    consolePrincipalId: adminPlane.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// =====================================================================
// RTI hub cross-subscription discovery — Reader at SUBSCRIPTION scope.
//
// The Real-Time Intelligence hub catalog (/rti-hub -> GET /api/rti-hub) lists
// every Event Hub namespace, IoT Hub, and ADX cluster the Console UAMI can see
// via Azure Resource Graph. Resource Graph honors RBAC: rows are returned only
// for scopes where the principal has at least Reader. The UAMI's other grants
// are resource-group-scoped, so without a subscription-scoped Reader the graph
// query returns [] and the hub appears empty. Reader is read-only — the
// least-privilege grant that makes cross-RG discovery work.
//
// Split into its own subscription-scoped module so consolePrincipalId arrives
// as a plain start-time param (avoids BCP177/BCP120 on the roleAssignment
// name/if — same pattern as admin-plane/scaling-rbac.bicep).
// =====================================================================
module rtiHubRbac 'modules/admin-plane/rti-hub-rbac.bicep' = {
  name: 'rti-hub-rbac'
  scope: subscription()
  params: {
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

output dlzSynapseWorkspaceName string = deploymentMode == 'single-sub' ? singleDlz.outputs.synapseWorkspaceName : ''
output dlzSynapseDedicatedPoolName string = deploymentMode == 'single-sub' ? singleDlz.outputs.synapseDedicatedPoolName : ''
output dlzResourceGroupName string = deploymentMode == 'single-sub' ? singleDlz.outputs.dlzResourceGroupName : ''
output dlzStorageAccountName string = deploymentMode == 'single-sub' ? singleDlz.outputs.storageAccountName : ''

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
// Vanity URL + the DNS records the admin must add to activate it.
output vanityPublicUrl string = adminPlane.outputs.vanityPublicUrl
output vanityCnameTarget string = adminPlane.outputs.vanityCnameTarget
output vanityDnsTxtName string = adminPlane.outputs.vanityDnsTxtName
output vanityValidationToken string = adminPlane.outputs.vanityValidationToken
