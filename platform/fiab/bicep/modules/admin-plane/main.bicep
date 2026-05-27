// CSA Loom — Admin Plane orchestrator
// Deployment scope: resource group (rg-csa-loom-admin-<region>)

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Cloud boundary (Commercial / GCC / GCC-High / IL5)')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Container platform — containerApps or aks')
@allowed(['containerApps', 'aks'])
param containerPlatform string

@description('Functions host SKU. Reserved for v3.x — declared so the orchestrator contract is stable while the Functions host wiring is deferred.')
#disable-next-line no-unused-params
param functionsHostSku string

@description('APIM SKU')
param apimSku string

@description('Catalog primary')
param catalogPrimary string

@description('Agent orchestrator')
param agentOrchestrator string

@description('Capacity SKU. Reserved for v3.x — Fabric/Power BI capacity sizing parameter; wired downstream once landing-zone capacity module lands.')
#disable-next-line no-unused-params
param capacitySku string

@description('Foundry portal enabled')
param foundryPortalEnabled bool

@description('Defender for Cloud AI Threat Protection enabled')
param defenderForAIEnabled bool

@description('Purview Data Map enabled')
param purviewEnabled bool

@description('Atlas on AKS enabled (IL5 only)')
param atlasOnAksEnabled bool

@description('OpenAI region for chat. Reserved for v3.x — multi-region OpenAI deployment wiring (per-model regional pinning) is deferred.')
#disable-next-line no-unused-params
param openaiLocation string

@description('OpenAI region for embeddings. Reserved for v3.x — see openaiLocation note above.')
#disable-next-line no-unused-params
param openaiEmbeddingsLocation string

@description('OpenAI chat model. Reserved for v3.x — explicit deployment-name pinning is handled inside ai-foundry.bicep today.')
#disable-next-line no-unused-params
param openaiChatModel string

@description('OpenAI embeddings model. Reserved for v3.x — see openaiChatModel note above.')
#disable-next-line no-unused-params
param openaiEmbeddingsModel string

@description('Key Vault Premium HSM isolated (IL5)')
param keyVaultHsmIsolated bool

@description('Admin Entra group object ID')
param adminEntraGroupId string

@description('Hub VNet CIDR')
param hubVnetCidr string

@description('Compliance tags')
param complianceTags object

@description('Deploy the Loom apps (Console, MCP, Orchestrator, Copilot, Activator, Mirroring, Direct-Lake Shim). Requires the container images to exist in ACR first — set false on initial provision, then true after images are built + pushed (PRP-16).')
param deployAppsEnabled bool = false

@description('Deploy AI Foundry Hub. Requires explicit storage-account strategy; default off so initial provision succeeds before operator picks Hub strategy.')
param aiFoundryEnabled bool = false

@description('Deploy APIM. Premium V2 takes 30+ min; default off so initial provision iterates quickly.')
param apimEnabled bool = false

@description('Deploy AI Search. Capacity in certain regions is intermittent; default off so first deploy succeeds even when AI Search SKUs are over-subscribed.')
param aiSearchEnabled bool = false

@description('Deploy shared ADX cluster in the admin plane. Each DLZ then attaches its own database to this single cluster.')
param adxEnabled bool = false

@description('ADX cluster SKU. Dev SKU is ~$140/mo.')
param adxSkuName string = 'Dev(No SLA)_Standard_E2a_v4'

// ---------- User access patterns (Bastion is always-on; these add reach) ----------

@description('Deploy a P2S VPN Gateway in the hub VNet (AAD auth, OpenVPN). ~30 min provisioning, ~$30/mo. Lets admin laptops reach the internal Console without Bastion. Default off — set true when ready.')
param vpnGatewayEnabled bool = false

@description('Deploy Application Gateway v2 + WAF v2 in front of the Console (public IP, in-VNet backend). ~15 min provisioning, ~$250/mo. Default off.')
param appGatewayEnabled bool = false

@description('Front Door Premium with a Private Link tunnel to the ACA env (global edge, managed cert, WAF). ~5 min provisioning, ~$330/mo. PE approval required after first deploy. Default off.')
param frontDoorEnabled bool = false

// ---------- Container image tags + Loom Console env-var wiring ----------

@description('Container image tag per app (loom-console, loom-mcp, loom-orchestrator, loom-activator, loom-mirroring, loom-direct-lake-shim). Default v0.1; override per release.')
param appImageTags object = {
  console: 'v0.1'
  mcp: 'v0.1'
  orchestrator: 'v0.1'
  activator: 'v0.1'
  mirroring: 'v0.1'
  directLake: 'v0.1'
}

@description('Loom version label shown in the UI (matches console image tag by convention).')
param loomVersion string = 'v0.1'

@description('Loom Synapse workspace name (for env-var wiring on loom-console). Default uses the single-sub DLZ convention.')
param loomSynapseWorkspace string = 'syn-loom-default-${location}'

@description('Loom Synapse Dedicated SQL pool name.')
param loomSynapseDedicatedPool string = 'loompool'

@description('Loom Azure Data Factory name (for env-var wiring on loom-console — backs the ADF Pipeline/Dataset/Trigger editors).')
param loomAdfName string = 'adf-loom-default-${location}'

@description('Loom DLZ resource group (for ARM REST pause/resume from the Console BFF).')
param loomDlzRg string = 'rg-csa-loom-dlz-single-${location}'

@description('Loom Storage account name (for ADLS Gen2 lake URLs). When empty, env vars omitted and the Lakehouse editor surfaces a config message.')
param loomStorageAccount string = ''

@description('Loom Cosmos account name. When empty, Cosmos env vars omitted.')
param loomCosmosAccount string = ''

@description('Azure AD tenant ID for MSAL on the Console.')
param loomMsalTenantId string = subscription().tenantId

@description('Azure AD app (client) ID of the Entra app registration backing MSAL. When empty, MSAL env vars omitted (Console runs unauth).')
param loomMsalClientId string = ''

@description('Azure AD app client secret stored in Key Vault as secret "loom-msal-client-secret". When empty, MSAL env vars omitted.')
@secure()
param loomMsalClientSecret string = ''

@description('Session cookie secret (HKDF input). Stored in Key Vault as "loom-session-secret". When empty, a fresh GUID is generated PER DEPLOY — this invalidates all existing sessions. Pass a stable value via env var to preserve sign-ins across deploys.')
@secure()
param loomSessionSecret string = newGuid()

// =====================================================================
// 1. Monitoring (LAW + AppInsights + Sentinel + AI rules) — FIRST
// because every other module wires diagnostic settings to it.
// =====================================================================

module monitoring 'monitoring.bicep' = {
  name: 'monitoring'
  params: {
    location: location
    defenderForAIEnabled: defenderForAIEnabled
    complianceTags: complianceTags
  }
}

// =====================================================================
// 2. Network foundation
// =====================================================================

module network 'network.bicep' = {
  name: 'network'
  params: {
    location: location
    hubVnetCidr: hubVnetCidr
    boundary: boundary
    containerPlatform: containerPlatform
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 3. Managed identities
// =====================================================================

module identity 'identity.bicep' = {
  name: 'identity'
  params: {
    location: location
    complianceTags: complianceTags
  }
}

// =====================================================================
// 4. Key Vault Premium (+ HSM if IL5)
// =====================================================================

module keyvault 'keyvault.bicep' = {
  name: 'keyvault'
  params: {
    location: location
    hsmIsolated: keyVaultHsmIsolated
    adminEntraGroupId: adminEntraGroupId
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    privateDnsZoneVaultId: network.outputs.privateDnsZoneIds.keyvault
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 5. Container registry
// =====================================================================

module registry 'registry.bicep' = {
  name: 'registry'
  params: {
    location: location
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    privateDnsZoneAcrId: network.outputs.privateDnsZoneIds.acr
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 6. Container platform (Container Apps Env OR AKS)
// =====================================================================

module containerPlatformModule 'container-platform.bicep' = {
  name: 'container-platform'
  params: {
    location: location
    containerPlatform: containerPlatform
    containerSubnetId: network.outputs.containerPlatformSubnetId
    lawId: monitoring.outputs.lawId
    lawCustomerId: monitoring.outputs.lawCustomerId
    lawSharedKey: monitoring.outputs.lawSharedKey
    complianceTags: complianceTags
  }
}

// =====================================================================
// 7. AI Search
// =====================================================================

module aiSearch 'ai-search.bicep' = if (aiSearchEnabled) {
  name: 'ai-search'
  params: {
    location: location
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    privateDnsZoneSearchId: network.outputs.privateDnsZoneIds.search
    workspaceId: monitoring.outputs.lawId
    adminEntraGroupId: adminEntraGroupId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 8. AI Foundry Hub (or Azure ML classic in boundaries without Foundry)
// =====================================================================

// Storage account for the AI Foundry Hub workspace (required dependency).
// Plain LRS Standard_v2, geo-redundancy off (matches DLZ policy), public
// network disabled, only the Foundry MI gets access via system role assignment.
resource foundryHubStorage 'Microsoft.Storage/storageAccounts@2024-01-01' = if (aiFoundryEnabled) {
  name: take('safoundryhub${uniqueString(resourceGroup().id)}', 24)
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

module aiFoundry 'ai-foundry.bicep' = if (aiFoundryEnabled) {
  name: 'ai-foundry'
  params: {
    location: location
    boundary: boundary
    foundryPortalEnabled: foundryPortalEnabled
    hubStorageAccountId: foundryHubStorage!.id
    hubKeyVaultId: keyvault.outputs.keyVaultId
    hubContainerRegistryId: registry.outputs.acrId
    hubAppInsightsId: monitoring.outputs.appInsightsId
    workspaceId: monitoring.outputs.lawId
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    privateDnsZoneAmlId: network.outputs.privateDnsZoneIds.azureml
    privateDnsZoneAmlApiId: network.outputs.privateDnsZoneIds.azuremlapi
    privateDnsZoneNotebooksId: network.outputs.privateDnsZoneIds.notebooks
    adminEntraGroupId: adminEntraGroupId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 9. APIM (Premium V2 or classic Premium per boundary)
// =====================================================================

module apim 'apim.bicep' = if (apimEnabled) {
  name: 'apim'
  params: {
    location: location
    sku: apimSku
    publisherEmail: 'csa-loom-ops@example.com'   // override in .bicepparam
    apimSubnetId: network.outputs.apimSubnetId
    appInsightsId: monitoring.outputs.appInsightsId
    appInsightsInstrumentationKey: monitoring.outputs.appInsightsInstrumentationKey
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 9b. Shared ADX cluster (admin-plane scope). DLZ databases attach here.
// =====================================================================

module adxCluster 'adx-cluster.bicep' = if (adxEnabled) {
  name: 'adx-cluster'
  params: {
    location: location
    skuName: adxSkuName
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 10. Catalog dispatcher (Purview / UC managed / Atlas-on-AKS)
// =====================================================================

module catalog 'catalog.bicep' = {
  name: 'catalog'
  params: {
    location: location
    boundary: boundary
    catalogPrimary: catalogPrimary
    purviewEnabled: purviewEnabled
    atlasOnAksEnabled: atlasOnAksEnabled
    adminEntraGroupId: adminEntraGroupId
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    aksClusterId: containerPlatform == 'aks' ? containerPlatformModule.outputs.aksId : ''
    complianceTags: complianceTags
  }
}

// =====================================================================
// 11. AI defense (Defender for AI workaround in Gov)
// =====================================================================

module aiDefense 'ai-defense.bicep' = {
  name: 'ai-defense'
  params: {
    location: location
    defenderForAIEnabled: defenderForAIEnabled
    lawId: monitoring.outputs.lawId
    lawName: monitoring.outputs.lawName
    // Key Vault reference syntax (operator stores `ops-teams-webhook`
    // secret in the Loom Key Vault). Vault name passed in directly to
    // avoid Bicep string-escape issues with the split expression.
    notificationWebhookKvRef: '@Microsoft.KeyVault(VaultName=${keyvault.outputs.keyVaultName};SecretName=ops-teams-webhook)'
    complianceTags: complianceTags
  }
}

// =====================================================================
// 12. App deployments (Console, MCP, Orchestrator, Copilot, Activator,
//                     Mirroring, Direct-Lake Shim, Presidio if Gov)
// =====================================================================

module appDeployments 'app-deployments.bicep' = if (containerPlatform == 'containerApps' && deployAppsEnabled) {
  name: 'app-deployments'
  params: {
    location: location
    containerPlatform: containerPlatform
    caeId: containerPlatformModule.outputs.caeId
    acrLoginServer: registry.outputs.acrLoginServer
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    boundary: boundary
    keyVaultUri: keyvault.outputs.keyVaultUri
    complianceTags: complianceTags
    apps: [
      {
        name: 'loom-console'
        image: 'loom-console:${appImageTags.console}'
        uamiId: identity.outputs.uamiConsoleId
        uamiClientId: identity.outputs.uamiConsoleClientId
        ingressPort: 3000
        external: true
        healthPath: '/api/health'
        tier: 'console'
        minReplicas: 2
        maxReplicas: 6
        env: concat(
          [
            { name: 'LOOM_VERSION', value: loomVersion }
            { name: 'NEXT_PUBLIC_LOOM_VERSION', value: loomVersion }
            { name: 'LOOM_SUBSCRIPTION_ID', value: subscription().subscriptionId }
            { name: 'LOOM_DLZ_RG', value: loomDlzRg }
            { name: 'LOOM_SYNAPSE_WORKSPACE', value: loomSynapseWorkspace }
            { name: 'LOOM_SYNAPSE_DEDICATED_POOL', value: loomSynapseDedicatedPool }
            { name: 'LOOM_ADF_NAME', value: loomAdfName }
            { name: 'AZURE_CLOUD', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'AzureUSGovernment' : 'AzureCloud' }
            { name: 'AZURE_TENANT_ID', value: loomMsalTenantId }
            { name: 'LOOM_COSMOS_ENDPOINT', value: !empty(loomCosmosAccount) ? 'https://${loomCosmosAccount}.documents.${environment().suffixes.storage == 'core.usgovcloudapi.net' ? 'azure.us' : 'azure.com'}:443/' : '' }
            { name: 'LOOM_COSMOS_DATABASE', value: 'loom' }
          ],
          !empty(loomStorageAccount) ? [
            { name: 'LOOM_BRONZE_URL',  value: 'https://${loomStorageAccount}.dfs.${environment().suffixes.storage}/bronze' }
            { name: 'LOOM_SILVER_URL',  value: 'https://${loomStorageAccount}.dfs.${environment().suffixes.storage}/silver' }
            { name: 'LOOM_GOLD_URL',    value: 'https://${loomStorageAccount}.dfs.${environment().suffixes.storage}/gold' }
            { name: 'LOOM_LANDING_URL', value: 'https://${loomStorageAccount}.dfs.${environment().suffixes.storage}/landing' }
          ] : [],
          !empty(loomMsalClientId) ? [
            { name: 'LOOM_MSAL_CLIENT_ID', value: loomMsalClientId }
            { name: 'LOOM_MSAL_CLIENT_SECRET', secretRef: 'loom-msal-client-secret' }
            // Back-compat alias for legacy code paths still reading AZURE_*
            { name: 'AZURE_CLIENT_SECRET', secretRef: 'loom-msal-client-secret' }
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
            { name: 'LOOM_UAMI_CLIENT_ID', value: identity.outputs.uamiConsoleClientId }
            // Dataverse auth — UAMIs can't be Dataverse Application Users
            // (Microsoft platform restriction), so re-use the MSAL Web App
            // SP credentials. The SP must be registered as a Dataverse
            // Application User with System Administrator role on every
            // env Loom should read. See docs/fiab/dataverse-app-user.md.
            { name: 'LOOM_DATAVERSE_CLIENT_ID', value: loomMsalClientId }
            { name: 'LOOM_DATAVERSE_CLIENT_SECRET', secretRef: 'loom-msal-client-secret' }
            { name: 'LOOM_DATAVERSE_TENANT_ID', value: tenant().tenantId }
          ] : [
            { name: 'LOOM_UAMI_CLIENT_ID', value: identity.outputs.uamiConsoleClientId }
          ]
        )
        secrets: !empty(loomMsalClientId) ? [
          { name: 'loom-msal-client-secret', value: loomMsalClientSecret }
          { name: 'session-secret', value: loomSessionSecret }
        ] : []
      }
      {
        name: 'loom-mcp'
        image: 'loom-mcp:${appImageTags.mcp}'
        uamiId: identity.outputs.uamiMcpId
        uamiClientId: identity.outputs.uamiMcpClientId
        ingressPort: 8080
        external: false
        healthPath: '/.well-known/health'
        tier: 'mcp'
        minReplicas: 1
        maxReplicas: 3
      }
      {
        name: 'loom-setup-orchestrator'
        image: 'loom-setup-orchestrator:${appImageTags.orchestrator}'
        uamiId: identity.outputs.uamiOrchestratorId
        uamiClientId: identity.outputs.uamiOrchestratorClientId
        ingressPort: 8000
        external: false
        healthPath: '/health'
        tier: 'orchestrator'
        minReplicas: 1
        maxReplicas: 3
        env: [
          { name: 'AGENT_ORCHESTRATOR', value: agentOrchestrator }
          { name: 'MCP_ENDPOINT', value: 'http://loom-mcp:8080' }
        ]
      }
      {
        name: 'loom-activator'
        image: 'loom-activator:${appImageTags.activator}'
        uamiId: identity.outputs.uamiActivatorId
        uamiClientId: identity.outputs.uamiActivatorClientId
        ingressPort: 8080
        external: false
        healthPath: '/health'
        tier: 'activator'
        minReplicas: 1
        maxReplicas: 3
      }
      {
        name: 'loom-mirroring'
        image: 'loom-mirroring:${appImageTags.mirroring}'
        uamiId: identity.outputs.uamiMirroringId
        uamiClientId: identity.outputs.uamiMirroringClientId
        ingressPort: 8083
        external: false
        healthPath: '/connectors'
        tier: 'mirroring'
        minReplicas: 1
        maxReplicas: 2
      }
      {
        name: 'loom-direct-lake-shim'
        image: 'loom-direct-lake-shim:${appImageTags.directLake}'
        uamiId: identity.outputs.uamiDirectLakeId
        uamiClientId: identity.outputs.uamiDirectLakeId
        ingressPort: 8080
        external: false
        healthPath: '/health'
        tier: 'direct-lake-shim'
        minReplicas: 1
        maxReplicas: 2
      }
    ]
  }
}

// Presidio sidecars — Gov only (where Content Safety isn't available)
module presidio 'presidio-sidecar.bicep' = if (containerPlatform == 'containerApps' && deployAppsEnabled && (boundary == 'GCC-High' || boundary == 'IL5')) {
  name: 'presidio'
  params: {
    location: location
    caeId: containerPlatformModule.outputs.caeId
    acrLoginServer: registry.outputs.acrLoginServer
    uamiId: identity.outputs.uamiCopilotId   // Reuses Copilot UAMI for ACR pull
    uamiClientId: identity.outputs.uamiCopilotClientId
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    boundary: boundary
    complianceTags: complianceTags
  }
}

// =====================================================================
// User access patterns (Bastion is always-on via network.bicep).
// Each module is flag-gated so operators can pick the right path
// without rewriting Bicep. See docs/fiab/access-patterns.md.
// =====================================================================

module vpnGateway 'vpn-gateway.bicep' = if (vpnGatewayEnabled) {
  name: 'vpn-gateway'
  params: {
    location: location
    gatewaySubnetId: network.outputs.gatewaySubnetId
    complianceTags: complianceTags
  }
}

module appGateway 'app-gateway.bicep' = if (appGatewayEnabled && containerPlatform == 'containerApps' && deployAppsEnabled) {
  name: 'app-gateway'
  params: {
    location: location
    appGatewaySubnetId: network.outputs.appGatewaySubnetId
    consoleFqdn: 'loom-console.${containerPlatformModule.outputs.caeDefaultDomain}'
    consoleBackendIp: containerPlatformModule.outputs.caeStaticIp
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
  }
}

module frontDoor 'front-door.bicep' = if (frontDoorEnabled && containerPlatform == 'containerApps' && deployAppsEnabled) {
  name: 'front-door'
  params: {
    location: location
    caeId: containerPlatformModule.outputs.caeId
    caeDefaultDomain: containerPlatformModule.outputs.caeDefaultDomain
    consoleFqdn: 'loom-console.${containerPlatformModule.outputs.caeDefaultDomain}'
    complianceTags: complianceTags
  }
}

// =====================================================================
// Outputs
// =====================================================================

output hubVnetId string = network.outputs.hubVnetId

output consoleUrl string = containerPlatform == 'containerApps'
  ? 'https://loom-console.${containerPlatformModule.outputs.caeDefaultDomain}'
  : 'https://loom-console.${location}.csa-loom.internal'

output mcpServerUrl string = containerPlatform == 'containerApps'
  ? 'https://loom-mcp.${containerPlatformModule.outputs.caeDefaultDomain}'
  : 'https://loom-mcp.${location}.csa-loom.internal'

output catalogEndpoint string = catalogPrimary == 'purview'
  ? 'https://purview-csa-loom-${location}.purview.azure.${boundary == 'GCC-High' || boundary == 'IL5' ? 'us' : 'com'}'
  : (catalogPrimary == 'unity-catalog-managed'
      ? 'https://adb-csa-loom-${location}.azuredatabricks.${boundary == 'GCC-High' || boundary == 'IL5' ? 'us' : 'net'}'
      : 'https://atlas-csa-loom.${location}.aks.csa-loom.internal')

output keyVaultUri string = keyvault.outputs.keyVaultUri
output appInsightsConnectionString string = monitoring.outputs.appInsightsConnectionString
output acrLoginServer string = registry.outputs.acrLoginServer
output uamiConsoleId string = identity.outputs.uamiConsoleId
output uamiConsolePrincipalId string = identity.outputs.uamiConsolePrincipalId
output uamiConsoleName string = identity.outputs.uamiConsoleName
output uamiOrchestratorId string = identity.outputs.uamiOrchestratorId
output uamiCopilotId string = identity.outputs.uamiCopilotId
output uamiMcpId string = identity.outputs.uamiMcpId
output uamiActivatorId string = identity.outputs.uamiActivatorId
output uamiActivatorPrincipalId string = identity.outputs.uamiActivatorPrincipalId
output uamiMirroringId string = identity.outputs.uamiMirroringId
output uamiDirectLakeId string = identity.outputs.uamiDirectLakeId

// Pass-through for DLZs
output privateDnsZoneIds object = network.outputs.privateDnsZoneIds
output lawId string = monitoring.outputs.lawId
output appInsightsId string = monitoring.outputs.appInsightsId

// Access-pattern outputs (only meaningful when their flag is on)
output vpnGatewayPublicIp string = vpnGatewayEnabled ? vpnGateway.outputs.vpnPublicIp : ''
output appGatewayPublicFqdn string = (appGatewayEnabled && containerPlatform == 'containerApps' && deployAppsEnabled) ? appGateway.outputs.publicFqdn : ''
output frontDoorPublicUrl string = (frontDoorEnabled && containerPlatform == 'containerApps' && deployAppsEnabled) ? frontDoor.outputs.frontDoorPublicUrl : ''
