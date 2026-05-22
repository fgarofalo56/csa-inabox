// CSA Loom — Data Landing Zone orchestrator
// Deployment scope: resource group (rg-csa-loom-dlz-<domain>-<region>)
// Per-DLZ; one instance per domain in multi-sub mode
//
// Status: SCAFFOLDED — module stubs in this folder; real Bicep
// implementations land via PRP-02.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Cloud boundary')
param boundary string

@description('Domain name (Finance / Procurement / Mission Ops / etc.)')
param domainName string

@description('Container platform')
param containerPlatform string

@description('Capacity SKU')
param capacitySku string

@description('Admin Plane hub VNet ID for spoke peering')
param adminPlaneHubVnetId string

@description('Catalog endpoint from Admin Plane')
param catalogEndpoint string

@description('Databricks UC managed enabled')
param databricksUnityCatalogEnabled bool

@description('Databricks SQL Warehouse enabled')
param databricksSqlWarehouseEnabled bool

@description('Storage requires CMK (IL5)')
param storageRequireCmk bool

@description('Power BI SKU')
param powerBiSku string

@description('Compliance tags')
param complianceTags object

// =====================================================================
// Module stubs — each placeholder; real implementations land via PRP-02
// =====================================================================

// 1. Spoke VNet (peered to Admin Plane hub)

// 2. Databricks workspace (Premium; UC managed conditional on boundary)

// 3. Synapse workspace (Serverless SQL pool only)

// 4. ADX database (on the shared cluster in Admin Plane)

// 5. ADLS Gen2 storage accounts (per-workspace; HSM-CMK at IL5)

// 6. Power BI workspace (via Power BI REST — no ARM provider)

// 7. Activator Engine (Container App or AKS workload)

// 8. Mirroring Engine (Container App or AKS workload)

// 9. Direct-Lake Shim (Container App or AKS workload)

// 10. Workspace identity (UAMI for workspace items)

// 11. Metadata (KV + SQL DB for orchestration state) — reuse from
//     Azure/data-landing-zone/modules/metadata.bicep

// 12. Logging (LAW workspace) — reuse from
//     Azure/data-landing-zone/modules/logging.bicep

// 13. Runtimes (SHIR for on-prem connectivity — opt-in)

// =====================================================================
// Outputs
// =====================================================================

output spokeVnetId string = 'PLACEHOLDER-spoke-vnet-resource-id'
output databricksWorkspaceUrl string = 'https://PLACEHOLDER.azuredatabricks.net'
output synapseEndpoint string = 'PLACEHOLDER-synapse-serverless-endpoint'
output adxDatabaseUrl string = 'PLACEHOLDER-adx-database'
