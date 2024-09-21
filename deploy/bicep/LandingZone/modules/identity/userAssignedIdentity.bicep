// Template to deploy User Assigned Identity

// targetScope = 'resourceGroup'

// Metadata
metadata name = 'ALZ Bicep - Subscription User Assigned Identity'
metadata description = 'Module used to deploy a User Assigned Identity'

@sys.description('The location for all resources.')

// Parameters
param location string
param prefix string
param tags object

// Resource
resource userAssignedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2018-11-30' = {
  name: '${prefix}-umi-identity'
  location: location
  tags: tags
}

output userAssignedIdentityName string = userAssignedIdentity.name
output userAssignedIdentityId string = userAssignedIdentity.id
output userAssignedIdentityPrincipalId string = userAssignedIdentity.properties.principalId
output userAssignedIdentityClientId string = userAssignedIdentity.properties.clientId

