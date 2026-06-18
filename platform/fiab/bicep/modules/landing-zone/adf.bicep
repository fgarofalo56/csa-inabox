// CSA Loom DLZ — Azure Data Factory (v2)
//
// Per v2 plan: ADF deployed into the DLZ to back the Loom ADF editors
// (Pipeline / Dataset / Trigger). Public access disabled; reached over
// the spoke PE subnet from Loom Console via hub→spoke peering.
//
// Posture (consistent with sibling DLZ modules):
//   - System-assigned identity (so ADF can reach linked services via MI later)
//   - publicNetworkAccess: Disabled (private link only)
//   - PE on snet-private-endpoints (groupId 'dataFactory')
//   - Private DNS zone group → privatelink.adf.azure.com (commercial)
//   - RBAC: Loom Console UAMI → "Data Factory Contributor" on the factory
//     (covers pipelines/datasets/triggers AND adfcdcs/* — list/get/status/
//      start/stop/delete/put — backing the Change Data Capture (preview) UI).
//     CDC change-data preview reads the resource's LANDED Delta target (not a
//     new ARM verb): the Console UAMI's existing Storage Blob Data Reader on
//     the DLZ ADLS Bronze container + Synapse Serverless (LOOM_SYNAPSE_WORKSPACE)
//     OPENROWSET FORMAT='DELTA' supply the rows — no extra factory grant needed.
//     (The factory MI's Storage Blob Data Contributor below is what WRITES that
//     Delta target during continuous CDC.)
//   - Diagnostic settings → standardized Loom LAW

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name (used for resource naming).')
param domainName string = 'default'

@description('Loom Console UAMI principal ID — granted Data Factory Contributor so the BFF can CRUD pipelines/datasets/triggers and trigger runs.')
param consolePrincipalId string

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Spoke private-endpoint subnet ID (snet-private-endpoints).')
param privateEndpointSubnetId string

@description('Private DNS zone resource ID for privatelink.adf.azure.com (commercial) — must be linked to hub + spoke VNets. Empty = the PE registers but its DNS zone group is skipped (the factory still provisions; DNS resolves once the zone is added). Decoupled so a missing zone no longer silently skips the whole factory.')
param adfPrivateDnsZoneId string = ''

@description('Log Analytics workspace ID for diagnostic settings. Empty (dlz-attach with no hub LAW coordinate) skips the diagnostic settings.')
param workspaceId string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object

@description('DLZ storage account resource ID. When set, grants the factory system-assigned MI Storage Blob Data Contributor so linked services using MSI auth (e.g. the "Practice with sample data" copy pipeline) can read/write ADLS Gen2 without an account key.')
param storageAccountId string = ''

@description('DLZ ADLS Gen2 storage account NAME (same RG). Alternative to storageAccountId — also grants the ADF system-assigned MI Storage Blob Data Contributor so Dataflow Gen2 (WranglingDataFlow) can write Parquet/CSV sinks to ADLS. Empty = skip (Azure SQL sinks still work).')
param adlsAccountName string = ''

@description('Deploy the "loom-geo-enrich" starter pipeline with enrichH3 (Bool), reverseGeocode (Bool), and bufferMeters (Int) parameters pre-declared. The GeoPipeline editor posts these flags to createRun as ADF pipeline parameters. When false, the editor still works but the target pipeline must declare those parameter names itself. Default true.')
param deployGeoEnrichPipeline bool = true

// Unify both inputs: prefer the explicit account name, else derive it from the
// resource ID. A single grant covers MSI-auth copy pipelines AND Dataflow Gen2
// sinks (same role, same principal, same account) — avoids a duplicate
// role-assignment collision on the storage account scope.
var sblobAccountName = !empty(adlsAccountName) ? adlsAccountName : (!empty(storageAccountId) ? last(split(storageAccountId, '/')) : '')

// =====================================================================
// Data Factory
// =====================================================================

resource adf 'Microsoft.DataFactory/factories@2018-06-01' = {
  name: 'adf-loom-${domainName}-${location}'
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    publicNetworkAccess: 'Disabled'
  }
}

// ---------------------------------------------------------------------
// HDInsight pipeline activities (F17) — Hive / Spark / MapReduce / Streaming
//
// ADF natively executes all four HDInsight activity types at this factory's
// api-version (2018-06-01); no extra factory config is required to *run* them.
// They target an `AzureHDInsight` linked service that names a cluster. The
// cluster is NOT provisioned here — HDInsight clusters are long-lived and
// cost-significant, so they are stood up out-of-band by the operator. To wire
// the activities up:
//   1. Provision (or reuse) an Azure HDInsight cluster, VNet-injected into the
//      spoke so this private-only factory can reach it.
//   2. In the Loom console: Manage -> Linked services -> New -> Azure HDInsight,
//      pointing at that cluster.
//   3. Set the admin-plane param `loomHdinsightLinkedService` (env vars
//      LOOM_HDINSIGHT_LINKED_SERVICE + NEXT_PUBLIC_LOOM_HDINSIGHT_LINKED_SERVICE)
//      to that linked-service name so new activities pre-fill the cluster.
//   When unset, the four activities render fully but show an honest MessageBar
//   gate naming LOOM_HDINSIGHT_LINKED_SERVICE (no Fabric dependency anywhere).
//   For on-demand HDInsight clusters, also grant the Console UAMI the
//   "HDInsight Cluster Operator" role on the cluster resource.
// ---------------------------------------------------------------------

// =====================================================================
// Geo-enrichment starter pipeline (loom-geo-enrich)
//
// Backs the GeoPipeline editor: the editor posts enrichH3 / reverseGeocode /
// bufferMeters as ADF pipeline PARAMETERS at trigger time (real createRun).
// This declares those parameter names so the editor's flags map 1:1. The
// activities array is an empty shell — operators build the enrichment graph in
// ADF Studio / the Loom pipeline editor (Copy + Dataflow/Function activities
// that read @pipeline().parameters.enrichH3 etc.). No Fabric dependency: this
// is a plain ADF pipeline resource. Opt-out with deployGeoEnrichPipeline=false.
// =====================================================================

resource geoEnrichPipeline 'Microsoft.DataFactory/factories/pipelines@2018-06-01' = if (deployGeoEnrichPipeline) {
  parent: adf
  name: 'loom-geo-enrich'
  properties: {
    description: 'Geo-enrichment pipeline driven by the Loom GeoPipeline editor flags. Parameters: enrichH3 (Bool), reverseGeocode (Bool), bufferMeters (Int).'
    annotations: [ 'loom', 'geo' ]
    parameters: {
      enrichH3:       { type: 'Bool',   defaultValue: true }
      reverseGeocode: { type: 'Bool',   defaultValue: false }
      bufferMeters:   { type: 'Int',    defaultValue: 0 }
      inputPath:      { type: 'String', defaultValue: '' }
      outputPath:     { type: 'String', defaultValue: '' }
    }
    activities: []
  }
}

// =====================================================================
// Private endpoint
// =====================================================================

resource peAdf 'Microsoft.Network/privateEndpoints@2024-03-01' = {
  name: 'pe-adf-loom-${domainName}'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'adf-portal'
        properties: {
          privateLinkServiceId: adf.id
          groupIds: [ 'dataFactory' ]
        }
      }
    ]
  }
}

resource peAdfDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-03-01' = if (!empty(adfPrivateDnsZoneId)) {
  parent: peAdf
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-adf-azure-com'
        properties: { privateDnsZoneId: adfPrivateDnsZoneId }
      }
    ]
  }
}

// =====================================================================
// RBAC — Loom Console UAMI → Data Factory Contributor on the factory
// (built-in role: 673868aa-7521-48a0-acc6-0f60742d39f5)
// =====================================================================

resource consoleAdfContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: adf
  name: guid(adf.id, consolePrincipalId, '673868aa-7521-48a0-acc6-0f60742d39f5')
  properties: {
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '673868aa-7521-48a0-acc6-0f60742d39f5')
  }
}

// =====================================================================
// =====================================================================
// RBAC — ADF factory system-assigned MI → Storage Blob Data Contributor
// on the DLZ storage account (built-in role:
// ba92f5b4-2d11-453d-a403-e96b0029c9fe). Required so ADF linked services
// using MSI auth (no account key) can read landing/ and write bronze/ —
// backs the "Practice with sample data" copy pipeline — AND so Dataflow
// Gen2 (WranglingDataFlow) can write its Parquet/CSV sink to ADLS.
// One grant covers both; scoped to the storage account in this RG.
// =====================================================================

resource storageForAdfRbac 'Microsoft.Storage/storageAccounts@2023-05-01' existing = if (!empty(sblobAccountName)) {
  name: empty(sblobAccountName) ? 'placeholder' : sblobAccountName
}

resource adfStorageBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(sblobAccountName)) {
  scope: storageForAdfRbac
  name: guid(adf.id, sblobAccountName, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  properties: {
    principalId: adf.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}

// =====================================================================
// Diagnostic settings → standardized Loom LAW
// =====================================================================

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: adf
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    // Resource-specific (Dedicated) mode routes ADF diagnostic logs into the
    // typed ADFPipelineRun / ADFActivityRun tables instead of the legacy
    // AzureDiagnostics catch-all. The Output-pane Log Analytics fallback
    // (runs older than ADF's 45-day native window) queries these typed tables.
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      { category: 'ActivityRuns',  enabled: true }
      { category: 'PipelineRuns',  enabled: true }
      { category: 'TriggerRuns',   enabled: true }
      { category: 'SandboxPipelineRuns', enabled: true }
      { category: 'SandboxActivityRuns', enabled: true }
      { category: 'SSISPackageEventMessages', enabled: true }
      { category: 'SSISPackageExecutableStatistics', enabled: true }
      { category: 'SSISPackageEventMessageContext', enabled: true }
      { category: 'SSISPackageExecutionComponentPhases', enabled: true }
      { category: 'SSISPackageExecutionDataStatistics', enabled: true }
      { category: 'SSISIntegrationRuntimeLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output factoryId   string = adf.id
output factoryName string = adf.name
output factoryPrincipalId string = adf.identity.principalId
