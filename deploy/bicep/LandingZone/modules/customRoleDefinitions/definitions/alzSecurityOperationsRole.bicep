targetScope = 'subscription'

metadata name = 'ALZ Bicep - Security Operations Role'
metadata description = 'Role for Security Operations'

@sys.description('The subscription scope to which the role can be assigned.  This subscription ID will be used for the assignableScopes property in the role definition.')
param parAssignableScopeSubscriptionId string

var varRole = {
  name: '[${subscription().displayName}] Security operations (SecOps)'
  description: 'Security administrator role with a horizontal view across the entire Azure estate and the Azure Key Vault purge policy'
}

resource resRoleDefinition 'Microsoft.Authorization/roleDefinitions@2022-05-01-preview' = {
  name: guid(varRole.name, parAssignableScopeSubscriptionId)
  properties: {
    roleName: varRole.name
    description: varRole.description
    type: 'CustomRole'
    assignableScopes: [
      parAssignableScopeSubscriptionId
    ]
    permissions: [
      {
        actions: [
          '*/read'
          '*/register/action'
          'Microsoft.KeyVault/locations/deletedVaults/purge/action'
          'Microsoft.PolicyInsights/*'
          'Microsoft.Authorization/policyAssignments/*'
          'Microsoft.Authorization/policyDefinitions/*'
          'Microsoft.Authorization/policyExemptions/*'
          'Microsoft.Authorization/policySetDefinitions/*'
          'Microsoft.Insights/alertRules/*'
          'Microsoft.Resources/deployments/*'
          'Microsoft.Security/*'
          'Microsoft.Support/*'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

output roleDefinitionId string = resRoleDefinition.id
