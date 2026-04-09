// Template to deploy remediation tasks for all policy assignments

targetScope = 'subscription'

metadata name = 'ALZ Bicep - Policy Remediation'
metadata description = 'Module used to set up Remediation Tasks for Policies at the subscription level'


@sys.description('Environment for the resources')
param environment string

// param initiatives array
param policyAssignmentid string
param policyAssignmentName string


// Resources
// resource remediationTask 'Microsoft.PolicyInsights/remediations@2021-10-01' = {
//   name: '${prefix}-remediationTask-${policyDefinitionName}-${environment}'
//   properties: {
//     failureThreshold: {
//       percentage: 1
//     }
//   policyAssignmentId: parmPolicyAssignmentid
//   policyDefinitionReferenceId: parmPolicyDefinitionReferenceId
//   resourceDiscoveryMode: 'ExistingNonCompliant'
//   parallelDeployments: 20
// }
// }

// resource remediationTask 'Microsoft.PolicyInsights/remediations@2021-10-01' = [for id in policyAssignmentid: {
//   name: '${prefix}-${id}-${environment}-remediation'
//   properties: {
//     // policyAssignmentId: resourceId('/providers/Microsoft.Authorization/policySetDefinitions', initiative.id)
//     policyAssignmentId: id
//     // policyDefinitionReferenceId: initiative.id
//     parallelDeployments: 100
//     resourceDiscoveryMode: 'ReEvaluateCompliance'
//   }
// }]

resource remediationTask 'Microsoft.PolicyInsights/remediations@2021-10-01' = {
  name: '${policyAssignmentName}-${environment}-remediation'
  properties: {
    policyAssignmentId: policyAssignmentid
    policyDefinitionReferenceId: policyAssignmentid
    parallelDeployments: 30
    resourceDiscoveryMode: 'ReEvaluateCompliance'
  }
}
