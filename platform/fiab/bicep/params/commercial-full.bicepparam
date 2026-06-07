// CSA Loom — Commercial full push-button deploy (everything enabled)
// Generated for the iterate-until-green session. Uses real Loom Admins
// group + flips every service flag on.

using '../main.bicep'

param environment = 'AzureCloud'
param location = 'eastus2'
param boundary = 'Commercial'
param deploymentMode = 'single-sub'

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

// Security
param defenderForAIEnabled = true
// Unified Catalog + Enterprise Purview reuse:
//   The /catalog surface federates Purview + UC + OneLake and the
//   /admin/security Purview tab calls REAL endpoints. Because this
//   tenant already has an Enterprise Purview (dmlz-dev-purview-eastus),
//   we DO NOT deploy a second one (would fail with
//   'EnterpriseTenantAlreadyExists'). Instead we wire the existing
//   account into the console via LOOM_PURVIEW_ACCOUNT.
//   If your tenant does NOT already have an Enterprise Purview, set
//   purviewEnabled = true and clear loomPurviewAccount.
param purviewEnabled = false
// Override via env: LOOM_PURVIEW_ACCOUNT=<short-account-name>
param loomPurviewAccount = readEnvironmentVariable('LOOM_PURVIEW_ACCOUNT', 'dmlz-dev-purview-eastus')
// Information Protection + DLP — opt in after the post-deploy bootstrap
// workflow grants the Graph AppRoles AND admin consent is issued.
// Set LOOM_MIP_ENABLED / LOOM_DLP_ENABLED env vars to flip these on.
param loomMipEnabled = bool(readEnvironmentVariable('LOOM_MIP_ENABLED', 'false'))
param loomDlpEnabled = bool(readEnvironmentVariable('LOOM_DLP_ENABLED', 'false'))
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

// MSAL — passed from env vars (don't commit secrets to disk)
param loomMsalClientId = readEnvironmentVariable('LOOM_MSAL_CLIENT_ID', '9844c28c-3b3a-4949-8d63-9eefa3b50a9d')
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
// Agent Foundry — provisions the dedicated AIServices account (aifndry-loom-eastus2)
// with the loom-agents project + chat (gpt-4.1-mini) + text-embedding-ada-002
// deployments and wires LOOM_AOAI_* / LOOM_FOUNDRY_PROJECT_*. This is what makes
// AI Functions (POST /api/ai-functions), Copilot, and the data-agent test-chat
// return real completions on a clean deploy instead of the 501 not_configured gate.
param agentFoundryEnabled = true
param apimEnabled = true
param aiSearchEnabled = false
param adxEnabled = true
param vpnGatewayEnabled = true
param appGatewayEnabled = true

// ---------- Bring-your-own existing services (reuse instead of provision-new) ----------
// Set the EXISTING_* env var (or edit here) to point Loom at an EXISTING resource
// in ANY resource group / subscription instead of provisioning a new one. When set,
// the matching module is skipped and the Console wires to the existing resource;
// run scripts/csa-loom/grant-navigator-rbac.sh post-deploy to grant the UAMI roles.
// Empty → provision new per the *Enabled flag above. See docs/fiab/bring-your-own-services.md.
// Discover reuse candidates across your subs: bash scripts/csa-loom/discover-services.sh
param existingAiSearchService    = readEnvironmentVariable('EXISTING_AI_SEARCH_SERVICE', '')
param existingAiSearchRg         = readEnvironmentVariable('EXISTING_AI_SEARCH_RG', '')
param existingApimName           = readEnvironmentVariable('EXISTING_APIM', '')
param existingApimRg             = readEnvironmentVariable('EXISTING_APIM_RG', '')
param existingAdxClusterName     = readEnvironmentVariable('EXISTING_KUSTO_CLUSTER', '')
param existingAdxClusterRg       = readEnvironmentVariable('EXISTING_KUSTO_RG', '')
param existingFoundryAccountName = readEnvironmentVariable('EXISTING_AOAI', '')
param existingFoundryRg          = readEnvironmentVariable('EXISTING_AOAI_RG', '')
param frontDoorEnabled = true

// Tags
param complianceTags = {
  Environment: 'Commercial'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  Data_Classification: 'Standard'
}
