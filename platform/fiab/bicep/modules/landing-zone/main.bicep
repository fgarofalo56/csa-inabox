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

@description('Container platform. Reserved for v3.x — DLZ resources do not host workloads directly; param is preserved for orchestration contract with admin-plane main.bicep.')
@allowed(['containerApps', 'aks'])
#disable-next-line no-unused-params
param containerPlatform string

@description('Capacity SKU. Reserved for v3.x — Fabric capacity sizing flows through admin plane today.')
#disable-next-line no-unused-params
param capacitySku string

@description('Admin Plane hub VNet ID for spoke peering')
param adminPlaneHubVnetId string

@description('Admin Plane Log Analytics workspace ID — every DLZ resource ships diagnostic settings here')
param adminPlaneLawId string

@description('Admin Plane App Insights connection string — every DLZ app emits telemetry here. Reserved for v3.x — DLZ modules read this from adminPlaneLawId today; explicit AI connection string will be passed once DLZ container workloads land.')
#disable-next-line no-unused-params
param adminPlaneAppInsightsConnectionString string = ''

@description('Admin Plane private DNS zones object (from network module outputs)')
param adminPlanePrivateDnsZoneIds object = {}

@description('Loom Console UAMI principal ID — set as Synapse SQL admin so the BFF can query via DefaultAzureCredential.')
param consolePrincipalId string = ''

@description('Loom Console UAMI name — used for the SQL admin login (must match the UAMI resource).')
param consoleUamiName string = ''

@description('Admin Plane spoke private DNS zone ID for privatelink.sql.azuresynapse.net. Required for the Synapse SQL PE to register DNS.')
param synapseSqlPrivateDnsZoneId string = ''

@description('Admin Plane spoke private DNS zone ID for privatelink.adf.azure.com (Commercial). Required for the ADF PE to register DNS.')
param adfPrivateDnsZoneId string = ''

@description('Admin Plane ADX cluster name (for ADX database creation)')
param adminPlaneAdxClusterName string = 'adx-csa-loom-shared'

@description('Admin Plane ADX cluster RG')
param adminPlaneAdxClusterRgName string

@description('ADX cluster system-assigned MI principal ID (from admin-plane adx-cluster.bicep output clusterPrincipalId). Threaded to eventhubs.bicep to grant Azure Event Hubs Data Receiver on the namespace so KQL-database Event Hub data connections work without SAS. Empty skips the grant (BYO/existing cluster: bootstrap the grant manually — see docs/fiab/v3-tenant-bootstrap.md).')
param adxClusterPrincipalId string = ''

@description('Admin Entra group object ID')
param adminEntraGroupId string

@description('Activator UAMI principal ID (from Admin Plane)')
param activatorPrincipalId string = ''

@description('Catalog endpoint from Admin Plane. Reserved for v3.x — Purview-backed DLZ scan job wiring is deferred; today scans are configured from the admin plane catalog module.')
#disable-next-line no-unused-params
param catalogEndpoint string

@description('Databricks UC managed enabled. Reserved for v3.x — Unity Catalog managed-vs-external mode is configured in databricks.bicep; this orchestrator-level flag is preserved for symmetry with admin plane.')
#disable-next-line no-unused-params
param databricksUnityCatalogEnabled bool

@description('Databricks SQL Warehouse enabled. Reserved for v3.x — DBSQL warehouse creation happens via SCIM bootstrap module today.')
#disable-next-line no-unused-params
param databricksSqlWarehouseEnabled bool

@description('Storage requires CMK (IL5)')
param storageRequireCmk bool

@description('Storage CMK key URI (required if storageRequireCmk)')
param storageCmkKeyUri string = ''

@description('Storage CMK UAMI ID (required if storageRequireCmk)')
param storageCmkIdentityId string = ''

@description('Power BI SKU. Reserved for v3.x — Power BI capacity is provisioned in admin plane; preserved here for orchestrator contract.')
#disable-next-line no-unused-params
param powerBiSku string

@description('Spoke VNet CIDR (must not overlap Admin Plane hub which is 10.0.0.0/16). Default is 10.100.0.0/16 for the single-sub DLZ; operator overrides for multi-DLZ deployments.')
param spokeVnetCidr string = '10.100.0.0/16'

@description('Compliance tags')
param complianceTags object

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

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
    consolePrincipalId: consolePrincipalId
    consoleUamiName: consoleUamiName
    workspaceId: adminPlaneLawId
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    synapseSqlPrivateDnsZoneId: synapseSqlPrivateDnsZoneId
    adxClusterPrincipalId: adxClusterPrincipalId
  }
}

// =====================================================================
// 4b. Synapse Dedicated SQL pool auto-pause (Logic App)
// =====================================================================

module synapseAutoPause 'synapse-auto-pause.bicep' = {
  name: 'dlz-synapse-autopause'
  params: {
    location: location
    domainName: domainName
    synapseWorkspaceName: synapse.outputs.synapseWorkspaceName
    dedicatedPoolName: synapse.outputs.dedicatedPoolName
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
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
    consolePrincipalId: consolePrincipalId
    adxClusterPrincipalId: adxClusterPrincipalId
    skipRoleGrants: skipRoleGrants
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
    consolePrincipalId: consolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

// =====================================================================
// 8. Stream Analytics. Backs the Loom stream-analytics-job editor
//    (added in the Data Engineering sweep, 2026-05-27).
//
//    Per the 2026-05-27 no-cuts-sweep policy override, this is now
//    ENABLED by default. Operators on cost-sensitive deployments can
//    set `enableStreamAnalytics=false` to skip the starter job + UAMI
//    role assignment. When off, the Loom editor surfaces an honest
//    501 MessageBar naming this module + the LOOM_ASA_RG env var.
// =====================================================================

@description('Provision an Azure Stream Analytics starter job + UAMI role assignment. Backs the Loom stream-analytics-job editor.')
param enableStreamAnalytics bool = true

module streamAnalytics 'stream-analytics.bicep' = if (enableStreamAnalytics && !empty(consolePrincipalId)) {
  name: 'dlz-stream-analytics'
  params: {
    location: location
    domainName: domainName
    consolePrincipalId: consolePrincipalId
    workspaceId: adminPlaneLawId
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    // ASA Lakehouse/Blob output writes to the DLZ ADLS Gen2 account via MSI
    // (Storage Blob Data Contributor granted in the module).
    adlsAccountName: storage.outputs.storageAccountName
    // ADX cluster backing KQL Database outputs (ingestor grant is a Kusto
    // control-plane step surfaced via module output for the bootstrap).
    adxClusterName: adminPlaneAdxClusterName
  }
}

// =====================================================================
// 9. Azure Data Factory — backs the data-pipeline / dataset / trigger editors
//
//    Per the 2026-05-27 no-cuts-sweep policy override, ADF is now wired
//    into the DLZ orchestrator by default. Operators that don't run ADF
//    workflows can set `adfEnabled=false`.
// =====================================================================

@description('Provision an Azure Data Factory (v2) in the DLZ. Backs the Loom data-pipeline / dataset / trigger editors.')
param adfEnabled bool = true

module adf 'adf.bicep' = if (adfEnabled && !empty(consolePrincipalId) && !empty(adfPrivateDnsZoneId)) {
  name: 'dlz-adf'
  params: {
    location: location
    domainName: domainName
    consolePrincipalId: consolePrincipalId
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    adfPrivateDnsZoneId: adfPrivateDnsZoneId
    workspaceId: adminPlaneLawId
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    // Grant the ADF factory MSI Storage Blob Data Contributor on the DLZ storage
    // account so MSI-auth linked services can read/write ADLS Gen2 (backs the
    // "Practice with sample data" copy pipeline) and Dataflow Gen2 Parquet/CSV sinks.
    storageAccountId: storage.outputs.storageAccountId
    adlsAccountName: storage.outputs.storageAccountName
  }
}

// =====================================================================
// 9a. Approval Logic App (F25) — Consumption Logic App + O365 Outlook
//
// Backs the pipeline editor's Approval activity: an ADF/Synapse WebHook
// activity POSTs to this Logic App's HTTP trigger; the Logic App sends an
// Office 365 approval email and calls back the ADF callBackUri (Approve →
// continue, Reject → fail). Azure-native — no Fabric / Power Automate.
// Deterministic name `logic-loom-approval-<region>` so the Console targets it
// via LOOM_APPROVAL_LOGIC_APP_NAME (defaulted in admin-plane/main.bicep). The
// O365 connection is authorized post-deploy (see the module header + bootstrap).
// =====================================================================

@description('Provision the approval Logic App (F25) backing the pipeline Approval activity.')
param approvalLogicAppEnabled bool = true

module approvalLogicApp '../integration/approval-logicapp.bicep' = if (approvalLogicAppEnabled) {
  name: 'dlz-approval-logicapp'
  params: {
    location: location
    consolePrincipalId: consolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

// =====================================================================
// 9b. Scaled Self-Hosted Integration Runtime (VMSS, scale-to-0)
//
// A shared 4-node self-hosted IR for the DLZ that costs nothing while idle:
// the VMSS sits at 0 instances and Loom scales it up only when a pipeline runs.
// Registers the IR on the DLZ Data Factory. Enabled by default but only deploys
// once an admin password is supplied (a VMSS needs a local credential) — supply
// `shirAdminPassword` from Key Vault at deploy. Honest gate per no-vaporware.
// =====================================================================

@description('Provision the scaled self-hosted IR (VMSS, scale-to-0) on the DLZ Data Factory.')
param selfHostedIrEnabled bool = true

@description('Local admin password for the SHIR VMSS nodes. Supply from Key Vault. Empty = SHIR not deployed (honest gate).')
@secure()
param shirAdminPassword string = ''

@description('Target SHIR node count (the cluster scales 0↔this on demand).')
param shirMaxNodes int = 4

module shir 'shir.bicep' = if (selfHostedIrEnabled && adfEnabled && !empty(consolePrincipalId) && !empty(adfPrivateDnsZoneId) && !empty(shirAdminPassword)) {
  name: 'dlz-shir'
  params: {
    location: location
    domainName: domainName
    dataFactoryName: adf.outputs.factoryName
    subnetId: network.outputs.workloadsSubnetId
    adminPassword: shirAdminPassword
    maxNodes: shirMaxNodes
    consolePrincipalId: consolePrincipalId
    skipRoleGrants: skipRoleGrants
    workspaceId: adminPlaneLawId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 10. Cosmos Gremlin + NoSQL vector containers
//
// Backs the `cosmos-gremlin-graph` and `vector-store` editors. Opt-in via
// the `cosmosGraphVectorEnabled` flag so deployments that don't need graph
// + vector workloads avoid the extra cost.
// =====================================================================

@description('Provision Cosmos Gremlin + NoSQL vector accounts to back the cosmos-gremlin-graph and vector-store editors.')
param cosmosGraphVectorEnabled bool = true

module cosmosGraphVector 'cosmos-graph-vector.bicep' = if (cosmosGraphVectorEnabled) {
  name: 'dlz-cosmos-graph-vector'
  params: {
    location: location
    domainName: domainName
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneCosmosId: adminPlanePrivateDnsZoneIds.cosmos
    // Caller is expected to add a privatelink.gremlin.cosmos.azure.com zone
    // to `adminPlanePrivateDnsZoneIds`. Older admin-planes that haven't
    // shipped that zone yet fall back to the SQL Cosmos zone (the Gremlin
    // PE then registers but DNS won't resolve — documented honest-gate
    // until the network module is bumped).
    privateDnsZoneCosmosGremlinId: contains(adminPlanePrivateDnsZoneIds, 'cosmosGremlin') ? adminPlanePrivateDnsZoneIds.cosmosGremlin : adminPlanePrivateDnsZoneIds.cosmos
    workspaceId: adminPlaneLawId
    consolePrincipalId: consolePrincipalId
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
  }
}

// =====================================================================
// Outputs
// =====================================================================

output spokeVnetId string = network.outputs.spokeVnetId
output databricksWorkspaceUrl string = databricks.outputs.workspaceUrl
output databricksWorkspaceId string = databricks.outputs.workspaceId
output synapseEndpoint string = synapse.outputs.synapseServerlessSqlEndpoint
output synapseSqlEndpoint string = synapse.outputs.synapseSqlEndpoint
output synapseWorkspaceName string = synapse.outputs.synapseWorkspaceName
output synapseDedicatedPoolName string = synapse.outputs.dedicatedPoolName
output storageAccountName string = storage.outputs.storageAccountName
output dlzResourceGroupName string = resourceGroup().name
output adxDatabaseUrl string = adxEnabled ? adx!.outputs.databaseUri : ''
output lakehouseDfsEndpoint string = storage.outputs.dfsEndpoint
output bronzeContainerUrl string = storage.outputs.bronzeContainerUrl
output silverContainerUrl string = storage.outputs.silverContainerUrl
output goldContainerUrl string = storage.outputs.goldContainerUrl
output landingZoneContainerUrl string = storage.outputs.landingZoneContainerUrl
output eventHubsNamespaceFqdn string = eventhubs.outputs.namespaceFqdn
output cosmosEndpoint string = cosmos.outputs.endpoint
output storageEventGridTopicId string = storage.outputs.eventGridTopicId

// CSA Loom family — Power Platform / ML / Geo / Graph sweep outputs
output cosmosGremlinEndpoint string = cosmosGraphVectorEnabled ? cosmosGraphVector!.outputs.gremlinEndpoint : ''
output cosmosGremlinDatabase string = cosmosGraphVectorEnabled ? cosmosGraphVector!.outputs.gremlinDatabase : ''
output cosmosGremlinGraph string = cosmosGraphVectorEnabled ? cosmosGraphVector!.outputs.gremlinGraph : ''
output cosmosVectorEndpoint string = cosmosGraphVectorEnabled ? cosmosGraphVector!.outputs.vectorEndpoint : ''
output cosmosVectorDatabase string = cosmosGraphVectorEnabled ? cosmosGraphVector!.outputs.vectorDatabase : ''
output cosmosVectorContainer string = cosmosGraphVectorEnabled ? cosmosGraphVector!.outputs.vectorDefaultContainer : ''

// CSA Loom no-cuts-sweep — ADF wiring outputs
output adfFactoryId string = (adfEnabled && !empty(consolePrincipalId) && !empty(adfPrivateDnsZoneId)) ? adf!.outputs.factoryId : ''
output adfFactoryName string = (adfEnabled && !empty(consolePrincipalId) && !empty(adfPrivateDnsZoneId)) ? adf!.outputs.factoryName : ''
output approvalLogicAppName string = approvalLogicAppEnabled ? approvalLogicApp!.outputs.workflowName : ''
output adfFactoryPrincipalId string = (adfEnabled && !empty(consolePrincipalId) && !empty(adfPrivateDnsZoneId)) ? adf!.outputs.factoryPrincipalId : ''
