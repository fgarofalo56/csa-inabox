// CSA Loom — FedCiv estate: TENANT (console + shared) → DMLZ subscription
// =====================================================================
// audit-t162 — multi-sub live migration, phase 1 of 2.
//
// This param file deploys ONLY the admin plane (console + shared services +
// Front Door) into the FedCiv DMLZ subscription. The bureau Data Landing
// Zones are deployed SEPARATELY against their own subscriptions with
// params/dlz-attach.bicepparam — see docs/fiab/topology-migration.md.
//
// FedCiv estate (Azure Commercial / AzureCloud):
//   • DMLZ sub  e093f4fd-5047-4ee4-968d-a56942c665f3  ← THIS deploy (console+shared)
//   • DLZ  sub  363ef5d1-0e77-4594-a530-f51af23dbf8c  ← bureau DLZ (dlz-attach)
//   • Main sub  ca2b3e6b-f892-4c57-b9d8-b64e5799f9ea  ← optional 2nd demo domain (dlz-attach)
//   • ALZ  sub  a60a2fdd-c133-4845-9beb-31f470bf3ef5  ← platform/connectivity hub + DNS
//
// Deploy (sub-scoped — the --subscription IS what lands the admin plane in DMLZ;
// main.bicep always emits the admin-plane RG, adminPlaneSubId is default-only):
//   az deployment sub create \
//     --subscription e093f4fd-5047-4ee4-968d-a56942c665f3 \
//     --location eastus2 \
//     -f platform/fiab/bicep/main.bicep \
//     -p platform/fiab/bicep/params/tenant-dmlz.bicepparam
//
// Modelled on commercial-full.bicepparam (FedCiv = Azure Commercial, not Gov)
// so every flag main.bicep accepts is set explicitly (no-vaporware: no freeform
// config). The dlz[] for-loop is a deliberate NO-OP here (empty arrays) so this
// deploy produces the console + shared services + Front Door and NOTHING else;
// the bureau DLZ attaches afterward via the standalone landing-zone module.

using '../main.bicep'

param environment = 'AzureCloud'
param location = 'eastus2'
param boundary = 'Commercial'

// PHASE-1 SPLIT: multi-sub mode, but the DLZ for-loop is intentionally empty.
// main.bicep ALWAYS deploys the admin plane (console + shared) regardless of
// these arrays, so an empty dlzSubscriptionIds/dlzDomainNames yields exactly
// "console + shared into DMLZ" and the bureau DLZ deploys standalone next.
param deploymentMode = 'multi-sub'
param dlzSubscriptionIds = []
param dlzDomainNames = []

// Cross-sub Setup Orchestrator. On, so the Console UAMI is granted Contributor
// on the DMLZ sub (and any spoke subs once added) — needed for the live
// cross-sub deploy/scale paths and the Setup Wizard's real ARM submit. The
// dlz[] loop being empty means no spoke-RBAC modules fire on this deploy.
param setupOrchestratorEnabled = bool(readEnvironmentVariable('LOOM_SETUP_ORCHESTRATOR_ENABLED', 'true'))
param setupTemplateUri = readEnvironmentVariable('LOOM_SETUP_TEMPLATE_URI', '')

// Compute
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

// Databricks feature flags
param databricksUnityCatalogEnabled = true
param databricksSqlWarehouseEnabled = true
// Databricks ACCOUNT id (GUID) — configures Unity Catalog by default (metastore +
// default catalog + Console-UAMI account_admin). Requires the Console UAMI to be a
// Databricks account admin (one-time) — docs/fiab/catalog/metastores.md.
param databricksAccountId = readEnvironmentVariable('LOOM_DATABRICKS_ACCOUNT_ID', '')

// Security
param defenderForAIEnabled = true
// Reuse an existing Enterprise Purview if the FedCiv tenant already has one
// (a second Enterprise account fails with EnterpriseTenantAlreadyExists). Set
// LOOM_PURVIEW_ACCOUNT to the existing short name, or set purviewEnabled=true
// (via env) + clear the account if the tenant has none.
param purviewEnabled = bool(readEnvironmentVariable('LOOM_PURVIEW_ENABLED', 'false'))
param loomPurviewAccount = readEnvironmentVariable('LOOM_PURVIEW_ACCOUNT', '')
param loomMipEnabled = bool(readEnvironmentVariable('LOOM_MIP_ENABLED', 'false'))
param loomDlpEnabled = bool(readEnvironmentVariable('LOOM_DLP_ENABLED', 'true'))
param loomDlpAdminEnabled = bool(readEnvironmentVariable('LOOM_DLP_ADMIN_ENABLED', 'false'))
param loomIdentityPickerEnabled = bool(readEnvironmentVariable('LOOM_IDENTITY_PICKER_ENABLED', 'false'))
param loomPipelineCiEnabled = bool(readEnvironmentVariable('LOOM_PIPELINE_CI_ENABLED', 'false'))
param storageRequireCmk = false
param keyVaultHsmIsolated = false
param atlasOnAksEnabled = false

// OpenAI
param openaiLocation = 'eastus2'
param openaiEmbeddingsLocation = 'eastus2'
param openaiChatModel = 'gpt-4o'
param openaiEmbeddingsModel = 'text-embedding-3-large'

// Power BI
param powerBiSku = 'F64'

// Analytics report embed — Commercial → Power BI. Native Fluent charts always
// work; the embedded-report path honestly gates (503 + exact follow-up) until
// workspace/report ids + Console-UAMI membership are supplied post-deploy.
param loomUsageReportKind     = readEnvironmentVariable('LOOM_USAGE_REPORT_KIND', 'powerbi')
param loomUsagePbiWorkspaceId = readEnvironmentVariable('LOOM_USAGE_PBI_WORKSPACE_ID', '')
param loomUsagePbiReportId    = readEnvironmentVariable('LOOM_USAGE_PBI_REPORT_ID', '')
param loomReportKind          = readEnvironmentVariable('LOOM_REPORT_KIND', 'powerbi')
param loomGovernPbiWorkspaceId = readEnvironmentVariable('LOOM_GOVERN_PBI_WORKSPACE_ID', '')
param loomGovernPbiReportId    = readEnvironmentVariable('LOOM_GOVERN_PBI_REPORT_ID', '')
param pbiEmbeddedEnabled       = bool(readEnvironmentVariable('LOOM_PBI_EMBEDDED_ENABLED', 'false'))

// Network — DMLZ hub. Must not overlap the bureau-DLZ spoke CIDR (10.100.0.0/16)
// nor the ALZ connectivity hub. Override LOOM_HUB_VNET_CIDR if the ALZ hub owns
// a different range and this DMLZ hub peers under it.
param hubVnetCidr = readEnvironmentVariable('LOOM_HUB_VNET_CIDR', '10.0.0.0/16')

// Identity — FedCiv Loom Admins group (object id). Required: supply via env.
param adminEntraGroupId = readEnvironmentVariable('LOOM_ADMIN_ENTRA_GROUP_ID', '')

// Feature-Permissions bootstrap admin — members open /admin/* before grants
// exist. Defaults to the Loom Admins group; set LOOM_TENANT_ADMIN_OID to a
// specific user OID for a reliable single-user bootstrap.
param loomTenantAdminGroupId = readEnvironmentVariable('LOOM_TENANT_ADMIN_GROUP_ID', adminEntraGroupId)
param loomTenantAdminOid = readEnvironmentVariable('LOOM_TENANT_ADMIN_OID', '')

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

// MSAL — passed from env (don't commit secrets to disk)
param loomMsalClientId = readEnvironmentVariable('LOOM_MSAL_CLIENT_ID', '')
param loomMsalClientSecret = readEnvironmentVariable('LOOM_MSAL_CLIENT_SECRET', '')
param loomSessionSecret = readEnvironmentVariable('LOOM_SESSION_SECRET', '')

// ---------- Bring-your-own existing services ----------
// >>> BYO-WIZARD START (regenerated by scripts/csa-loom/byo-wizard.sh — edit env vars or re-run the wizard)
param existingAiSearchService    = readEnvironmentVariable('EXISTING_AI_SEARCH_SERVICE', '')
param existingAiSearchRg         = readEnvironmentVariable('EXISTING_AI_SEARCH_RG', '')
param existingAiSearchSub        = readEnvironmentVariable('EXISTING_AI_SEARCH_SUB', '')
param existingApimName           = readEnvironmentVariable('EXISTING_APIM', '')
param existingApimRg             = readEnvironmentVariable('EXISTING_APIM_RG', '')
param existingApimSub            = readEnvironmentVariable('EXISTING_APIM_SUB', '')
param existingAdxClusterName     = readEnvironmentVariable('EXISTING_KUSTO_CLUSTER', '')
param existingAdxClusterRg       = readEnvironmentVariable('EXISTING_KUSTO_RG', '')
param existingAdxClusterSub      = readEnvironmentVariable('EXISTING_KUSTO_SUB', '')
param existingFoundryAccountName = readEnvironmentVariable('EXISTING_AOAI', '')
param existingFoundryRg          = readEnvironmentVariable('EXISTING_AOAI_RG', '')
param existingFoundrySub         = readEnvironmentVariable('EXISTING_AOAI_SUB', '')
param existingPurviewAccount     = readEnvironmentVariable('EXISTING_PURVIEW', '')
param existingPurviewRg          = readEnvironmentVariable('EXISTING_PURVIEW_RG', '')
param existingPurviewSub         = readEnvironmentVariable('EXISTING_PURVIEW_SUB', '')
param existingSynapseWorkspace   = readEnvironmentVariable('EXISTING_SYNAPSE', '')
param existingSynapseRg          = readEnvironmentVariable('EXISTING_SYNAPSE_RG', '')
param existingSynapseSub         = readEnvironmentVariable('EXISTING_SYNAPSE_SUB', '')
param existingCosmosAccount      = readEnvironmentVariable('EXISTING_COSMOS_ACCOUNT', '')
param existingCosmosRg           = readEnvironmentVariable('EXISTING_COSMOS_ACCOUNT_RG', '')
param existingCosmosSub          = readEnvironmentVariable('EXISTING_COSMOS_ACCOUNT_SUB', '')
param existingEventHubNamespace  = readEnvironmentVariable('EXISTING_EVENTHUB_NAMESPACE', '')
param existingEventHubRg         = readEnvironmentVariable('EXISTING_EVENTHUB_RG', '')
param existingEventHubSub        = readEnvironmentVariable('EXISTING_EVENTHUB_SUB', '')
param existingDatabricksWorkspace = readEnvironmentVariable('EXISTING_DATABRICKS', '')
param existingDatabricksRg       = readEnvironmentVariable('EXISTING_DATABRICKS_RG', '')
param existingDatabricksSub      = readEnvironmentVariable('EXISTING_DATABRICKS_SUB', '')
param existingDatabricksHostname = readEnvironmentVariable('EXISTING_DATABRICKS_HOSTNAME', '')
// No-Fabric mode is the DEFAULT (Azure-native, per no-fabric-dependency.md).
param fabricEnabled              = (toLower(readEnvironmentVariable('FABRIC_ENABLED', 'false')) == 'true')
// <<< BYO-WIZARD END

// Feature flags — full FedCiv console surface (mirrors commercial-full).
param deployAppsEnabled = true
param aiFoundryEnabled = true
param contentSafetyEnabled = true
param agentFoundryEnabled = true
param apimEnabled = true
param aiSearchEnabled = false
param adxEnabled = true
param cosmosGraphVectorEnabled = true
// Console's own serverless metadata Cosmos (the `loom` DB the BFF reads/writes).
// On by default; the hub module fires for this tenant topology (no local DLZ to
// host it). Serverless removes the 25-container shared-throughput cap that broke
// workspaces/domains live. Auto-skips if a BYO existingCosmosAccount is supplied.
param loomConsoleCosmosEnabled = true
// Org-visuals (Embed codes F22 + Organizational visuals F23) — ON by default
// (opt-out). In tenant/dlz-attach the LOOM_ORG_VISUALS_URL env + Storage Blob
// Delegator grant are wired post-attach by csa-loom-post-deploy-bootstrap.yml.
param loomOrgVisualsEnabled = true
param vpnGatewayEnabled = true
param appGatewayEnabled = true
param mlWorkspaceEnabled = true

// Public ingress — Front Door Premium (Commercial-GA). This is the NEW public
// endpoint the cutover step re-points the vanity domain at. Vanity domain via
// env: the deploy outputs the CNAME + _dnsauth TXT to add at DNS.
param frontDoorEnabled = true
param loomVanityDomain = readEnvironmentVariable('LOOM_VANITY_DOMAIN', '')

// Tags
param complianceTags = {
  Environment: 'FedCiv'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  Data_Classification: 'CUI'
  Loom_Tier: 'admin-plane'
  Loom_Estate: 'fedciv-dmlz'
}

// =====================================================================
// Data-engineering backends — ON by default (opt-out). Set any to false to
// skip that provision; the console editor then honest-gates (LOOM_* env blanked)
// instead of 502-ing. See docs/fiab/prp/deploy-readiness-100pct.md.
// =====================================================================
param loomSynapseEnabled = true
param loomDatabricksEnabled = true
param loomDataFactoryEnabled = true
param loomSelfHostedIrEnabled = true
