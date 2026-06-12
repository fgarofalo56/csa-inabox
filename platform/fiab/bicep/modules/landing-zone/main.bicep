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

@description('Loom Console UAMI application/client id — stamped as the AAS admin SP (app:<appId>@<tenantId>) for datamart-migration targets.')
param consoleUamiAppId string = ''

@description('Deploy an Azure Analysis Services server as the datamart-migration semantic-model target. Default true for full feature parity.')
param deployAas bool = true

@description('AAS SKU for the datamart-migration server.')
param aasSku string = 'B1'

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

@description('Databricks ACCOUNT id (GUID). When set (with a script UAMI that is a Databricks account admin), Unity Catalog is configured by DEFAULT: the regional metastore is created + assigned to the workspace and a default catalog is created, so Browse > Unity Catalog shows a real configured catalog. Empty = UC enabled later via the post-deploy bootstrap workflow (never a hard deploy blocker).')
param databricksAccountId string = ''

@description('Resource id of the UAMI the UC-bootstrap deploymentScript runs as (the Console UAMI). MUST be a Databricks account admin (one-time human grant) for the default-on UC enablement to succeed. Empty = the UC-bootstrap module is skipped.')
param databricksUcScriptUamiId string = ''

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

@description('Soft-delete retention days for ADLS Gen2 blob/directory recovery (OneLake Recycle bin restore window). 1–365. Default 30.')
@minValue(1)
@maxValue(365)
param recycleRetentionDays int = 30

@description('Grant the Console UAMI "Storage Account Contributor" on the DLZ storage account so the OneLake Lifecycle Management rules editor can read/write blob lifecycle policies (managementPolicies/default). Off by default; set true when the lifecycle feature is enabled.')
param consolePrincipalNeedsLifecycleWrite bool = false

@description('Grant the Console UAMI "Storage Account Contributor" on the DLZ storage account so the Customer-Managed Keys (F14) editor can PATCH encryption.keyVaultProperties. Shares the lifecycle role grant. Off by default.')
param consolePrincipalNeedsCmkBind bool = false

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
    recycleRetentionDays: recycleRetentionDays
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
// 3a. Databricks Access Connector MI → Storage Blob Data Contributor on the
//     lakehouse ADLS account. Powers OPTIMIZE / ANALYZE / write-back on Unity
//     Catalog external Delta tables (statistics + maintenance). Connector
//     principalId is empty on GCC-High / IL5 (UC unsupported) → grant no-ops.
// =====================================================================

module databricksStorageRbac 'databricks-storage-rbac.bicep' = {
  name: 'dlz-databricks-storage-rbac'
  params: {
    storageAccountName: storage.outputs.storageAccountName
    accessConnectorPrincipalId: databricks.outputs.accessConnectorPrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// =====================================================================
// 3b. Unity Catalog configured by DEFAULT
//     Creates/assigns the regional UC metastore + a default catalog + grants
//     the Console UAMI account_admin, so Browse > Unity Catalog shows a real
//     configured catalog after a stock deploy. Only runs where UC is supported
//     (Commercial + GCC) AND an account id + a script UAMI (Databricks account
//     admin) are supplied. Otherwise skipped — the workspace still exists and UC
//     can be enabled later via the post-deploy bootstrap workflow (honest,
//     non-blocking per no-vaporware.md). Mirror of
//     scripts/csa-loom/enable-unity-catalog.sh — keep the two in sync.
// =====================================================================

// Unity Catalog is supported only on Commercial + GCC (mirrors the
// `ucSupported` var in databricks.bicep). Compute it locally from the boundary
// param so the module `if`-condition is resolvable at the START of deployment —
// reading databricks.outputs.ucSupported here triggers BCP177 (module outputs
// are not known up-front) and fails `az bicep build` for every boundary.
var dlzUcSupported = boundary == 'Commercial' || boundary == 'GCC'

module databricksUcBootstrap 'databricks-uc-bootstrap.bicep' = if (dlzUcSupported && !empty(databricksAccountId) && !empty(databricksUcScriptUamiId) && !empty(consoleUamiAppId)) {
  name: 'dlz-databricks-uc-bootstrap'
  params: {
    location: location
    databricksAccountId: databricksAccountId
    workspaceNumericId: databricks.outputs.workspaceNumericId
    workspaceHost: databricks.outputs.workspaceHost
    consoleUamiClientId: consoleUamiAppId
    scriptUamiId: databricksUcScriptUamiId
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
// 4a1b. Azure Analysis Services — datamart-migration semantic-model target.
//       Datamarts are deprecated; the migrate route provisions a Synapse
//       Serverless DB + this AAS server as the Azure-native replacement.
//       No Fabric / Power BI capacity required.
// =====================================================================

module aas 'aas.bicep' = if (deployAas) {
  name: 'dlz-aas'
  params: {
    location: location
    domainName: domainName
    aasSku: aasSku
    consolePrincipalId: consolePrincipalId
    consoleUamiAppId: consoleUamiAppId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

// =====================================================================
// 4a2. Console UAMI constrained RBAC Administrator on lakehouse storage
//      (F16 access-request approval final tier — delegate Storage Blob
//       Data roles only, via an ABAC condition; no self-escalation).
// =====================================================================

module storageRbacAdmin 'storage-rbac-admin.bicep' = {
  name: 'dlz-storage-rbac-admin'
  params: {
    storageAccountName: storage.outputs.storageAccountName
    consolePrincipalId: consolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// =====================================================================
// 4a3. Console UAMI "Storage Account Contributor" on lakehouse storage
//      (OneLake Lifecycle Management rules editor — read/write
//       managementPolicies/default via the ARM management plane). Off by
//       default; enabled via consolePrincipalNeedsLifecycleWrite.
// =====================================================================

module storageLifecycleRbac 'storage-lifecycle-rbac.bicep' = {
  name: 'dlz-storage-lifecycle-rbac'
  params: {
    storageAccountName: storage.outputs.storageAccountName
    consolePrincipalId: consolePrincipalId
    consolePrincipalNeedsLifecycleWrite: consolePrincipalNeedsLifecycleWrite
    consolePrincipalNeedsCmkBind: consolePrincipalNeedsCmkBind
    skipRoleGrants: skipRoleGrants
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
    // Sovereign-cloud ARM host so the auto-pause Logic App targets the correct
    // management plane (Commercial vs Gov), matching LOOM_ARM_ENDPOINT.
    loomArmEndpoint: boundary == 'GCC-High' || boundary == 'IL5' ? 'https://management.usgovcloudapi.net' : 'https://management.azure.com'
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
    // ADF factory MI gets Azure Event Hubs Data Sender so Eventstream "CDC"
    // source pipelines can write change events to namespace Event Hubs.
    adfPrincipalId: (adfEnabled && !empty(consolePrincipalId) && !empty(adfPrivateDnsZoneId)) ? adf!.outputs.factoryPrincipalId : ''
    adxClusterPrincipalId: adxClusterPrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

// Business Events — Event Grid custom topic for the /business-events publishing
// surface (Azure-native Activator structured signals). Fans out to the
// telemetry Event Hub so published business events are also durable + appear in
// the Real-Time hub. Console UAMI granted EventGrid Data Sender + Contributor.
module eventgridBusiness 'eventgrid-business.bicep' = {
  name: 'dlz-eventgrid-business'
  params: {
    location: location
    consolePrincipalId: consolePrincipalId
    eventHubResourceId: '${eventhubs.outputs.namespaceId}/eventhubs/${eventhubs.outputs.telemetryHubName}'
    workspaceId: adminPlaneLawId
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
// 8b. Azure Analysis Services — OPTIONAL azure-native semantic engine.
//
//     One AAS server backs BOTH the semantic-model "Model view" XMLA write
//     path (relationships + drill hierarchies) AND the "Get data" (Power
//     Query M) ingest refresh phase. Per no-fabric-dependency.md the
//     semantic model works fully without this (Loom-native Cosmos backend is
//     the default). AAS is the azure-native, no-Fabric option for a live
//     tabular engine; opt in with enableAas=true and wire the xmlaEndpoint /
//     aasConnectionString outputs into LOOM_AAS_XMLA_ENDPOINT / LOOM_AAS_SERVER.
//
//     Commercial only — AAS has no Government offering. Leave enableAas false
//     in GCC-High / DoD (the Console gates the AAS phases honestly there). The
//     Console UAMI must be listed in aasServerAdminMembers as
//     `app:<clientId>@<tenantId>` so its MI can call the XMLA / refresh REST APIs.
// =====================================================================

@description('Provision an Azure Analysis Services server (opt-in). Backs the optional XMLA write path of the Loom semantic-model Model view AND the Power Query "Get data" ingest refresh phase. Default OFF — the Loom-native Cosmos backend works without it. Commercial only — leave false in Government clouds.')
param enableAas bool = false

@description('Analysis Services SKU. D1 = Developer (cheapest); B1/B2 = Basic; S0/S1 = Standard query pools.')
param aasSkuName string = 'D1'

@description('AAS server administrator identifiers (UPNs / `app:<clientId>@<tenantId>` SPNs). The Console UAMI must be included so its MI can call the XMLA write / refresh REST APIs. Empty = the editor honestly gates the live-engine write; the Loom-native Cosmos path still works.')
param aasServerAdminMembers array = []

module aasRlsOls 'aas.bicep' = if (enableAas) {
  name: 'dlz-aas-rls-ols'
  params: {
    name: toLower(take('aas${domainName}${uniqueString(resourceGroup().id)}', 63))
    location: location
    skuName: aasSkuName
    serverAdminMembers: aasServerAdminMembers
    complianceTags: complianceTags
  }
}


//
//    Per the 2026-05-27 no-cuts-sweep policy override, ADF is now wired
//    into the DLZ orchestrator by default. Operators that don't run ADF
//    workflows can set `adfEnabled=false`.
// =====================================================================

@description('Provision an Azure Data Factory (v2) in the DLZ. Backs the Loom data-pipeline / dataset / trigger editors.')
param adfEnabled bool = true

@description('Deploy the "loom-geo-enrich" starter pipeline (enrichH3/reverseGeocode/bufferMeters parameters) in the DLZ factory so the GeoPipeline editor has a ready target. Default true.')
param deployGeoEnrichPipeline bool = true

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
    deployGeoEnrichPipeline: deployGeoEnrichPipeline
  }
}

// =====================================================================
// (Azure Analysis Services is provisioned by the unified `aas` module above
//  — section 8b. The Power Query ingest refresh phase and the Model view XMLA
//  write path share that single server. No separate AAS module here.)
// =====================================================================

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
    boundary: boundary
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
// 11. Weave (Semantic Ontology) graph store — PostgreSQL + Apache AGE
//
// Backs the Weave object/link/action *instance* write-back (the ontology
// editor's Objects / Write-back actions surfaces → lib/azure/
// weave-ontology-store.ts → ag_catalog cypher). Default-on: Palantir-class
// ontology write-back REQUIRES a graph store, so it ships by default (mirrors
// cosmosGraphVectorEnabled). The post-deploy bootstrap then runs
// CREATE EXTENSION AGE + create_graph + pgaadauth_create_principal.
// =====================================================================

@description('Provision the Weave ontology PostgreSQL + Apache AGE graph store to back object/link/action instance write-back. Default on — Palantir-class ontology write-back requires the graph store.')
param weaveOntologyEnabled bool = true

module postgresWeave 'postgres-weave.bicep' = if (weaveOntologyEnabled) {
  name: 'dlz-postgres-weave'
  params: {
    location: location
    boundary: boundary
    domainName: domainName
    consolePrincipalId: consolePrincipalId
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
output synapseSqlEndpoint string = synapse.outputs.synapseSqlEndpoint
output synapseWorkspaceName string = synapse.outputs.synapseWorkspaceName
output synapseDedicatedPoolName string = synapse.outputs.dedicatedPoolName
// Spark identities for the notebook AI-functions grant (orchestrator wires
// these into admin-plane/aoai-spark-rbac.bicep so PySpark cells can call AOAI).
output synapseManagedIdentityPrincipalId string = synapse.outputs.synapseManagedIdentityPrincipalId
output databricksAccessConnectorPrincipalId string = databricks.outputs.accessConnectorPrincipalId
output storageAccountName string = storage.outputs.storageAccountName
output dlzResourceGroupName string = resourceGroup().name
output adxDatabaseUrl string = adxEnabled ? adx!.outputs.databaseUri : ''
output lakehouseDfsEndpoint string = storage.outputs.dfsEndpoint
output bronzeContainerUrl string = storage.outputs.bronzeContainerUrl
output silverContainerUrl string = storage.outputs.silverContainerUrl
output goldContainerUrl string = storage.outputs.goldContainerUrl
output landingContainerUrl string = storage.outputs.landingContainerUrl
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

// Weave (Semantic Ontology) graph store outputs — wired to the Console env
// (LOOM_WEAVE_PG_FQDN / LOOM_WEAVE_PG_DATABASE) by the admin-plane.
output weavePgServerName string = weaveOntologyEnabled ? postgresWeave!.outputs.weavePgServerName : ''
output weavePgFqdn string = weaveOntologyEnabled ? postgresWeave!.outputs.weavePgFqdn : ''
output weavePgDatabase string = weaveOntologyEnabled ? postgresWeave!.outputs.weavePgDatabase : ''

// CSA Loom no-cuts-sweep — ADF wiring outputs
output adfFactoryId string = (adfEnabled && !empty(consolePrincipalId) && !empty(adfPrivateDnsZoneId)) ? adf!.outputs.factoryId : ''
output adfFactoryName string = (adfEnabled && !empty(consolePrincipalId) && !empty(adfPrivateDnsZoneId)) ? adf!.outputs.factoryName : ''
output approvalLogicAppName string = approvalLogicAppEnabled ? approvalLogicApp!.outputs.workflowName : ''
output adfFactoryPrincipalId string = (adfEnabled && !empty(consolePrincipalId) && !empty(adfPrivateDnsZoneId)) ? adf!.outputs.factoryPrincipalId : ''
// CSA Loom semantic-model AAS (opt-in) — empty when enableAas is false. One
// server backs both the Model view XMLA write path and the Power Query ingest
// refresh. xmlaEndpoint → LOOM_AAS_XMLA_ENDPOINT; aasConnectionString →
// LOOM_AAS_SERVER (LOOM_AAS_MODEL is set per deployed tabular model by the operator).
output aasXmlaEndpoint string = enableAas ? aas!.outputs.xmlaEndpoint : ''
output aasServerName string = enableAas ? aas!.outputs.serverName : ''
output aasConnectionString string = enableAas ? aas!.outputs.aasConnectionString : ''
