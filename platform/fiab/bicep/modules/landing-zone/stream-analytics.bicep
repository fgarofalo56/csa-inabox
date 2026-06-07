// CSA Loom DLZ — Azure Stream Analytics (optional)
//
// Backs the `stream-analytics-job` Loom editor. Provisions a single
// "starter" ASA job per DLZ (Stopped on creation) so the editor has a
// real ARM object to list, plus the role assignment that lets the
// Loom Console UAMI list / start / stop / update transformations.
//
// Posture:
//   - Job created in Stopped state (operators wire inputs/outputs in
//     the editor or in the Azure portal, then start)
//   - Standard SKU (V2 introduced 2024 — keeping Standard since
//     V2 isn't GA in all regions yet)
//   - 3 streaming units default (cheapest functional size)
//   - Diagnostic settings → standardized Loom LAW
//   - RBAC: Loom Console UAMI → "Stream Analytics Contributor"
//
// Query Builder (Compile / Test Query):
//   The Eventstream transform-node builder validates and runs generated SAQL
//   via the subscription/location-scoped RP actions
//   Microsoft.StreamAnalytics/locations/{CompileQuery,TestQuery,SampleInput}/action.
//   Those are ABOVE this RG, so the RG-scoped Contributor grant below does NOT
//   authorize them. Grant the Console UAMI the built-in role "Stream Analytics
//   Query Tester" (1ec5b3c1-b17e-4e25-8312-2acb3c3c5abf) at SUBSCRIPTION scope
//   as a one-time tenant action (see docs/fiab/v3-tenant-bootstrap.md). Until
//   then the editor's Compile/Run surfaces an honest error naming this role.
//   The "Run test" sample-output path additionally needs a blob container SAS
//   write URI — set LOOM_ASA_TEST_WRITE_URI (admin-plane/main.bicep param
//   loomAsaTestWriteUri); without it the Run action shows an honest infra-gate
//   while Compile (validation) stays fully functional.
//
// Enabled by setting `enableStreamAnalytics=true` in the parent
// landing-zone main.bicep. Default is FALSE so existing deployments
// don't accidentally provision streaming compute they don't need.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name (used for resource naming).')
param domainName string = 'default'

@description('Loom Console UAMI principal ID — granted Stream Analytics Contributor on this RG so the BFF can list, save transformations, start, and stop.')
param consolePrincipalId string

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Starting streaming units (SU). 1, 3, 6, 12, 18, 24, 30, 36, 42, 48, …')
@allowed([ 1, 3, 6, 12, 18, 24, 30, 36, 42, 48 ])
param startingStreamingUnits int = 3

@description('Log Analytics workspace ID for diagnostic settings.')
param workspaceId string

@description('Compliance tags applied to every resource.')
param complianceTags object

// =====================================================================
// Streaming job — Stopped on creation. Inputs / outputs are authored
// in the Loom editor or directly in the portal.
// =====================================================================

resource asaJob 'Microsoft.StreamAnalytics/streamingjobs@2020-03-01' = {
  name: 'asa-loom-${domainName}-${location}'
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    sku: { name: 'Standard' }
    eventsOutOfOrderPolicy: 'Adjust'
    outputErrorPolicy: 'Stop'
    eventsOutOfOrderMaxDelayInSeconds: 5
    eventsLateArrivalMaxDelayInSeconds: 5
    dataLocale: 'en-US'
    compatibilityLevel: '1.2'
    jobType: 'Cloud'
    contentStoragePolicy: 'SystemAccount'
  }
}

// Default transformation — placeholder SAQL with 3 SU. Operator
// replaces this in the Loom editor; we provision it so the job is
// immediately editable.
resource transformation 'Microsoft.StreamAnalytics/streamingjobs/transformations@2020-03-01' = {
  parent: asaJob
  name: 'Transformation'
  properties: {
    streamingUnits: startingStreamingUnits
    query: '-- Starter SAQL — replace via the Loom Stream Analytics editor.\nSELECT *\nINTO [output]\nFROM [input]'
  }
}

// =====================================================================
// RBAC — Loom Console UAMI → Stream Analytics Contributor on the RG
// (so the BFF can list, get, save transformations, start, stop)
// Built-in role: 65cb152a-1b39-4f9d-aafa-1f49f88b1f5b
// =====================================================================

resource consoleAsaContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: resourceGroup()
  name: guid(resourceGroup().id, consolePrincipalId, '65cb152a-1b39-4f9d-aafa-1f49f88b1f5b')
  properties: {
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '65cb152a-1b39-4f9d-aafa-1f49f88b1f5b')
  }
}

// =====================================================================
// Diagnostic settings → standardized Loom LAW
// =====================================================================

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: asaJob
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'Execution', enabled: true }
      { category: 'Authoring', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output jobId   string = asaJob.id
output jobName string = asaJob.name
output rgName  string = resourceGroup().name
