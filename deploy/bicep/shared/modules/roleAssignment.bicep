// Shared module: Role Assignment
// Reusable RBAC assignment for data platform services
targetScope = 'resourceGroup'

// Parameters
@description('Principal ID (object ID) to assign the role to.')
param principalId string

@description('Type of principal.')
@allowed([
  'Device'
  'ForeignGroup'
  'Group'
  'ServicePrincipal'
  'User'
])
param principalType string = 'ServicePrincipal'

@description('Full resource ID of the role definition to assign.')
param roleDefinitionId string

@description('Scope at which to create the assignment. Defaults to resource group.')
param scope string = resourceGroup().id

@description('Optional description for the role assignment.')
param description string = ''

// Variables
var roleAssignmentName = guid(scope, principalId, roleDefinitionId)

// Resources
resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: roleAssignmentName
  properties: {
    principalId: principalId
    principalType: principalType
    roleDefinitionId: roleDefinitionId
    description: !empty(description) ? description : null
  }
}

// Outputs
@description('Resource ID of the role assignment.')
output roleAssignmentId string = roleAssignment.id

@description('Name (GUID) of the role assignment.')
output roleAssignmentName string = roleAssignment.name
