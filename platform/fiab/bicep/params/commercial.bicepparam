// CSA Loom — Azure Commercial parameters
// Per AMENDMENTS A4 + per-boundary dispatch matrix (architecture.md §4.3)
//
// Status: PARAMETER SCAFFOLDED — values aligned with PRD §7.3.1

using '../main.bicep'

param environment = 'AzureCloud'
param location = 'eastus2'
param boundary = 'Commercial'
param deploymentMode = 'single-sub'   // or 'multi-sub'

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
// Purview defaults OFF — many Microsoft tenants already have an
// Enterprise-tier tenant-level Purview account (only one allowed per
// tenant). Operator opts in once they've decided whether to reuse the
// existing account (preferred) or scope a new one.
param purviewEnabled = true
// /admin/security Purview tab — point at an EXISTING Purview account
// to enable inline source/scan/glossary/domain management. Leave empty
// to gate the tab behind a structured NotConfigured MessageBar (the
// no-vaporware-compliant fallback). Pull the short account name from
// `az purview account list`.
param loomPurviewAccount = readEnvironmentVariable('LOOM_PURVIEW_ACCOUNT', '')
// /admin/security Information Protection + DLP tabs — both default OFF
// until the post-deploy bootstrap workflow grants the Graph AppRoles
// AND a Tenant Administrator clicks Grant admin consent. After that,
// flip these to true and redeploy admin-plane.
param loomMipEnabled = false
param loomDlpEnabled = false
param storageRequireCmk = false
param keyVaultHsmIsolated = false

// OpenAI
param openaiLocation = 'eastus2'
param openaiEmbeddingsLocation = 'eastus2'
param openaiChatModel = 'gpt-4o'
param openaiEmbeddingsModel = 'text-embedding-3-large'

// Power BI
param powerBiSku = 'F64'

// Role-assignment drift guard — set LOOM_SKIP_ROLE_GRANTS=true when
// re-provisioning an environment that already has the RBAC grants, so
// ARM doesn't fail with RoleAssignmentExists. Defaults false for fresh
// deploys.
param skipRoleGrants = readEnvironmentVariable('LOOM_SKIP_ROLE_GRANTS', 'false') == 'true'

// Network
param hubVnetCidr = '10.0.0.0/16'

// Identity
param adminEntraGroupId = '<replace-with-FiaB-Admins-group-guid>'

// Multi-sub mode (empty for single-sub)
param dlzSubscriptionIds = []
param dlzDomainNames = []

// Tags
param complianceTags = {
  Environment: 'Commercial'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  Data_Classification: 'Standard'
}
