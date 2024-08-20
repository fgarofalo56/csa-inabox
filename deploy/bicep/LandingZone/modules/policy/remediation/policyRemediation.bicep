// Template to deploy remediation tasks for all policy assignments

targetScope = 'subscription'

metadata name = 'ALZ Bicep - Policy Remediation'
metadata description = 'Module used to set up Remediation Tasks for Policies at the subscription level'

@sys.description('Policy Assignments')
param parmPolicyAssignmentid string

@sys.description('Policy Definition Reference ID')
param parmPolicyDefinitionReferenceId string

@sys.description('Prefix for the resources')
param prefix string

@sys.description('Environment for the resources')
param environment string

@sys.description('Policy Definition Name')
param policyDefinitionName string


// Resources
resource remediationTask 'Microsoft.PolicyInsights/policyAssignments/remediationTasks@2021-10-01' = {
  name: '${prefix}-remediationTask-${policyDefinitionName}-${environment}'
  properties: {
    policyAssignmentId: parmPolicyAssignmentid
    policyDefinitionReferenceId: parmPolicyDefinitionReferenceId
    resourceDiscoveryMode: 'ExistingNonCompliant'
    parallelDeployments: 10
    failureThreshold
        failureThreshold: {
      percentage: 0.1
    }
  }
}

