// CSA Loom deploy-planner — Azure Stream Analytics job
//
// Wired by the deploy-planner catalog (key: streamAnalytics → streamAnalyticsEnabled).
// Self-contained (no networking deps): one streaming job created Stopped with a
// starter transformation, so the Stream Analytics editor has a real ARM object
// to list / start / stop / edit. The Loom Console UAMI is granted Stream
// Analytics Contributor on the RG.
//
// Grounded in Microsoft Learn:
//   Microsoft.StreamAnalytics/streamingjobs  (Bicep)
//   https://learn.microsoft.com/azure/templates/microsoft.streamanalytics/streamingjobs

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Starting streaming units.')
@allowed([1, 3, 6, 12, 18, 24, 30, 36, 42, 48])
param startingStreamingUnits int = 3

@description('Loom Console UAMI principal ID — granted Stream Analytics Contributor on the RG. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var jobName = take('asa-loom-${uniqueString(resourceGroup().id)}', 63)

resource asaJob 'Microsoft.StreamAnalytics/streamingjobs@2021-10-01-preview' = {
  name: jobName
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
  }
}

resource transformation 'Microsoft.StreamAnalytics/streamingjobs/transformations@2021-10-01-preview' = {
  parent: asaJob
  name: 'Transformation'
  properties: {
    streamingUnits: startingStreamingUnits
    query: '-- Starter SAQL — replace via the Loom Stream Analytics editor.\nSELECT *\nINTO [output]\nFROM [input]'
  }
}

// Stream Analytics Contributor — list / start / stop / edit transformations
// (role 6e0c8711-85a0-4490-8365-8ec13c4560b4).
resource asaContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: resourceGroup()
  name: guid(resourceGroup().id, consolePrincipalId, '6e0c8711-85a0-4490-8365-8ec13c4560b4')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '6e0c8711-85a0-4490-8365-8ec13c4560b4')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output jobId string = asaJob.id
output jobName string = asaJob.name
