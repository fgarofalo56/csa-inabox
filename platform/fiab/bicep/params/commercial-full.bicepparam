// CSA Loom — Commercial full push-button deploy (everything enabled)
// Generated for the iterate-until-green session. Uses real Loom Admins
// group + flips every service flag on.

using '../main.bicep'

param environment = 'AzureCloud'
param location = 'eastus2'
param boundary = 'Commercial'
param deploymentMode = 'single-sub'
// audit-t157: tenant = first-run install (deploys the hub + DLZ). Add-landing-zone uses dlz-attach via the orchestrator, never this param file.
param topology = 'tenant'

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
// Sourced from LOOM_DATABRICKS_ACCOUNT_ID so a stock deploy with it set configures
// UC with no param-file edit. Unset = UC enabled later via the bootstrap workflow.
param databricksAccountId = readEnvironmentVariable('LOOM_DATABRICKS_ACCOUNT_ID', '')

// Security
param defenderForAIEnabled = true
// Unified Catalog + Enterprise Purview reuse:
//   The /catalog surface federates Purview + UC + OneLake and the
//   /admin/security Purview tab calls REAL endpoints.
//   Governance deploy-readiness (#229): Purview is now ON BY DEFAULT (opt-out).
//   A clean commercial-full deploy provisions + wires + PE-protects a NEW classic
//   Data Map account so /governance works on first login with no manual step.
//   Opt OUT with LOOM_PURVIEW_ENABLED=false. REUSE an existing account instead by
//   setting LOOM_PURVIEW_ACCOUNT to its short name (reuse takes precedence over
//   provisioning). LOOM_PURVIEW_LOCATION pins the account to a known-Purview
//   region when the hub region lacks capacity (empty = hub location).
param purviewEnabled = bool(readEnvironmentVariable('LOOM_PURVIEW_ENABLED', 'true'))
// Empty default = use the freshly provisioned account. Set LOOM_PURVIEW_ACCOUNT
// to a short account name to REUSE an existing Purview instead.
param loomPurviewAccount = readEnvironmentVariable('LOOM_PURVIEW_ACCOUNT', '')
param purviewLocation = readEnvironmentVariable('LOOM_PURVIEW_LOCATION', '')
// Information Protection + DLP — opt in after the post-deploy bootstrap
// workflow grants the Graph AppRoles AND admin consent is issued.
// Set LOOM_MIP_ENABLED / LOOM_DLP_ENABLED env vars to flip these on.
param loomMipEnabled = bool(readEnvironmentVariable('LOOM_MIP_ENABLED', 'false'))
// DLP defaults ON: the bootstrap grants the DLP AppRoles by default, so the
// DLP tab is wired out of the box. Override with LOOM_DLP_ENABLED=false to gate it.
param loomDlpEnabled = bool(readEnvironmentVariable('LOOM_DLP_ENABLED', 'true'))
// DLP policy CRUD via the SCC PowerShell sidecar — opt-in (Graph has no DLP
// write API). Off until the SCC app + cert are bootstrapped; reads/alerts/
// restrict-access work regardless.
param loomDlpAdminEnabled = bool(readEnvironmentVariable('LOOM_DLP_ADMIN_ENABLED', 'false'))
param loomIdentityPickerEnabled = bool(readEnvironmentVariable('LOOM_IDENTITY_PICKER_ENABLED', 'false'))
param loomDomainGroupProvisioningEnabled = bool(readEnvironmentVariable('LOOM_DOMAIN_GROUP_PROVISIONING', 'false'))
// Headless CI Bearer-token path on the deployment-pipeline routes (Azure DevOps /
// GitHub Actions task — Fabric fabric-devops-pipelines parity). Off by default;
// set LOOM_PIPELINE_CI_ENABLED=true to let the CSA Loom DevOps task drive deploys.
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

// Analytics report embed (F21 Usage "Open analytics" + F2 Govern "View more").
// Commercial → Power BI. Default the KIND so /admin/usage + Govern surface the
// embedded-report path out of the box; the BFF honestly gates (503 with the
// exact follow-up) until the workspace/report ids + Console-UAMI membership +
// the "Service principals can use Power BI APIs" tenant setting are supplied
// (post-deploy admin actions — docs/fiab/v3-tenant-bootstrap.md#usage-analytics-embed).
// The native Fluent usage/governance charts always work without these.
param loomUsageReportKind     = readEnvironmentVariable('LOOM_USAGE_REPORT_KIND', 'powerbi')
param loomUsagePbiWorkspaceId = readEnvironmentVariable('LOOM_USAGE_PBI_WORKSPACE_ID', '')
param loomUsagePbiReportId    = readEnvironmentVariable('LOOM_USAGE_PBI_REPORT_ID', '')
param loomReportKind          = readEnvironmentVariable('LOOM_REPORT_KIND', 'powerbi')
param loomGovernPbiWorkspaceId = readEnvironmentVariable('LOOM_GOVERN_PBI_WORKSPACE_ID', '')
param loomGovernPbiReportId    = readEnvironmentVariable('LOOM_GOVERN_PBI_REPORT_ID', '')
// Opt-in dedicated Power BI Embedded (A1) capacity for the embed token path.
// Off by default — the reports can also live on the F64 capacity above.
param pbiEmbeddedEnabled       = bool(readEnvironmentVariable('LOOM_PBI_EMBEDDED_ENABLED', 'false'))

// Network
param hubVnetCidr = '10.0.0.0/16'

// Identity — real Loom Admins group
param adminEntraGroupId = '716f5ec5-20d0-4713-9e42-57ef931cd665'

// Feature-Permissions bootstrap admin — members can open /admin/* before any
// grants exist. Defaults to the Loom Admins group above (so members bypass the
// gate with full Admin). Also set LOOM_TENANT_ADMIN_OID to a specific user OID
// for a reliable single-user bootstrap (group-claim emission can be disabled in
// the tenant, in which case the OID match is what unblocks /admin/permissions).
param loomTenantAdminGroupId = readEnvironmentVariable('LOOM_TENANT_ADMIN_GROUP_ID', adminEntraGroupId)
param loomTenantAdminOid = readEnvironmentVariable('LOOM_TENANT_ADMIN_OID', '')

// Loom version + image tags — preserves currently deployed images
param loomVersion = readEnvironmentVariable('LOOM_VERSION', 'v2.1')
param appImageTags = {
  console: readEnvironmentVariable('LOOM_CONSOLE_TAG', 'v2.1')
  mcp: readEnvironmentVariable('LOOM_MCP_TAG', 'v0.7')
  orchestrator: readEnvironmentVariable('LOOM_ORCHESTRATOR_TAG', 'v0.7')
  activator: readEnvironmentVariable('LOOM_ACTIVATOR_TAG', 'v0.7')
  mirroring: readEnvironmentVariable('LOOM_MIRRORING_TAG', 'v0.7')
  directLake: readEnvironmentVariable('LOOM_DIRECTLAKE_TAG', 'v0.7')
}

// MSAL — the app registration + client secret are now PROVISIONED by default
// (loomMsalAppReg.enabled=true → entra-app-registration.bicep / the post-deploy
// bootstrap, GH #1383). Pass LOOM_MSAL_CLIENT_ID only to BYO an existing app
// registration; empty lets the deploy provision a fresh one (no hardcoded
// shared app id — each deployment gets its own, with redirect URIs reconciled
// to its own console host).
param loomMsalClientId = readEnvironmentVariable('LOOM_MSAL_CLIENT_ID', '')
param loomMsalClientSecret = readEnvironmentVariable('LOOM_MSAL_CLIENT_SECRET', '')
// Stable session secret — pass via env to preserve sign-ins; empty → admin-plane
// derives a stable per-RG GUID (newGuid() is invalid in a .bicepparam, BCP065).
param loomSessionSecret = readEnvironmentVariable('LOOM_SESSION_SECRET', '')

// Multi-sub mode (empty for single-sub)
param dlzSubscriptionIds = []
param dlzDomainNames = []

// Feature flags — ALL ON for full push-button deploy
// AI Search currently OFF — eastus2 capacity exhausted (InsufficientResourcesAvailable).
// Re-enable in next iteration when capacity refreshes OR switch region.
param deployAppsEnabled = true
param aiFoundryEnabled = true
// Azure AI Content Safety — copilot persona moderation (Prompt Shields + harm
// analyze). Available in Commercial; wires LOOM_CONTENT_SAFETY_ENDPOINT.
param contentSafetyEnabled = true
// Agent Foundry — provisions the dedicated AIServices account (aifndry-loom-eastus2)
// with the loom-agents project + chat (gpt-4.1-mini) + text-embedding-ada-002
// deployments and wires LOOM_AOAI_* / LOOM_FOUNDRY_PROJECT_*. This is what makes
// AI Functions (POST /api/ai-functions), Copilot, and the data-agent test-chat
// return real completions on a clean deploy instead of the 501 not_configured gate.
param agentFoundryEnabled = true
param apimEnabled = true
param aiSearchEnabled = false
param adxEnabled = true
// RTI (Real-Time Intelligence) backends — Event Hubs + Stream Analytics. ON by
// default (opt-out); set the env var to 'false' to skip the cost. Event Hubs
// backs the Eventstream sources + Data Explorer receive; Stream Analytics backs
// the stream-analytics-job editor + the Eventstream transform node. To REUSE an
// existing Event Hubs namespace / ASA job, set the EXISTING_* vars in the BYO block.
param loomEventHubEnabled = bool(readEnvironmentVariable('LOOM_EVENTHUB_ENABLED', 'true'))
param loomStreamAnalyticsEnabled = bool(readEnvironmentVariable('LOOM_STREAM_ANALYTICS_ENABLED', 'true'))
// Setup Orchestrator — on by default so the Setup Wizard's Deploy submits the
// real subscription-scoped ARM deployment and the Console UAMI is granted
// Contributor on the target sub(s). Set LOOM_SETUP_TEMPLATE_URI to the published
// main.json templateLink; empty = the orchestrator honestly fails Deploy with the
// publish remediation rather than faking success.
param setupOrchestratorEnabled = bool(readEnvironmentVariable('LOOM_SETUP_ORCHESTRATOR_ENABLED', 'true'))
param setupTemplateUri = readEnvironmentVariable('LOOM_SETUP_TEMPLATE_URI', '')
// Cosmos Gremlin (graph editor) + NoSQL vector accounts. Default on so the
// cosmos-gremlin-graph + vector-store editors work on a clean full deploy —
// the Gremlin capability is fixed at account-creation, so the default NoSQL
// account can't back the graph editor.
param cosmosGraphVectorEnabled = true
// Org-visuals (Embed codes F22 + Organizational visuals F23) — ON by default
// (opt-out). Wires the Console UAMI org-visuals container grant + Storage Blob
// Delegator + LOOM_ORG_VISUALS_URL. Set false to honest-gate those panes; the
// medallion lake is unaffected. Azure Blob only — no Fabric/Power BI dependency.
param loomOrgVisualsEnabled = true
param vpnGatewayEnabled = true
param appGatewayEnabled = true
// Azure ML workspace — backs the notebook "Azure ML" compute path (Compute
// Instances + datastores + Command-job cell runs). The deploy-planner
// ml-workspace.bicep module provisions an AML workspace + its KV/Storage/
// AppInsights deps and grants the Console UAMI AzureML Data Scientist, which
// surfaces LOOM_AML_WORKSPACE/RG/REGION to the console. No Fabric dependency.
param mlWorkspaceEnabled = true

// BI stack — Azure Analysis Services + Direct Lake shim are opt-in on the
// admin-plane (modules/admin-plane/main.bicep params aasEnabled, aasSkuName,
// loomBiBackend, loomDirectLakeShimEnabled). Top-level top-level main.bicep
// keeps the defaults conservative; flip the admin-plane params directly when
// opting in. Azure-native, no Fabric / Power BI workspace dependency.

// ---------- Bring-your-own existing services (reuse instead of provision-new) ----------
// Set the EXISTING_* env var (or edit here) to point Loom at an EXISTING resource
// in ANY resource group / subscription instead of provisioning a new one. When set,
// the matching module is skipped and the Console wires to the existing resource;
// run scripts/csa-loom/grant-navigator-rbac.sh post-deploy to grant the UAMI roles.
// Empty → provision new per the *Enabled flag above. See docs/fiab/bring-your-own-services.md.
// Discover reuse candidates across your subs: bash scripts/csa-loom/discover-services.sh
// Generate this block interactively (reuse vs new per service, cross-sub aware):
//   bash scripts/csa-loom/byo-wizard.sh --boundary commercial-full
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
param existingFoundryChatDeployment  = readEnvironmentVariable('EXISTING_AOAI_CHAT_DEPLOYMENT', '')
param existingFoundryEmbedDeployment = readEnvironmentVariable('EXISTING_AOAI_EMBED_DEPLOYMENT', '')
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
param existingAsaJob             = readEnvironmentVariable('EXISTING_ASA_JOB', '')
param existingAsaRg              = readEnvironmentVariable('EXISTING_ASA_RG', '')
param existingAsaSub             = readEnvironmentVariable('EXISTING_ASA_SUB', '')
param existingDatabricksWorkspace = readEnvironmentVariable('EXISTING_DATABRICKS', '')
param existingDatabricksRg       = readEnvironmentVariable('EXISTING_DATABRICKS_RG', '')
param existingDatabricksSub      = readEnvironmentVariable('EXISTING_DATABRICKS_SUB', '')
param existingDatabricksHostname = readEnvironmentVariable('EXISTING_DATABRICKS_HOSTNAME', '')
// No-Fabric mode is the default (Azure-native, per no-fabric-dependency.md).
param fabricEnabled              = (toLower(readEnvironmentVariable('FABRIC_ENABLED', 'false')) == 'true')
// <<< BYO-WIZARD END
param frontDoorEnabled = true

// Tags
param complianceTags = {
  Environment: 'Commercial'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  Data_Classification: 'Standard'
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
