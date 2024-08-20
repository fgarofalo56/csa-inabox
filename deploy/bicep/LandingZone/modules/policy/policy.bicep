// Templete to deploy policy assignment for built in policies and policy sets
targetScope = 'subscription'

metadata name = 'ALZ Bicep - Policy Settings'
metadata description = 'Module used to set up Policies at the subscription level'

// @sys.description('Log Analytics Workspace Resource ID.')
// param parLogAnalyticsWorkspaceResourceId string

@sys.description('Log Analytics Workspace Resource Name')
param logAnalytics string 

// @sys.description('Log Analytics Workspace Resource Group Name')
// param logAnalyticsRG string

@sys.description('Managed Identity')
param userAssignedIdentityId string


@sys.description('Policy Resource Location.')
param location string = 'eastus'

@sys.description('Policy Assignment Non-Compliance Message.')
param nonComplianceMessage string

param prefix string
param environment string

param tags object = {}

// param resourceLocationList array = [
//   'eastus'
//   'eastus2'
//   'westus'
//   'westus2'
//   'centralus'
//   'northcentralus'
//   'southcentralus'
//   'westcentralus'
// ]
// param effect string = 'DeployIfNotExists'

// param profileName string = 'alz-policy-profile'
// param metricsEnabled string = 'True'
// param logsEnabled string = 'True'

// Variables
var diagnosticSettingName = '${prefix}-dataObservability-${environment}-diagSettingsLA'

// Assign built in policy sets for logging and monitoring
// Array of built in policy definitions
param policyAssignments array = [
  {
    name: '${prefix}-EnableLogsPolicy-${environment}-policyAssignment'
    policyDefinitionId: '/providers/Microsoft.Authorization/policySetDefinitions/0884adba-2312-4468-abeb-5422caed1038'
    displayName: '${prefix}-${environment} Enable allLogs category group resource logging for supported resources to Log Analytics'
    setName: '0884adba-2312-4468-abeb-5422caed1038'
  }
  {
    name: '${prefix}-EnableAuditPolicy-${environment}-policyAssignment'
    policyDefinitionId: '/providers/Microsoft.Authorization/policySetDefinitions/f5b29bc4-feca-4cc6-a58a-772dd5e290a5'
    displayName: '${prefix}-${environment} Enable audit category group resource logging for supported resources to Log Analytics'
    setName: 'f5b29bc4-feca-4cc6-a58a-772dd5e290a5'
  }
]

resource policySetAssignment 'Microsoft.Authorization/policyAssignments@2024-04-01' = [for assignment in policyAssignments: {
  name: assignment.name
  location: location
  scope: subscription()
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
        '${userAssignedIdentityId}': {}
      }
    }
  
  properties: {
    displayName: assignment.displayName
    policyDefinitionId: assignment.policyDefinitionId
    metadata: tags

    // Additional properties like parameters, etc.
    nonComplianceMessages:[ 
      {
      message: nonComplianceMessage
    }
  ]
    parameters: {
      logAnalytics: {
        value: logAnalytics
      }
      diagnosticSettingName: {
        value: diagnosticSettingName
    }
  }
}
}
]


// Count of the number of policy sets assigned
var varPolicySetCount = length(policyAssignments)

resource policySetDefinitions 'Microsoft.Authorization/policySetDefinitions@2023-04-01' existing = [for i in range(0, varPolicySetCount):{
  name: policyAssignments[i].setName
  scope: tenant()
  }]

// Outputs

output policySetDefinitions array = [for i in range(0, varPolicySetCount):{
policyDefinitionId: policySetDefinitions[i].id
policySetDefinitionName: policySetDefinitions[i].name
// policySetDefinitionproperties: policySetDefinitions[i].properties
policySetDefinitionpropertiespolicyDefinitions: map(policySetDefinitions[i].properties.policyDefinitions, DefinitionId => DefinitionId.policyDefinitionId)
// policySetDefinitionpropertiespolicyDefinitions: toObject(policySetDefinitions[i].properties.policyDefinitions, entry => 'policyDefinitionId', entry => entry.policyDefinitionId)
// policySetDefinitionPolicyIds: flatten(policySetDefinitions[i].properties.policyDefinitions.policyDefinitionId)
// policySetDefinitionReferenceId: flatten(policySetDefinitions[i].properties.policyDefinitions.policyDefinitionReferenceId)
}]
