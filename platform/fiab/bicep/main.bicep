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

@description('AZURE_CLOUD two-value discriminator for the Console (AzureCloud | AzureUSGovernment). Empty (default) = derived from boundary. Threaded to the admin-plane module so GCC-High / IL5 deployments can set AzureUSGovernment explicitly without relying on the 4-way boundary mapping.')
@allowed(['', 'AzureCloud', 'AzureUSGovernment'])
param loomAzureCloud string = ''

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

@description('Enable the Power BI Admin InformationProtection.setLabels API for /admin/batch-labeling Power BI propagation. Requires loomMipEnabled=true plus the Console UAMI to be a Fabric Administrator (a one-time M365/Entra admin action, not an ARM role). Defaults off; batch labeling still writes Cosmos + Purview when false.')
param loomPowerBiAdminLabels bool = false

@description('HTTPS XMLA endpoint for semantic-model authoring surfaces that need the XMLA write surface (Automatic aggregations). Azure-native default: an Azure Analysis Services server (https://<server>.asazure.windows.net/xmla, or .asazure.usgovcloudapi.net in Gov). A Power BI Premium / Fabric capacity XMLA endpoint is an opt-in alternative selected by URL. Empty = the Aggregations surface honest-gates (no Fabric dependency).')
param loomPowerbiXmlaEndpoint string = ''

@description('Enable the reusable Identity Picker (Entra user/group/service-principal search + transitive nested-group resolution) via Microsoft Graph. Requires the Console UAMI to be admin-consented for User.Read.All + Group.Read.All + Application.Read.All (scripts/csa-loom/grant-identity-graph-approles.sh). Defaults off — the bootstrap workflow flips the AppRoles, then operators re-deploy with this true. When false /api/governance/identities/search returns 503 with the exact remediation.')
param loomIdentityPickerEnabled bool = false

@description('Enable OneLake shortcuts to SharePoint document libraries / OneDrive folders via Microsoft Graph (lakehouse editor → New shortcut → SharePoint / OneDrive). Requires the Console UAMI admin-consented for Sites.Read.All + Files.Read.All (scripts/csa-loom/grant-shortcut-graph-approles.sh). Defaults off — the bootstrap workflow flips the AppRoles, then operators re-deploy with this true. When false the SharePoint source renders but browse/create return 503 with the exact remediation (no mock data). Azure-native parity with Fabric OneLake OneDrive/SharePoint shortcuts; NO Fabric dependency.')
param loomSharepointShortcutsEnabled bool = false

@description('Apache Atlas on AKS deployment (IL5 only)')
param atlasOnAksEnabled bool = false

@description('Grant the Console UAMI "Storage Account Contributor" on each DLZ storage account so the OneLake Lifecycle Management rules editor can read/write blob lifecycle policies (managementPolicies/default). Off by default.')
param consolePrincipalNeedsLifecycleWrite bool = false

@description('Grant the Console UAMI "Storage Account Contributor" on each DLZ storage account so the Customer-Managed Keys (F14) editor can PATCH encryption.keyVaultProperties. Shares the lifecycle grant. Off by default.')
param consolePrincipalNeedsCmkBind bool = false

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

@description('Soft-delete retention days for ADLS Gen2 blob/directory recovery (OneLake Recycle bin restore window). 1–365. Default 30. GA all clouds.')
@minValue(1)
@maxValue(365)
param recycleRetentionDays int = 30

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

@description('Inline-completion (ghost text) AOAI deployment name for notebook/SQL code cells (LOOM_AOAI_COMPLETION_DEPLOYMENT). Empty = ghost text uses the chat deployment (LOOM_AOAI_DEPLOYMENT). Set to a dedicated gpt-4o-mini slot for lower latency without consuming chat quota. Leave empty in GCC-High / IL5 regions where the model is unavailable.')
param loomAoaiCompletionDeployment string = ''

@description('Resource group of the AML workspace for MLflow experiment tracking (ml-experiment "Runs & metrics" tab). Empty → falls back to LOOM_FOUNDRY_RG.')
param loomAmlRg string = ''

@description('Deploy APIM. Premium V2 takes 30+ min; default off for fast iteration.')
param apimEnabled bool = false

@description('Deploy AI Search. Default off — capacity in eastus2 is intermittent.')
param aiSearchEnabled bool = false

@description('Deploy ADX shared cluster (admin-plane) + per-DLZ ADX databases. Backs the RTI editor family — Eventhouse, KQL Database, KQL Queryset, KQL Dashboard, Eventstream. Default on as of 2026-05-27 (sweep-rti). Set false to skip ~$140/mo Dev SKU cluster.')
param adxEnabled bool = true

@description('Deploy a Gremlin-capable Cosmos DB account (EnableGremlin) + NoSQL vector account in each DLZ. Backs the cosmos-gremlin-graph (graph editor) and vector-store editors. Default on — the graph editor requires a Gremlin account at create-time (a NoSQL account cannot be converted). Set false to skip ~2 Cosmos accounts/DLZ.')
param cosmosGraphVectorEnabled bool = true

@description('Deploy the MAF (Microsoft Agent Framework, Gov AOAI-direct) orchestration-tier Container App (loom-copilot-maf). Set true in the GCC-High / IL5 params. The admin-plane gates activation on boundary∈{GCC-High,IL5} + containerPlatform==containerApps + deployAppsEnabled, so it is a safe no-op on the AKS path (the Console copilot-orchestrator then uses its documented Gov AOAI-direct fallback). Requires the loom-copilot-maf image pushed to ACR first.')
param copilotMafEnabled bool = false

@description('Deploy the browser-driven Setup Orchestrator Container App (loom-setup-orchestrator) so the Setup Wizard\'s Deploy submits the real subscription-scoped ARM deployment (templateLink to main.json). Off by default — flip on once the loom-setup-orchestrator image is in ACR + the template is published (Container Apps boundaries + deployAppsEnabled). When enabled, the Setup Orchestrator identity (the Console UAMI) is granted Contributor on the Admin Plane subscription AND each multi-sub spoke subscription so it can deploy across subscriptions.')
param setupOrchestratorEnabled bool = false

@description('templateLink URI to the compiled main.json the Setup Orchestrator submits (publish via `az bicep build -f platform/fiab/bicep/main.bicep`). Threaded to the orchestrator as LOOM_SETUP_TEMPLATE_URI. Empty = the orchestrator honestly fails the Deploy with the publish remediation rather than faking success.')
param setupTemplateUri string = ''

@description('Enable the headless CI Bearer-token path on the Loom deployment-pipeline routes so an Azure DevOps / GitHub Actions agent can drive deploys + management via the CSA Loom DevOps task (Fabric "fabric-devops-pipelines" parity). Off by default — Console-session callers always work; this only gates the token path, which fails closed when off. When true the Console gets LOOM_PIPELINE_CI_ENABLED=true plus the shared LOOM_INTERNAL_TOKEN as the default Bearer secret. Cloud-agnostic: the ADO task talks only to the tenant own Loom URL + Entra, never api.fabric.microsoft.com.')
param loomPipelineCiEnabled bool = false

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

// ---- Cross-subscription (…Sub) dimension + remaining BYO services (full
// reuse-vs-new surface per docs/fiab/design/full-deployment-and-byo.md §4.2).
// All are forwarded to the admin-plane module, where they build the
// LOOM_<SVC>_SUB Console env vars + override the navigator binding when set.
// Emit these from scripts/csa-loom/byo-wizard.sh (the bicepparam generator).
@description('Subscription id of the existing AI Search service (cross-sub reuse).')
param existingAiSearchSub string = ''
@description('Subscription id of the existing APIM service (cross-sub reuse).')
param existingApimSub string = ''
@description('Subscription id of the existing ADX cluster (cross-sub reuse).')
param existingAdxClusterSub string = ''
@description('Subscription id of the existing Foundry/AOAI account (cross-sub reuse).')
param existingFoundrySub string = ''
@description('Reuse an existing Microsoft Purview account (short name). Overrides loomPurviewAccount.')
param existingPurviewAccount string = ''
@description('Resource group of the existing Purview account.')
param existingPurviewRg string = ''
@description('Subscription id of the existing Purview account (cross-sub reuse).')
param existingPurviewSub string = ''
@description('Reuse an existing Synapse workspace (name) for the navigator.')
param existingSynapseWorkspace string = ''
@description('Resource group of the existing Synapse workspace.')
param existingSynapseRg string = ''
@description('Subscription id of the existing Synapse workspace (cross-sub reuse).')
param existingSynapseSub string = ''
@description('Reuse an existing Cosmos DB account (name) for the control-plane navigator.')
param existingCosmosAccount string = ''
@description('Resource group of the existing Cosmos account.')
param existingCosmosRg string = ''
@description('Subscription id of the existing Cosmos account (cross-sub reuse).')
param existingCosmosSub string = ''
@description('Reuse an existing Event Hubs namespace (name) for the Eventstream navigator.')
param existingEventHubNamespace string = ''
@description('Resource group of the existing Event Hubs namespace.')
param existingEventHubRg string = ''
@description('Subscription id of the existing Event Hubs namespace (cross-sub reuse).')
param existingEventHubSub string = ''
@description('Reuse an existing Databricks workspace (name) — informational for RBAC.')
param existingDatabricksWorkspace string = ''
@description('Resource group of the existing Databricks workspace.')
param existingDatabricksRg string = ''
@description('Subscription id of the existing Databricks workspace (cross-sub reuse).')
param existingDatabricksSub string = ''
@description('Reuse an existing Databricks workspace hostname (adb-*.azuredatabricks.net). Overrides the navigator binding; the byo-wizard resolves this from workspaceUrl.')
param existingDatabricksHostname string = ''
@description('Reuse an existing Data Factory (name) for the Data Factory navigator / pipeline mounts.')
param existingAdfFactory string = ''
@description('Resource group of the existing Data Factory.')
param existingAdfRg string = ''
@description('Subscription id of the existing Data Factory (cross-sub reuse).')
param existingAdfSub string = ''

@description('Microsoft Fabric mode. DEFAULT false (Azure-native, no Fabric dependency per no-fabric-dependency.md). When false, no Fabric capacity/workspace is bound and loomDefaultFabricWorkspace is forced empty; the Console gates Fabric calls on UAMI authz and stays fully functional on Azure-native backends. Set true ONLY to opt into a bound Fabric workspace.')
param fabricEnabled bool = false

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

@description('Azure OpenAI account endpoint or name for the SQL editor Copilot (LOOM_AZURE_OPENAI_ENDPOINT — Fix / Explain / NL→T-SQL + inline ghost text). Empty derives from the Foundry Agent Service account when agentFoundryEnabled=true; empty + Foundry off → the SQL Copilot pane shows an honest gate naming this var + the Cognitive Services OpenAI User role.')
param loomAzureOpenAiEndpoint string = ''

@description('Azure OpenAI Chat Completions API version (LOOM_AOAI_API_VERSION) for the Copilot / data-agent orchestrators. Default 2024-10-21; advance for o-series reasoning models. The data-plane host is derived per sovereign boundary from environment(), so this value is cloud-invariant.')
param loomAoaiApiVersion string = '2024-10-21'

@description('Entra app client ID for Loom Console MSAL. When empty, Console runs unauth.')
param loomMsalClientId string = ''

@description('Entra app client secret for Loom Console MSAL. Stored in Container App secret store.')
@secure()
param loomMsalClientSecret string = ''

@description('Session cookie secret (HKDF input). Empty → admin-plane derives a stable per-RG GUID so sign-ins survive redeploys; set LOOM_SESSION_SECRET for a tenant-managed secret.')
@secure()
param loomSessionSecret string = ''

@description('Data mirroring backend selector (LOOM_MIRROR_BACKEND). Default adf-cdc (Azure-native CDC to ADLS Bronze, NO Fabric). synapse-link is Azure-native too; fabric is opt-in only and additionally requires loomDefaultFabricWorkspace.')
@allowed(['adf-cdc', 'synapse-link', 'fabric'])
param loomMirrorBackend string = 'adf-cdc'

@description('Opt-in ADF CDC mirroring — pre-existing ADF linked service for the relational SOURCE (Azure SQL / SQL Server). Empty = built-in CSV snapshot engine (Azure-native, no Fabric).')
param loomMirrorSourceLinkedService string = ''

@description('Opt-in ADF CDC/Copy mirroring — pre-existing ADF AzureBlobFS linked service pointing at the DLZ ADLS account (Delta/Parquet sink). Empty = built-in snapshot engine.')
param loomMirrorAdlsLinkedService string = ''

@description('Opt-in ADF Copy mirroring — pre-existing ADF Snowflake linked service (credential in Key Vault). Empty = falls back to loomMirrorSourceLinkedService. Snowflake → ADF Copy → ADLS Bronze Parquet, NO Fabric.')
param loomMirrorSnowflakeLinkedService string = ''

@description('Refresh cadence for the ADF Copy backend schedule trigger (Snowflake): 15min | 1h | 4h | daily | on-demand. Default 1h.')
@allowed(['15min', '1h', '4h', 'daily', 'on-demand'])
param loomMirrorCopyCadence string = '1h'

@description('Default Fabric/Power BI workspace id (LOOM_DEFAULT_FABRIC_WORKSPACE). Leave EMPTY (default) for the Azure-native path — Fabric is strictly opt-in (per no-fabric-dependency.md) and only used when a *-backend env is also set to fabric.')
param loomDefaultFabricWorkspace string = ''

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

// T95 — Cosmos data-plane host suffixes, sovereign-cloud-specific. The DLZ
// cosmos-graph-vector module computes the same suffixes; we mirror them here
// so the deterministic-name endpoints wired into the Console env (below) match
// the accounts the module actually deploys. Commercial/GCC → azure.com;
// GCC-High/IL5 (Azure US Government) → azure.us.
var gremlinHostSuffix = (boundary == 'GCC-High' || boundary == 'IL5') ? 'gremlin.cosmos.azure.us' : 'gremlin.cosmos.azure.com'
var cosmosDocSuffix = (boundary == 'GCC-High' || boundary == 'IL5') ? 'azure.us' : 'azure.com'

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
    loomAzureCloud: loomAzureCloud
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
    consolePrincipalNeedsCmkBind: consolePrincipalNeedsCmkBind
    adminEntraGroupId: adminEntraGroupId
    loomTenantAdminGroupId: loomTenantAdminGroupId
    loomTenantAdminOid: loomTenantAdminOid
    hubVnetCidr: hubVnetCidr
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    recycleRetentionDays: recycleRetentionDays
    deployAppsEnabled: deployAppsEnabled
    aiFoundryEnabled: aiFoundryEnabled
    contentSafetyEnabled: contentSafetyEnabled
    agentFoundryEnabled: agentFoundryEnabled
    loomAoaiCompletionDeployment: loomAoaiCompletionDeployment
    loomAmlRg: loomAmlRg
    apimEnabled: apimEnabled
    aiSearchEnabled: aiSearchEnabled
    adxEnabled: adxEnabled
    copilotMafEnabled: copilotMafEnabled
    setupOrchestratorEnabled: setupOrchestratorEnabled
    setupTemplateUri: setupTemplateUri
    loomPipelineCiEnabled: loomPipelineCiEnabled
    existingAiSearchService: existingAiSearchService
    existingAiSearchRg: existingAiSearchRg
    existingApimName: existingApimName
    existingApimRg: existingApimRg
    existingAdxClusterName: existingAdxClusterName
    existingAdxClusterRg: existingAdxClusterRg
    existingFoundryAccountName: existingFoundryAccountName
    existingFoundryRg: existingFoundryRg
    // Consolidated BYO overrides (cross-sub …Sub + Purview/Synapse/Cosmos/
    // EventHubs/Databricks) — one object param keeps admin-plane under Bicep's
    // 256-param ceiling. Emitted by scripts/csa-loom/byo-wizard.sh.
    byoExisting: {
      aiSearchSub: existingAiSearchSub
      apimSub: existingApimSub
      adxClusterSub: existingAdxClusterSub
      foundrySub: existingFoundrySub
      purviewAccount: existingPurviewAccount
      purviewRg: existingPurviewRg
      purviewSub: existingPurviewSub
      synapseWorkspace: existingSynapseWorkspace
      synapseRg: existingSynapseRg
      synapseSub: existingSynapseSub
      cosmosAccount: existingCosmosAccount
      cosmosRg: existingCosmosRg
      cosmosSub: existingCosmosSub
      eventHubNamespace: existingEventHubNamespace
      eventHubRg: existingEventHubRg
      eventHubSub: existingEventHubSub
      databricksWorkspace: existingDatabricksWorkspace
      databricksRg: existingDatabricksRg
      databricksSub: existingDatabricksSub
      databricksHostname: existingDatabricksHostname
      adfFactory: existingAdfFactory
      adfRg: existingAdfRg
      adfSub: existingAdfSub
    }
    // Azure ML workspace for the notebook AML path. Name is the deterministic
    // deploy-planner ml-workspace.bicep name (uniqueString over the DLZ RG), so
    // we wire it WITHOUT referencing dpMlWorkspace.outputs (that module depends
    // on adminPlane's UAMI principal — referencing its output here would create
    // a cycle). Empty when the module isn't enabled → AML toggle honest-gates.
    amlWorkspaceName: (deploymentMode == 'single-sub' && mlWorkspaceEnabled) ? take('aml-loom-${uniqueString(singleDlzRg.id)}', 33) : ''
    amlWorkspaceRg: (deploymentMode == 'single-sub' && mlWorkspaceEnabled) ? singleDlzRg.name : ''
    vpnGatewayEnabled: vpnGatewayEnabled
    appGatewayEnabled: appGatewayEnabled
    frontDoorEnabled: frontDoorEnabled
    loomVanityDomain: loomVanityDomain
    loomStorageAccount: take('saloomdefault${uniqueString(singleDlzRg.id)}', 24)
    loomCosmosAccount: take('cosmos-loom-default-${uniqueString(singleDlzRg.id)}', 44)
    // Forward the Cosmos data-plane endpoints to the Console so the vector-store
    // and graph editors bind to the deployed accounts by default (no manual
    // config). The DLZ `cosmos-graph-vector` module (cosmosGraphVectorEnabled,
    // default on) creates a dedicated Gremlin account + a dedicated NoSQL vector
    // account, named deterministically as `cosmos-loom-gremlin-default-<uniq>`
    // and `cosmos-loom-vec-default-<uniq>` over the DLZ RG id. We compute those
    // names inline here rather than reading singleDlz.outputs.* because
    // `adminPlane` deploys BEFORE `singleDlz` (and singleDlz depends on
    // adminPlane outputs) — referencing the DLZ output would create a cycle.
    // This is the same deterministic-name pattern used for amlWorkspaceName /
    // loomCosmosAccount above. Database/graph names match the module's literals
    // (loom-graph / default / loom-vectors / docs-vec); they are NOT optional —
    // the gremlin client defaults to graphdb/graph which the module never
    // creates, so a bare endpoint would target a non-existent db/graph.
    // Multi-sub mode can't be wired from a single admin-plane (one Console env,
    // N DLZs) — operators run scripts/csa-loom/patch-navigator-env.sh there.
    loomCosmosVectorEndpoint: (deploymentMode == 'single-sub' && cosmosGraphVectorEnabled) ? 'https://${take('cosmos-loom-vec-default-${uniqueString(singleDlzRg.id)}', 44)}.documents.${cosmosDocSuffix}:443/' : ''
    loomCosmosVectorDatabase: (deploymentMode == 'single-sub' && cosmosGraphVectorEnabled) ? 'loom-vectors' : ''
    loomCosmosVectorContainer: (deploymentMode == 'single-sub' && cosmosGraphVectorEnabled) ? 'docs-vec' : ''
    loomCosmosGremlinEndpoint: (deploymentMode == 'single-sub' && cosmosGraphVectorEnabled) ? 'wss://${take('cosmos-loom-gremlin-default-${uniqueString(singleDlzRg.id)}', 44)}.${gremlinHostSuffix}:443/' : ''
    loomCosmosGremlinDatabase: (deploymentMode == 'single-sub' && cosmosGraphVectorEnabled) ? 'loom-graph' : ''
    loomCosmosGremlinGraph: (deploymentMode == 'single-sub' && cosmosGraphVectorEnabled) ? 'default' : ''
    // Bind the console's warehouse/SQL env (LOOM_SYNAPSE_WORKSPACE /
    // LOOM_SYNAPSE_DEDICATED_POOL) to the DLZ Synapse workspace + dedicated pool
    // the landing-zone provisions (synapse.bicep: 'syn-loom-${domainName}-${location}'
    // with domainName='default', dedicatedPoolName='loompool'). Computed
    // deterministically (NOT via singleDlz.outputs — landing-zone consumes
    // adminPlane's UAMI, so referencing its outputs here would create a cycle).
    // This makes the warehouse access-policy grant target the real pool; without
    // it the binding silently relies on the admin-plane default matching.
    loomSynapseWorkspace: 'syn-loom-default-${location}'
    loomSynapseDedicatedPool: 'loompool'
    loomPurviewAccount: loomPurviewAccount
    loomMipEnabled: loomMipEnabled
    loomDlpEnabled: loomDlpEnabled
    loomPowerBiAdminLabels: loomPowerBiAdminLabels
    loomPowerbiXmlaEndpoint: loomPowerbiXmlaEndpoint
    loomIdentityPickerEnabled: loomIdentityPickerEnabled
    loomSharepointShortcutsEnabled: loomSharepointShortcutsEnabled
    loomMsalClientId: loomMsalClientId
    loomMsalClientSecret: loomMsalClientSecret
    loomSessionSecret: loomSessionSecret
    loomMirrorBackend: loomMirrorBackend
    loomMirrorSourceLinkedService: loomMirrorSourceLinkedService
    loomMirrorAdlsLinkedService: loomMirrorAdlsLinkedService
    loomMirrorSnowflakeLinkedService: loomMirrorSnowflakeLinkedService
    loomMirrorCopyCadence: loomMirrorCopyCadence
    // No-Fabric mode (default): force the bound workspace empty so nothing
    // hard-depends on a Fabric capacity/workspace (no-fabric-dependency.md). Set
    // fabricEnabled=true ONLY to opt into a bound Fabric workspace.
    loomDefaultFabricWorkspace: fabricEnabled ? loomDefaultFabricWorkspace : ''
    loomVersion: loomVersion
    appImageTags: appImageTags
    // Standalone AML workspace coords for the AML control-plane navigator.
    loomAmlWorkspace: loomAmlWorkspace
    loomAmlResourceGroup: loomAmlResourceGroup
    loomAmlSubscription: loomAmlSubscription
    loomAmlRegion: loomAmlRegion
    // Azure OpenAI endpoint for the SQL editor Copilot (Fix/Explain/NL→T-SQL).
    loomAzureOpenAiEndpoint: loomAzureOpenAiEndpoint
    loomAoaiApiVersion: loomAoaiApiVersion
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
    consoleUamiAppId: adminPlane.outputs.uamiConsoleClientId
    synapseSqlPrivateDnsZoneId: adminPlane.outputs.privateDnsZoneIds.synapseSql
    adfPrivateDnsZoneId: adminPlane.outputs.privateDnsZoneIds.adf
    catalogEndpoint: adminPlane.outputs.catalogEndpoint
    databricksUnityCatalogEnabled: databricksUnityCatalogEnabled
    databricksSqlWarehouseEnabled: databricksSqlWarehouseEnabled
    storageRequireCmk: storageRequireCmk
    powerBiSku: powerBiSku
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    consolePrincipalNeedsLifecycleWrite: consolePrincipalNeedsLifecycleWrite
    consolePrincipalNeedsCmkBind: consolePrincipalNeedsCmkBind
    shirAdminPassword: shirAdminPassword
    recycleRetentionDays: recycleRetentionDays
    cosmosGraphVectorEnabled: cosmosGraphVectorEnabled
  }
}

// F8 (Manage Policies) / T14 — let the Console UAMI assign container-scoped
// Storage Blob Data roles on the lake account when an access request is
// approved. Constrained RBAC-Administrator (data-plane roles only) — see the
// module header. Scoped to the DLZ RG where the storage account lives.
module singleDlzAccessPolicyRbac 'modules/admin-plane/access-policy-rbac.bicep' = if (deploymentMode == 'single-sub') {
  name: 'dlz-single-access-policy-rbac'
  scope: singleDlzRg
  params: {
    consolePrincipalId: adminPlane.outputs.uamiConsolePrincipalId
    storageAccountName: singleDlz!.outputs.storageAccountName
    skipRoleGrants: skipRoleGrants
  }
}

// F16 (Notebook AI functions) — grant the DLZ Spark identities (Synapse
// workspace MSI + Databricks Access Connector MSI) Cognitive Services OpenAI
// User on the admin-plane AOAI account, so ai.summarize / classify / extract /
// translate / sentiment in a PySpark/pandas notebook cell can call AOAI. The
// AOAI account lives in the Admin Plane RG (deployed before the DLZ), so the
// grant is made here (orchestrator) at admin-plane scope, fed the Spark
// identities from the DLZ outputs. The module no-ops (its role assignments are
// guarded on !empty(aiServicesAccountName)) when admin-plane used an existing
// external AOAI account — the operator grants the role manually then.
module singleDlzAoaiSparkRbac 'modules/admin-plane/aoai-spark-rbac.bicep' = if (deploymentMode == 'single-sub') {
  name: 'dlz-single-aoai-spark-rbac'
  scope: adminPlaneRg
  params: {
    aiServicesAccountName: adminPlane.outputs.aiServicesAccountName
    synapseWorkspacePrincipalId: singleDlz!.outputs.synapseManagedIdentityPrincipalId
    databricksAccessConnectorPrincipalId: singleDlz!.outputs.databricksAccessConnectorPrincipalId
    skipRoleGrants: skipRoleGrants
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
    consoleUamiAppId: adminPlane.outputs.uamiConsoleClientId
    synapseSqlPrivateDnsZoneId: adminPlane.outputs.privateDnsZoneIds.synapseSql
    adfPrivateDnsZoneId: adminPlane.outputs.privateDnsZoneIds.adf
    catalogEndpoint: adminPlane.outputs.catalogEndpoint
    databricksUnityCatalogEnabled: databricksUnityCatalogEnabled
    databricksSqlWarehouseEnabled: databricksSqlWarehouseEnabled
    storageRequireCmk: storageRequireCmk
    powerBiSku: powerBiSku
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    consolePrincipalNeedsLifecycleWrite: consolePrincipalNeedsLifecycleWrite
    consolePrincipalNeedsCmkBind: consolePrincipalNeedsCmkBind
    shirAdminPassword: shirAdminPassword
    recycleRetentionDays: recycleRetentionDays
    cosmosGraphVectorEnabled: cosmosGraphVectorEnabled
  }
}]

// Multi-sub: per-DLZ access-policy RBAC-Admin grant (F8 / T14), one per DLZ.
@batchSize(1)
module dlzAccessPolicyRbac 'modules/admin-plane/access-policy-rbac.bicep' = [for (subId, i) in dlzSubscriptionIds: if (deploymentMode == 'multi-sub') {
  name: 'dlz-${i}-access-policy-rbac'
  scope: resourceGroup(subId, 'rg-csa-loom-dlz-${dlzDomainNames[i]}-${location}')
  params: {
    consolePrincipalId: adminPlane.outputs.uamiConsolePrincipalId
    storageAccountName: dlz[i]!.outputs.storageAccountName
    skipRoleGrants: skipRoleGrants
  }
}]


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

// Console UAMI → Cost Management Reader at subscription scope, so the
// /admin/capacity cost column (F5) + the /monitor Cost tab read live
// Microsoft.CostManagement spend per resource and the Loom-wide rollup.
module consoleCostReaderRbac 'modules/admin-plane/cost-management-reader-rbac.bicep' = {
  name: 'console-cost-management-reader'
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

// =====================================================================
// Setup Orchestrator deploy-auth — Contributor at SUBSCRIPTION scope.
//
// The Setup Orchestrator (setup-orchestrator.bicep) runs `az deployment sub
// create` AS the Console UAMI. To deploy a Data Landing Zone it needs
// Contributor at the TARGET subscription scope — for multi-sub rollouts that
// means Contributor on the Admin Plane (hub) sub AND every spoke sub in
// dlzSubscriptionIds. Both grants are made only when setupOrchestratorEnabled
// (the orchestrator principal arrives empty otherwise → the module no-ops).
// =====================================================================
module setupOrchestratorHubRbac 'modules/admin-plane/setup-orchestrator-rbac.bicep' = {
  name: 'setup-orchestrator-hub-rbac'
  scope: subscription()
  params: {
    orchestratorPrincipalId: setupOrchestratorEnabled ? dpConsolePrincipalId : ''
    skipRoleGrants: skipRoleGrants
  }
}

module setupOrchestratorSpokeRbac 'modules/admin-plane/setup-orchestrator-rbac.bicep' = [for (subId, i) in dlzSubscriptionIds: if (deploymentMode == 'multi-sub' && setupOrchestratorEnabled) {
  name: 'setup-orchestrator-spoke-rbac-${i}'
  scope: subscription(subId)
  params: {
    orchestratorPrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}]

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
