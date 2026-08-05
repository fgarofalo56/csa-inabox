// CSA Loom — FedCiv estate: bureau DATA LANDING ZONE → DLZ subscription
// =====================================================================
// audit-t162 — multi-sub live migration, phase 2 of 2.
//
// Deploys ONE Data Landing Zone (spoke VNet + ADLS lakehouse + Synapse + ADX
// DB + Cosmos + Event Hubs + ADF) into a spoke subscription, peered back to
// the DMLZ admin-plane hub deployed by params/tenant-dmlz.bicepparam.
//
// This SAME file deploys both the bureau DLZ AND the optional 2nd demo domain:
// override domainName + --subscription per invocation.
//   • bureau DLZ → DLZ sub  <YOUR_DLZ_SUBSCRIPTION_ID>  domainName=bureau
//   • 2nd demo   → Main sub <YOUR_DEMO_SUBSCRIPTION_ID>  domainName=demo2
//
// Deploy (RG-scoped — a sub-scoped admin-plane deploy CANNOT create RGs in
// other subs, so pre-create the RG first):
//   bash scripts/csa-loom/bootstrap-dlz-rgs.sh eastus2 \
//     "<YOUR_DLZ_SUBSCRIPTION_ID>,<YOUR_DEMO_SUBSCRIPTION_ID>" \
//     "bureau,demo2"
//   az deployment group create \
//     --subscription <YOUR_DLZ_SUBSCRIPTION_ID> \
//     -g rg-csa-loom-dlz-bureau-eastus2 \
//     -f platform/fiab/bicep/modules/landing-zone/main.bicep \
//     -p platform/fiab/bicep/params/dlz-attach.bicepparam \
//     -p domainName=bureau
//
// The four admin-plane handoffs (hub VNet, LAW, catalog endpoint, Console UAMI
// principal) come from the tenant-dmlz deploy outputs — capture them with:
//   az deployment sub show -n <tenant-deploy> \
//     --subscription <YOUR_SUBSCRIPTION_ID> \
//     --query properties.outputs
// then export the LOOM_* env vars below. See docs/fiab/topology-migration.md.

using '../modules/landing-zone/main.bicep'

// --- Identity / placement ---
param location = readEnvironmentVariable('LOOM_LOCATION', 'eastus2')
param boundary = 'Commercial'
// domainName is supplied per-invocation (-p domainName=bureau | demo2); the env
// default lets a single-domain run work without the -p override.
param domainName = readEnvironmentVariable('LOOM_DLZ_DOMAIN', 'bureau')

// --- Orchestration contract (reserved-for-v3.x params on landing-zone; set to
//     match the admin plane so the contract is explicit, per no-vaporware) ---
param containerPlatform = 'containerApps'
param capacitySku = 'F8'
param powerBiSku = 'F64'
param databricksUnityCatalogEnabled = true
param databricksSqlWarehouseEnabled = true
param catalogEndpoint = readEnvironmentVariable('LOOM_CATALOG_ENDPOINT', '')

// --- Admin-plane handoffs (from tenant-dmlz deploy outputs) ---
// adminPlaneHubVnetId: the DMLZ hub VNet the spoke peers to. In the FedCiv
// estate the connectivity hub may live in the ALZ sub
// (<YOUR_CONNECTIVITY_SUBSCRIPTION_ID>) — supply that hub's resource id here
// and the spoke peers under the ALZ platform topology. network.bicep consumes
// it as the spoke-peering remote VNet id.
param adminPlaneHubVnetId = readEnvironmentVariable('LOOM_ADMIN_HUB_VNET_ID', '')
param adminPlaneLawId = readEnvironmentVariable('LOOM_ADMIN_LAW_ID', '')
param adminPlaneAdxClusterRgName = readEnvironmentVariable('LOOM_ADMIN_ADX_RG', 'rg-csa-loom-admin-eastus2')
param adminPlaneAdxClusterName = readEnvironmentVariable('LOOM_ADMIN_ADX_CLUSTER', 'adx-csa-loom-shared')
param adxClusterPrincipalId = readEnvironmentVariable('LOOM_ADMIN_ADX_PRINCIPAL_ID', '')

// Console UAMI handoffs — stamps the Console identity as Synapse SQL admin +
// Cosmos data-plane contributor so the BFF can query the spoke via
// DefaultAzureCredential. Empty values skip the grants (re-provision safe).
param consolePrincipalId = readEnvironmentVariable('LOOM_CONSOLE_PRINCIPAL_ID', '')
param consoleUamiName = readEnvironmentVariable('LOOM_CONSOLE_UAMI_NAME', '')
param consoleUamiAppId = readEnvironmentVariable('LOOM_CONSOLE_UAMI_APP_ID', '')
param activatorPrincipalId = readEnvironmentVariable('LOOM_ACTIVATOR_PRINCIPAL_ID', '')

// Private DNS zones (from admin-plane network outputs object). Each PE in the
// spoke registers into the corresponding zone hosted in/under the DMLZ/ALZ hub.
// Supplied as individual resource ids so the .bicepparam can rebuild the object
// (readEnvironmentVariable returns strings). The Synapse-SQL + ADF zones are
// passed separately because the landing-zone module takes them as scalars.
param adminPlanePrivateDnsZoneIds = {
  blob: readEnvironmentVariable('LOOM_DNS_ZONE_BLOB', '')
  dfs: readEnvironmentVariable('LOOM_DNS_ZONE_DFS', '')
  cosmos: readEnvironmentVariable('LOOM_DNS_ZONE_COSMOS', '')
  cosmosGremlin: readEnvironmentVariable('LOOM_DNS_ZONE_COSMOS_GREMLIN', readEnvironmentVariable('LOOM_DNS_ZONE_COSMOS', ''))
  servicebus: readEnvironmentVariable('LOOM_DNS_ZONE_SERVICEBUS', '')
}
param synapseSqlPrivateDnsZoneId = readEnvironmentVariable('LOOM_DNS_ZONE_SYNAPSE_SQL', '')
param adfPrivateDnsZoneId = readEnvironmentVariable('LOOM_DNS_ZONE_ADF', '')

// --- Spoke network ---
// Each DLZ needs a unique, non-overlapping CIDR (the DMLZ hub is 10.0.0.0/16).
// bureau → 10.100.0.0/16 (module default); 2nd demo → 10.101.0.0/16. Override
// per-invocation with -p spokeVnetCidr= or LOOM_DLZ_SPOKE_CIDR.
param spokeVnetCidr = readEnvironmentVariable('LOOM_DLZ_SPOKE_CIDR', '10.100.0.0/16')

// --- Domain steward group ---
param adminEntraGroupId = readEnvironmentVariable('LOOM_ADMIN_ENTRA_GROUP_ID', '')

// --- Compliance / security ---
param storageRequireCmk = false
param deployAas = bool(readEnvironmentVariable('LOOM_DLZ_DEPLOY_AAS', 'true'))

// Re-provision safety: set true when re-running against an env that already has
// the role grants, to avoid RoleAssignmentExists.
param skipRoleGrants = bool(readEnvironmentVariable('LOOM_SKIP_ROLE_GRANTS', 'false'))

// --- Tags ---
param complianceTags = {
  Environment: 'FedCiv'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  Data_Classification: 'CUI'
  Loom_Tier: 'dlz'
  Loom_Estate: 'fedciv'
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

// ---------- ADOPT-OR-CREATE plan (replaces the per-service EXISTING_* params) ----------
// main.bicep no longer declares 36 `existing*` scalars; it declares ONE `adopt`
// object keyed by the service key in apps/fiab-console/lib/deploy/adoption-catalog.ts.
// That is what freed the ARM parameter budget (251 -> 216 of 256) so networking,
// storage, Log Analytics and ACR adoption become possible at all.
//
// TWO input paths, and the explicit plan always wins:
//
//   1. LOOM_ADOPT_JSON - the whole plan as one JSON document, emitted by
//      `planToArmParameters()` (apps/fiab-console/lib/deploy/plan-to-arm.ts).
//      This is the first-class path every deploy tier uses.
//   2. The legacy per-service EXISTING_* environment variables below, kept
//      working verbatim so byo-wizard.sh / scan-and-deploy.sh / a hand-exported
//      shell keep behaving exactly as before.
//
// `union(legacy, plan)` means a service present in BOTH resolves to the plan's
// decision. A service in NEITHER is absent from the object, and main.bicep's
// `adoptMode()` defaults an absent key to 'create' - so an empty environment
// still produces a complete greenfield deployment.
//
// NOTE: setting an EXISTING_* name now also SUPPRESSES the matching new resource
// (main.bicep's provision<Service> vars). Previously several services - Purview,
// Maps, Foundry, Synapse, Databricks, ADF - rebound the Console env to the
// existing resource while STILL deploying a duplicate beside it.
var legacyAdoptFromEnv = union(
  empty(readEnvironmentVariable('EXISTING_AI_SEARCH_SERVICE', '')) ? {} : { aisearch: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_AI_SEARCH_SERVICE', ''), rg: readEnvironmentVariable('EXISTING_AI_SEARCH_RG', ''), sub: readEnvironmentVariable('EXISTING_AI_SEARCH_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_APIM', '')) ? {} : { apim: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_APIM', ''), rg: readEnvironmentVariable('EXISTING_APIM_RG', ''), sub: readEnvironmentVariable('EXISTING_APIM_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_KUSTO_CLUSTER', '')) ? {} : { adx: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_KUSTO_CLUSTER', ''), rg: readEnvironmentVariable('EXISTING_KUSTO_RG', ''), sub: readEnvironmentVariable('EXISTING_KUSTO_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_AOAI', '')) ? {} : { foundry: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_AOAI', ''), rg: readEnvironmentVariable('EXISTING_AOAI_RG', ''), sub: readEnvironmentVariable('EXISTING_AOAI_SUB', '') }, extra: { chatDeployment: readEnvironmentVariable('EXISTING_AOAI_CHAT_DEPLOYMENT', ''), embedDeployment: readEnvironmentVariable('EXISTING_AOAI_EMBED_DEPLOYMENT', '') } } },
  empty(readEnvironmentVariable('EXISTING_PURVIEW', '')) ? {} : { purview: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_PURVIEW', ''), rg: readEnvironmentVariable('EXISTING_PURVIEW_RG', ''), sub: readEnvironmentVariable('EXISTING_PURVIEW_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_SYNAPSE', '')) ? {} : { synapse: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_SYNAPSE', ''), rg: readEnvironmentVariable('EXISTING_SYNAPSE_RG', ''), sub: readEnvironmentVariable('EXISTING_SYNAPSE_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_COSMOS_ACCOUNT', '')) ? {} : { cosmos: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_COSMOS_ACCOUNT', ''), rg: readEnvironmentVariable('EXISTING_COSMOS_ACCOUNT_RG', ''), sub: readEnvironmentVariable('EXISTING_COSMOS_ACCOUNT_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_EVENTHUB_NAMESPACE', '')) ? {} : { eventhubs: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_EVENTHUB_NAMESPACE', ''), rg: readEnvironmentVariable('EXISTING_EVENTHUB_RG', ''), sub: readEnvironmentVariable('EXISTING_EVENTHUB_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_ASA_JOB', '')) ? {} : { streamanalytics: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_ASA_JOB', ''), rg: readEnvironmentVariable('EXISTING_ASA_RG', ''), sub: readEnvironmentVariable('EXISTING_ASA_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_DATABRICKS', '')) ? {} : { databricks: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_DATABRICKS', ''), rg: readEnvironmentVariable('EXISTING_DATABRICKS_RG', ''), sub: readEnvironmentVariable('EXISTING_DATABRICKS_SUB', '') }, extra: { hostname: readEnvironmentVariable('EXISTING_DATABRICKS_HOSTNAME', '') } } },
  empty(readEnvironmentVariable('EXISTING_ADF', '')) ? {} : { adf: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_ADF', ''), rg: readEnvironmentVariable('EXISTING_ADF_RG', ''), sub: readEnvironmentVariable('EXISTING_ADF_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_ACCOUNT', '')) ? {} : { maps: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_AZURE_MAPS_ACCOUNT', ''), rg: readEnvironmentVariable('EXISTING_AZURE_MAPS_RG', ''), sub: readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_AML_WORKSPACE', '')) ? {} : { aml: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_AML_WORKSPACE', ''), rg: readEnvironmentVariable('EXISTING_AML_RG', ''), sub: readEnvironmentVariable('EXISTING_AML_SUB', '') } } }
)
param adopt = union(legacyAdoptFromEnv, json(readEnvironmentVariable('LOOM_ADOPT_JSON', '{}')))
