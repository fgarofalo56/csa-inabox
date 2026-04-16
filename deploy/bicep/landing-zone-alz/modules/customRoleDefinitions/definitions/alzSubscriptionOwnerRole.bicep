targetScope = 'subscription'

metadata name = 'ALZ Bicep - Subscription Owner Role'
metadata description = 'Role for Subscription Owners'

@sys.description('The subscription scope to which the role can be assigned.  This subscription ID will be used for the assignableScopes property in the role definition.')
param parAssignableScopeSubscriptionId string

var varRole = {
  name: '[${subscription().displayName}] Subscription owner'
  description: 'Delegated role for subscription owner derived from subscription Owner role'
}

// #checkov:skip=CKV_AZURE_39:ALZ convention - custom role mirrors built-in with additional constraints
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
          'Microsoft.Network/vpnGateways/*'
          'Microsoft.Network/expressRouteCircuits/*'
          'Microsoft.Network/routeTables/write'
          'Microsoft.Network/vpnSites/*'
        ]
        dataActions: []
        notDataActions: []
      }
    ]
  }
}
output roleDefinitionId string = resRoleDefinition.id
