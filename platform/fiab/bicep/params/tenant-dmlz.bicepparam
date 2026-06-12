// CSA Loom — TENANT (DMLZ) reference parameters  [audit-t156 / t162]
//
// topology = 'tenant' deploys the ONE Loom console + ALL tenant-shared services
// into the Data Management Landing Zone (DMLZ) subscription and NO landing-zone
// resources. Domain landing zones attach later with params/dlz-attach.bicepparam
// (topology='dlz-attach'), wired to the hub this deployment stands up.
//
// Reference estate (OPERATOR DECISION D1, 2026-06-12 — the real FedCiv demo estate):
//   DMLZ sub  e093f4fd-5047-4ee4-968d-a56942c665f3  → this deployment (console + shared)
//   DLZ sub   363ef5d1-0e77-4594-a530-f51af23dbf8c  → first domain (see dlz-attach.bicepparam)
//   ALZ sub   a60a2fdd-c133-4845-9beb-31f470bf3ef5  → platform/connectivity hooks (peering)
//   Main sub  ca2b3e6b-f892-4c57-b9d8-b64e5799f9ea  → 2nd demo domain (dlz-attach)
//
// After this deploys, capture the `topologyManifest` output and feed its `hub`
// block into dlz-attach.bicepparam (the orchestrator automates this in t157).

using '../main.bicep'

// ── audit-t156 topology ──────────────────────────────────────────────────────
param topology = 'tenant'
// adminPlaneSubId pins the DMLZ subscription that owns the console + shared svcs.
param adminPlaneSubId = readEnvironmentVariable('LOOM_DMLZ_SUB', 'e093f4fd-5047-4ee4-968d-a56942c665f3')
// No landing zones in the tenant deployment — domains attach via dlz-attach.
param dlzSubscriptionIds = []
param dlzDomainNames = []
// Legacy back-compat field (ignored when topology is set, kept for tooling).
param deploymentMode = 'single-sub'

param environment = 'AzureCloud'
param location = 'eastus2'
param boundary = 'Commercial'

// Compute
param containerPlatform = 'containerApps'
param functionsHostSku = 'FlexConsumption'
param apimSku = 'PremiumV2'

// Catalog + AI orchestration (shared services live in the DMLZ)
param catalogPrimary = 'unity-catalog-managed'
param agentOrchestrator = 'foundry-agent-service'
param foundryPortalEnabled = true

// Capacity sizing
param capacitySku = 'F8'

// Databricks feature flags
param databricksUnityCatalogEnabled = true
param databricksSqlWarehouseEnabled = true
param databricksAccountId = ''

// Security / shared governance (Purview lands in the DMLZ per D5)
param defenderForAIEnabled = true
param contentSafetyEnabled = true
param purviewEnabled = true
param loomPurviewAccount = readEnvironmentVariable('LOOM_PURVIEW_ACCOUNT', '')
param loomMipEnabled = false
param loomDlpEnabled = true
param loomIdentityPickerEnabled = false
param storageRequireCmk = false
param keyVaultHsmIsolated = false

// OpenAI
param openaiLocation = 'eastus2'
param openaiEmbeddingsLocation = 'eastus2'
param openaiChatModel = 'gpt-4o'
param openaiEmbeddingsModel = 'text-embedding-3-large'

// Power BI
param powerBiSku = 'F64'

// Role-assignment drift guard
param skipRoleGrants = readEnvironmentVariable('LOOM_SKIP_ROLE_GRANTS', 'false') == 'true'

// Network — the hub VNet other DLZ spokes peer to (documented hook to the ALZ hub).
param hubVnetCidr = '10.0.0.0/16'

// Identity
param adminEntraGroupId = readEnvironmentVariable('FIAB_ADMIN_GROUP_ID', '<replace-with-FiaB-Admins-group-guid>')
param loomTenantAdminGroupId = readEnvironmentVariable('LOOM_TENANT_ADMIN_GROUP_ID', '')
param loomTenantAdminOid = readEnvironmentVariable('LOOM_TENANT_ADMIN_OID', '')

// The orchestrator deploys DLZ attaches under its identity (Contributor on each
// target sub) — enable so the single console can run "Add landing zone" (t157).
param setupOrchestratorEnabled = readEnvironmentVariable('LOOM_SETUP_ORCHESTRATOR_ENABLED', 'false') == 'true'

// Tags
param complianceTags = {
  Environment: 'Commercial'
  CSA_Loom: 'true'
  Loom_Topology: 'tenant-dmlz'
  FedRAMP_Level: 'High'
  Data_Classification: 'Standard'
}
