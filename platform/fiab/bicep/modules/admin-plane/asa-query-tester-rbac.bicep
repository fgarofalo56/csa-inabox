// CSA Loom — Stream Analytics Query Tester RBAC (subscription scope).
//
// The Eventstream transform-node builder + the stream-analytics-job editor
// validate (Compile) and run (Test) generated SAQL through the
// subscription/location-scoped RP actions:
//   Microsoft.StreamAnalytics/locations/{CompileQuery,TestQuery,SampleInput}/action
// Those actions live ABOVE any resource group, so the RG-scoped "Stream
// Analytics Contributor" grant from modules/landing-zone/stream-analytics.bicep
// does NOT authorize them. The built-in role that does is:
//   Stream Analytics Query Tester — 1ec5b3c1-b17e-4e25-8312-2acb3c3c5abf
// granted at SUBSCRIPTION scope. Without it the editor's Compile/Run surfaces an
// honest 403 (per no-vaporware.md). Granting it here lights those controls up on
// first login (deploy-readiness G2), matching the documented one-time tenant
// action in docs/fiab/v3-tenant-bootstrap.md so a fresh deploy needs no manual
// patch.
//
// Cloud-agnostic: the role definition GUID is identical in Commercial / GCC /
// GCC-High / IL5 / DoD. Read-only-equivalent (validation/test compute only) —
// it cannot create or modify resources.
//
// Subscription scope (own module, vs. inlining in main.bicep) so the Console
// UAMI principalId — a main.bicep module OUTPUT — arrives as a plain
// start-time-known param, satisfying the roleAssignment name/if requirement
// (avoids BCP177/BCP120). Same pattern as rti-hub-rbac.bicep / scaling-rbac.bicep.

targetScope = 'subscription'

@description('Console UAMI principalId — granted Stream Analytics Query Tester at this subscription scope so the Eventstream transform builder + stream-analytics-job editor can Compile/Test SAQL. Empty string skips the grant.')
param consolePrincipalId string

@description('When true, skip the grant (re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

@description('When false, skip the grant entirely (Stream Analytics opt-out). Mirrors loomStreamAnalyticsEnabled — no point granting the tester role when no ASA surface is provisioned.')
param loomStreamAnalyticsEnabled bool = true

// Stream Analytics Query Tester — 1ec5b3c1-b17e-4e25-8312-2acb3c3c5abf
resource asaQueryTester 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants && loomStreamAnalyticsEnabled) {
  name: guid(subscription().id, consolePrincipalId, 'asa-query-tester')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '1ec5b3c1-b17e-4e25-8312-2acb3c3c5abf')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    description: 'Loom Console UAMI: Compile/Test Stream Analytics SAQL via the subscription-scoped CompileQuery/TestQuery/SampleInput actions (Eventstream transform builder + stream-analytics-job editor).'
  }
}

output roleAssigned bool = !empty(consolePrincipalId) && !skipRoleGrants && loomStreamAnalyticsEnabled
