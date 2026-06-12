// CSA Loom — DLZ-ATTACH reference parameters  [audit-t156 / t157 / t162]
//
// topology = 'dlz-attach' deploys ONLY a domain landing zone (Databricks /
// Synapse / ADX / storage / Event Hubs / SHIR, per D5) into the target
// subscription(s). The admin plane is SKIPPED — there is NO second console,
// Front Door, or Cosmos. The new DLZ wires into the EXISTING tenant hub via the
// `hubCoordinates` object below, which the operator/orchestrator fills from the
// tenant (DMLZ) deployment's `topologyManifest.hub` output (t157 automates this).
//
// Reference estate (OPERATOR DECISION D1): the first bureau DLZ lands in sub
// 363ef5d1-0e77-4594-a530-f51af23dbf8c; a 2nd demo domain can land in
// ca2b3e6b-f892-4c57-b9d8-b64e5799f9ea (Main sub). The hub lives in the DMLZ
// sub e093f4fd-5047-4ee4-968d-a56942c665f3 (params/tenant-dmlz.bicepparam).
//
// Deploy AGAINST the DLZ target subscription:
//   az deployment sub create --subscription <DLZ-sub> -l eastus2 \
//     -f platform/fiab/bicep/main.bicep -p platform/fiab/bicep/params/dlz-attach.bicepparam
// (the per-DLZ RG is pre-created by scripts/csa-loom/bootstrap-dlz-rgs.sh).

using '../main.bicep'

// ── audit-t156 topology ──────────────────────────────────────────────────────
param topology = 'dlz-attach'
// Legacy field — dlz-attach reuses the multi-sub DLZ fan-out worker.
param deploymentMode = 'multi-sub'

// The domain landing zone(s) to stand up (parallel arrays the bicep [for] reads).
param dlzSubscriptionIds = [
  readEnvironmentVariable('LOOM_DLZ_SUB', '363ef5d1-0e77-4594-a530-f51af23dbf8c')
]
param dlzDomainNames = [
  readEnvironmentVariable('LOOM_DLZ_DOMAIN', 'usda-mrp')
]
// Where the EXISTING hub lives (DMLZ sub) — cross-sub references resolve here.
param adminPlaneSubId = readEnvironmentVariable('LOOM_DMLZ_SUB', 'e093f4fd-5047-4ee4-968d-a56942c665f3')

// ── Hub coordinates from the tenant deployment's topologyManifest.hub output ──
// REQUIRED in dlz-attach (the admin plane is skipped). The orchestrator reads
// these from the Cosmos `tenant-topology` doc; for a manual run, export the env
// vars below from the tenant deployment outputs:
//   az deployment sub show -n <tenant-deploy> --query properties.outputs.topologyManifest.value.hub
param hubCoordinates = {
  adminPlaneRgName: readEnvironmentVariable('LOOM_HUB_ADMIN_RG', 'rg-csa-loom-admin-eastus2')
  hubVnetId: readEnvironmentVariable('LOOM_HUB_VNET_ID', '')
  lawId: readEnvironmentVariable('LOOM_HUB_LAW_ID', '')
  appInsightsConnectionString: readEnvironmentVariable('LOOM_HUB_APPINSIGHTS_CONN', '')
  privateDnsZoneIds: {
    synapseSql: readEnvironmentVariable('LOOM_HUB_PDNS_SYNAPSE_SQL', '')
    adf: readEnvironmentVariable('LOOM_HUB_PDNS_ADF', '')
  }
  adxClusterPrincipalId: readEnvironmentVariable('LOOM_HUB_ADX_PRINCIPAL_ID', '')
  consolePrincipalId: readEnvironmentVariable('LOOM_HUB_CONSOLE_PRINCIPAL_ID', '')
  consoleUamiName: readEnvironmentVariable('LOOM_HUB_CONSOLE_UAMI_NAME', '')
  consoleUamiAppId: readEnvironmentVariable('LOOM_HUB_CONSOLE_UAMI_APPID', '')
  consoleUamiResourceId: readEnvironmentVariable('LOOM_HUB_CONSOLE_UAMI_ID', '')
  activatorPrincipalId: readEnvironmentVariable('LOOM_HUB_ACTIVATOR_PRINCIPAL_ID', '')
  catalogEndpoint: readEnvironmentVariable('LOOM_HUB_CATALOG_ENDPOINT', '')
  aiServicesAccountName: readEnvironmentVariable('LOOM_HUB_AOAI_ACCOUNT', '')
  consoleUrl: readEnvironmentVariable('LOOM_HUB_CONSOLE_URL', '')
}

param environment = 'AzureCloud'
param location = 'eastus2'
param boundary = 'Commercial'

// Compute (must match the tenant deployment's boundary dispatch)
param containerPlatform = 'containerApps'
param functionsHostSku = 'FlexConsumption'
param apimSku = 'PremiumV2'

// Catalog binds to the shared DMLZ catalog (the DLZ does not stand up its own).
param catalogPrimary = 'unity-catalog-managed'
param agentOrchestrator = 'foundry-agent-service'
param foundryPortalEnabled = true

// Per-domain capacity sizing (chargeback unit — D4).
param capacitySku = readEnvironmentVariable('LOOM_DLZ_CAPACITY_SKU', 'F8')

// Databricks feature flags (per-domain DLZ compute)
param databricksUnityCatalogEnabled = true
param databricksSqlWarehouseEnabled = true
param databricksAccountId = ''

// Security — shared governance stays in the DMLZ; the DLZ inherits tenant policy.
param defenderForAIEnabled = false
param contentSafetyEnabled = false
param purviewEnabled = false
param storageRequireCmk = false
param keyVaultHsmIsolated = false

// OpenAI (the DLZ Spark identities call the shared DMLZ AOAI — no new account)
param openaiLocation = 'eastus2'
param openaiEmbeddingsLocation = 'eastus2'
param openaiChatModel = 'gpt-4o'
param openaiEmbeddingsModel = 'text-embedding-3-large'

// Power BI
param powerBiSku = 'F64'

param skipRoleGrants = readEnvironmentVariable('LOOM_SKIP_ROLE_GRANTS', 'false') == 'true'
param hubVnetCidr = '10.1.0.0/16'

// Identity (tenant FiaB Admins group governs the whole estate)
param adminEntraGroupId = readEnvironmentVariable('FIAB_ADMIN_GROUP_ID', '<replace-with-FiaB-Admins-group-guid>')

// Orchestrator deploys this attach under its identity (Contributor on the DLZ sub).
param setupOrchestratorEnabled = readEnvironmentVariable('LOOM_SETUP_ORCHESTRATOR_ENABLED', 'false') == 'true'

// Per-domain chargeback tags (D4) — loom-domain stamps every DLZ resource.
param complianceTags = {
  Environment: 'Commercial'
  CSA_Loom: 'true'
  Loom_Topology: 'dlz-attach'
  'loom-domain': readEnvironmentVariable('LOOM_DLZ_DOMAIN', 'usda-mrp')
  costCenter: readEnvironmentVariable('LOOM_DLZ_COST_CENTER', 'unset')
  FedRAMP_Level: 'High'
  Data_Classification: 'Standard'
}
