// CSA Loom — Data Landing Zone orchestrator
// Deployment scope: resource group (rg-csa-loom-dlz-<domain>-<region>)

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Cloud boundary')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Domain name (Finance / Procurement / Mission Ops / etc.)')
param domainName string

@description('Container platform')
@allowed(['containerApps', 'aks'])
param containerPlatform string

@description('Capacity SKU')
param capacitySku string

@description('Admin Plane hub VNet ID for spoke peering')
param adminPlaneHubVnetId string

@description('Admin Plane Log Analytics workspace ID — every DLZ resource ships diagnostic settings here')
param adminPlaneLawId string

@description('Admin Plane App Insights connection string — every DLZ app emits telemetry here')
param adminPlaneAppInsightsConnectionString string = ''

@description('Admin Plane private DNS zones object (from network module outputs)')
param adminPlanePrivateDnsZoneIds object = {}

@description('Admin Plane ADX cluster name (for ADX database creation)')
param adminPlaneAdxClusterName string = 'adx-csa-loom-shared'

@description('Admin Plane ADX cluster RG')
param adminPlaneAdxClusterRgName string

@description('Admin Entra group object ID')
param adminEntraGroupId string

@description('Activator UAMI principal ID (from Admin Plane)')
param activatorPrincipalId string = ''

@description('Catalog endpoint from Admin Plane')
param catalogEndpoint string

@description('Databricks UC managed enabled')
param databricksUnityCatalogEnabled bool

@description('Databricks SQL Warehouse enabled')
param databricksSqlWarehouseEnabled bool

@description('Storage requires CMK (IL5)')
param storageRequireCmk bool

@description('Storage CMK key URI (required if storageRequireCmk)')
param storageCmkKeyUri string = ''

@description('Storage CMK UAMI ID (required if storageRequireCmk)')
param storageCmkIdentityId string = ''

@description('Power BI SKU')
param powerBiSku string

@description('Spoke VNet CIDR (must not overlap Admin Plane hub which is 10.0.0.0/16). Default is 10.100.0.0/16 for the single-sub DLZ; operator overrides for multi-DLZ deployments.')
param spokeVnetCidr string = '10.100.0.0/16'

@description('Compliance tags')
param complianceTags object

// =====================================================================
// 1. Spoke VNet (peered to Admin Plane hub)
// =====================================================================

module network 'network.bicep' = {
  name: 'dlz-network'
  params: {
    location: location
    domainName: domainName
    spokeVnetCidr: spokeVnetCidr
    adminPlaneHubVnetId: adminPlaneHubVnetId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 2. ADLS Gen2 storage account (the actual lakehouse)
// =====================================================================

module storage 'storage.bicep' = {
  name: 'dlz-storage'
  params: {
    location: location
    domainName: domainName
    requireCmk: storageRequireCmk
    cmkKeyUri: storageCmkKeyUri
    cmkIdentityId: storageCmkIdentityId
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneBlobId: adminPlanePrivateDnsZoneIds.blob
    privateDnsZoneDfsId: adminPlanePrivateDnsZoneIds.dfs
    workspaceId: adminPlaneLawId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 3. Databricks workspace
// =====================================================================

module databricks 'databricks.bicep' = {
  name: 'dlz-databricks'
  params: {
    location: location
    domainName: domainName
    spokeVnetName: network.outputs.spokeVnetName
    privateSubnetName: network.outputs.databricksPrivateSubnetName
    publicSubnetName: network.outputs.databricksPublicSubnetName
    boundary: boundary
    storageCmkKeyUri: storageCmkKeyUri
    workspaceId: adminPlaneLawId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 4. Synapse workspace (Serverless SQL pool)
// =====================================================================

module synapse 'synapse.bicep' = {
  name: 'dlz-synapse'
  params: {
    location: location
    domainName: domainName
    defaultStorageAccountName: storage.outputs.storageAccountName
    adminEntraGroupId: adminEntraGroupId
    workspaceId: adminPlaneLawId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 5. Event Hubs namespace (Kafka surface for Mirroring CDC)
// =====================================================================

module eventhubs 'eventhubs.bicep' = {
  name: 'dlz-eventhubs'
  params: {
    location: location
    domainName: domainName
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneServicebusId: adminPlanePrivateDnsZoneIds.servicebus
    workspaceId: adminPlaneLawId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 6. ADX database (on the Admin Plane shared cluster)
// =====================================================================

@description('Deploy ADX database (requires admin-plane ADX cluster to exist). Default off until ADX cluster is provisioned.')
param adxEnabled bool = false

module adx 'adx.bicep' = if (adxEnabled) {
  name: 'dlz-adx-db'
  params: {
    domainName: domainName
    adxClusterName: adminPlaneAdxClusterName
    adxClusterRgName: adminPlaneAdxClusterRgName
    adxClusterLocation: location
    adminEntraGroupId: adminEntraGroupId
    activatorPrincipalId: activatorPrincipalId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 7. Cosmos DB for application state
// =====================================================================

module cosmos 'cosmos.bicep' = {
  name: 'dlz-cosmos'
  params: {
    location: location
    domainName: domainName
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneCosmosId: adminPlanePrivateDnsZoneIds.cosmos
    workspaceId: adminPlaneLawId
    complianceTags: complianceTags
  }
}

// =====================================================================
// Outputs
// =====================================================================

output spokeVnetId string = network.outputs.spokeVnetId
output databricksWorkspaceUrl string = databricks.outputs.workspaceUrl
output databricksWorkspaceId string = databricks.outputs.workspaceId
output synapseEndpoint string = synapse.outputs.synapseServerlessSqlEndpoint
output adxDatabaseUrl string = adxEnabled ? adx!.outputs.databaseUri : ''
output lakehouseDfsEndpoint string = storage.outputs.dfsEndpoint
output bronzeContainerUrl string = storage.outputs.bronzeContainerUrl
output silverContainerUrl string = storage.outputs.silverContainerUrl
output goldContainerUrl string = storage.outputs.goldContainerUrl
output landingZoneContainerUrl string = storage.outputs.landingZoneContainerUrl
output eventHubsNamespaceFqdn string = eventhubs.outputs.namespaceFqdn
output cosmosEndpoint string = cosmos.outputs.endpoint
output storageEventGridTopicId string = storage.outputs.eventGridTopicId
