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
//   • bureau DLZ → DLZ sub  363ef5d1-0e77-4594-a530-f51af23dbf8c  domainName=bureau
//   • 2nd demo   → Main sub ca2b3e6b-f892-4c57-b9d8-b64e5799f9ea  domainName=demo2
//
// Deploy (RG-scoped — a sub-scoped admin-plane deploy CANNOT create RGs in
// other subs, so pre-create the RG first):
//   bash scripts/csa-loom/bootstrap-dlz-rgs.sh eastus2 \
//     "363ef5d1-0e77-4594-a530-f51af23dbf8c,ca2b3e6b-f892-4c57-b9d8-b64e5799f9ea" \
//     "bureau,demo2"
//   az deployment group create \
//     --subscription 363ef5d1-0e77-4594-a530-f51af23dbf8c \
//     -g rg-csa-loom-dlz-bureau-eastus2 \
//     -f platform/fiab/bicep/modules/landing-zone/main.bicep \
//     -p platform/fiab/bicep/params/dlz-attach.bicepparam \
//     -p domainName=bureau
//
// The four admin-plane handoffs (hub VNet, LAW, catalog endpoint, Console UAMI
// principal) come from the tenant-dmlz deploy outputs — capture them with:
//   az deployment sub show -n <tenant-deploy> \
//     --subscription e093f4fd-5047-4ee4-968d-a56942c665f3 \
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
// (a60a2fdd-c133-4845-9beb-31f470bf3ef5) — supply that hub's resource id here
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
