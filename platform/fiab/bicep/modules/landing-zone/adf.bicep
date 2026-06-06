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

@description('DLZ storage account resource ID. When set, grants the factory system-assigned MI Storage Blob Data Contributor so linked services using MSI auth (e.g. the "Practice with sample data" copy pipeline) can read/write ADLS Gen2 without an account key.')
param storageAccountId string = ''

var storageAccountName = !empty(storageAccountId) ? last(split(storageAccountId, '/')) : ''

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
// RBAC — ADF factory system-assigned MI → Storage Blob Data Contributor
// on the DLZ storage account (built-in role:
// ba92f5b4-2d11-453d-a403-e96b0029c9fe). Required so ADF linked services
// using MSI auth (no account key) can read landing/ and write bronze/ —
// backs the "Practice with sample data" copy pipeline.
// =====================================================================

resource storageForAdfRbac 'Microsoft.Storage/storageAccounts@2023-05-01' existing = if (!empty(storageAccountName)) {
  name: storageAccountName
}

resource adfStorageBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(storageAccountId)) {
  scope: storageForAdfRbac
  name: guid(storageAccountId, adf.id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  properties: {
    principalId: adf.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
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
