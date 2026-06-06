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

@description('Private DNS zone resource ID for privatelink.adf.azure.com (commercial) — must be linked to hub + spoke VNets.')
param adfPrivateDnsZoneId string

@description('Log Analytics workspace ID for diagnostic settings.')
param workspaceId string

@description('Compliance tags applied to every resource.')
param complianceTags object

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

resource peAdfDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-03-01' = {
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
// Diagnostic settings → standardized Loom LAW
// =====================================================================

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: adf
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
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
