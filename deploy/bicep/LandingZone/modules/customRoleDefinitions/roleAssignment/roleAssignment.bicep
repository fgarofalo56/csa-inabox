// Template used to assign roles to the user assigned identity

targetScope = 'subscription'

// Metadata
metadata name = 'ALZ Bicep - Subscription Role Assignment'

// Parameters
param roleDefinitionId string
param principalId string


// Variables

// Resource
resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(roleDefinitionId, principalId)
  properties: {
    roleDefinitionId: roleDefinitionId
    principalId:  principalId
  }
}

output roleAssignmentName string = roleAssignment.name
output roleAssignmentId string = roleAssignment.id


