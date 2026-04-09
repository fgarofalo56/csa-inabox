//This BICEP File is to assign multiple built-in policies to a subscription using a single policy assignment template

resource policyAssignment 'Microsoft.Authorization/policyAssignments@2021-06-01' = {
  name: 'FRGAROFALO Assign Builtin Policy - Enable logging by category group for Azure Synapse Analytics (microsoft.synapse/workspaces) to Log Analytics'
  location: 'eastus'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    assignmentType: 'BuiltIn'
    enforcementMode: 'Default'
    metadata: {
      assignedBy: 'AzurePolicies'
      category: 'DataOberviability'
      description: 'Enable diagnostic settings for all resources'
      owner: 'frgarofa'
    }    
    nonComplianceMessages: [
      {
      message: 'This resource is not compliant with the Cloud Scale Analytics diagnostic settings policy.'
    }
  ]
    policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/305408ed-dd5a-43b9-80c1-9eea87a176bb'
    scope: '/subscriptions/${subscription().subscriptionId}'
    parameters: {
        categoryGroup: {
        value: 'allLogs'
      }
      logAnalytics: {
        value: 'alz-log-analytics'
      }
    }
  }
}
