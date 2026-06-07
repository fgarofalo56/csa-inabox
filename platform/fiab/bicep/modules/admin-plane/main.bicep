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

@description('Wire LOOM_DATABRICKS_HOSTNAMES into the console for Unity Catalog federation')
param databricksUnityCatalogEnabled bool = false

@description('Notebook per-cell execution backend (F16). Azure-native default is Synapse Spark Livy; set to "databricks" to opt the notebook editor into the Databricks Execution Context API instead. Must NOT be "databricks" at IL5.')
@allowed(['', 'synapse', 'databricks'])
param loomNotebookBackend string = ''

@description('Cloud authorization tier (e.g. "IL5"). When IL5, the notebook editor blocks the Databricks opt-in (Databricks Gov is not IL5-authorized) and falls back to Synapse Livy.')
param loomCloudTier string = ''

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

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Deploy the Loom apps (Console, MCP, Orchestrator, Copilot, Activator, Mirroring, Direct-Lake Shim). Requires the container images to exist in ACR first — set false on initial provision, then true after images are built + pushed (PRP-16).')
param deployAppsEnabled bool = false

@description('Deploy AI Foundry Hub. Requires explicit storage-account strategy; default off so initial provision succeeds before operator picks Hub strategy.')
param aiFoundryEnabled bool = false

@description('Deploy the dedicated AI Foundry Agent Service account (aifndry-loom-<location>) with the loom-agents project + chat/embedding model deployments. Backs LOOM_FOUNDRY_PROJECT_ENDPOINT / LOOM_AOAI_* for the Agent Service. Independent of aiFoundryEnabled.')
param agentFoundryEnabled bool = false

@description('Deploy the shared Data API builder preview runtime that the DAB editor\'s live REST/GraphQL testers point at via LOOM_DAB_PREVIEW_URL.')
param dabRuntimeEnabled bool = false

@description('SQL server FQDN the DAB preview runtime targets (e.g. <srv>.database.windows.net). Required when dabRuntimeEnabled.')
param dabSqlServerFqdn string = ''

@description('SQL database the DAB preview runtime targets. Required when dabRuntimeEnabled.')
param dabSqlDatabase string = ''

@description('Deploy APIM. Premium V2 takes 30+ min; default off so initial provision iterates quickly.')
param apimEnabled bool = false

@description('Deploy AI Search. Capacity in certain regions is intermittent; default off so first deploy succeeds even when AI Search SKUs are over-subscribed.')
param aiSearchEnabled bool = false

@description('Deploy shared ADX cluster in the admin plane. Each DLZ then attaches its own database to this single cluster.')
param adxEnabled bool = false

@description('ADX cluster SKU. Dev SKU is ~$140/mo.')
param adxSkuName string = 'Dev(No SLA)_Standard_E2a_v4'

@description('Deploy the read-only Workspace-Monitoring ADX database + Azure Monitor diagnostic-export pipeline (Fabric workspace-monitoring parity). Requires adxEnabled (new cluster). Default off.')
param workspaceMonitorEnabled bool = false

@description('Monitoring database name (underscores only so the kql-dashboard data-source slug round-trips). Must match LOOM_WORKSPACE_MONITOR_DB.')
param workspaceMonitorDbName string = 'loomdb_workspace_monitor'

@description('Event Hub namespace ARM resource id for the LAW→EventHub→ADX live monitoring feed. Empty → DB + seeded tables work; live continuous ingestion is wired once set.')
param workspaceMonitorEventHubNamespaceId string = ''

@description('Enable ADX optimized auto-scale. Requires a Standard-tier adxSkuName (Basic/Dev SKUs reject it).')
param adxEnableOptimizedAutoscale bool = false

@description('ADX optimized auto-scale minimum instance count.')
@minValue(2)
@maxValue(1000)
param adxAutoscaleMinimum int = 2

@description('ADX optimized auto-scale maximum instance count.')
@minValue(2)
@maxValue(1000)
param adxAutoscaleMaximum int = 10

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

@description('Synapse dev-endpoint DNS suffix for sovereign clouds. Commercial = azuresynapse.net (default); GCC-High / DoD = azuresynapse.us. Empty resolves to azuresynapse.net in code.')
param loomSynapseDevSuffix string = ''

@description('Default Synapse Spark pool used for lakehouse schema DDL (CREATE/ALTER/DROP SCHEMA via Livy). Matches the synapse.bicep sparkPool default.')
param loomDefaultSparkPool string = 'loompool'

@description('Loom Synapse Spark (Big Data) pool name — backs the Lakehouse column-summary stats job + notebook/spark editors. Defaults to the loompool Spark pool the landing-zone Synapse module deploys.')
param loomSynapseSparkPool string = 'loompool'

@description('Synapse SQL TDS host suffix override. Empty (default) = derived from AZURE_CLOUD in synapse-sql-client.ts (Commercial/GCC sql.azuresynapse.net; GCC-High/IL5 sql.azuresynapse.usgovcloudapi.net). Set explicitly only to force a specific sovereign endpoint.')
param loomSynapseHostSuffix string = ''

@description('Synapse SQL endpoint suffix for the live Tables catalog row-count path. Commercial = azuresynapse.net (default); Azure Government (GCC / GCC-High / IL5) = azuresynapse.us. Leave empty for Commercial.')
param loomSynapseSqlSuffix string = ''

@description('Entra principal name the console identity is registered under in PostgreSQL (pgaadauth_create_principal). Empty = the PG Query tab shows an honest setup gate.')
param loomPostgresAadUser string = ''

@description('Loom Azure Data Factory name (for env-var wiring on loom-console — backs the ADF Pipeline/Dataset/Trigger editors).')
param loomAdfName string = 'adf-loom-default-${location}'

@description('Scaled self-hosted IR VMSS name (backs the SHIR metrics tile + scale controls). Defaults to the single-sub DLZ name; empty disables the SHIR surface (honest gate).')
param loomShirVmssName string = 'vmss-loom-shir-default'

@description('Loom Azure Data Factory resource group. Empty defaults to LOOM_DLZ_RG.')
param loomAdfRg string = ''

@description('Approval Logic App workflow name (backs the Approval activity in the pipeline editor). Defaults to the deterministic DLZ convention deployed by modules/integration/approval-logicapp.bicep; empty -> the approval-logicapp route returns an honest 503 with deployment instructions.')
param loomApprovalLogicAppName string = 'logic-loom-approval-${location}'

@description('Approval Logic App resource group. Empty defaults to LOOM_DLZ_RG (where the DLZ approval Logic App is deployed).')
param loomApprovalLogicAppRg string = ''

@description('F4: Key Vault URI for schedule-time pipeline parameter overrides. Empty defaults to the admin-plane vault (Console UAMI already has Secrets Officer there). Set to a separate vault URI to source parameters from elsewhere (grant the Console identity "Key Vault Secrets User" on it).')
param loomParamKeyVaultUri string = ''

@description('F4: Azure App Configuration endpoint for schedule-time pipeline parameter overrides. Empty disables the App Config source. Set to an App Configuration endpoint and grant the Console identity "App Configuration Data Reader" to enable.')
param loomParamAppConfigEndpoint string = ''

@description('Loom HDInsight cluster linked-service name (backs the four ADF HDInsight pipeline activities — Hive/Spark/MapReduce/Streaming). Empty leaves the editor honest-gated until an Azure HDInsight linked service is registered in the factory.')
param loomHdinsightLinkedService string = ''

@description('Loom DLZ resource group (for ARM REST pause/resume from the Console BFF).')
param loomDlzRg string = 'rg-csa-loom-dlz-single-${location}'

@description('Loom Stream Analytics resource group (backs the stream-analytics-job editor). Empty defaults to LOOM_DLZ_RG.')
param loomAsaRg string = ''

@description('Loom Stream Analytics subscription ID. Empty defaults to LOOM_SUBSCRIPTION_ID.')
param loomAsaSub string = ''

@description('Default ASA job name the Eventstream editor pre-fills for "Push destinations to ASA". Matches the starter job from modules/landing-zone/stream-analytics.bicep (asa-loom-<domain>-<region>). Editable in the UI.')
param loomAsaJobName string = 'asa-loom-default-${location}'

@description('Azure region for Stream Analytics jobs created on demand from the Eventstream canvas (POST /api/items/eventstream/{id}/provision). Defaults to the deployment region; falls back to LOOM_LOCATION then eastus in the client.')
param loomAsaLocation string = location

@description('Loom Event Hubs namespace name (backs the Event Hubs namespace navigator in the Eventstream editor). Defaults to the single-sub DLZ convention evhns-loom-default-<region> emitted by modules/landing-zone/eventhubs.bicep; override for multi-domain deployments. Empty surfaces the navigator config gate.')
param loomEventHubNamespace string = 'evhns-loom-default-${location}'

@description('Loom Event Hubs resource group. Empty defaults to LOOM_DLZ_RG.')
param loomEventHubRg string = ''

@description('Loom Event Hubs subscription ID. Empty defaults to LOOM_SUBSCRIPTION_ID.')
param loomEventHubSub string = ''

@description('RTI hub catalog — extra subscription IDs (comma-separated) to include in cross-subscription stream discovery via Azure Resource Graph, beyond the deployment subscription. The Console UAMI needs Reader at each subscription scope.')
param loomExtraSubscriptions string = ''

@description('Optional ARM resource ID of a default IoT Hub for ADX data connections (KQL Database → Add data connection wizard). When set, the IoT Hub picker pre-selects this hub; when empty, the wizard discovers all IoT Hubs visible to the Loom identity via Resource Graph. The ADX cluster system-assigned managed identity must hold "IoT Hub Contributor" (role ID 4763167e-fb37-48bb-8710-0fcd9d82e439, grants Microsoft.Devices/IotHubs/IotHubKeys/read) at the target IoT Hub scope for device-to-cloud ingestion to succeed — because the hub is user-selected at runtime, that grant is a one-time operator action surfaced as an honest-gate MessageBar in the editor.')
param loomIotHubResourceId string = ''

@description('Loom Alert Rules resource group (for monitoring alerts/rules). Empty defaults to LOOM_DLZ_RG.')
param loomAlertRg string = ''

@description('ARM management endpoint. Empty defaults to https://management.azure.com (Commercial). Set to https://management.usgovcloudapi.net for GCC-High / IL5.')
param loomArmEndpoint string = ''

@description('ARM token scope. Empty defaults to <ARM endpoint>/.default. Override only for sovereign clouds where the audience differs.')
param loomArmScope string = ''

@description('Loom Storage account name (for ADLS Gen2 lake URLs). When empty, env vars omitted and the Lakehouse editor surfaces a config message.')
param loomStorageAccount string = ''

@description('ADLS Gen2 storage account name for ADX continuous-export (Delta / OneLake-style availability). Backs LOOM_RTI_EXPORT_ADLS and grants the ADX cluster MI Storage Blob Data Contributor. Defaults to loomStorageAccount when empty.')
param loomRtiExportAdls string = ''

@description('Resource group of the ADX continuous-export ADLS account. Empty defaults to this deployment RG.')
param loomRtiExportAdlsRg string = ''

@description('Loom Cosmos account name. When empty, Cosmos env vars omitted.')
param loomCosmosAccount string = ''

@description('Loom Cosmos DB account resource group for the control-plane navigator (databases/containers/sprocs). Empty defaults to LOOM_DLZ_RG, where the single-sub DLZ Cosmos account lives.')
param loomCosmosAccountRg string = ''

@description('Loom Databricks workspace hostname (e.g. adb-1234567890123456.7.azuredatabricks.net) backing the Databricks navigator (jobs/clusters/notebooks/SQL warehouses + Unity Catalog). The real hostname embeds a non-deterministic workspace id, so it is NOT hard-coded — it is patched onto the Console post-deploy from the DLZ databricks workspaceUrl output (scripts/csa-loom/patch-navigator-env.sh). Empty surfaces the navigator config gate.')
param loomDatabricksHostname string = ''

@description('Optional Databricks SQL Warehouse id used for lakehouse ALTER TABLE … CLUSTER BY (liquid clustering). When blank, the lakehouse settings route auto-selects the first RUNNING warehouse in the workspace. Empty by default so existing deployments are unaffected.')
param loomDatabricksSqlWarehouseId string = ''

// =====================================================================
// Bring-your-own existing services (reuse instead of provision-new).
//
// When an existing<Service> name is set, the matching admin-plane module is
// NOT deployed and the Console wires its env to the existing resource (in any
// RG/sub). Empty → provision new per the *Enabled flag. Reuse-first deploys
// set these via readEnvironmentVariable('EXISTING_*', '') in the .bicepparam.
// Role grants for reused resources are applied post-deploy (reuse-first,
// cross-sub) by scripts/csa-loom/grant-navigator-rbac.sh; the live env-var
// values (esp. cross-region ADX URI) are reconciled by patch-navigator-env.sh.
// See docs/fiab/bring-your-own-services.md.
// =====================================================================
@description('Reuse an existing Azure AI Search service (name) instead of provisioning one. Empty → provision new when aiSearchEnabled.')
param existingAiSearchService string = ''
@description('Resource group of the existing AI Search service. Empty defaults to this admin RG.')
param existingAiSearchRg string = ''
@description('Reuse an existing API Management service (name) instead of provisioning one. Empty → provision new when apimEnabled.')
param existingApimName string = ''
@description('Resource group of the existing APIM service. Empty defaults to this admin RG.')
param existingApimRg string = ''
@description('Reuse an existing ADX/Kusto cluster (name) instead of provisioning one. Empty → provision new when adxEnabled.')
param existingAdxClusterName string = ''
@description('Resource group of the existing ADX cluster. Empty defaults to this admin RG.')
param existingAdxClusterRg string = ''
@description('Reuse an existing AI Foundry / AOAI (AIServices) account (name) instead of provisioning the Foundry hub. Empty → provision new when aiFoundryEnabled.')
param existingFoundryAccountName string = ''
@description('Resource group of the existing Foundry/AOAI account. Empty defaults to this admin RG.')
param existingFoundryRg string = ''

// Effective "reuse-or-new" identities used for Console env wiring below.
var byoAiSearchRg = !empty(existingAiSearchRg) ? existingAiSearchRg : resourceGroup().name
var byoApimRg     = !empty(existingApimRg) ? existingApimRg : resourceGroup().name
var byoAdxRg      = !empty(existingAdxClusterRg) ? existingAdxClusterRg : resourceGroup().name
var byoFoundryRg  = !empty(existingFoundryRg) ? existingFoundryRg : resourceGroup().name

// CSA Loom family sweep (Power Platform / ML / Geo / Graph): the DLZ
// orchestrator emits Cosmos Gremlin + NoSQL Vector endpoints when
// `cosmosGraphVectorEnabled = true`. Pass them through here so the
// Console BFF picks them up at runtime.
@description('Cosmos Gremlin endpoint (e.g. wss://<acct>.gremlin.cosmos.azure.com:443/). When empty, the cosmos-gremlin-graph editor surfaces its honest-gate MessageBar.')
param loomCosmosGremlinEndpoint string = ''
@description('Cosmos Gremlin database (default: loom-graph)')
param loomCosmosGremlinDatabase string = ''
@description('Cosmos Gremlin graph (default: default)')
param loomCosmosGremlinGraph string = ''
@description('Cosmos NoSQL vector endpoint for the vector-store editor. When empty, the editor only persists the spec without dispatch.')
param loomCosmosVectorEndpoint string = ''
@description('Cosmos NoSQL vector database (default: loom-vectors)')
param loomCosmosVectorDatabase string = ''
@description('Cosmos NoSQL vector container (default: docs-vec)')
param loomCosmosVectorContainer string = ''
@description('Azure Maps account name (e.g. maps-csa-loom-xyz). When empty, the geo-map / map editors fall back to OSM and surface the honest-gate MessageBar.')
param loomAzureMapsAccount string = ''
@description('Azure Maps primary key secret name in Key Vault (default: loom-azure-maps-primary-key). The Console reads this via secretRef.')
param loomAzureMapsKeySecretName string = 'loom-azure-maps-primary-key'

@description('Purview account name (short, NOT full URL) — e.g. "purview-csa-loom-eastus2". When empty, /admin/security Purview tab + /api/items/data-product/*/register-purview return HTTP 503 with a structured remediation hint.')
param loomPurviewAccount string = ''

@description('Enable Microsoft Information Protection (sensitivity labels / label policies) calls via Microsoft Graph. Requires the Console UAMI to have InformationProtectionPolicy.Read.All admin-consented. When false, /admin/security Information Protection tab returns 503.')
param loomMipEnabled bool = false

@description('Enable Purview DLP (policies / rules / alerts / simulate) calls via Microsoft Graph. Requires Console UAMI Policy.Read.All + SecurityAlert.Read.All admin-consented. When false, /admin/security DLP tab returns 503.')
param loomDlpEnabled bool = false

@description('Azure AD tenant ID for MSAL on the Console.')
param loomMsalTenantId string = subscription().tenantId

@description('Azure AD app (client) ID of the Entra app registration backing MSAL. When empty, MSAL env vars omitted (Console runs unauth).')
param loomMsalClientId string = ''

@description('Azure AD app client secret stored in Key Vault as secret "loom-msal-client-secret". When empty, MSAL env vars omitted.')
@secure()
param loomMsalClientSecret string = ''

@description('Session cookie secret (HKDF input). When empty, a STABLE per-RG GUID is derived (guid(rg.id, ...)) so sign-ins survive redeploys; pass an explicit value (LOOM_SESSION_SECRET) for a tenant-managed secret. newGuid() cannot be used here because this param is also assignable from a .bicepparam, where newGuid() is invalid (BCP065).')
@secure()
param loomSessionSecret string = ''

// =====================================================================
// Phase 2 — RBAC tenant-admin bootstrap + install-time provisioning targets
// =====================================================================

@description('Entra group oid(s) — comma-separated — whose members bypass the Loom Feature Permissions gate. Bootstrap admins need this set OR loomTenantAdminOid to manage /admin/permissions before any grants exist.')
param loomTenantAdminGroupId string = ''

@description('Entra user oid that bypasses the Loom Feature Permissions gate. Used in single-user bootstrap scenarios. Members of loomTenantAdminGroupId are recommended for production.')
param loomTenantAdminOid string = ''

@description('Default Fabric/Power BI workspace id the Phase-2 install engine uses when a Loom workspace has no bound Fabric group yet. Optional — the wizard prompts when missing.')
param loomDefaultFabricWorkspace string = ''

@description('Phase-2 warehouse provisioner backend. synapse-dedicated (default) runs DDL against the dedicated Synapse pool via TDS+AAD; fabric-warehouse is on the v3.5 roadmap.')
@allowed(['synapse-dedicated', 'fabric-warehouse'])
param loomWarehouseBackend string = 'synapse-dedicated'

// =====================================================================
// Azure-native backend selectors (no-fabric-dependency)
// =====================================================================

@description('Azure Data Lake Storage Gen2 bronze container name. Default: bronze.')
param loomBronzeContainer string = 'bronze'

@description('Pipeline orchestrator backend selector. Default: synapse. Alternatives: adf, fabric.')
@allowed(['synapse', 'adf', 'fabric'])
param loomPipelineBackend string = 'synapse'

@description('Event ingestion backend selector. Default: eventhubs (Azure Event Hubs). Alternatives: fabric.')
@allowed(['eventhubs', 'fabric'])
param loomEventBackend string = 'eventhubs'

@description('Activator rule backend selector. Default: azure-monitor (Azure Monitor). Alternatives: fabric.')
@allowed(['azure-monitor', 'fabric'])
param loomActivatorBackend string = 'azure-monitor'

@description('Dashboard backend selector. Default: adx (Azure Data Explorer/Kusto). Alternatives: fabric.')
@allowed(['adx', 'fabric'])
param loomDashboardBackend string = 'adx'

@description('Data mirroring backend selector. Default: adf-cdc (Azure Data Factory Change Data Capture). Alternatives: synapse-link, fabric.')
@allowed(['adf-cdc', 'synapse-link', 'fabric'])
param loomMirrorBackend string = 'adf-cdc'

@description('Lakehouse storage backend selector. Default: adls (Azure Data Lake Storage Gen2). Alternatives: fabric.')
@allowed(['adls', 'fabric'])
param loomLakehouseBackend string = 'adls'

@description('Semantic model backend selector. Default: loom-native. Alternatives: analysis-services, powerbi.')
@allowed(['loom-native', 'analysis-services', 'powerbi'])
param loomSemanticBackend string = 'loom-native'

// ---------------------------------------------------------------------
// Copy Job watermark control table (F14 — Fabric Copy job parity)
// ---------------------------------------------------------------------

@description('FQDN of the Azure SQL server holding the copy-job watermark control table (dbo.copy_watermark), e.g. sql-loom-ctrl.database.windows.net. Empty = incremental copy surfaces an honest-gate MessageBar; full copy still works.')
param loomCopyJobControlSqlServer string = ''

@description('Database name for the copy-job watermark control table.')
param loomCopyJobControlSqlDb string = 'loom-control'

@description('Deploy the copy-job control table + stored procedure (and grant the ADF factory + console UAMI) via a deployment script. Requires loomCopyJobControlSqlServer set and the console UAMI configured as an Entra admin on that SQL server.')
param copyJobControlEnabled bool = false

@description('Dataflow Gen2 (Power Query) backend selector. Default: adf (Azure-native WranglingDataFlow on ADF Spark — no Fabric). fabric is opt-in and additionally requires LOOM_DEFAULT_FABRIC_WORKSPACE.')
@allowed(['adf', 'fabric'])
param loomDataflowBackend string = 'adf'

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
    skipRoleGrants: skipRoleGrants
    // /monitor Logs (KQL) tab — Console UAMI gets Log Analytics Reader on the LAW.
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
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
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
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

module aiSearch 'ai-search.bicep' = if (aiSearchEnabled && empty(existingAiSearchService)) {
  name: 'ai-search'
  params: {
    location: location
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    privateDnsZoneSearchId: network.outputs.privateDnsZoneIds.search
    workspaceId: monitoring.outputs.lawId
    adminEntraGroupId: adminEntraGroupId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

// =====================================================================
// 8. AI Foundry Hub (or Azure ML classic in boundaries without Foundry)
// =====================================================================

// Storage account for the AI Foundry Hub workspace (required dependency).
// Plain LRS Standard_v2, geo-redundancy off (matches DLZ policy), public
// network disabled, only the Foundry MI gets access via system role assignment.
resource foundryHubStorage 'Microsoft.Storage/storageAccounts@2024-01-01' = if (aiFoundryEnabled && empty(existingFoundryAccountName)) {
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

module aiFoundry 'ai-foundry.bicep' = if (aiFoundryEnabled && empty(existingFoundryAccountName)) {
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
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

// =====================================================================
// 8b. AI Foundry Agent Service account (aifndry-loom-<location>)
// Dedicated AIServices account + loom-agents project + chat/embedding
// model deployments. Backs LOOM_FOUNDRY_PROJECT_ENDPOINT + LOOM_AOAI_* for
// the Agent Service. Mirrors the live Commercial deployment one-for-one.
// =====================================================================

module agentFoundry '../ai/foundry-project.bicep' = if (agentFoundryEnabled) {
  name: 'agent-foundry'
  params: {
    location: location
    // Sovereign / private-only boundaries keep the account off the public net.
    publicNetworkAccess: boundary == 'Commercial'
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
  }
}

// Shared Data API builder preview runtime (off by default — needs a SQL target).
module dabRuntime 'dab-runtime.bicep' = if (dabRuntimeEnabled && !empty(dabSqlServerFqdn)) {
  name: 'dab-runtime'
  params: {
    location: location
    managedEnvironmentId: containerPlatformModule.outputs.caeId
    uamiResourceId: identity.outputs.uamiConsoleId
    uamiClientId: identity.outputs.uamiConsoleClientId
    sqlServerFqdn: dabSqlServerFqdn
    sqlDatabase: dabSqlDatabase
  }
}

// =====================================================================
// 8b. Copy Job watermark control table (F14) — dbo.copy_watermark +
// dbo.usp_write_watermark in the control SQL DB, plus grants for the ADF
// factory MI + console UAMI. Opt-in; the console also self-heals the DDL.
// =====================================================================

module copyJobControl 'copy-job-control.bicep' = if (copyJobControlEnabled && !empty(loomCopyJobControlSqlServer)) {
  name: 'copy-job-control'
  params: {
    sqlServerFqdn: loomCopyJobControlSqlServer
    sqlDatabase: loomCopyJobControlSqlDb
    scriptIdentityId: identity.outputs.uamiConsoleId
    scriptIdentityClientId: identity.outputs.uamiConsoleClientId
    consoleUamiName: identity.outputs.uamiConsoleName
    adfFactoryName: loomAdfName
    azureCloud: boundary == 'GCC-High' || boundary == 'IL5' ? 'AzureUSGovernment' : 'AzureCloud'
    location: location
    complianceTags: complianceTags
  }
}


// =====================================================================
// 9. APIM (Premium V2 or classic Premium per boundary)
// =====================================================================

module apim 'apim.bicep' = if (apimEnabled && empty(existingApimName)) {
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

module adxCluster 'adx-cluster.bicep' = if (adxEnabled && empty(existingAdxClusterName)) {
  name: 'adx-cluster'
  params: {
    location: location
    skuName: adxSkuName
    enableOptimizedAutoscale: adxEnableOptimizedAutoscale
    autoscaleMinimum: adxAutoscaleMinimum
    autoscaleMaximum: adxAutoscaleMaximum
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    // Console UAMI → Monitoring Contributor on the cluster (alert rules + diagnostics).
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    // Continuous-export: grant cluster MI Storage Blob Data Contributor on the DLZ ADLS account.
    // Empty when loomStorageAccount is unset → grant is skipped → wizard shows honest gate.
    adlsAccountName: loomStorageAccount
    adlsAccountRg: loomDlzRg
    // EH data connections: grant cluster MI Azure Event Hubs Data Receiver on the DLZ EH namespace.
    // The namespace name follows the single-sub DLZ convention set in loomEventHubNamespace.
    ehNamespaceName: loomEventHubNamespace
    ehNamespaceRg: !empty(loomEventHubRg) ? loomEventHubRg : loomDlzRg
  }
}

// Continuous-export (Delta → ADLS Gen2) RBAC: grant the new ADX cluster's
// system-assigned MI Storage Blob Data Contributor on the export account so
// OneLake-style availability works Azure-native (no Fabric workspace). Deployed
// at the storage account's RG (DLZ lake account is commonly in a different RG).
module adxExportRbac 'adx-export-rbac.bicep' = if (adxEnabled && empty(existingAdxClusterName) && !skipRoleGrants && !empty(!empty(loomRtiExportAdls) ? loomRtiExportAdls : loomStorageAccount)) {
  name: 'adx-export-rbac'
  scope: resourceGroup(!empty(loomRtiExportAdlsRg) ? loomRtiExportAdlsRg : resourceGroup().name)
  params: {
    exportAdlsAccountName: !empty(loomRtiExportAdls) ? loomRtiExportAdls : loomStorageAccount
    clusterPrincipalId: adxCluster!.outputs.clusterPrincipalId
  }
}

// Workspace-monitoring ADX database + Azure Monitor diagnostic-export pipeline.
// Read-only telemetry store (Fabric workspace-monitoring parity, no Fabric).
// Console UAMI gets Admin (provisioner seeds tables); admin group gets Viewer.
module workspaceMonitor 'workspace-monitor.bicep' = if (workspaceMonitorEnabled && adxEnabled && empty(existingAdxClusterName)) {
  name: 'workspace-monitor'
  params: {
    location: location
    adxClusterName: adxCluster!.outputs.clusterName
    monitorDbName: workspaceMonitorDbName
    lawName: monitoring.outputs.lawName
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    adminEntraGroupId: adminEntraGroupId
    eventHubNamespaceId: workspaceMonitorEventHubNamespaceId
    skipRoleGrants: skipRoleGrants
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
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    aksClusterId: containerPlatform == 'aks' ? containerPlatformModule.outputs.aksId : ''
    complianceTags: complianceTags
  }
}

// =====================================================================
// 10b. Azure Maps account (geoanalytics backing)
//
// Backs the geo-map / geo-pipeline / map editors. Only deploys in
// Commercial / GCC — Azure Maps is not yet GA in GCC-High / IL5.
// When skipped, the editors render the documented honest-gate
// MessageBars (per no-vaporware.md).
// =====================================================================

@description('Provision an Azure Maps account to back the geo-map / geo-pipeline / map editors. Only honored in Commercial / GCC; skipped in GCC-High / IL5.')
param azureMapsEnabled bool = true

module azureMaps 'azure-maps.bicep' = if (azureMapsEnabled && (boundary == 'Commercial' || boundary == 'GCC')) {
  name: 'azure-maps'
  params: {
    location: location
    boundary: boundary
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    keyVaultId: keyvault.outputs.keyVaultId
    skipRoleGrants: skipRoleGrants
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
            { name: 'LOOM_ADMIN_RG', value: resourceGroup().name }
            { name: 'LOOM_AI_SEARCH_RG', value: byoAiSearchRg }
            { name: 'LOOM_ACA_RG', value: resourceGroup().name }
            { name: 'LOOM_DLZ_RG', value: loomDlzRg }
            // Default ADLS Gen2 account for the Azure-native lakehouse + shortcut
            // example targets ({{ADLS_ACCOUNT}} token). Without this the lakehouse
            // shortcut examples resolve to a non-existent host (ENOTFOUND).
            { name: 'LOOM_ADLS_ACCOUNT', value: loomStorageAccount }
            // ADLS Gen2 account for ADX continuous-export (Delta / OneLake-style
            // availability). When unset, the eventhouse Export dialog shows an
            // honest gate. Defaults to the lake account (same MI grant).
            { name: 'LOOM_RTI_EXPORT_ADLS', value: !empty(loomRtiExportAdls) ? loomRtiExportAdls : loomStorageAccount }
            // /monitor observability surface — Log Analytics workspace GUID
            // (customerId) for the Logs (KQL) tab. The UAMI needs
            // "Log Analytics Reader" on this workspace + "Monitoring Reader"
            // on the sub for metrics/activity/health/alerts.
            { name: 'LOOM_LOG_ANALYTICS_WORKSPACE_ID', value: monitoring.outputs.lawCustomerId }
            { name: 'LOOM_LOG_ANALYTICS_RESOURCE_ID', value: monitoring.outputs.lawId }
            // ADF Output-pane Log Analytics fallback — runs older than ADF's
            // 45-day native monitoring window are queried from the typed
            // ADFPipelineRun / ADFActivityRun tables in this workspace. Separate
            // env var (same workspace GUID) so operators can repoint the ADF
            // history fallback at a dedicated operational workspace without
            // touching the /monitor Logs (KQL) tab.
            { name: 'LOOM_ADF_LOG_ANALYTICS_WORKSPACE', value: monitoring.outputs.lawCustomerId }
            // Cloud-aware Log Analytics QUERY endpoint. Commercial/GCC use the
            // public host; GCC-High / IL5 (Azure Government) use api.loganalytics.us.
            // Read by adf-client.ts (ADF fallback) + monitor-client.ts (Logs tab).
            { name: 'LOOM_LOG_ANALYTICS_ENDPOINT', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'https://api.loganalytics.us' : 'https://api.loganalytics.azure.com' }
            { name: 'LOOM_SYNAPSE_WORKSPACE', value: loomSynapseWorkspace }
            { name: 'LOOM_SYNAPSE_DEDICATED_POOL', value: loomSynapseDedicatedPool }
            // Lakehouse schemas (F9) — Spark pool for CREATE/ALTER/DROP SCHEMA
            // DDL via Livy, and the sovereign-cloud dev-endpoint DNS suffix.
            { name: 'LOOM_DEFAULT_SPARK_POOL', value: loomDefaultSparkPool }
            { name: 'LOOM_SYNAPSE_DEV_SUFFIX', value: loomSynapseDevSuffix }
            { name: 'LOOM_SYNAPSE_HOST_SUFFIX', value: loomSynapseHostSuffix }
            { name: 'LOOM_SPARK_POOL', value: loomSynapseSparkPool }
            // TDS AAD token audience cloud portability (read by synapse-sql-client sqlScope()).
            // Commercial / GCC use database.windows.net; GCC-High / IL5 use the US-Gov audience.
            { name: 'LOOM_SYNAPSE_SQL_TOKEN_SCOPE', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'database.usgovcloudapi.net' : 'database.windows.net' }
            // Synapse SQL endpoint suffix — Commercial defaults to azuresynapse.net
            // in synapse-sql-client.ts; gov clouds set azuresynapse.us here.
            { name: 'LOOM_SYNAPSE_SQL_SUFFIX', value: loomSynapseSqlSuffix }
            { name: 'LOOM_POSTGRES_AAD_USER', value: loomPostgresAadUser }
            { name: 'LOOM_KEY_VAULT_URI', value: keyvault.outputs.keyVaultUri }
            // F4: schedule-time pipeline parameter overrides. KV defaults to the
            // admin-plane vault (Console UAMI already has Secrets Officer there);
            // point at a separate vault by overriding loomParamKeyVaultUri and
            // granting the Console identity "Key Vault Secrets User" on it.
            { name: 'LOOM_PARAM_KEYVAULT', value: !empty(loomParamKeyVaultUri) ? loomParamKeyVaultUri : keyvault.outputs.keyVaultUri }
            // App Configuration source for parameter overrides. Empty disables
            // the App Config path; set to an App Configuration endpoint and grant
            // the Console identity "App Configuration Data Reader" to enable.
            { name: 'LOOM_PARAM_APPCONFIG', value: loomParamAppConfigEndpoint }
            { name: 'LOOM_ADF_NAME', value: loomAdfName }
            { name: 'LOOM_ADF_RG', value: !empty(loomAdfRg) ? loomAdfRg : loomDlzRg }
            // Approval activity (F25) - Consumption Logic App + O365 approval
            // email backing the pipeline editor's Approval activity. Empty name
            // -> the approval-logicapp route returns an honest 503 naming the
            // bicep module + env var (no Fabric / Power Automate dependency).
            { name: 'LOOM_APPROVAL_LOGIC_APP_NAME', value: loomApprovalLogicAppName }
            { name: 'LOOM_APPROVAL_LOGIC_APP_RG', value: !empty(loomApprovalLogicAppRg) ? loomApprovalLogicAppRg : loomDlzRg }
            // Copy Job (F14) — watermark control table address. When the server
            // is unset, incremental copy surfaces an honest-gate MessageBar and
            // full copy still works; see data/copy-job-control.bicep.
            { name: 'LOOM_COPYJOB_CONTROL_SQL_SERVER', value: loomCopyJobControlSqlServer }
            { name: 'LOOM_COPYJOB_CONTROL_SQL_DB', value: loomCopyJobControlSqlDb }
            // HDInsight pipeline activities (Hive/Spark/MapReduce/Streaming) —
            // names the AzureHDInsight linked service in the factory. Exposed
            // both server-side and as NEXT_PUBLIC_* so activity-catalog.ts can
            // pre-fill the cluster reference for new activities. Empty leaves
            // the four activities honest-gated (MessageBar names this var).
            { name: 'LOOM_HDINSIGHT_LINKED_SERVICE', value: loomHdinsightLinkedService }
            { name: 'NEXT_PUBLIC_LOOM_HDINSIGHT_LINKED_SERVICE', value: loomHdinsightLinkedService }
            { name: 'LOOM_SHIR_VMSS_NAME', value: loomShirVmssName }
            // Azure-native Activator (lib/azure/activator-monitor.ts) creates
            // Microsoft.Insights/scheduledQueryRules + action groups here. Defaults
            // to THIS admin RG — the same RG where monitoring.bicep grants the
            // Console UAMI "Monitoring Contributor" (749f88ad…). Override to land
            // alerts elsewhere AND grant the role on that RG.
            { name: 'LOOM_ALERT_RG', value: !empty(loomAlertRg) ? loomAlertRg : resourceGroup().name }
            // Region stamped into the scheduledQueryRule + actionGroup ARM bodies.
            // Defaults to the deployment location so Gov (usgov*) deployments do
            // NOT fall back to the Commercial 'eastus' default in monitor-client.ts.
            { name: 'LOOM_ALERT_LOCATION', value: location }
            // ARM endpoint / scope overrides for sovereign clouds (GCC-High / IL5).
            // Empty on Commercial → monitor-client.ts falls back to
            // https://management.azure.com. Set both for Azure Government.
            { name: 'LOOM_ARM_ENDPOINT', value: loomArmEndpoint }
            { name: 'LOOM_ARM_SCOPE', value: loomArmScope }
            // Stream Analytics — defaults to LOOM_DLZ_RG / LOOM_SUBSCRIPTION_ID
            // when blank (see lib/azure/stream-analytics-client.ts). Override
            // when ASA lives in a different RG / sub than the DLZ.
            { name: 'LOOM_ASA_RG', value: loomAsaRg }
            { name: 'LOOM_ASA_SUB', value: loomAsaSub }
            { name: 'NEXT_PUBLIC_LOOM_ASA_JOB_NAME', value: loomAsaJobName }
            // Region for ASA jobs the Eventstream canvas provisions on demand.
            { name: 'LOOM_ASA_LOCATION', value: loomAsaLocation }
            // Event Hubs namespace navigator (Eventstream editor left pane) —
            // defaults RG/sub to LOOM_DLZ_RG / LOOM_SUBSCRIPTION_ID when unset.
            { name: 'LOOM_EVENTHUB_NAMESPACE', value: loomEventHubNamespace }
            { name: 'LOOM_EVENTHUB_RG', value: loomEventHubRg }
            { name: 'LOOM_EVENTHUB_SUB', value: loomEventHubSub }
            // RTI hub catalog (/rti-hub -> GET /api/rti-hub) - additional
            // subscription ids (comma-separated) to include in the Azure
            // Resource Graph stream discovery alongside LOOM_SUBSCRIPTION_ID.
            // Empty = discover the deployment subscription only. The Console
            // UAMI needs Reader at each subscription's scope (granted at sub
            // scope in platform/fiab/bicep/main.bicep).
            { name: 'LOOM_EXTRA_SUBSCRIPTIONS', value: loomExtraSubscriptions }
            { name: 'LOOM_IOT_HUB_RESOURCE_ID', value: loomIotHubResourceId }
            // Full ARM resource id of the Event Hubs namespace — consumed by the
            // eventhouse ingest route (ADX → Event Hub data connection, Get-Data
            // wizard) AND the workspace-monitoring provisioner (LAW→EH→ADX live
            // feed). An explicit workspaceMonitorEventHubNamespaceId override wins;
            // otherwise derived from the navigator namespace/RG/sub (DLZ fallback).
            { name: 'LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID', value: !empty(workspaceMonitorEventHubNamespaceId) ? workspaceMonitorEventHubNamespaceId : (empty(loomEventHubNamespace) ? '' : '/subscriptions/${empty(loomEventHubSub) ? subscription().subscriptionId : loomEventHubSub}/resourceGroups/${empty(loomEventHubRg) ? loomDlzRg : loomEventHubRg}/providers/Microsoft.EventHub/namespaces/${loomEventHubNamespace}') }
            // Cloud-aware ARM base. Commercial → management.azure.com (default);
            // GCC-High / IL5 → management.usgovcloudapi.net. Read by eventhubs-
            // client, the eventhouse ingest/preview routes, adf/azure-sql clients.
            { name: 'LOOM_ARM_ENDPOINT', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'https://management.usgovcloudapi.net' : 'https://management.azure.com' }
            // ----------------------------------------------------------------
            // Service-navigator control-plane wiring (parity program #209).
            // Each editor's left-pane navigator (ADF Studio-style) reads these
            // to target the real Azure resource. When the backing resource is
            // not deployed (its *Enabled flag is false) the value is '' and the
            // navigator renders its honest config-gate MessageBar — never a fake.
            // ----------------------------------------------------------------
            // Databricks navigator (jobs/clusters/notebooks/SQL warehouses). The
            // singular hostname is what databricks-client.ts reads; the real
            // value embeds a non-deterministic workspace id so it is patched
            // post-deploy from the DLZ workspaceUrl (see loomDatabricksHostname).
            { name: 'LOOM_DATABRICKS_HOSTNAME', value: loomDatabricksHostname }
            // Optional warehouse pin for lakehouse liquid-clustering DDL
            // (ALTER TABLE … CLUSTER BY). Blank → route auto-selects the first
            // RUNNING SQL Warehouse.
            { name: 'LOOM_DATABRICKS_SQL_WAREHOUSE_ID', value: loomDatabricksSqlWarehouseId }
            // Notebook per-cell execution backend (F16). Empty/'synapse' → Azure-
            // native Synapse Spark Livy (default). 'databricks' opts into the
            // Databricks Execution Context API. LOOM_CLOUD_TIER=IL5 makes the BFF
            // block the Databricks opt-in regardless (falls back to Livy).
            { name: 'LOOM_NOTEBOOK_BACKEND', value: loomNotebookBackend }
            { name: 'LOOM_CLOUD_TIER', value: loomCloudTier }
            // ADX / Kusto navigator + KQL editors. bicep formerly set only the
            // bare LOOM_KUSTO_CLUSTER (read nowhere); the client reads the URI,
            // name, RG, location, and default database.
            // Each prefers a reused existing<Service> (any RG/sub) over the
            // provisioned module output, and is '' when neither → honest gate.
            { name: 'LOOM_KUSTO_CLUSTER_URI',  value: !empty(existingAdxClusterName) ? 'https://${existingAdxClusterName}.${location}.kusto.windows.net' : (adxEnabled ? adxCluster!.outputs.clusterUri : '') }
            // Data Management (ingestion) endpoint — REQUIRED for `.purge table
            // records` (GDPR erasure); the engine endpoint rejects purge. Prefer
            // the ARM clusterDataIngestionUri; for a reused cluster derive the
            // ingest-* host. kusto-client falls back to prepending `ingest-` to
            // the cluster URI when this is unset.
            { name: 'LOOM_KUSTO_DM_URI',       value: !empty(existingAdxClusterName) ? 'https://ingest-${existingAdxClusterName}.${location}.kusto.windows.net' : (adxEnabled ? adxCluster!.outputs.clusterDataIngestionUri : '') }
            { name: 'LOOM_KUSTO_CLUSTER_NAME', value: !empty(existingAdxClusterName) ? existingAdxClusterName : (adxEnabled ? adxCluster!.outputs.clusterName : '') }
            { name: 'LOOM_KUSTO_RG',           value: !empty(existingAdxClusterName) ? byoAdxRg : (adxEnabled ? resourceGroup().name : '') }
            { name: 'LOOM_KUSTO_LOCATION',     value: (!empty(existingAdxClusterName) || adxEnabled) ? location : '' }
            // Per-DLZ ADX database is named loomdb-<domain>; the single-sub DLZ
            // uses domain "default" → loomdb-default. For a reused cluster the real
            // default DB is reconciled post-deploy by patch-navigator-env.sh.
            { name: 'LOOM_KUSTO_DEFAULT_DB',   value: (!empty(existingAdxClusterName) || adxEnabled) ? 'loomdb-default' : '' }
            // Workspace-monitoring read-only ADX DB (Azure Monitor diag-export
            // parity for Fabric workspace monitoring). Set only when deployed so
            // the provisioner + dashboard target the real DB; '' → honest gate.
            { name: 'LOOM_WORKSPACE_MONITOR_DB', value: (workspaceMonitorEnabled && adxEnabled && empty(existingAdxClusterName)) ? workspaceMonitorDbName : '' }
            // (LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID for the live LAW→EH→ADX feed is
            // set once above — shared with the eventhouse ingest route; the
            // workspaceMonitorEventHubNamespaceId param overrides it when provided.)
            // RTI — continuous-export destination. Points at the same DLZ ADLS
            // account as LOOM_ADLS_ACCOUNT. Empty → the export-to-ADLS wizard
            // shows a Fluent MessageBar naming LOOM_RTI_EXPORT_ADLS (no-vaporware.md).
            { name: 'LOOM_RTI_EXPORT_ADLS',    value: loomStorageAccount }
            // RTI — queued / one-click ingestion endpoint (Get Data wizard). For a
            // provisioned cluster this is the ARM dataIngestionUri; for a reused
            // cluster the ingest-<name> host is reconciled post-deploy alongside
            // LOOM_KUSTO_CLUSTER_URI by patch-navigator-env.sh. Empty when ADX off.
            { name: 'LOOM_KUSTO_DATA_INGESTION_URI', value: !empty(existingAdxClusterName) ? 'https://ingest-${existingAdxClusterName}.${location}.kusto.windows.net' : (adxEnabled ? adxCluster!.outputs.clusterDataIngestionUri : '') }
            // Sovereign-cloud ARM endpoint for Azure Monitor metrics calls (e.g.
            // the Eventhouse Capacity/throttle panel). Empty = public cloud
            // (https://management.azure.com). Operators in GCC-High / IL5 set
            // 'https://management.usgovcloudapi.net'. Read by monitor-client.ts.
            { name: 'LOOM_ARM_ENDPOINT',       value: '' }
            // AI Search navigator + the loom-items grounding index + help copilot.
            // RG/sub fall back to LOOM_AI_SEARCH_RG / LOOM_SUBSCRIPTION_ID.
            { name: 'LOOM_AI_SEARCH_SERVICE',  value: !empty(existingAiSearchService) ? existingAiSearchService : (aiSearchEnabled ? aiSearch!.outputs.searchName : '') }
            // APIM navigator (apis/products/named-values/backends/subscriptions) + marketplace.
            { name: 'LOOM_APIM_NAME',          value: !empty(existingApimName) ? existingApimName : (apimEnabled ? apim!.outputs.apimName : '') }
            { name: 'LOOM_APIM_RG',            value: !empty(existingApimName) ? byoApimRg : (apimEnabled ? resourceGroup().name : '') }
            // Cosmos DB control-plane navigator (databases/containers/sprocs). This
            // is the USER-navigated account (distinct from Loom's own store at
            // LOOM_COSMOS_ENDPOINT) and lives in the DLZ RG. Requires the Console
            // UAMI to hold "DocumentDB Account Contributor" (granted in cosmos.bicep).
            { name: 'LOOM_COSMOS_ACCOUNT',     value: loomCosmosAccount }
            { name: 'LOOM_COSMOS_ACCOUNT_RG',  value: !empty(loomCosmosAccountRg) ? loomCosmosAccountRg : loomDlzRg }
            { name: 'AZURE_CLOUD', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'AzureUSGovernment' : 'AzureCloud' }
            { name: 'AZURE_TENANT_ID', value: loomMsalTenantId }
            { name: 'LOOM_COSMOS_ENDPOINT', value: !empty(loomCosmosAccount) ? 'https://${loomCosmosAccount}.documents.${environment().suffixes.storage == 'core.usgovcloudapi.net' ? 'azure.us' : 'azure.com'}:443/' : '' }
            { name: 'LOOM_COSMOS_DATABASE', value: 'loom' }
            // CSA Loom family sweep (Power Platform / ML / Geo / Graph) —
            // see scripts/csa-loom/powerplatform-tenant-bootstrap.sh for
            // the one-time tenant config required to use them.
            { name: 'LOOM_COSMOS_GREMLIN_ENDPOINT',  value: loomCosmosGremlinEndpoint }
            { name: 'LOOM_COSMOS_GREMLIN_DATABASE',  value: loomCosmosGremlinDatabase }
            { name: 'LOOM_COSMOS_GREMLIN_GRAPH',     value: loomCosmosGremlinGraph }
            { name: 'NEXT_PUBLIC_LOOM_COSMOS_GREMLIN_ENDPOINT', value: loomCosmosGremlinEndpoint }
            { name: 'LOOM_COSMOS_VECTOR_ENDPOINT',   value: loomCosmosVectorEndpoint }
            { name: 'LOOM_COSMOS_VECTOR_DATABASE',   value: loomCosmosVectorDatabase }
            { name: 'LOOM_COSMOS_VECTOR_CONTAINER',  value: loomCosmosVectorContainer }
            { name: 'LOOM_AZURE_MAPS_ACCOUNT',       value: loomAzureMapsAccount }
            { name: 'LOOM_KUSTO_CLUSTER',            value: !empty(existingAdxClusterName) ? existingAdxClusterName : (adxEnabled ? adxCluster!.outputs.clusterName : '') }
            { name: 'NEXT_PUBLIC_LOOM_KUSTO_CLUSTER', value: !empty(existingAdxClusterName) ? existingAdxClusterName : (adxEnabled ? adxCluster!.outputs.clusterName : '') }
            // Phase 2 — RBAC tenant-admin bootstrap + install-time provisioning targets
            { name: 'LOOM_TENANT_ADMIN_GROUP_ID', value: loomTenantAdminGroupId }
            { name: 'LOOM_TENANT_ADMIN_OID', value: loomTenantAdminOid }
            { name: 'LOOM_DEFAULT_FABRIC_WORKSPACE', value: loomDefaultFabricWorkspace }
            { name: 'LOOM_WAREHOUSE_BACKEND', value: loomWarehouseBackend }
            // ----------------------------------------------------------------
            // Azure-native backend selectors (no-fabric-dependency)
            // ----------------------------------------------------------------
            { name: 'LOOM_BRONZE_CONTAINER', value: loomBronzeContainer }
            { name: 'LOOM_PIPELINE_BACKEND', value: loomPipelineBackend }
            { name: 'LOOM_EVENT_BACKEND', value: loomEventBackend }
            { name: 'LOOM_ACTIVATOR_BACKEND', value: loomActivatorBackend }
            { name: 'LOOM_DASHBOARD_BACKEND', value: loomDashboardBackend }
            { name: 'LOOM_MIRROR_BACKEND', value: loomMirrorBackend }
            { name: 'LOOM_LAKEHOUSE_BACKEND', value: loomLakehouseBackend }
            { name: 'LOOM_SEMANTIC_BACKEND', value: loomSemanticBackend }
            { name: 'LOOM_DATAFLOW_BACKEND', value: loomDataflowBackend }
          ],
          // Azure Maps subscription key — exposed to SPA as NEXT_PUBLIC_
          // so the MapEditor can use the static-map URL. AAD-auth path
          // doesn't need this. Only set when the maps account is wired.
          !empty(loomAzureMapsAccount) ? [
            { name: 'NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY', secretRef: 'loom-azure-maps-key' }
          ] : [],
          !empty(loomStorageAccount) ? [
            { name: 'LOOM_BRONZE_URL',  value: 'https://${loomStorageAccount}.dfs.${environment().suffixes.storage}/bronze' }
            { name: 'LOOM_SILVER_URL',  value: 'https://${loomStorageAccount}.dfs.${environment().suffixes.storage}/silver' }
            { name: 'LOOM_GOLD_URL',    value: 'https://${loomStorageAccount}.dfs.${environment().suffixes.storage}/gold' }
            { name: 'LOOM_LANDING_URL', value: 'https://${loomStorageAccount}.dfs.${environment().suffixes.storage}/landing' }
            // LOOM_SAMPLE_ADLS gates the data-pipeline "Practice with sample data"
            // card: when set, the BFF uploads a sample CSV to landing/samples and
            // runs an ADF copy pipeline into bronze/samples. Defaults to the DLZ
            // storage account (same as LOOM_ADLS_ACCOUNT). Only emitted when an
            // ADLS account is configured, so the card's honest gate fires
            // otherwise. Requires the ADF factory MSI to hold Storage Blob Data
            // Contributor (granted in landing-zone/adf.bicep).
            { name: 'LOOM_SAMPLE_ADLS', value: loomStorageAccount }
          ] : [],
          // ----------------------------------------------------------------
          // Unified Catalog federation + admin-security env wiring.
          //
          // The /catalog surface federates Purview + Unity Catalog + Fabric
          // OneLake. The /admin/security panel surfaces Purview + MIP + DLP.
          // Each backend is gated independently — when an env var is
          // missing, the corresponding UI surface renders a Fluent
          // MessageBar naming the missing env var and the Graph AppRole /
          // Purview portal role that must be granted.
          //
          // LOOM_PURVIEW_ACCOUNT precedence:
          //   1. Explicit `loomPurviewAccount` param (used by both
          //      /catalog federation and /admin/security Purview tab)
          //   2. purview-csa-loom-<location> when `purviewEnabled = true`
          //      and no explicit account name was supplied
          // ----------------------------------------------------------------
          !empty(loomPurviewAccount) ? [
            { name: 'LOOM_PURVIEW_ACCOUNT', value: loomPurviewAccount }
          ] : (purviewEnabled ? [
            { name: 'LOOM_PURVIEW_ACCOUNT', value: 'purview-csa-loom-${location}' }
          ] : []),
          loomMipEnabled ? [
            { name: 'LOOM_MIP_ENABLED', value: 'true' }
          ] : [],
          loomDlpEnabled ? [
            { name: 'LOOM_DLP_ENABLED', value: 'true' }
          ] : [],
          catalogPrimary == 'unity-catalog-managed' || databricksUnityCatalogEnabled ? [
            // Unity Catalog federation hostname list. Uses the REAL workspace
            // hostname (same source as the singular LOOM_DATABRICKS_HOSTNAME) —
            // NOT a synthesized adb-csa-loom-* name, which never resolves
            // (Databricks workspace URLs embed a non-deterministic id). Empty
            // until patched post-deploy from the DLZ workspaceUrl, so UC gates
            // honestly rather than calling a phantom host (per no-vaporware.md).
            { name: 'LOOM_DATABRICKS_HOSTNAMES', value: loomDatabricksHostname }
          ] : [],
          // Fabric API base is always set — the runtime gates on UAMI authz.
          [
            { name: 'LOOM_FABRIC_BASE', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'https://api.fabric.microsoft.us/v1' : 'https://api.fabric.microsoft.com/v1' }
            { name: 'LOOM_FABRIC_ADMIN_BASE', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'https://api.fabric.microsoft.us/v1.0/myorg/admin' : 'https://api.fabric.microsoft.com/v1.0/myorg/admin' }
          ],
          !empty(loomMsalClientId) ? [
            { name: 'LOOM_MSAL_CLIENT_ID', value: loomMsalClientId }
            { name: 'LOOM_MSAL_CLIENT_SECRET', secretRef: 'loom-msal-client-secret' }
            // NOTE: do NOT map this secret to AZURE_CLIENT_SECRET — the Console
            // authenticates to Azure with its MANAGED IDENTITY (AZURE_CLIENT_ID /
            // LOOM_UAMI_CLIENT_ID below). Setting AZURE_CLIENT_SECRET makes
            // @azure/identity's EnvironmentCredential attempt a client-secret
            // login with the UAMI client id → AADSTS7000232 (MSI can't use a
            // secret), which breaks Cost/Monitor/Defender calls. MSAL + Dataverse
            // read LOOM_MSAL_CLIENT_SECRET / LOOM_DATAVERSE_CLIENT_SECRET instead.
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
            { name: 'LOOM_UAMI_CLIENT_ID', value: identity.outputs.uamiConsoleClientId }
            // Microsoft Graph user enrichment — flipped ON by default so
            // /admin/users surfaces displayName + department from Entra.
            // The Console UAMI also needs the Graph Directory.Read.All
            // app-role grant, which the
            // scripts/csa-loom/grant-uami-graph-roles.sh post-deploy
            // bootstrap step performs (idempotent).
            { name: 'LOOM_GRAPH_USERS_ENABLED', value: 'true' }
            // Dataverse auth — UAMIs can't be Dataverse Application Users
            // (Microsoft platform restriction), so re-use the MSAL Web App
            // SP credentials. The SP must be registered as a Dataverse
            // Application User with System Administrator role on every
            // env Loom should read. See docs/fiab/dataverse-app-user.md.
            { name: 'LOOM_DATAVERSE_CLIENT_ID', value: loomMsalClientId }
            { name: 'LOOM_DATAVERSE_CLIENT_SECRET', secretRef: 'loom-msal-client-secret' }
            { name: 'LOOM_DATAVERSE_TENANT_ID', value: tenant().tenantId }
            // AI Foundry model-hosting account — used by the hub editor's
            // Models / Quota / Keys / Networking / RBAC tabs and the
            // data-agent test chat. Empty when AI Foundry isn't deployed.
            { name: 'LOOM_FOUNDRY_RG', value: byoFoundryRg }
            { name: 'LOOM_FOUNDRY_NAME', value: (aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.hubName : '' }
            { name: 'LOOM_AOAI_ACCOUNT', value: !empty(existingFoundryAccountName) ? existingFoundryAccountName : (aiFoundryEnabled ? aiFoundry!.outputs.aiServicesAccountName : '') }
            // The model-hosting account lives in this admin-plane RG. foundry-cs-client.ts
            // reads LOOM_AOAI_RG (falls back to LOOM_FOUNDRY_RG, but pin it explicitly).
            { name: 'LOOM_AOAI_RG', value: byoFoundryRg }
            // Foundry region — foundry-client.ts reads this for region-scoped
            // quota/model calls; falls back to a hard-coded 'eastus2' otherwise.
            { name: 'LOOM_FOUNDRY_REGION', value: location }
            // Foundry Agent Service (data-plane) — backs the data-agent Publish flow +
            // the Foundry agent editor. The dedicated Agent Service account
            // (foundry-project.bicep, aifndry-loom-<location>) takes precedence;
            // otherwise fall back to the shared Hub's project (ai-foundry.bicep).
            // Empty when neither is deployed.
            { name: 'LOOM_FOUNDRY_PROJECT_ENDPOINT', value: agentFoundryEnabled ? agentFoundry!.outputs.projectEndpoint : ((aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.projectEndpoint : '') }
            { name: 'LOOM_FOUNDRY_PROJECT_ID',       value: agentFoundryEnabled ? agentFoundry!.outputs.projectId : ((aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.projectId : '') }
            { name: 'LOOM_FOUNDRY_PROJECT_NAME',     value: agentFoundryEnabled ? agentFoundry!.outputs.projectNameOut : '' }
            // AOAI inference endpoint + model deployment names for the Agent
            // Service account. Consumed by the AOAI clients (chat + embeddings).
            { name: 'LOOM_AOAI_ENDPOINT',          value: agentFoundryEnabled ? agentFoundry!.outputs.aoaiEndpoint : '' }
            { name: 'LOOM_AOAI_CHAT_DEPLOYMENT',   value: agentFoundryEnabled ? agentFoundry!.outputs.chatDeployment : '' }
            // The copilot/data-agent orchestrators read LOOM_AOAI_DEPLOYMENT (not
            // the _CHAT_ variant) to resolve the model — keep both in sync so the
            // Copilot/data-agent chat works out of the box (the "no AOAI model"
            // gap was exactly this name mismatch on the live deploy).
            { name: 'LOOM_AOAI_DEPLOYMENT',        value: agentFoundryEnabled ? agentFoundry!.outputs.chatDeployment : '' }
            // AOAI token audience by cloud (public: cognitiveservices.azure.com,
            // Gov: cognitiveservices.azure.us). Derived from the ARM environment()
            // built-in so no new parameter is needed. Read by the NL2KQL + Notebook
            // assist routes (process.env.LOOM_AOAI_AUDIENCE) to mint the bearer.
            { name: 'LOOM_AOAI_AUDIENCE',          value: environment().suffixes.storage != 'core.windows.net' ? 'https://cognitiveservices.azure.us' : 'https://cognitiveservices.azure.com' }
            { name: 'LOOM_AOAI_EMBED_DEPLOYMENT',  value: agentFoundryEnabled ? agentFoundry!.outputs.embedDeployment : '' }
            { name: 'LOOM_DAB_PREVIEW_URL',        value: (dabRuntimeEnabled && !empty(dabSqlServerFqdn)) ? dabRuntime!.outputs.dabPreviewUrl : '' }
          ] : [
            { name: 'LOOM_UAMI_CLIENT_ID', value: identity.outputs.uamiConsoleClientId }
            { name: 'LOOM_GRAPH_USERS_ENABLED', value: 'true' }
          ]
        )
        secrets: concat(
          !empty(loomMsalClientId) ? [
            { name: 'loom-msal-client-secret', value: loomMsalClientSecret }
            { name: 'session-secret', value: empty(loomSessionSecret) ? guid(resourceGroup().id, 'loom-session-secret-v1') : loomSessionSecret }
          ] : [],
          !empty(loomAzureMapsAccount) ? [
            // Read from KV at deploy time. The azure-maps module wrote the
            // primary key here as 'loom-azure-maps-primary-key' on the
            // Loom Key Vault.
            { name: 'loom-azure-maps-key', keyVaultUrl: '${keyvault.outputs.keyVaultUri}secrets/${loomAzureMapsKeySecretName}', identity: identity.outputs.uamiConsoleId }
          ] : []
        )
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
    vanityDomain: loomVanityDomain
    complianceTags: complianceTags
  }
}

@description('Optional vanity hostname for the console (e.g. csa-loom.contoso.ai). Empty = generated Front Door host only. The deploy emits the CNAME + _dnsauth TXT to add at your DNS provider.')
param loomVanityDomain string = ''

// =====================================================================
// Outputs
// =====================================================================

// =====================================================================
// Scale-by-SKU console (/admin/scaling) — the Console UAMI scales compute
// SKUs that all live in THIS admin RG: ADX/Kusto cluster, Synapse dedicated
// SQL pool (DWU), APIM, Container Apps, Fabric/foundry compute, AI Search.
// Those are ARM control-plane PATCH calls, so the UAMI needs write here.
// Without this grant the UAMI has only narrow per-resource + Reader roles in
// this RG and EVERY scale operation returns 403. Delegated to a sub-module so
// the principalId (a module output) is start-time-known inside it (BCP177).
// =====================================================================
module scalingRbac 'scaling-rbac.bicep' = {
  name: 'console-scaling-rbac'
  params: {
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

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

// ADX cluster system-assigned MI principal ID — threaded to the DLZ
// landing-zone module so eventhubs.bicep can grant it Azure Event Hubs Data
// Receiver (required for KQL-database Event Hub data connections). Empty when
// ADX is disabled or a BYO existing cluster is used (then bootstrap the grant
// manually — see docs/fiab/v3-tenant-bootstrap.md).
output adxClusterPrincipalId string = (adxEnabled && empty(existingAdxClusterName)) ? adxCluster!.outputs.clusterPrincipalId : ''
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
var fdOn = frontDoorEnabled && containerPlatform == 'containerApps' && deployAppsEnabled
@description('Vanity console URL (empty if no vanity domain set).')
output vanityPublicUrl string = fdOn ? frontDoor.outputs.vanityPublicUrl : ''
@description('DNS the admin must add at their provider to activate the vanity domain: CNAME <vanityDomain> → vanityCnameTarget, and TXT vanityDnsTxtName → vanityValidationToken.')
output vanityCnameTarget string = fdOn ? frontDoor.outputs.vanityCnameTarget : ''
output vanityDnsTxtName string = fdOn ? frontDoor.outputs.vanityDnsTxtName : ''
output vanityValidationToken string = fdOn ? frontDoor.outputs.vanityValidationToken : ''
