targetScope = 'subscription'

metadata name = 'ALZ Bicep - Application Owner Role'
metadata description = 'Role for Application Owners'

@sys.description('The subscription scope to which the role can be assigned.  This subscription ID will be used for the assignableScopes property in the role definition.')
param parAssignableScopeSubscriptionId string

var varRole = {
  name: '[${subscription().displayName}] Application owners (DevOps/AppOps)'
  description: 'Contributor role granted for application/operations team at resource group level'
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
          '*'
        ]
        notActions: [
          'Microsoft.Authorization/*/write'
          'Microsoft.Network/publicIPAddresses/write'
          'Microsoft.Network/virtualNetworks/write'
          'Microsoft.KeyVault/locations/deletedVaults/purge/action'
        ]
        dataActions: []
        notDataActions: []
      }
    ]
  }
}
output roleDefinitionId string = resRoleDefinition.id
