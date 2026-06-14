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

@description('Optional: ADLS Gen2 storage account in THIS resource group that ASA Blob/lakehouse outputs write to. When set, the ASA job managed identity is granted Storage Blob Data Contributor on it (MSI auth, no account keys).')
param adlsAccountName string = ''

@description('Optional: ADX (Azure Data Explorer) cluster name backing KQL Database outputs. Used only for documentation/output — ADX ingestor grants are a Kusto control-plane operation, not ARM RBAC (see comment below).')
param adxClusterName string = ''

// =====================================================================
// Streaming job — Stopped on creation. Inputs / outputs are authored
// in the Loom editor or directly in the portal. API 2021-10-01-preview
// is required for `authenticationMode: 'Msi'` on Blob/ADLS Gen2 and
// Kusto/ADX outputs (matches the deploy-planner ASA module).
// =====================================================================

resource asaJob 'Microsoft.StreamAnalytics/streamingjobs@2021-10-01-preview' = {
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
resource transformation 'Microsoft.StreamAnalytics/streamingjobs/transformations@2021-10-01-preview' = {
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
// Built-in role: 6e0c8711-85a0-4490-8365-8ec13c4560b4
// =====================================================================

resource consoleAsaContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: resourceGroup()
  name: guid(resourceGroup().id, consolePrincipalId, '6e0c8711-85a0-4490-8365-8ec13c4560b4')
  properties: {
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '6e0c8711-85a0-4490-8365-8ec13c4560b4')
  }
}

// =====================================================================
// RBAC — ASA job managed identity → Storage Blob Data Contributor on the
// ADLS Gen2 account, so the Lakehouse/Blob output can write transformed
// events as files using MSI auth (no account keys). Only assigned when
// `adlsAccountName` is supplied AND the account lives in this RG.
// Built-in role: ba92f5b4-2d11-453d-a403-e96b0029c9fe
// =====================================================================

resource adlsAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = if (!empty(adlsAccountName)) {
  name: adlsAccountName
}

resource asaBlobDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(adlsAccountName)) {
  scope: adlsAccount
  name: guid(adlsAccount.id, asaJob.id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  properties: {
    principalId: asaJob.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}

// =====================================================================
// ADX / KQL Database output ingestor — NOT expressible as ARM RBAC.
// Azure Data Explorer authorizes ingestion via Kusto control-plane
// principal assignments, not Microsoft.Authorization role assignments.
// After this job is created, grant its managed identity ingest rights:
//
//   az kusto cluster-principal-assignment create \
//     --cluster-name <adxClusterName> --resource-group <adxResourceGroup> \
//     --principal-assignment-name asa-loom-ingestor \
//     --principal-id <asaJob.identity.principalId> --principal-type App \
//     --role AllDatabasesIngestor
//
// (Or a database-scoped `.add database <db> ingestors ('aadapp=<principalId>')`
// control command.) This is wired into the post-deploy bootstrap rather than
// bicep. `adxClusterName` is surfaced as an output to drive that step.
// =====================================================================

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
output asaPrincipalId string = asaJob.identity.principalId
output adxClusterForIngestor string = adxClusterName
