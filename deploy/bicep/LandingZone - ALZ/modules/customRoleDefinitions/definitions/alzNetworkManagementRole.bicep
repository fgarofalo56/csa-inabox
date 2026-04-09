targetScope = 'subscription'

metadata name = 'ALZ Bicep - Network Management Role'
metadata description = 'Role for Network Management'

@sys.description('The subscription scope to which the role can be assigned.  This subscription ID will be used for the assignableScopes property in the role definition.')
param parAssignableScopeSubscriptionId string

var varRole = {
  name: '[${subscription().displayName}] Network management (NetOps)'
  description: 'Platform-wide global connectivity management: Virtual networks, UDRs, NSGs, NVAs, VPN, Azure ExpressRoute, and others'
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
          'Microsoft.Network/*'
          'Microsoft.Resources/deployments/*'
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
